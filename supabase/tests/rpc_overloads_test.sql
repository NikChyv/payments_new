-- pgTAP: у клиентских RPC ровно одна версия.
--
-- Ради чего тест написан: 16.09.2026 на проде нашлась вторая, старая
-- edit_payment_by_token (11 аргументов, без p_files). PostgREST при вызове
-- без p_files отвечал PGRST203 «could not choose the best candidate» —
-- правка заявки у клиента со старым кэшем фронта не работала. CLAUDE.md,
-- грабли №1: параметр со значением по умолчанию — это перегрузка, старую
-- версию надо удалять явно. Тест ловит забытый drop в будущих миграциях.
--
-- Считаем версии по имени: у функций с параметром по умолчанию PostgREST
-- разрешает вызов и с ним, и без него только пока версия одна.

begin;
select plan(8);

create or replace function pg_temp.versions(p_name text) returns int
language sql as $$
  select count(*)::int from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_name;
$$;

select is(pg_temp.versions('edit_payment_by_token'), 1,
  'edit_payment_by_token — одна версия (с p_files default null)');
select is(pg_temp.versions('submit_payment'), 1,
  'submit_payment — одна версия');
select is(pg_temp.versions('reply_by_token'), 1,
  'reply_by_token — одна версия');
select is(pg_temp.versions('post_staff_message'), 1,
  'post_staff_message — одна версия');
select is(pg_temp.versions('daily_reminder_message'), 1,
  'daily_reminder_message — одна версия (uuid default null)');
select is(pg_temp.versions('list_payments_by_token'), 1,
  'list_payments_by_token — одна версия');
select is(pg_temp.versions('client_by_token'), 1,
  'client_by_token — одна версия');
-- adjust_due_date перегружена намеренно: (date) и (date, timestamp) для
-- тестируемости, без параметров по умолчанию — PostgREST их различает.
select is(pg_temp.versions('adjust_due_date'), 2,
  'adjust_due_date — ровно две версии, обе без default');

select * from finish();
rollback;
