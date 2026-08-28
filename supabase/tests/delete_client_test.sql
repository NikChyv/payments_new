-- pgTAP: удаление клиента админом.
-- Главное, что тут доказывается, — отказ при наличии заявок. Без него удаление
-- молча осиротило бы платежи (FK стоит ON DELETE SET NULL), и из очереди
-- бухгалтера они бы просто пропали.

begin;
select plan(17);

insert into auth.users (id) values
  ('000000ad-0000-0000-0000-0000000000ad'),
  ('000000bb-0000-0000-0000-0000000000bb');
insert into staff (id, name, is_admin) values
  ('000000ad-0000-0000-0000-0000000000ad', 'Админ',     true),
  ('000000bb-0000-0000-0000-0000000000bb', 'Бухгалтер', false);

-- EmptyCo — пробный клиент без заявок (такие и надо чистить)
-- BusyCo   — рабочий клиент с заявкой
-- KeepCo   — контроль: не должен пострадать
insert into clients (id, name, token, staff_id, telegram_id) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'EmptyCo', 'emptytok', null, 555000333),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'BusyCo',  'busytok',  null, null),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'KeepCo',  'keeptok',  null, null);
select submit_payment('busytok','BP',100,'U',current_date,'once','p',false,null,null);

-- незавершённый диалог с ботом у пробного клиента
insert into tg_sessions (telegram_id, step) values (555000333, 'payee');

-- ---- 1) без авторизации удалять нельзя ----
select throws_ok(
  $$ select delete_client('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') $$,
  'P0001',
  'Только администратор может удалять клиентов',
  'без входа удаление запрещено'
);

-- ---- 2) обычный бухгалтер тоже не может ----
set local request.jwt.claims = '{"sub":"000000bb-0000-0000-0000-0000000000bb","role":"authenticated"}';
select throws_ok(
  $$ select delete_client('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') $$,
  'P0001',
  'Только администратор может удалять клиентов',
  'бухгалтер без прав админа удалить не может'
);
select is(
  (select count(*) from clients where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  1::bigint,
  'после отказа клиент на месте'
);

-- ---- дальше от имени админа ----
set local request.jwt.claims = '{"sub":"000000ad-0000-0000-0000-0000000000ad","role":"authenticated"}';

-- ---- 3) несуществующий клиент ----
select throws_ok(
  $$ select delete_client('00000000-0000-0000-0000-000000000000') $$,
  'P0001',
  'Клиент не найден',
  'удаление несуществующего клиента — внятная ошибка'
);

-- ---- 4) клиент с заявками не удаляется ----
select throws_ok(
  $$ select delete_client('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'P0001',
  'У клиента «BusyCo» заявок: 1. Удалить нельзя — история платежей потеряет привязку.',
  'клиент с заявками не удаляется, в тексте — имя и число заявок'
);
select is(
  (select count(*) from clients where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1::bigint,
  'клиент с заявками остался в базе'
);
-- ради этого всё и затевалось: заявка не осиротела
select is(
  (select client_id from payments where payee = 'BP'),
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'заявка сохранила привязку к клиенту'
);

-- ---- 5) пустой клиент удаляется ----
select lives_ok(
  $$ select delete_client('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') $$,
  'клиента без заявок админ удаляет'
);
select is(
  (select count(*) from clients where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0::bigint,
  'клиент действительно удалён'
);
select is( client_by_token('emptytok'), null, 'его ссылка больше не работает' );
select is(
  (select count(*) from tg_sessions where telegram_id = 555000333),
  0::bigint,
  'незавершённый диалог с ботом подчищен'
);

-- ---- 6) соседей не задело ----
select is(
  (select count(*) from clients where id in
     ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cccccccc-cccc-cccc-cccc-cccccccccccc')),
  2::bigint,
  'другие клиенты не затронуты'
);

-- ---- 7) две фирмы на одном Telegram ----
-- Человек ведёт две компании и привязал к боту обе. Удаление одной не должно
-- стирать его незаконченную переписку: она общая на чат, а не на фирму.
-- Раньше tg_sessions чистились безусловно, и человек терял набранную заявку
-- по ОСТАВШЕЙСЯ фирме.
insert into clients (id, name, token, staff_id, telegram_id) values
  ('11111111-1111-1111-1111-111111111111', 'TwinA', 'twinatok', null, 555000777),
  ('22222222-2222-2222-2222-222222222222', 'TwinB', 'twinbtok', null, 555000777);
insert into tg_sessions (telegram_id, step) values (555000777, 'payee');

-- страховка от возврата ограничения: если кто-то навесит на telegram_id
-- уникальный индекс, эта вставка упадёт и тест покраснеет здесь, а не в проде
select is(
  (select count(*) from clients where telegram_id = 555000777),
  2::bigint,
  'один telegram_id разрешён у нескольких фирм'
);

select lives_ok(
  $$ select delete_client('11111111-1111-1111-1111-111111111111') $$,
  'первая из двух фирм удаляется'
);
select is(
  (select count(*) from tg_sessions where telegram_id = 555000777),
  1::bigint,
  'диалог с ботом уцелел: у человека осталась вторая фирма'
);

select lives_ok(
  $$ select delete_client('22222222-2222-2222-2222-222222222222') $$,
  'вторая фирма тоже удаляется'
);
select is(
  (select count(*) from tg_sessions where telegram_id = 555000777),
  0::bigint,
  'после удаления последней фирмы диалог подчищен'
);

select * from finish();
rollback;
