-- Пункт 8: журнал изменений платежей. Фиксирует создание, удаление и СМЕНУ
-- статуса (кто/когда/из чего в что). No-op апдейты (web upsert всех строк)
-- не логируются — только реальные переходы статуса.

create table if not exists public.payments_audit (
  id           bigint generated always as identity primary key,
  payment_id   text,
  client_id    uuid,
  action       text not null,          -- INSERT / UPDATE / DELETE
  old_status   text,
  new_status   text,
  changed_by   uuid,                    -- auth.uid() сотрудника, если есть
  changed_role text,                    -- authenticated / anon / service_role
  changed_at   timestamptz not null default now()
);

create index if not exists payments_audit_payment_idx on public.payments_audit (payment_id, changed_at);

-- Триггер-функция. SECURITY DEFINER — пишет журнал независимо от прав вызвавшего
-- (клиент через anon-RPC, сотрудник через upsert). «Кто» берём из JWT-claims.
create or replace function public.log_payment_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_claims jsonb;
  v_uid    uuid;
  v_role   text;
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
    return new;
  end if;
  return null;
end; $$;

drop trigger if exists trg_payments_audit on public.payments;
create trigger trg_payments_audit
  after insert or update or delete on public.payments
  for each row execute function public.log_payment_change();

-- Доступ: журнал видит только админ. anon полностью закрыт (revoke + RLS).
alter table public.payments_audit enable row level security;
-- в Supabase новые public-таблицы по умолчанию доступны anon на уровне привилегий
-- (защищает только RLS) — как и для payments в Фазе 2, явно отзываем.
revoke all on public.payments_audit from anon;
drop policy if exists audit_admin_read on public.payments_audit;
create policy audit_admin_read on public.payments_audit
  for select to authenticated using (is_admin());
grant select on public.payments_audit to authenticated;
