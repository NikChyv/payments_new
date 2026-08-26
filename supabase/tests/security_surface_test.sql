-- pgTAP: контур безопасности — RLS включён на всех таблицах с данными,
-- у анонимного клиента нет прямых прав на платежи и служебные таблицы.
-- Единственный путь для anon — SECURITY DEFINER функции по токену.

begin;
select plan(21);

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

-- ---- административные и служебные RPC недоступны анониму ----
-- эти функции SECURITY DEFINER: если у anon есть право на вызов, гейт is_admin()
-- остаётся единственной преградой — а единственной он быть не должен.
-- Право EXECUTE достаётся PUBLIC по умолчанию, поэтому одного grant мало:
-- нужен явный revoke (миграция 20260809000002).
select ok(not has_function_privilege('anon', 'public.delete_client(uuid)', 'EXECUTE'),
          'anon не может вызвать delete_client');
select ok(not has_function_privilege('anon', 'public.rotate_client_token(uuid)', 'EXECUTE'),
          'anon не может вызвать rotate_client_token');
select ok(not has_function_privilege('anon', 'public.send_daily_reminder()', 'EXECUTE'),
          'anon не может разослать утренний список');
select ok(not has_function_privilege('anon', 'public.check_rate_limit(text,text,int,interval)', 'EXECUTE'),
          'anon не может крутить счётчики лимитов напрямую');
select ok(has_function_privilege('authenticated', 'public.delete_client(uuid)', 'EXECUTE'),
          'вошедший сотрудник может вызвать delete_client (внутри — гейт is_admin)');

-- ---- а путь клиента по токену обязан остаться открытым ----
-- страховка от чрезмерного revoke: если закрыть эти функции, клиенты
-- мгновенно потеряют возможность подать и посмотреть заявку
select ok(has_function_privilege('anon', 'public.client_by_token(text)', 'EXECUTE'),
          'anon по-прежнему может открыть свою ссылку');
select ok(has_function_privilege('anon', 'public.list_payments_by_token(text)', 'EXECUTE'),
          'anon по-прежнему видит свои платежи');
select ok(has_function_privilege('anon',
          'public.submit_payment(text,text,numeric,text,date,text,text,boolean,text,text,jsonb)', 'EXECUTE'),
          'anon по-прежнему может подать заявку');
select ok(has_function_privilege('anon',
          'public.edit_payment_by_token(text,text,text,numeric,text,date,text,text,boolean,text,text,jsonb)', 'EXECUTE'),
          'anon по-прежнему может исправить свою заявку');
-- пересоздание функции сбрасывает права: если забыть grant, клиенты встанут
select ok(not has_function_privilege('anon', 'public.normalize_files(jsonb,text,text)', 'EXECUTE'),
          'служебная normalize_files анониму недоступна');

select * from finish();
rollback;
