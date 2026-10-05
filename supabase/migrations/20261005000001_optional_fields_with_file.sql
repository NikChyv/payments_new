-- С приложенным документом получатель, сумма и дата необязательны (05.10).
--
-- Клиент присылает счёт, в котором всё уже написано, и не хочет перепечатывать
-- получателя и сумму руками — а форма и база этого требовали. Решение
-- владельца 05.10: приложен хотя бы один файл — эти три поля можно не
-- заполнять; файла нет — обязательны, как раньше. Заявку без суммы бухгалтер
-- может оплатить как есть, вписывать сумму не обязан. Бот не меняется: там
-- файл спрашивается последним шагом.
--
-- Что куда пишется, когда поле пустое:
--   • получатель — «По документу: <имя первого файла>». Пустым не оставляем:
--     по получателю заявку называют в очереди, поиске и каждом уведомлении;
--   • дата — ближайший рабочий день (adjust_due_date от сегодня);
--   • сумма — NULL, «неизвестна». Ноль не годится: он попал бы в итоги как
--     настоящая сумма и в «на 0,00 Br оплачен» клиенту.
--
-- Правило — в триггере проверки, а не в RPC: заявка попадает в базу через
-- submit_payment, edit_payment_by_token и прямую запись сотрудника, дверь
-- должна быть одна (как и в 20260916000001).
--
-- Копия повторяющегося платежа (parent_id) наследует «сумма неизвестна» без
-- файлов: файлы в копию не переносятся, и без этой оговорки она молча не
-- создавалась бы.

create or replace function public.validate_payment_fields()
returns trigger language plpgsql set search_path = public as $$
declare
  v_has_files boolean := jsonb_typeof(new.files) = 'array' and jsonb_array_length(new.files) > 0;
begin
  if tg_op = 'UPDATE' and not payment_content_changed(old, new) then
    return new;
  end if;

  if new.amount is null then
    if not v_has_files and new.parent_id is null then
      raise exception 'Укажите сумму или приложите документ';
    end if;
  elsif new.amount <= 0 then
    raise exception 'Сумма должна быть больше нуля';
  elsif new.amount >= 1000000000000 then
    raise exception 'Слишком большая сумма';
  end if;

  if btrim(coalesce(new.payee, '')) = '' then
    if not v_has_files then
      raise exception 'Укажите получателя или приложите документ';
    end if;
    new.payee := left('По документу: ' || coalesce(nullif(btrim(new.files -> 0 ->> 'name'), ''), 'файл'), 200);
  end if;
  if length(new.payee) > 200 then
    raise exception 'Получатель длиннее 200 символов';
  end if;

  if new.due is null then
    if not v_has_files then
      raise exception 'Укажите дату платежа или приложите документ';
    end if;
    new.due := adjust_due_date((now() at time zone 'Europe/Minsk')::date);
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

-- ---------------------------------------------------------------------------
-- RPC клиента: пустая сумма — NULL, а не 0. Раньше coalesce(p_amount, 0)
-- превращал «не указано» в ноль, и триггер отвечал «сумма должна быть больше
-- нуля». Ноль от старого фронта и бота — тоже «не указано»: решает триггер.
-- Остальное тело — как в 20260826000001 / 20260916000001.
-- ---------------------------------------------------------------------------
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

  v_due   := adjust_due_date(p_due);   -- null остаётся null: дату поставит триггер
  v_files := normalize_files(p_files, p_file_url, p_file_name);

  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name, files,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, nullif(p_amount, 0), p_requisites, v_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,false),
          v_files -> 0 ->> 'url', v_files -> 0 ->> 'name', v_files,
          v_client.id, now());
  return v_id;
end; $$;

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
    amount       = nullif(p_amount, 0),
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

-- ---------------------------------------------------------------------------
-- Оплата по частям при неизвестной сумме невозможна — остаток не посчитать.
-- Тело повторяет 20260917000002, добавлен один отказ.
-- ---------------------------------------------------------------------------
create or replace function public.pay_part(
  p_id text, p_amount numeric, p_new_due date, p_seen_paid numeric
) returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  r        payments%rowtype;
  v_by     text;
  v_paid   numeric;
  v_left   numeric;
  v_due    date;
  v_status text;
  v_part   jsonb;
begin
  select name into v_by from staff where id = auth.uid();
  if v_by is null then
    raise exception 'Отмечать оплату может только сотрудник';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Сумма части должна быть больше нуля';
  end if;

  select * into r from payments where id = p_id for update;
  if not found then
    raise exception 'Заявка не найдена или не ваша';
  end if;
  if r.status not in ('new', 'in_progress') then
    raise exception 'Заявка уже оплачена — часть не записана';
  end if;
  if p_seen_paid is distinct from r.paid_amount then
    raise exception 'Заявку тем временем изменили — обновите экран';
  end if;

  -- Без суммы заявки остаток не посчитать: «v_left > 0» на null ложно, и первая
  -- же часть закрыла бы заявку как оплаченную целиком.
  if r.amount is null then
    raise exception 'У заявки не указана сумма — впишите её («Редактировать»), и часть можно будет записать';
  end if;

  v_paid := r.paid_amount + p_amount;
  v_left := r.amount - v_paid;

  if v_left > 0 then
    if p_new_due is null then
      raise exception 'Укажите дату оплаты остатка';
    end if;
    -- рабочий график: будущий выходной — ошибка, «сегодня» после 17:00 — завтра
    v_due    := adjust_due_date(p_new_due);
    v_status := 'in_progress';
  else
    v_due    := r.due;       -- оплачено целиком: дату не трогаем
    v_status := 'paid';
  end if;

  v_part := jsonb_build_object(
    'id',         gen_random_uuid()::text,
    'amount',     p_amount,
    'at',         to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'by',         auth.uid(),
    'by_name',    v_by,
    -- дата до части: по ней отмена вернёт срок, а по due_before первой
    -- части считается следующий повторяющийся платёж (от исходной даты)
    'due_before', r.due,
    'due_after',  case when v_left > 0 then v_due end
  );

  perform set_config('app.parts_rpc', 'on', true);
  update payments
     set parts       = parts || jsonb_build_array(v_part),
         paid_amount = v_paid,
         due         = v_due,
         status      = v_status
   where id = p_id;
  perform set_config('app.parts_rpc', '', true);

  return jsonb_build_object('part', v_part, 'paid_amount', v_paid,
                            'left', greatest(v_left, 0), 'due', v_due, 'status', v_status);
end; $$;

-- ---------------------------------------------------------------------------
-- Утреннее письмо: у заявки без суммы — «сумма в документе», а не «0.00 Br».
-- Тело повторяет 20261001000001.
-- ---------------------------------------------------------------------------
create or replace function public.daily_reminder_message(p_staff_id uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  rec       record;
  msg       text;
  item      text;
  v_today   date := (now() at time zone 'Europe/Minsk')::date;
  cnt       int := 0;
  shown     int := 0;
  ocnt      int := 0;
  oshown    int := 0;
  v_overdue int;
  v_budget  int;
  v_admin   boolean := false;
begin
  if p_staff_id is not null then
    select coalesce(is_admin, false) into v_admin from staff where id = p_staff_id;
  end if;

  -- сколько просрочки, считаем заранее: от этого зависит, сколько места
  -- отдать сегодняшним
  select count(*) into v_overdue
    from payments p left join clients c on c.id = p.client_id
   where p.due < v_today
     and p.status in ('new', 'in_progress')
     and ((p.client_id is not null and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
          or (p.client_id is null and p_staff_id is not null and p.created_by_staff = p_staff_id));
  v_budget := case when v_overdue > 0 then 2900 else 3500 end;

  msg := '📅 <b>Платежи на ' || to_char(v_today, 'DD.MM.YYYY') || '</b>' || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.paid_amount,
           greatest(p.amount - p.paid_amount, 0) as left_amount,
           p.client, p.purpose, p.file_url, p.file_name
    from payments p
    left join clients c on c.id = p.client_id
    where p.due = v_today
      and p.status in ('new', 'in_progress')
      and (
        -- заявка клиента: бухгалтеру только его, админу и запасному письму — все
        (p.client_id is not null
         and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
        -- личная задача — только автору
        or (p.client_id is null
            and p_staff_id is not null and p.created_by_staff = p_staff_id)
      )
    order by greatest(p.amount - p.paid_amount, 0) desc
  loop
    cnt := cnt + 1;
    item := cnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || case when rec.amount is null then 'сумма в документе'
                       else to_char(rec.left_amount, 'FM999999999.00') || ' Br' end
      || case when rec.paid_amount > 0
              then ' (остаток из ' || to_char(rec.amount, 'FM999999999.00') || ')'
              else '' end
      || chr(10)
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

    if shown = cnt - 1 and length(msg) + length(item) <= v_budget then
      msg := msg || item;
      shown := cnt;
    end if;
  end loop;

  if cnt = 0 then
    msg := msg || case when v_overdue > 0 then 'На сегодня платежей нет.' else 'Нет платежей на сегодня 🎉' end;
  else
    if shown < cnt then
      msg := msg || '…и ещё ' || (cnt - shown) || ' — полный список в приложении' || chr(10) || chr(10);
    end if;
    msg := msg || '💼 Всего: ' || cnt;
  end if;

  if v_overdue = 0 then
    return msg;
  end if;

  msg := msg || chr(10) || chr(10) || '⚠️ <b>Просрочено: ' || v_overdue || '</b>' || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.paid_amount, p.due,
           greatest(p.amount - p.paid_amount, 0) as left_amount,
           p.client
    from payments p
    left join clients c on c.id = p.client_id
    where p.due < v_today
      and p.status in ('new', 'in_progress')
      and ((p.client_id is not null and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
           or (p.client_id is null and p_staff_id is not null and p.created_by_staff = p_staff_id))
    order by p.due, greatest(p.amount - p.paid_amount, 0) desc
  loop
    ocnt := ocnt + 1;
    item := ocnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || case when rec.amount is null then 'сумма в документе'
                       else to_char(rec.left_amount, 'FM999999999.00') || ' Br' end
      || case when rec.paid_amount > 0
              then ' (остаток из ' || to_char(rec.amount, 'FM999999999.00') || ')'
              else '' end
      || chr(10)
      || '   👤 ' || tg_esc(coalesce(nullif(rec.client, ''), '—'))
      || ' · с ' || to_char(rec.due, 'DD.MM') || ', ' || (v_today - rec.due) || ' дн.' || chr(10);

    -- 3500, а не 4096: запас на хвост письма и на то, что Telegram считает
    -- длину по-своему
    if oshown = ocnt - 1 and length(msg) + length(item) <= 3500 then
      msg := msg || item;
      oshown := ocnt;
    end if;
  end loop;

  if oshown < ocnt then
    msg := msg || '…и ещё ' || (ocnt - oshown) || ' просроченных — в приложении';
  end if;

  return rtrim(msg, chr(10));
end; $$;

revoke all on function public.daily_reminder_message(uuid) from public, anon, authenticated;
