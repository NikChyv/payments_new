-- pgTAP-тесты клиентской (anon) поверхности: изоляция по токену, дефолты,
-- правила редактирования, отсутствие прямого доступа anon к payments.
-- Запуск: supabase test db (локально и в CI). Транзакция откатывается.

begin;
select plan(14);

-- ---- setup: два клиента с токенами (без бухгалтера) ----
insert into clients (id, name, token, staff_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Client A', 'tokA', null),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Client B', 'tokB', null);

-- по одному платежу каждому через боевой RPC submit_payment
select submit_payment('tokA','PayeeA',100,'U',current_date,'once','p',null,null,null) as aid \gset
select submit_payment('tokB','PayeeB',200,'U',current_date,'once','p',true,null,null)  as bid \gset

-- 1) Ф1: need_receipt по умолчанию false (передали null)
select is(
  (select need_receipt from payments where id = :'aid'),
  false,
  'submit_payment: need_receipt по умолчанию false'
);

-- 1b) явный true сохраняется (дефолт не затирает выбор клиента)
select is(
  (select need_receipt from payments where id = :'bid'),
  true,
  'submit_payment: явный need_receipt=true сохраняется'
);

-- 1c) заявка от клиента НЕ помечена авто-созданной (иначе уведомление не уйдёт)
select is(
  (select auto_created from payments where id = :'aid'),
  false,
  'submit_payment: auto_created=false — уведомление о заявке клиента уходит'
);

-- 1d) заявка клиента не помечена как созданная сотрудником (иначе он же её и не отредактирует)
select is(
  (select created_by_staff from payments where id = :'aid'),
  null,
  'submit_payment: created_by_staff пуст у заявки клиента'
);

-- 2) client_by_token возвращает имя своего клиента
select is( client_by_token('tokA'), 'Client A', 'client_by_token отдаёт имя клиента' );

-- 3) list_payments_by_token(A) видит ровно свои платежи
select is(
  (select count(*)::int from list_payments_by_token('tokA')),
  1,
  'list_payments_by_token(A): ровно свои платежи'
);

-- 4) и НЕ видит платежи B (изоляция)
select is(
  (select count(*)::int from list_payments_by_token('tokA') where id = :'bid'),
  0,
  'list_payments_by_token(A) не видит платежи B'
);

-- 5) неверный токен -> ничего
select is(
  (select count(*)::int from list_payments_by_token('nope')),
  0,
  'list_payments_by_token(неверный токен) -> пусто'
);

-- 6) Ф2: правка своей new-заявки успешна
select lives_ok(
  format($$ select edit_payment_by_token('tokA', %L,
       'PayeeA2', 150, 'U2', current_date, 'monthly', 'p2', true, null, null) $$, :'aid'),
  'edit_payment_by_token: правка своей new-заявки проходит'
);

-- 6b) и она РЕАЛЬНО записала новые значения (не просто «не упала»)
select results_eq(
  format($$ select payee, amount, requisites, recurrence, purpose, need_receipt
              from payments where id = %L $$, :'aid'),
  $$ values ('PayeeA2', 150::numeric, 'U2', 'monthly', 'p2', true) $$,
  'edit_payment_by_token: новые значения действительно сохранены'
);

-- 7) чужим токеном нельзя править платёж A
select throws_ok(
  format($$ select edit_payment_by_token('tokB', %L,
       'HACK', 1, null, current_date, 'once', null, false, null, null) $$, :'aid'),
  'P0001',
  'Заявку нельзя изменить: не найдена, не ваша или уже в работе',
  'edit_payment_by_token: чужой токен не правит платёж'
);

-- 7b) и данные после чужой попытки не изменились
select is(
  (select payee from payments where id = :'aid'),
  'PayeeA2',
  'после попытки чужим токеном данные остались прежними'
);

-- 8) нельзя править не-new
update payments set status = 'in_progress' where id = :'aid';
select throws_ok(
  format($$ select edit_payment_by_token('tokA', %L,
       'X', 1, null, current_date, 'once', null, false, null, null) $$, :'aid'),
  'P0001',
  'Заявку нельзя изменить: не найдена, не ваша или уже в работе',
  'edit_payment_by_token: не-new править нельзя'
);

-- 9) Фаза 2 RLS: у anon нет прямого SELECT на payments
select ok(
  not has_table_privilege('anon', 'public.payments', 'SELECT'),
  'anon не имеет прямого SELECT на payments (revoke phase 2)'
);

select * from finish();
rollback;
