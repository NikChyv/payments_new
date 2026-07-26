-- Заявки, созданные сотрудником: для клиента («налог оплатить до …») или
-- «для себя» (личная напоминалка без клиента).
--
-- Правила:
--  • «для себя» (client_id is null) видит только автор и админ;
--  • заявку, созданную бухгалтером, клиент видит, но НЕ редактирует.

alter table public.payments
  add column if not exists created_by_staff uuid references public.staff(id) on delete set null;

create index if not exists payments_created_by_staff_idx on public.payments (created_by_staff);

-- ---------------------------------------------------------------------------
-- RLS: к «своим клиентам» добавляем «созданное мной» (в т.ч. без клиента).
-- ---------------------------------------------------------------------------
drop policy if exists pay_staff_read   on public.payments;
drop policy if exists pay_staff_insert on public.payments;
drop policy if exists pay_staff_update on public.payments;
drop policy if exists pay_staff_delete on public.payments;

create policy pay_staff_read on public.payments for select to authenticated
  using (
    is_admin()
    or client_id in (select id from clients where staff_id = auth.uid())
    or created_by_staff = auth.uid()
  );

create policy pay_staff_insert on public.payments for insert to authenticated
  with check (
    is_admin()
    or client_id in (select id from clients where staff_id = auth.uid())
    or (client_id is null and created_by_staff = auth.uid())
  );

create policy pay_staff_update on public.payments for update to authenticated
  using (
    is_admin()
    or client_id in (select id from clients where staff_id = auth.uid())
    or created_by_staff = auth.uid()
  )
  with check (
    is_admin()
    or client_id in (select id from clients where staff_id = auth.uid())
    or created_by_staff = auth.uid()
  );

create policy pay_staff_delete on public.payments for delete to authenticated
  using (
    is_admin()
    or client_id in (select id from clients where staff_id = auth.uid())
    or created_by_staff = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Клиент не редактирует заявку, которую завёл бухгалтер (налоги и т.п.).
-- ---------------------------------------------------------------------------
create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients;
begin
  perform check_rate_limit(p_token, 'edit', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;
  update payments set
    payee        = p_payee,
    amount       = coalesce(p_amount, 0),
    requisites   = p_requisites,
    due          = p_due,
    recurrence   = coalesce(p_recurrence, 'once'),
    purpose      = p_purpose,
    need_receipt = coalesce(p_need_receipt, false),
    file_url     = coalesce(p_file_url, file_url),
    file_name    = coalesce(p_file_name, file_name)
  where id = p_id and client_id = v_client.id and status = 'new'
    and created_by_staff is null;   -- заявки бухгалтера клиент не правит
  if not found then
    raise exception 'Заявку нельзя изменить: не найдена, не ваша или уже в работе';
  end if;
  return true;
end; $$;
