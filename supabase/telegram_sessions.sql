-- =============================================================================
--  Telegram-бот — Фаза B: состояние пошагового диалога создания поручения.
--  Выполнить в Supabase → SQL Editor.
-- =============================================================================

-- Незавершённый диалог клиента: на каком шаге и что уже собрано.
create table if not exists tg_sessions (
  telegram_id bigint primary key,
  step        text,
  draft       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
