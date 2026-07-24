-- Фича 1: платёжный документ по умолчанию НЕ нужен.
-- Клиент запрашивает его только по нужде (галочка снята по умолчанию).

-- Дефолт колонки: было неявно true (в submit_payment), теперь false.
alter table public.payments alter column need_receipt set default false;

-- submit_payment: при отсутствии значения — false (было coalesce(...,true)).
create or replace function public.submit_payment(
  p_token text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_id text;
begin
  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;
  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, coalesce(p_amount,0), p_requisites, p_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,false),
          p_file_url, p_file_name, v_client.id, now());
  return v_id;
end; $$;
