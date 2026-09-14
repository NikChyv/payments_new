-- Принадлежность заявки и след удаления в журнале.
--
-- Этап 4 плана docs/FIXPLAN.md, серверная часть — M6.3 и M6.4.

-- ---------------------------------------------------------------------------
-- M6.3. Бухгалтер не может «увести» чужую заявку в личные
--
-- Политика pay_staff_update в with check пропускает строку, у которой
-- `client_id is null and created_by_staff = auth.uid()`. Значит бухгалтер из
-- консоли браузера мог выполнить
--   sb.from('payments').update({client_id: null, created_by_staff: <свой id>})
-- и превратить заявку клиента в свою личную: она пропадала из очереди коллег и
-- из кабинета клиента, у админа висела как «Личное». В журнале — EDIT, где
-- client_id не упоминается вовсе.
--
-- Политику не трогаем: она описывает, КТО может менять строку, и в этом права.
-- Не хватало правила, ЧТО в строке менять нельзя, — это триггер. Клиента и
-- автора заявки меняет только админ.
--
-- Проверяем именно вошедшего сотрудника. Служебные пути менять владельцев
-- вправе: функции и бот ходят под service_role, SQL Editor — без JWT вовсе,
-- а каскад ON DELETE SET NULL при удалении сотрудника тоже приходит сюда
-- UPDATE'ом. Фронт эти две колонки после создания заявки не пишет никогда
-- (updateContentRemote, changeStatusRemote, attachDocRemote их не содержат),
-- так что законные действия бухгалтера триггер не задевает.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_ownership()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if new.client_id        is not distinct from old.client_id
     and new.created_by_staff is not distinct from old.created_by_staff then
    return new;
  end if;

  begin
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then v_role := null;
  end;

  if v_role = 'authenticated' and not is_admin() then
    raise exception 'Менять клиента или автора заявки может только администратор';
  end if;

  return new;
end; $$;

drop trigger if exists trg_payments_guard_ownership on public.payments;
create trigger trg_payments_guard_ownership
  before update on public.payments
  for each row execute function public.guard_payment_ownership();

-- ---------------------------------------------------------------------------
-- M6.4. Удаление заявки оставляет в журнале снимок строки
--
-- На DELETE log_payment_change писала только id, клиента и статус. Бухгалтеру
-- политика разрешает удалить и оплаченную заявку — и после этого в журнале не
-- оставалось ни суммы, ни получателя, ни файлов. «Правка суммы оплаченного
-- платежа без следа» была закрыта ещё 26.08, «удаление без следа» — нет.
--
-- Запрещать удаление не стали: ошибочно заведённую заявку бухгалтеру удалять
-- нужно, и это его обычная работа. Вместо запрета — полный снимок строки в
-- changes, под ключом `deleted`, чтобы его нельзя было спутать с парами
-- «было → стало» у EDIT. Удаления редки, так что целая строка, включая
-- переписку, журнал не раздует.
--
-- Функция пересоздаётся целиком — тело повторяет 20260826000002_edit_tracking.sql,
-- меняется только ветка DELETE. Сигнатура та же, триггеры на неё уже ссылаются.
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
