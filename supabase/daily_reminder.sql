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
-- а сам текст собирает `daily_reminder_message(staff_id)` из миграций: там нет
-- секретов, и она покрыта тестами.
--
-- Из этого следует: **пока этот файл не выполнен на проде, рассылка идёт
-- по старому.** Выполнять после `supabase db push`.
--
-- ---------------------------------------------------------------------------
-- Кому уходит письмо
--
-- Получатели берутся из `staff.telegram_id` — по одному письму на человека,
-- потому что письма у всех разные: бухгалтер видит только своих клиентов и
-- свои личные задачи, админ — всех клиентов (с 14.09, миграция
-- 20260914000001_addressed_notifications.sql). Заполняется вручную, по id:
--
--   update staff set telegram_id = <chat_id> where id = '<uid>';
--
-- Пока ни у кого не проставлено — работает запасной путь по зашитым ниже
-- chat_id, ровно как раньше. В таком письме личных задач нет вовсе: некому
-- решить, чьи они. Как только появится первый telegram_id, запасной путь
-- выключается сам.
-- ---------------------------------------------------------------------------

create or replace function send_daily_reminder()
returns void language plpgsql security definer set search_path = public as $$
declare
  bot_token text   := '<TELEGRAM_BOT_TOKEN>';               -- подставить при выполнении
  fallback  text[] := array['<CHAT_ID_1>', '<CHAT_ID_2>'];  -- пока staff.telegram_id пуст
  t         record;
  cid       text;
  sent      int := 0;

  -- PL/pgSQL инициализирует переменные по порядку объявления, поэтому bot_token
  -- здесь уже есть
  api_url   text := 'https://api.telegram.org/bot' || bot_token || '/sendMessage';
begin
  for t in select staff_id, chat_id from daily_reminder_targets() loop
    perform net.http_post(
      url     := api_url,
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := json_build_object(
                   'chat_id',                 t.chat_id,
                   'text',                    daily_reminder_message(t.staff_id),
                   'parse_mode',              'HTML',
                   'disable_web_page_preview', true
                 )::jsonb
    );
    sent := sent + 1;
  end loop;

  if sent > 0 then return; end if;

  foreach cid in array fallback loop
    perform net.http_post(
      url     := api_url,
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := json_build_object(
                   'chat_id',                 cid,
                   'text',                    daily_reminder_message(null::uuid),
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

-- Проверочный запуск вручную (пришлёт сообщения получателям):
-- select send_daily_reminder();
--
-- Посмотреть текст, никому не отправляя:
-- select daily_reminder_message();                     -- общий, без личных задач
-- select daily_reminder_message('<uuid сотрудника>');   -- как его увидит он
--
-- Кому сейчас уйдёт:
-- select * from daily_reminder_targets();
