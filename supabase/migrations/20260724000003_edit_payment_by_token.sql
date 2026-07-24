-- Фича 2: клиент может отредактировать свою заявку, пока бухгалтер не взял её
-- в работу (status = 'new'). Правит только СВОЙ платёж (проверка по токену),
-- и только пока он новый. Anon ходит через эту функцию, не в таблицу напрямую.

create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients;
begin
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
    -- файл: если новый не передан (null) — сохраняем прежний
    file_url     = coalesce(p_file_url, file_url),
    file_name    = coalesce(p_file_name, file_name)
  where id = p_id and client_id = v_client.id and status = 'new';
  if not found then
    raise exception 'Заявку нельзя изменить: не найдена, не ваша или уже в работе';
  end if;
  return true;
end; $$;

grant execute on function public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text
) to anon;
