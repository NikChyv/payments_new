-- pgTAP: отметка «приглашение отправлено» (18.10).
--
-- Ради чего тест написан: клиентов подключают несколько бухгалтеров, и по
-- отметке они решают, кому ещё писать. Неверная отметка — это клиент, которому
-- не написал никто, или двойное приглашение. Проверяем, кто может её ставить,
-- что она записывает и что перевыпуск ссылки её снимает.

begin;
select plan(13);

insert into auth.users (id) values
  ('000001ad-0000-0000-0000-0000000001ad'),
  ('000001bb-0000-0000-0000-0000000001bb'),
  ('000001cc-0000-0000-0000-0000000001cc'),
  ('000001dd-0000-0000-0000-0000000001dd');
insert into staff (id, name, is_admin) values
  ('000001ad-0000-0000-0000-0000000001ad', 'Админ',     true),
  ('000001bb-0000-0000-0000-0000000001bb', 'Валентина', false),
  ('000001cc-0000-0000-0000-0000000001cc', 'Татьяна',   false);
-- 000001dd — вошёл в систему, но не сотрудник

insert into clients (id, name, token, staff_id) values
  ('10000000-0000-0000-0000-0000000000a1', 'Фирма Валентины', 'invTokV', '000001bb-0000-0000-0000-0000000001bb'),
  ('10000000-0000-0000-0000-0000000000a2', 'Фирма Татьяны',   'invTokT', '000001cc-0000-0000-0000-0000000001cc'),
  ('10000000-0000-0000-0000-0000000000a3', 'Ничья фирма',     'invTokN', null);

-- ---- 1-2) доступ ----
select ok(not has_function_privilege('anon', 'public.mark_client_invited(uuid)', 'EXECUTE'),
          'аноним отметку не ставит');
select ok(has_function_privilege('authenticated', 'public.mark_client_invited(uuid)', 'EXECUTE'),
          'вошедшему функция доступна — права решает она сама');

-- ---- 3) не сотрудник ----
set local request.jwt.claims = '{"sub":"000001dd-0000-0000-0000-0000000001dd","role":"authenticated"}';
select throws_ok($$ select mark_client_invited('10000000-0000-0000-0000-0000000000a1') $$,
  'P0001', 'Отмечать приглашения могут только сотрудники',
  'вошедший, но не сотрудник — отказ');

-- ---- 4-6) бухгалтер: своего — да, чужого и ничьего — нет ----
set local request.jwt.claims = '{"sub":"000001bb-0000-0000-0000-0000000001bb","role":"authenticated"}';
select lives_ok($$ select mark_client_invited('10000000-0000-0000-0000-0000000000a1') $$,
  'бухгалтер отмечает своего клиента');
select throws_ok($$ select mark_client_invited('10000000-0000-0000-0000-0000000000a2') $$,
  'P0001', 'Это клиент другого бухгалтера',
  'чужого клиента — отказ');
select throws_ok($$ select mark_client_invited('10000000-0000-0000-0000-0000000000a3') $$,
  'P0001', 'Это клиент другого бухгалтера',
  'клиента без бухгалтера — тоже отказ, это дело админа');

reset request.jwt.claims;

-- ---- 7-8) что записалось ----
select is((select invited_by from clients where id = '10000000-0000-0000-0000-0000000000a1'),
          '000001bb-0000-0000-0000-0000000001bb'::uuid,
          'записано, кто отправил');
select ok((select invited_at from clients where id = '10000000-0000-0000-0000-0000000000a1') is not null
          and (select invited_at from clients where id = '10000000-0000-0000-0000-0000000000a2') is null,
          'дата у своего стоит, у чужого после отказа — пусто');

-- ---- 9-10) админ — любого ----
set local request.jwt.claims = '{"sub":"000001ad-0000-0000-0000-0000000001ad","role":"authenticated"}';
select lives_ok($$ select mark_client_invited('10000000-0000-0000-0000-0000000000a3') $$,
  'админ отмечает и ничьего клиента');
select throws_ok($$ select mark_client_invited('10000000-0000-0000-0000-000000000000') $$,
  'P0001', 'Клиент не найден',
  'несуществующий клиент — внятная ошибка');
reset request.jwt.claims;

-- ---- 11-13) перевыпуск ссылки снимает отметку, остальные правки — нет ----
update clients set name = 'Фирма Валентины (новое имя)' where id = '10000000-0000-0000-0000-0000000000a1';
select ok((select invited_at from clients where id = '10000000-0000-0000-0000-0000000000a1') is not null,
          'переименование отметку не трогает');

update clients set token = 'invTokV2' where id = '10000000-0000-0000-0000-0000000000a1';
select ok((select invited_at is null and invited_by is null from clients where id = '10000000-0000-0000-0000-0000000000a1'),
          'новая ссылка — старое приглашение снято, клиент снова «не приглашён»');
select ok((select invited_at from clients where id = '10000000-0000-0000-0000-0000000000a3') is not null,
          'у других клиентов отметка на месте');

select * from finish();
rollback;
