-- pgTAP: контур безопасности — RLS включён на всех таблицах с данными,
-- у анонимного клиента нет прямых прав на платежи и служебные таблицы.
-- Единственный путь для anon — SECURITY DEFINER функции по токену.

begin;
select plan(11);

-- ---- RLS включён везде, где есть данные ----
select ok((select relrowsecurity from pg_class where oid = 'public.payments'::regclass),
          'RLS включён на payments');
select ok((select relrowsecurity from pg_class where oid = 'public.clients'::regclass),
          'RLS включён на clients');
select ok((select relrowsecurity from pg_class where oid = 'public.staff'::regclass),
          'RLS включён на staff');
select ok((select relrowsecurity from pg_class where oid = 'public.tg_sessions'::regclass),
          'RLS включён на tg_sessions');
select ok((select relrowsecurity from pg_class where oid = 'public.payments_audit'::regclass),
          'RLS включён на payments_audit');
select ok((select relrowsecurity from pg_class where oid = 'public.rpc_rate_limit'::regclass),
          'RLS включён на rpc_rate_limit');

-- ---- anon не пишет в платежи напрямую (Фаза 2: revoke all) ----
select ok(not has_table_privilege('anon', 'public.payments', 'INSERT'),
          'anon не может вставлять в payments напрямую');
select ok(not has_table_privilege('anon', 'public.payments', 'UPDATE'),
          'anon не может менять payments напрямую');
select ok(not has_table_privilege('anon', 'public.payments', 'DELETE'),
          'anon не может удалять из payments');

-- ---- служебные таблицы закрыты полностью ----
select ok(not has_table_privilege('anon', 'public.payments_audit', 'SELECT'),
          'anon не читает журнал изменений');
select ok(not has_table_privilege('anon', 'public.rpc_rate_limit', 'SELECT'),
          'anon не читает счётчики лимитов');

select * from finish();
rollback;
