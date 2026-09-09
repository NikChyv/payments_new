-- Database Webhooks: пересоздание триггеров на проде.
--
-- Эти триггеры живут ВНЕ миграций (docs/ARCHITECTURE.md, раздел 5): они
-- содержат секреты, а миграции лежат в публичном репозитории. Раньше они были
-- в baseline.sql вместе с боевым service_role-ключом — так ключ и утёк.
--
-- Выполнять в Supabase → SQL Editor, подставив два значения:
--
--   <SECRET_KEY>      Settings → API Keys → Secret keys → sb_secret_…
--   <WEBHOOK_SECRET>  своя случайная строка: openssl rand -hex 32
--                     та же самая должна лежать в секретах функций как
--                     WEBHOOK_SECRET (Edge Functions → Secrets)
--
-- Порядок при переходе на новые ключи — чтобы уведомления не встали:
--   1. задеплоить функции (проверка секрета пока выключена: она включается
--      только когда в окружении есть WEBHOOK_SECRET);
--   2. выполнить этот файл — триггеры начинают слать оба заголовка;
--   3. добавить WEBHOOK_SECRET в секреты функций — защита включилась;
--   4. проверить сквозной сценарий на тестовой фирме;
--   5. и только теперь Disable JWT-based API keys в панели.

begin;

drop trigger if exists "notify-client"  on public.payments;
drop trigger if exists "notify-payment" on public.payments;

-- Клиенту: оплата, документ, переписка. Срабатывает на любое обновление —
-- ветвление внутри функции.
create trigger "notify-client"
  after update on public.payments
  for each row execute function supabase_functions.http_request(
    'https://gmvhphuabiyggfurfhmc.supabase.co/functions/v1/notify-client',
    'POST',
    '{"Content-type":"application/json","Authorization":"Bearer <SECRET_KEY>","x-webhook-secret":"<WEBHOOK_SECRET>"}',
    '{}',
    '5000'
  );

-- Бухгалтерам: новая заявка от клиента.
create trigger "notify-payment"
  after insert on public.payments
  for each row execute function supabase_functions.http_request(
    'https://gmvhphuabiyggfurfhmc.supabase.co/functions/v1/notify-payment',
    'POST',
    '{"Content-type":"application/json","Authorization":"Bearer <SECRET_KEY>","x-webhook-secret":"<WEBHOOK_SECRET>"}',
    '{}',
    '5000'
  );

commit;

-- Проверка: два триггера на месте.
--   select tgname from pg_trigger
--    where tgrelid = 'public.payments'::regclass and not tgisinternal;
