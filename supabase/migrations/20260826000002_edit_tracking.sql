-- Правка заявки бухгалтером: журнал и «кто менял».
--
-- Раньше содержимое заявки менял только сам клиент через RPC. Теперь править
-- сможет и бухгалтер, включая суммы уже оплаченных платежей. Две вещи, без
-- которых это опасно:
--   1) журнал фиксировал лишь смену статуса — изменение суммы не оставляло следа;
--   2) уведомление о правке должно уходить в нужную сторону, а для этого надо
--      знать, кто правил: клиент (anon по токену) или сотрудник (authenticated).

-- ---------------------------------------------------------------------------
-- Что считаем «изменением содержимого». Одно определение на два триггера,
-- чтобы они не разъехались.
-- ---------------------------------------------------------------------------
create or replace function public.payment_content_changed(o public.payments, n public.payments)
returns boolean language sql immutable as $$
  select o.payee        is distinct from n.payee
      or o.amount       is distinct from n.amount
      or o.requisites   is distinct from n.requisites
      or o.due          is distinct from n.due
      or o.recurrence   is distinct from n.recurrence
      or o.purpose      is distinct from n.purpose
      or o.need_receipt is distinct from n.need_receipt
      or o.files        is distinct from n.files;
$$;

-- ---------------------------------------------------------------------------
-- Отметка, кто последним менял содержимое. Ставит БД, а не фронт: значение из
-- JWT подделать из браузера нельзя, а поле, которое заполняет клиентский код,
-- рано или поздно разъедется с реальностью.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists last_edit_role text,
  add column if not exists last_edit_at   timestamptz;

create or replace function public.stamp_payment_editor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_claims jsonb;
begin
  if not payment_content_changed(old, new) then
    return new;   -- смена статуса и обновление флагов уведомлений — не правка
  end if;
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then v_claims := null;
  end;
  new.last_edit_role := coalesce(v_claims ->> 'role', 'unknown');
  new.last_edit_at   := now();
  return new;
end; $$;

drop trigger if exists trg_payments_stamp_editor on public.payments;
create trigger trg_payments_stamp_editor
  before update on public.payments
  for each row execute function public.stamp_payment_editor();

-- ---------------------------------------------------------------------------
-- Журнал: записываем и правки содержимого — что именно поменялось.
-- ---------------------------------------------------------------------------
alter table public.payments_audit
  add column if not exists changes jsonb;

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
    insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role)
    values (old.id, old.client_id, 'DELETE', old.status, null, v_uid, v_role);
    return old;

  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into payments_audit(payment_id, client_id, action, old_status, new_status, changed_by, changed_role)
      values (new.id, new.client_id, 'UPDATE', old.status, new.status, v_uid, v_role);
    end if;

    if payment_content_changed(old, new) then
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

-- normalize_files вызывается только изнутри SECURITY DEFINER функций, то есть от
-- имени владельца — снаружи она не нужна (см. правило про PUBLIC в CLAUDE.md).
revoke all on function public.normalize_files(jsonb, text, text) from public, anon, authenticated;

-- Триггерным функциям права намеренно не трогаем: PostgreSQL не проверяет
-- EXECUTE при срабатывании триггера, а ошибка здесь уронила бы вставку заявок.
