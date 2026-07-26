-- Пункт 4: rate-limiting на anon-поверхности (submit_payment / edit_payment_by_token).
-- Ограничение на уровне БД, поэтому покрывает ОБА канала сразу: веб и Telegram-бот
-- (бот шлёт заявки через тот же RPC).
--
-- Модель: фиксированное окно. Ключ — токен клиента, счётчик на (ключ, действие, окно).

create table if not exists public.rpc_rate_limit (
  key          text        not null,
  action       text        not null,
  window_start timestamptz not null,
  cnt          int         not null default 0,
  primary key (key, action, window_start)
);

-- служебная таблица: снаружи недоступна, пишется только SECURITY DEFINER-функциями
alter table public.rpc_rate_limit enable row level security;
revoke all on public.rpc_rate_limit from anon, authenticated;

-- Считает вызов и бросает исключение при превышении лимита.
create or replace function public.check_rate_limit(
  p_key text, p_action text, p_max int, p_window interval
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_secs  double precision := extract(epoch from p_window);
  v_start timestamptz;
  v_cnt   int;
begin
  if p_key is null or p_key = '' then return; end if;
  -- начало текущего окна (bucket)
  v_start := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);

  insert into rpc_rate_limit(key, action, window_start, cnt)
  values (p_key, p_action, v_start, 1)
  on conflict (key, action, window_start)
    do update set cnt = rpc_rate_limit.cnt + 1
  returning cnt into v_cnt;

  -- изредка подчищаем старые окна, чтобы таблица не росла
  if random() < 0.01 then
    delete from rpc_rate_limit where window_start < now() - interval '1 day';
  end if;

  if v_cnt > p_max then
    raise exception 'Слишком много запросов. Подождите немного и попробуйте снова.';
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- submit_payment с лимитом: 10/мин и 60/час на токен клиента.
-- ---------------------------------------------------------------------------
create or replace function public.submit_payment(
  p_token text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_id text;
begin
  perform check_rate_limit(p_token, 'submit', 10, interval '1 minute');
  perform check_rate_limit(p_token, 'submit_h', 60, interval '1 hour');

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

-- ---------------------------------------------------------------------------
-- edit_payment_by_token с лимитом: 20/мин на токен.
-- ВНИМАНИЕ: в проде эта функция дополнительно перекрывается ручным скриптом
-- supabase/edit_notify.sql (уведомление о правке) — там лимит тоже есть.
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
  where id = p_id and client_id = v_client.id and status = 'new';
  if not found then
    raise exception 'Заявку нельзя изменить: не найдена, не ваша или уже в работе';
  end if;
  return true;
end; $$;
