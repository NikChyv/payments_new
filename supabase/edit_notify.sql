-- =============================================================================
--  Уведомление бухгалтерам, когда клиент ИЗМЕНИЛ заявку (пока она 'new').
--  Расширяет edit_payment_by_token: после успешной правки шлёт сообщение в
--  Telegram через net.http_post (асинхронно, ответ клиенту не тормозит).
--
--  ПРИМЕНЕНИЕ: вставить в Supabase → SQL Editor, ПРЕДВАРИТЕЛЬНО заменив
--  <TELEGRAM_BOT_TOKEN> на реальный токен бота (тот же, что в send_daily_reminder).
--  chat_id получателей — те же, что для остальных уведомлений (Никита, Валентина).
--
--  Секрет: реальный токен только в проде; в репозитории — плейсхолдер.
-- =============================================================================

create or replace function public.edit_payment_by_token(
  p_token text, p_id text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client   clients;
  bot_token  text   := '<TELEGRAM_BOT_TOKEN>';
  chat_ids   text[] := array['670574684', '744619432'];  -- Никита, Валентина
  cid        text;
  msg        text;
begin
  -- лимит частоты (из миграции 006) — обязателен, иначе ручная вставка снимет защиту
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

  -- Уведомление бухгалтерам об изменении
  msg := '✏️ <b>Клиент изменил заявку</b>' || chr(10) || chr(10)
      || '👤 Клиент: ' || coalesce(v_client.name, '—') || chr(10)
      || '💳 Кому: '   || coalesce(p_payee, '—') || chr(10)
      || '💰 Сумма: '  || to_char(coalesce(p_amount, 0), 'FM999999999.00') || ' Br' || chr(10)
      || '📅 Срок: '   || coalesce(to_char(p_due, 'DD.MM.YYYY'), '—')
      || case when p_purpose is not null and p_purpose <> ''
              then chr(10) || '📝 ' || p_purpose else '' end;

  foreach cid in array chat_ids loop
    perform net.http_post(
      url     := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := json_build_object(
                   'chat_id',                 cid,
                   'text',                    msg,
                   'parse_mode',              'HTML',
                   'disable_web_page_preview', true
                 )::jsonb
    );
  end loop;

  return true;
end; $$;

grant execute on function public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text
) to anon;
