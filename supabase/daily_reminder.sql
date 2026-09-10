-- Ежедневное напоминание о платежах на сегодня в 8:30 по Минску.
-- Выполнить в Supabase → SQL Editor, подставив реальные значения.
--
-- ВАЖНО: НЕ коммить настоящий токен бота в репозиторий — он секретный.
-- Здесь намеренно стоят заглушки.
--
-- Требует расширения pg_cron и pg_net (Database → Extensions).
--
-- ---------------------------------------------------------------------------
-- Почему этот файл накатывается руками, а не миграцией
--
-- В теле функции лежит боевой токен бота. Миграция с `create or replace`
-- затёрла бы его плейсхолдером, и утренние уведомления встали бы (CLAUDE.md,
-- грабли №2). Поэтому здесь осталась только оболочка — взять текст и разослать,
-- а сам текст собирает `daily_reminder_message()` из миграции
-- 20260910000001_url_scheme_and_html_escape.sql: там нет секретов, и она
-- покрыта тестами.
--
-- Из этого следует: **пока этот файл не выполнен на проде, рассылка идёт
-- по старому — с неэкранированным HTML (находка M4.3).** Выполнять после
-- `supabase db push`, иначе функции `daily_reminder_message` ещё нет.
-- ---------------------------------------------------------------------------

create or replace function send_daily_reminder()
returns void language plpgsql security definer set search_path = public as $$
declare
  bot_token text   := '<TELEGRAM_BOT_TOKEN>';               -- подставить при выполнении
  chat_ids  text[] := array['<CHAT_ID_1>', '<CHAT_ID_2>'];  -- получатели
  cid       text;
  msg       text;
begin
  msg := daily_reminder_message();

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

-- Расписание: каждый день в 8:30 по Минску (= 05:30 UTC, UTC+3).
-- Повторный запуск безопасен: pg_cron заменяет задание с тем же именем.
select cron.schedule('daily-reminder', '30 5 * * *', 'select send_daily_reminder()');

-- Проверочный запуск вручную (пришлёт сообщение получателям):
-- select send_daily_reminder();
--
-- Посмотреть текст, никому не отправляя:
-- select daily_reminder_message();
