-- Жёлтые находки ревью, не попавшие в этапы (docs/FIXPLAN.md, таблица
-- «Жёлтые, которые в этапы не попали»). Серверная часть:
--
--   M2.2  проверка суммы, длины полей и периодичности — во всех дверях сразу
--   M1.4  копия повторяющегося платежа помнит исходную заявку (parent_id)
--   M7.2  вопрос клиенту по закрытой заявке не задаётся
--   M7.3  общий потолок в 10 файлов и для ответов в переписке
--   M2.4  правка без смены даты дату не двигает
--   M9.1  админ меняет бухгалтера клиента
--   M9.2  админ переименовывает клиента — имя доезжает до его заявок
--
-- Плюс найденное по ходу: утреннее письмо админу с десятками заявок упиралось
-- в лимит Telegram 4096 символов и не уходило целиком, молча.

-- ---------------------------------------------------------------------------
-- M2.2. Проверка полей заявки
--
-- Раньше сумма и длина проверялись только формой (min="1") и ботом, а RPC
-- принимали что угодно: заявка на −5000, получатель в 20 000 символов. Второе
-- хуже, чем выглядит: уведомление о новой заявке не пролезает в лимит Telegram
-- и не уходит никому.
--
-- Проверка — триггером, а не в каждой RPC: заявка попадает в базу через
-- submit_payment, edit_payment_by_token, бот и прямую запись сотрудника
-- (форма, копия повторяющегося платежа). Одна проверка на все двери — как
-- is_safe_file_url.
--
-- На UPDATE проверяем, только если менялось содержание. Иначе старая заявка,
-- заведённая до проверки с кривым полем, перестала бы переводиться по статусам:
-- «Отметить оплаченным» падало бы на чужой давней ошибке.
-- ---------------------------------------------------------------------------
create or replace function public.validate_payment_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and not payment_content_changed(old, new) then
    return new;
  end if;

  if new.amount is null or new.amount <= 0 then
    raise exception 'Сумма должна быть больше нуля';
  end if;
  if new.amount >= 1000000000000 then
    raise exception 'Слишком большая сумма';
  end if;
  if btrim(coalesce(new.payee, '')) = '' then
    raise exception 'Укажите получателя';
  end if;
  if length(new.payee) > 200 then
    raise exception 'Получатель длиннее 200 символов';
  end if;
  if length(coalesce(new.requisites, '')) > 1000 then
    raise exception 'Реквизиты длиннее 1000 символов';
  end if;
  if length(coalesce(new.purpose, '')) > 1000 then
    raise exception 'Назначение длиннее 1000 символов';
  end if;
  if new.recurrence is null or new.recurrence not in ('once', 'weekly', 'monthly') then
    raise exception 'Неизвестная периодичность: %', coalesce(new.recurrence, 'пусто');
  end if;

  return new;
end; $$;

drop trigger if exists trg_payments_validate on public.payments;
create trigger trg_payments_validate
  before insert or update on public.payments
  for each row execute function public.validate_payment_fields();

-- ---------------------------------------------------------------------------
-- M1.4. Копия повторяющегося платежа помнит, от какой заявки она создана
--
-- «Отменить оплату» убирала следующий платёж, найденный по совпадению клиента,
-- получателя, суммы и даты. Совпасть могла заявка, которую клиент завёл сам, —
-- удалялась она. А если клиент поправил сумму в копии, та не находилась и
-- оставался дубль.
--
-- Внешнего ключа намеренно нет: ON DELETE SET NULL превратил бы удаление
-- исходной заявки в UPDATE копии, а на UPDATE висит вебхук уведомлений.
-- Ссылка нужна только для поиска, битая ссылка ничего не ломает.
-- ---------------------------------------------------------------------------
alter table public.payments add column if not exists parent_id text;
create index if not exists payments_parent_id_idx
  on public.payments (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- M7.2. Вопрос по закрытой заявке не задаётся
--
-- Клиент на него ответить не может (reply_by_token отказывает на 'sent', бот
-- пишет «уже закрыта»), а бухгалтер видел «ждём ответа» и напоминал в пустоту.
-- Решение владельца 16.09: закрыто — значит закрыто, как и с документом задним
-- числом. Тело повторяет 20260909000001_payment_thread.sql, изменение помечено.
-- ---------------------------------------------------------------------------
create or replace function public.post_staff_message(
  p_id text, p_text text, p_kind text default 'question'
) returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_text   text;
  v_author text;
  v_kind   text := coalesce(p_kind, 'question');
  v_len    int;
  v_status text;
  v_msg    jsonb;
begin
  v_text := btrim(coalesce(p_text, ''));
  if v_text = '' then
    raise exception 'Пустое сообщение';
  end if;
  if length(v_text) > 1000 then
    raise exception 'Сообщение длиннее 1000 символов';
  end if;
  if v_kind not in ('question', 'reminder') then
    raise exception 'Неизвестный тип сообщения: %', v_kind;
  end if;

  select name into v_author from staff where id = auth.uid();
  if v_author is null then
    raise exception 'Писать клиенту может только сотрудник';
  end if;

  select jsonb_array_length(thread), status into v_len, v_status from payments where id = p_id;
  if v_len is null then
    raise exception 'Заявка не найдена или не ваша';
  end if;
  -- M7.2
  if v_status = 'sent' then
    raise exception 'Заявка закрыта — клиент ответить по ней уже не сможет';
  end if;
  -- Потолок на переписку. Она лежит в строке заявки и растёт без ограничений,
  -- а половина записей приходит с анонимной стороны (reply_by_token).
  if v_len >= 100 then
    raise exception 'В переписке уже 100 сообщений — дальше только по телефону';
  end if;

  v_msg := jsonb_build_object(
    'id',     gen_random_uuid()::text,
    'who',    'staff',
    'kind',   v_kind,
    'text',   v_text,
    'author', v_author,
    'files',  '[]'::jsonb,
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  update payments set thread = thread || jsonb_build_array(v_msg) where id = p_id;
  if not found then
    raise exception 'Заявка не найдена или не ваша';
  end if;

  return v_msg;
end; $$;

revoke all on function public.post_staff_message(text, text, text) from public, anon;
grant execute on function public.post_staff_message(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- M7.3. Общий потолок в 10 файлов и для ответов
--
-- Ответ клиента дописывал файлы к заявке без оглядки на то, сколько их уже.
-- После пары ответов их становилось 12, и следующая правка заявки клиентом
-- падала в normalize_files на «слишком много файлов» — хотя сам он ничего не
-- добавлял. Тело повторяет 20260910000001_url_scheme_and_html_escape.sql,
-- изменение помечено M7.3.
-- ---------------------------------------------------------------------------
create or replace function public.reply_by_token(
  p_token text, p_id text, p_text text, p_files jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client clients;
  v_pay    payments;
  v_text   text;
  v_files  jsonb;
  v_msg    jsonb;
begin
  perform check_rate_limit(p_token, 'reply', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  select * into v_pay from payments where id = p_id and client_id = v_client.id;
  if v_pay.id is null then
    raise exception 'Заявка не найдена';
  end if;
  -- Закрытая заявка закрыта: дописывать в неё задним числом нельзя — тем же
  -- правилом мы отказались от «попросить документ потом».
  if v_pay.status = 'sent' then
    raise exception 'Заявка закрыта — ответить по ней уже нельзя';
  end if;

  v_text  := btrim(coalesce(p_text, ''));
  v_files := coalesce(p_files, '[]'::jsonb);
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Файлы должны быть массивом';
  end if;
  if v_text = '' and jsonb_array_length(v_files) = 0 then
    raise exception 'Пустой ответ';
  end if;
  if length(v_text) > 1000 then
    raise exception 'Сообщение длиннее 1000 символов';
  end if;
  if jsonb_array_length(v_files) > 10 then
    raise exception 'Не больше 10 файлов за раз';
  end if;
  if jsonb_array_length(v_pay.thread) >= 100 then
    raise exception 'В переписке уже 100 сообщений — дальше только по телефону';
  end if;

  -- оставляем только url и name: что бы ни прислал браузер, в заявку попадёт
  -- ровно та же форма, что кладёт submit_payment
  select coalesce(jsonb_agg(jsonb_build_object(
           'url',  e ->> 'url',
           'name', coalesce(nullif(btrim(coalesce(e ->> 'name', '')), ''), 'файл')
         )), '[]'::jsonb)
    into v_files
    from jsonb_array_elements(v_files) e
   where coalesce(e ->> 'url', '') <> '';

  -- M7.3: тот же предел, что у заявки в normalize_files, — считаем вместе с уже
  -- приложенными. Текст ответа без файлов проходит всегда.
  if jsonb_array_length(v_files) > 0
     and jsonb_array_length(coalesce(v_pay.files, '[]'::jsonb)) + jsonb_array_length(v_files) > 10 then
    raise exception 'В заявке уже % файлов из 10 — приложить ещё % не получится. Напишите ответ текстом или уберите лишние файлы в заявке',
      jsonb_array_length(coalesce(v_pay.files, '[]'::jsonb)), jsonb_array_length(v_files);
  end if;

  -- M2.1: файл из ответа ложится во вложения заявки и оттуда попадает в href
  if exists (select 1 from jsonb_array_elements(v_files) e
              where not is_safe_file_url(e ->> 'url')) then
    raise exception 'Недопустимая ссылка на файл';
  end if;

  v_msg := jsonb_build_object(
    'id',     gen_random_uuid()::text,
    'who',    'client',
    'kind',   'reply',
    'text',   v_text,
    'author', v_client.name,
    'files',  v_files,
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  update payments p set
    thread    = p.thread || jsonb_build_array(v_msg),
    files     = p.files  || v_files,
    -- зеркало трогаем только если файлы реально пришли: у старых заявок files
    -- пуст, а file_url заполнен, и обнулить его значит потерять вложение
    file_url  = case when jsonb_array_length(v_files) > 0
                     then (p.files || v_files) -> 0 ->> 'url'  else p.file_url  end,
    file_name = case when jsonb_array_length(v_files) > 0
                     then (p.files || v_files) -> 0 ->> 'name' else p.file_name end
  where p.id = p_id;

  return v_msg;
end; $$;

revoke all on function public.reply_by_token(text, text, text, jsonb) from public;
grant execute on function public.reply_by_token(text, text, text, jsonb)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M2.4. Правка без смены даты дату не двигает
--
-- Клиент в 17:30 правил назначение у сегодняшней заявки — adjust_due_date
-- молча уносила её на следующий рабочий день. Он дату не трогал и переноса не
-- видел. Решение владельца 16.09: дату, которую человек не менял, оставляем как
-- есть; перенос работает, только когда дату выбрали заново (и форма заранее
-- говорит, куда она уедет).
--
-- Тело повторяет 20260826000001_multi_files.sql, сигнатура та же. Прежние
-- защиты на месте: лимит частоты, status = 'new', created_by_staff is null.
-- ---------------------------------------------------------------------------
create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text, p_files jsonb default null
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_due date; v_old_due date; v_files jsonb;
begin
  perform check_rate_limit(p_token, 'edit', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  -- M2.4
  select due into v_old_due from payments where id = p_id and client_id = v_client.id;
  if p_due is not distinct from v_old_due then
    v_due := v_old_due;
  else
    v_due := adjust_due_date(p_due);
  end if;

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

grant execute on function public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- M9.1 + M9.2. Админ меняет бухгалтера и название клиента
--
-- Раньше и то и другое делалось только SQL-запросом, а название к тому же
-- расходилось: payments.client хранит копию имени, которую читают очередь
-- (фильтр по клиенту), выгрузка, бот, уведомления и утреннее письмо.
--
-- Бухгалтер. Меняется одна колонка clients.staff_id, заявки не трогаются:
-- видимость в очереди считается по ней (политики pay_staff_*), так что вся
-- история клиента уходит к новому бухгалтеру сама. Прежний бухгалтер сохраняет
-- только заявки, которые завёл сам (created_by_staff).
--
-- Название. Копия имени в заявках переписывается здесь же. Тонкость: на UPDATE
-- заявки висит вебхук notify-client, а он «допосылает при следующем касании»
-- всё, что по заявке раньше не дошло, — документы, вопросы. Клиент, недавно
-- привязавший бота, получил бы при переименовании пачку старых сообщений по
-- всем своим заявкам. Поэтому на время этого UPDATE вебхуки на payments
-- выключаются. ALTER TABLE транзакционен: другие сессии выключения не видят, а
-- их записи в payments ждут конца транзакции и вебхук получают. Ищем вебхуки
-- по функции supabase_functions.http_request, а не по имени — имя задаётся
-- вручную в scripts/webhooks.sql.
--
-- Журнал и last_edit_role переименование не задевает: payment_content_changed
-- колонку client не смотрит.
-- ---------------------------------------------------------------------------
create or replace function public.update_client(p_id uuid, p_name text, p_staff_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_client clients;
  v_name   text := btrim(coalesce(p_name, ''));
  v_hooks  text[];
  v_hook   text;
begin
  if not is_admin() then
    raise exception 'Менять клиента может только администратор';
  end if;

  select * into v_client from clients where id = p_id;
  if v_client.id is null then
    raise exception 'Клиент не найден';
  end if;
  if v_name = '' then
    raise exception 'Укажите название компании';
  end if;
  if length(v_name) > 200 then
    raise exception 'Название длиннее 200 символов';
  end if;
  if p_staff_id is null or not exists (select 1 from staff where id = p_staff_id) then
    raise exception 'Выберите бухгалтера из списка сотрудников';
  end if;

  update clients set name = v_name, staff_id = p_staff_id where id = p_id;

  if v_name is distinct from v_client.name then
    select coalesce(array_agg(t.tgname), '{}') into v_hooks
      from pg_trigger t
      join pg_proc p      on p.oid = t.tgfoid
      join pg_namespace n on n.oid = p.pronamespace
     where t.tgrelid = 'public.payments'::regclass
       and not t.tgisinternal
       and t.tgenabled <> 'D'
       and n.nspname = 'supabase_functions' and p.proname = 'http_request';

    foreach v_hook in array v_hooks loop
      execute format('alter table public.payments disable trigger %I', v_hook);
    end loop;

    update payments set client = v_name
     where client_id = p_id and client is distinct from v_name;

    foreach v_hook in array v_hooks loop
      execute format('alter table public.payments enable trigger %I', v_hook);
    end loop;
  end if;
end; $$;

revoke all on function public.update_client(uuid, text, uuid) from public, anon;
grant execute on function public.update_client(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Утреннее письмо не должно упираться в лимит Telegram
--
-- Найдено по ходу M2.2. Письмо собирается одним сообщением, а у Telegram
-- предел 4096 символов. Админ получает заявки всех клиентов; двадцать заявок с
-- назначением и ссылкой на файл этот предел переходят — и Telegram отвергает
-- письмо целиком. Ответ оседает в net._http_response, журнал notify_failures
-- его не видит: утром просто ничего не приходит.
--
-- Теперь назначение в письме обрезается до 150 символов, а когда текст
-- подходит к пределу, оставшиеся заявки не расписываются, а считаются:
-- «…и ещё N — полный список в приложении». Порядок прежний — по сумме,
-- крупные наверху. Остальное тело повторяет 20260914000001_addressed_notifications.sql.
-- ---------------------------------------------------------------------------
create or replace function public.daily_reminder_message(p_staff_id uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  rec      record;
  msg      text;
  item     text;
  today    text;
  cnt      int := 0;
  shown    int := 0;
  v_admin  boolean := false;
begin
  if p_staff_id is not null then
    select coalesce(is_admin, false) into v_admin from staff where id = p_staff_id;
  end if;

  today := to_char(now() at time zone 'Europe/Minsk', 'YYYY-MM-DD');
  msg := '📅 <b>Платежи на ' || to_char(now() at time zone 'Europe/Minsk', 'DD.MM.YYYY') || '</b>'
      || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.client, p.purpose, p.file_url, p.file_name
    from payments p
    left join clients c on c.id = p.client_id
    where p.due::text = today
      and p.status in ('new', 'in_progress')
      and (
        -- заявка клиента: бухгалтеру только его, админу и запасному письму — все
        (p.client_id is not null
         and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
        -- личная задача — только автору
        or (p.client_id is null
            and p_staff_id is not null and p.created_by_staff = p_staff_id)
      )
    order by p.amount desc
  loop
    cnt := cnt + 1;
    item := cnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || to_char(rec.amount, 'FM999999999.00') || ' Br' || chr(10)
      || '   👤 ' || tg_esc(coalesce(nullif(rec.client, ''), '—')) || chr(10)
      || case when rec.purpose is not null and rec.purpose <> ''
              then '   📝 ' || tg_esc(case when length(rec.purpose) > 150
                                            then left(rec.purpose, 150) || '…'
                                            else rec.purpose end) || chr(10)
              else '' end
      -- ссылку в href пускаем только проверенную: у старых заявок в file_url
      -- может лежать что угодно, они завелись до этой проверки
      || case when is_safe_file_url(rec.file_url)
              then '   📎 <a href="' || rec.file_url || '">'
                   || tg_esc(coalesce(nullif(rec.file_name, ''), 'файл')) || '</a>' || chr(10)
              else '' end
      || chr(10);

    -- 3500, а не 4096: запас на хвост письма и на то, что Telegram считает
    -- длину по-своему. Заявки после предела только считаем.
    if shown = cnt - 1 and length(msg) + length(item) <= 3500 then
      msg := msg || item;
      shown := cnt;
    end if;
  end loop;

  if cnt = 0 then
    msg := msg || 'Нет платежей на сегодня 🎉';
  else
    if shown < cnt then
      msg := msg || '…и ещё ' || (cnt - shown) || ' — полный список в приложении' || chr(10) || chr(10);
    end if;
    msg := msg || '💼 Всего: ' || cnt;
  end if;

  return msg;
end; $$;

revoke all on function public.daily_reminder_message(uuid) from public, anon, authenticated;
