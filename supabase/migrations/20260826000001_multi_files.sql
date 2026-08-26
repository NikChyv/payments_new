-- Несколько файлов в одной заявке.
--
-- Файлы переезжают в jsonb-массив `files`: [{"url": "...", "name": "..."}, ...].
-- Старые колонки file_url / file_name НЕ удаляем, а держим зеркалом первого
-- файла: их читают утренняя рассылка (send_daily_reminder), уведомление о новой
-- заявке (notify-payment) и Telegram-бот. Иначе пришлось бы менять всё разом,
-- а деплой у нас пошаговый: миграции → функции → фронт.

alter table public.payments
  add column if not exists files jsonb not null default '[]'::jsonb;

-- существующие заявки: единственный файл становится первым элементом массива
update public.payments
set files = jsonb_build_array(jsonb_build_object('url', file_url, 'name', coalesce(nullif(file_name, ''), 'файл')))
where file_url is not null and file_url <> '' and files = '[]'::jsonb;

-- Приводим то, что пришло от клиента, к каноничному виду и проверяем.
-- Отдельной функцией, потому что нужна одинаково в submit и в edit.
create or replace function public.normalize_files(
  p_files jsonb, p_file_url text, p_file_name text
) returns jsonb language plpgsql immutable set search_path = public as $$
declare v jsonb;
begin
  v := coalesce(p_files, '[]'::jsonb);

  if jsonb_typeof(v) <> 'array' then
    raise exception 'files должен быть массивом';
  end if;

  -- совместимость: старый вызов с одним файлом (бот, невыкаченный фронт)
  if jsonb_array_length(v) = 0 and coalesce(p_file_url, '') <> '' then
    v := jsonb_build_array(jsonb_build_object('url', p_file_url,
                                              'name', coalesce(nullif(p_file_name, ''), 'файл')));
  end if;

  if jsonb_array_length(v) > 10 then
    raise exception 'Слишком много файлов: % (максимум 10)', jsonb_array_length(v);
  end if;

  -- элемент без ссылки бесполезен и ломает показ — отсекаем сразу
  if exists (select 1 from jsonb_array_elements(v) e where coalesce(e ->> 'url', '') = '') then
    raise exception 'У каждого файла должна быть ссылка';
  end if;

  return v;
end; $$;

-- ---------------------------------------------------------------------------
-- submit_payment: добавлен p_files. Параметр со значением по умолчанию, поэтому
-- прежние вызовы с десятью аргументами (бот, ещё не выкаченный фронт)
-- продолжают работать.
--
-- Старые версии обязательно удалить: `create or replace` с новым параметром
-- создаёт ПЕРЕГРУЗКУ, а не замену, и вызов с десятью аргументами становится
-- неоднозначным — «function ... is not unique». Права после пересоздания
-- выдаём заново, они с функцией не переезжают.
-- ---------------------------------------------------------------------------
drop function if exists public.submit_payment(
  text, text, numeric, text, date, text, text, boolean, text, text);
drop function if exists public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text);

create or replace function public.submit_payment(
  p_token text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text, p_files jsonb default null
) returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_id text; v_due date; v_files jsonb;
begin
  perform check_rate_limit(p_token, 'submit', 10, interval '1 minute');
  perform check_rate_limit(p_token, 'submit_h', 60, interval '1 hour');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  v_due   := adjust_due_date(p_due);
  v_files := normalize_files(p_files, p_file_url, p_file_name);

  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name, files,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, coalesce(p_amount,0), p_requisites, v_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,false),
          v_files -> 0 ->> 'url', v_files -> 0 ->> 'name', v_files,
          v_client.id, now());
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- edit_payment_by_token: тот же p_files.
-- Все прежние защиты на месте — check_rate_limit, status = 'new',
-- created_by_staff is null, adjust_due_date. Функцию целиком пересоздаём,
-- поэтому терять их нельзя (см. CLAUDE.md).
-- ---------------------------------------------------------------------------
create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text, p_files jsonb default null
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_due date; v_files jsonb;
begin
  perform check_rate_limit(p_token, 'edit', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  v_due := adjust_due_date(p_due);

  -- p_files не передан = «файлы не трогаем»; передан (пусть и пустой) = заменяем
  if p_files is null and coalesce(p_file_url, '') = '' then
    v_files := null;
  else
    v_files := normalize_files(p_files, p_file_url, p_file_name);
  end if;

  update payments set
    payee        = p_payee,
    amount       = coalesce(p_amount, 0),
    requisites   = p_requisites,
    due          = v_due,
    recurrence   = coalesce(p_recurrence, 'once'),
    purpose      = p_purpose,
    need_receipt = coalesce(p_need_receipt, false),
    files        = coalesce(v_files, files),
    file_url     = case when v_files is null then file_url  else v_files -> 0 ->> 'url'  end,
    file_name    = case when v_files is null then file_name else v_files -> 0 ->> 'name' end
  where id = p_id and client_id = v_client.id and status = 'new'
    and created_by_staff is null;
  if not found then
    raise exception 'Заявку нельзя изменить: не найдена, не ваша или уже в работе';
  end if;
  return true;
end; $$;

-- Права после пересоздания функций: клиент ходит по токену как anon, сотрудник —
-- как authenticated. Обе функции SECURITY DEFINER, внутри проверяют токен.
grant execute on function public.submit_payment(
  text, text, numeric, text, date, text, text, boolean, text, text, jsonb) to anon, authenticated;
grant execute on function public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text, jsonb) to anon, authenticated;
