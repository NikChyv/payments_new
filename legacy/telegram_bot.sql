-- ⛔ НЕ ВЫПОЛНЯТЬ. Историческая копия эпохи до миграций, см. legacy/README.md.
-- Всё, что здесь было, уже в supabase/migrations/, и в более строгом виде.
-- Прогон этого файла в SQL Editor на проде откатит права и политики.

-- =============================================================================
--  Telegram-бот для клиентов — Фаза A: привязка аккаунта + «Мои платежи».
--  Выполнить в Supabase → SQL Editor.
--
--  Бот работает server-side (Edge Function telegram-bot) с service_role,
--  поэтому читает/пишет таблицы напрямую — отдельные RPC не нужны.
--  Здесь только добавляем колонку для связи telegram-аккаунта с клиентом.
-- =============================================================================

-- telegram_id привязанного аккаунта клиента (chat_id в Telegram).
alter table clients add column if not exists telegram_id bigint;

-- быстрый поиск клиента по его telegram_id (бот делает это на каждое сообщение).
create index if not exists clients_telegram_id_idx on clients (telegram_id);
