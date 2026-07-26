-- Рабочий график: пн–пт до 17:00 (Europe/Minsk).
--
-- Правила для даты платежа в заявке клиента:
--   • дата в БУДУЩЕМ и выпадает на сб/вс  → ошибка (платёж не проведётся);
--   • дата = СЕГОДНЯ, но провести уже нельзя (выходной или после 17:00)
--     → переносим на ближайший рабочий день;
--   • дата в ПРОШЛОМ → не трогаем (пусть висит как просроченная, это сигнал).
--
-- Праздники пока не учитываем — только суббота и воскресенье.

create or replace function public.next_working_day(p_d date)
returns date language sql immutable as $$
  select p_d + n
  from generate_series(1, 7) as n
  where extract(isodow from p_d + n) < 6
  order by n
  limit 1;
$$;

create or replace function public.adjust_due_date(p_due date)
returns date language plpgsql stable set search_path = public as $$
declare
  v_local timestamp;
  v_today date;
begin
  if p_due is null then return p_due; end if;

  v_local := now() at time zone 'Europe/Minsk';
  v_today := v_local::date;

  -- будущее: выходной запрещаем явной ошибкой
  if p_due > v_today then
    if extract(isodow from p_due) >= 6 then
      raise exception 'В выходной платёж не проводится. Выберите рабочий день (пн–пт).';
    end if;
    return p_due;
  end if;

  -- сегодня: если рабочий день уже закончился или это выходной — на следующий рабочий
  if p_due = v_today then
    if extract(isodow from v_today) >= 6 or v_local::time >= time '17:00' then
      return next_working_day(v_today);
    end if;
  end if;

  return p_due;   -- прошлые даты оставляем как есть
end; $$;

-- ---------------------------------------------------------------------------
-- Подключаем правило к заявкам клиента (веб и бот идут через эти функции).
-- ---------------------------------------------------------------------------
create or replace function public.submit_payment(
  p_token text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_id text; v_due date;
begin
  perform check_rate_limit(p_token, 'submit', 10, interval '1 minute');
  perform check_rate_limit(p_token, 'submit_h', 60, interval '1 hour');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  v_due := adjust_due_date(p_due);

  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, coalesce(p_amount,0), p_requisites, v_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,false),
          p_file_url, p_file_name, v_client.id, now());
  return v_id;
end; $$;

create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_due date;
begin
  perform check_rate_limit(p_token, 'edit', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  v_due := adjust_due_date(p_due);

  update payments set
    payee        = p_payee,
    amount       = coalesce(p_amount, 0),
    requisites   = p_requisites,
    due          = v_due,
    recurrence   = coalesce(p_recurrence, 'once'),
    purpose      = p_purpose,
    need_receipt = coalesce(p_need_receipt, false),
    file_url     = coalesce(p_file_url, file_url),
    file_name    = coalesce(p_file_name, file_name)
  where id = p_id and client_id = v_client.id and status = 'new'
    and created_by_staff is null;
  if not found then
    raise exception 'Заявку нельзя изменить: не найдена, не ваша или уже в работе';
  end if;
  return true;
end; $$;
