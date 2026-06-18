-- Ежедневное напоминание о платежах на сегодня в 8:30 по Минску.
-- Выполнить один раз в Supabase → SQL Editor.
--
-- ВАЖНО: подставь реальные значения вместо плейсех ниже. НЕ коммить настоящий
-- токен бота в репозиторий — он секретный. Здесь намеренно стоят заглушки.
--
-- Требует расширения pg_cron и pg_net (Database → Extensions).

create or replace function send_daily_reminder()
returns void language plpgsql security definer set search_path = public as $$
declare
  rec       record;
  msg       text;
  today     text;
  cnt       int    := 0;
  bot_token text   := '<TELEGRAM_BOT_TOKEN>';            -- подставить при выполнении
  chat_ids  text[] := array['<CHAT_ID_1>', '<CHAT_ID_2>'];  -- получатели, через запятую
  cid       text;
begin
  today := to_char(now() at time zone 'Europe/Minsk', 'YYYY-MM-DD');
  msg := '📅 <b>Платежи на ' || to_char(now() at time zone 'Europe/Minsk', 'DD.MM.YYYY') || '</b>'
      || chr(10) || chr(10);

  for rec in
    select payee, amount, client, purpose, file_url, file_name
    from payments
    where due::text = today
      and status in ('new', 'in_progress')
    order by amount desc
  loop
    cnt := cnt + 1;
    msg := msg
      || cnt || '. <b>' || rec.payee || '</b>'
      || ' — ' || to_char(rec.amount, 'FM999999999.00') || ' Br' || chr(10)
      || '   👤 ' || coalesce(nullif(rec.client, ''), '—') || chr(10)
      || case when rec.purpose is not null and rec.purpose <> ''
              then '   📝 ' || rec.purpose || chr(10)
              else '' end
      || case when rec.file_url is not null and rec.file_url <> ''
              then '   📎 <a href="' || rec.file_url || '">'
                   || coalesce(nullif(rec.file_name, ''), 'файл') || '</a>' || chr(10)
              else '' end
      || chr(10);
  end loop;

  if cnt = 0 then
    msg := msg || 'Нет платежей на сегодня 🎉';
  else
    msg := msg || '💼 Всего: ' || cnt;
  end if;

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
end;
$$;

-- Расписание: каждый день в 8:30 по Минску (= 05:30 UTC, UTC+3)
select cron.schedule('daily-reminder', '30 5 * * *', 'select send_daily_reminder()');

-- Проверочный запуск вручную:
-- select send_daily_reminder();
