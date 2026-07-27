-- pgTAP: отзыв/ротация ссылки клиента.
-- Раньше ротация эмулировалась ручным UPDATE — сама функция не проверялась.
-- Теперь вызываем rotate_client_token по-настоящему, подставляя JWT админа.

begin;
select plan(11);

-- админ и обычный бухгалтер
insert into auth.users (id) values
  ('000000ad-0000-0000-0000-0000000000ad'),
  ('000000bb-0000-0000-0000-0000000000bb');
insert into staff (id, name, is_admin) values
  ('000000ad-0000-0000-0000-0000000000ad', 'Админ',    true),
  ('000000bb-0000-0000-0000-0000000000bb', 'Бухгалтер', false);

-- у RotCo привязан Telegram (как будто клиент нажал «Старт» по старой ссылке)
insert into clients (id, name, token, staff_id, telegram_id) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'RotCo',   'oldtok',   null, 555000111),
  ('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'OtherCo', 'othertok', null, 555000222);
select submit_payment('oldtok','RP',100,'U',current_date,'once','p',false,null,null);

-- ---- 1) без авторизации ротация запрещена ----
select throws_ok(
  $$ select rotate_client_token('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'P0001',
  'Только администратор может перевыпускать ссылки',
  'без входа ротация запрещена'
);

-- ---- 2) обычный бухгалтер тоже не может ----
set local request.jwt.claims = '{"sub":"000000bb-0000-0000-0000-0000000000bb","role":"authenticated"}';
select throws_ok(
  $$ select rotate_client_token('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'P0001',
  'Только администратор может перевыпускать ссылки',
  'бухгалтер без прав админа перевыпустить не может'
);

-- ---- 3-8) админ: реальный вызов функции ----
set local request.jwt.claims = '{"sub":"000000ad-0000-0000-0000-0000000000ad","role":"authenticated"}';
select ok( is_admin(), 'is_admin() распознаёт админа по JWT' );

select rotate_client_token('dddddddd-dddd-dddd-dddd-dddddddddddd') as newtok \gset

-- ::text обязателен: у двух безтиповых литералов pgTAP не выводит полиморфный тип
select isnt( :'newtok'::text, 'oldtok'::text, 'функция вернула НОВЫЙ токен' );
select matches( :'newtok'::text, '^[0-9a-f]{32}$', 'новый токен — 32 hex-символа (128 бит)' );
select is(
  (select token from clients where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  :'newtok'::text,
  'новый токен записан именно этому клиенту'
);
select is(
  (select token from clients where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'),
  'othertok',
  'токен другого клиента не затронут'
);
select is( client_by_token('oldtok'), null, 'старая ссылка мертва' );
select is( client_by_token(:'newtok'), 'RotCo', 'новая ссылка работает' );

-- отзыв должен быть ПОЛНЫМ: бот ищет клиента по telegram_id, поэтому старая
-- привязка обязана слетать — иначе доступ через бота переживает перевыпуск
select is(
  (select telegram_id from clients where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  null,
  'привязка Telegram сброшена — доступ через бота отозван'
);
select is(
  (select telegram_id from clients where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'),
  555000222::bigint,
  'привязка другого клиента не затронута'
);

select * from finish();
rollback;
