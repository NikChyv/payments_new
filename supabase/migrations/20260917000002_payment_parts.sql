-- Оплата по частям (редизайн, шаг 4). Решения — docs/REDESIGN.md §5а.
--
-- Частичная оплата — не статус, а число. Пока остаток больше нуля, заявка
-- «в работе»: иначе «оплачено» ушло бы клиенту после первой части и копия
-- повторяющегося платежа создалась бы раньше срока. Заявка одна, ничего не
-- пересоздаётся: части копятся в payments.parts, сумма оплаченного — в
-- paid_amount, сумма заявки остаётся исходной (переплата разрешена).
--
-- Менять части может только pay_part / undo_part. Прямой update от
-- бухгалтера (фронт пишет заявку точечными update) их не пропустит —
-- сторож ниже. Иначе отставшая вкладка или консоль браузера перезаписали бы
-- историю частей, а по ней считаются остаток, утреннее письмо и уведомления.

alter table public.payments
  add column if not exists parts jsonb not null default '[]'::jsonb,
  add column if not exists paid_amount numeric not null default 0,
  -- сколько частей уже сообщено клиенту — как client_docs_notified:
  -- не дошло сейчас, notify-client допошлёт при следующем касании заявки
  add column if not exists client_parts_notified int not null default 0;

-- ---------------------------------------------------------------------------
-- Сторож частей.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_parts()
returns trigger language plpgsql set search_path = public as $$
declare
  v_role text;
  v_sum  numeric;
begin
  begin
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then v_role := null;
  end;

  if tg_op = 'INSERT' then
    -- новая заявка (форма, клиент, копия повторяющегося) начинается без частей
    if v_role in ('authenticated', 'anon')
       and (new.parts <> '[]'::jsonb or new.paid_amount <> 0) then
      raise exception 'Части оплаты записываются только через pay_part';
    end if;
  elsif (new.parts is distinct from old.parts or new.paid_amount is distinct from old.paid_amount)
        and v_role in ('authenticated', 'anon')
        and coalesce(current_setting('app.parts_rpc', true), '') <> 'on' then
    raise exception 'Части оплаты меняются только через pay_part / undo_part';
  end if;

  -- Инвариант для всех путей, включая SQL Editor и service_role: оплачено
  -- ровно столько, сколько в частях. Разойдись они — остаток в очереди,
  -- утреннем письме и уведомлении клиенту врал бы молча.
  if jsonb_typeof(new.parts) <> 'array' then
    raise exception 'parts должен быть массивом';
  end if;
  select coalesce(sum((e ->> 'amount')::numeric), 0) into v_sum
    from jsonb_array_elements(new.parts) e;
  if v_sum is distinct from new.paid_amount then
    raise exception 'paid_amount (%) не совпадает с суммой частей (%)', new.paid_amount, v_sum;
  end if;
  return new;
end; $$;

drop trigger if exists trg_payments_guard_parts on public.payments;
create trigger trg_payments_guard_parts
  before insert or update on public.payments
  for each row execute function public.guard_payment_parts();

-- ---------------------------------------------------------------------------
-- Журнал: часть и её отмена — свои записи PART / PART_UNDO.
--
-- Пишет их тот же триггер, что и остальной журнал, а не RPC: RPC работает с
-- правами бухгалтера, а писать в payments_audit ему нельзя. Заодно в журнал
-- попадёт и ручная правка частей из SQL Editor.
--
-- pay_part меняет дату остатка, и payment_content_changed видит это как
-- правку — без оговорки на одно действие легли бы две записи: PART и EDIT
-- «дата было → стало». Дата уже есть в PART, поэтому EDIT при изменении
-- частей не пишем. Функция целиком повторяет 20260914000002, кроме этого.
-- ---------------------------------------------------------------------------
create or replace function public.log_payment_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_claims  jsonb;
  v_uid     uuid;
  v_role    text;
  v_changes jsonb;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then v_claims := null;
  end;
  begin
    v_uid := nullif(v_claims ->> 'sub', '')::uuid;
  exception when others then v_uid := null;
  end;
  v_role := v_claims ->> 'role';

  if tg_op = 'INSERT' then
    insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role)
    values (new.id, new.client_id, 'INSERT', null, new.status, v_uid, v_role);
    return new;

  elsif tg_op = 'DELETE' then
    -- M6.4: снимок всей строки, иначе удалённый платёж восстановить не из чего
    insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role, changes)
    values (old.id, old.client_id, 'DELETE', old.status, null, v_uid, v_role,
            jsonb_build_object('deleted', to_jsonb(old)));
    return old;

  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role)
      values (new.id, new.client_id, 'UPDATE', old.status, new.status, v_uid, v_role);
    end if;

    if old.parts is distinct from new.parts then
      insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role, changes)
      values (new.id, new.client_id,
              case when new.paid_amount >= old.paid_amount then 'PART' else 'PART_UNDO' end,
              old.status, new.status, v_uid, v_role,
              jsonb_build_object(
                'amount', abs(new.paid_amount - old.paid_amount),
                'paid',   jsonb_build_array(old.paid_amount, new.paid_amount),
                'due',    jsonb_build_array(old.due, new.due)));
    elsif payment_content_changed(old, new) then
      -- только реально изменившиеся поля, парами «было → стало»
      v_changes := '{}'::jsonb;
      if old.payee        is distinct from new.payee        then v_changes := v_changes || jsonb_build_object('payee',        jsonb_build_array(old.payee, new.payee)); end if;
      if old.amount       is distinct from new.amount       then v_changes := v_changes || jsonb_build_object('amount',       jsonb_build_array(old.amount, new.amount)); end if;
      if old.requisites   is distinct from new.requisites   then v_changes := v_changes || jsonb_build_object('requisites',   jsonb_build_array(old.requisites, new.requisites)); end if;
      if old.due          is distinct from new.due          then v_changes := v_changes || jsonb_build_object('due',          jsonb_build_array(old.due, new.due)); end if;
      if old.recurrence   is distinct from new.recurrence   then v_changes := v_changes || jsonb_build_object('recurrence',   jsonb_build_array(old.recurrence, new.recurrence)); end if;
      if old.purpose      is distinct from new.purpose      then v_changes := v_changes || jsonb_build_object('purpose',      jsonb_build_array(old.purpose, new.purpose)); end if;
      if old.need_receipt is distinct from new.need_receipt then v_changes := v_changes || jsonb_build_object('need_receipt', jsonb_build_array(old.need_receipt, new.need_receipt)); end if;
      if old.files        is distinct from new.files        then v_changes := v_changes || jsonb_build_object('files',        jsonb_build_array(jsonb_array_length(old.files), jsonb_array_length(new.files))); end if;

      insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role, changes)
      values (new.id, new.client_id, 'EDIT', old.status, new.status, v_uid, v_role, v_changes);
    end if;
    return new;
  end if;
  return null;
end; $$;

-- ---------------------------------------------------------------------------
-- pay_part: бухгалтер вводит ОПЛАЧЕННУЮ сумму, остаток считается сам.
--
-- security invoker: чужую заявку бухгалтер не увидит и не обновит — работает
-- обычный RLS, как у post_staff_message.
--
-- p_seen_paid — сколько было оплачено на экране в момент нажатия. Не совпало —
-- часть успел записать кто-то другой, и вторая запись поверх неё задвоила бы
-- оплату. Та же схема, что .eq("status", <что видел>) у смены статуса.
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

revoke all on function public.pay_part(text, numeric, date, numeric) from public, anon;
grant execute on function public.pay_part(text, numeric, date, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- undo_part: «Отменить оплату» при частях отменяет ПОСЛЕДНЮЮ часть.
--
-- p_part_id — какую часть человек видел последней. Не совпала с последней в
-- базе — между отрисовкой и нажатием записали ещё одну, и отменили бы не ту.
-- По закрытой (sent) заявке — отказ: сначала «Вернуть в «Оплачено»», иначе
-- заявка с отправленным документом тихо вернулась бы в работу.
-- Документы, привязанные к отменённой части, не удаляем — снимаем привязку.
-- ---------------------------------------------------------------------------
create or replace function public.undo_part(p_id text, p_part_id text)
returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  r        payments%rowtype;
  v_n      int;
  v_last   jsonb;
  v_paid   numeric;
  v_due    date;
  v_status text;
begin
  if not exists (select 1 from staff where id = auth.uid()) then
    raise exception 'Отменять оплату может только сотрудник';
  end if;

  select * into r from payments where id = p_id for update;
  if not found then
    raise exception 'Заявка не найдена или не ваша';
  end if;
  if r.status = 'sent' then
    raise exception 'Заявка закрыта — сначала верните её в «Оплачено»';
  end if;

  v_n := jsonb_array_length(r.parts);
  if v_n = 0 then
    raise exception 'У заявки нет частей оплаты';
  end if;
  v_last := r.parts -> (v_n - 1);
  if (v_last ->> 'id') is distinct from p_part_id then
    raise exception 'Отменить можно только последнюю часть — обновите экран';
  end if;

  v_paid   := r.paid_amount - (v_last ->> 'amount')::numeric;
  v_due    := (v_last ->> 'due_before')::date;   -- прошлую дату не переносим
  v_status := case when r.status = 'paid' then 'in_progress' else r.status end;

  perform set_config('app.parts_rpc', 'on', true);
  update payments
     set parts       = parts - (v_n - 1),
         paid_amount = v_paid,
         due         = v_due,
         status      = v_status,
         staff_files = (
           select coalesce(jsonb_agg(case when f ->> 'part_id' = p_part_id then f - 'part_id' else f end
                                     order by i), '[]'::jsonb)
             from jsonb_array_elements(r.staff_files) with ordinality as t(f, i))
   where id = p_id;
  perform set_config('app.parts_rpc', '', true);

  return jsonb_build_object('paid_amount', v_paid, 'left', greatest(r.amount - v_paid, 0),
                            'due', v_due, 'status', v_status);
end; $$;

revoke all on function public.undo_part(text, text) from public, anon;
grant execute on function public.undo_part(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Утреннее письмо — по остатку. Бухгалтер несёт в банк остаток, а не полную
-- сумму заявки; у частично оплаченной показываем и сколько из скольких.
-- Функция целиком повторяет 20260916000001, кроме суммы и порядка.
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
    select p.payee, p.amount, p.paid_amount,
           greatest(p.amount - p.paid_amount, 0) as left_amount,
           p.client, p.purpose, p.file_url, p.file_name
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
    order by greatest(p.amount - p.paid_amount, 0) desc
  loop
    cnt := cnt + 1;
    item := cnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || to_char(rec.left_amount, 'FM999999999.00') || ' Br'
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
