-- pgTAP: ротация токена клиента (пункт 5).
-- Проверяет: гейт админа, и что после смены токена старая ссылка мертва.

begin;
select plan(4);

insert into clients (id, name, token, staff_id)
  values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'RotCo', 'oldtok', null);
select submit_payment('oldtok','RP',100,'U',current_date,'once','p',false,null,null);

-- 1) без админа rotate_client_token падает (is_admin gate; в тесте нет JWT -> не админ)
select throws_ok(
  $$ select rotate_client_token('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'P0001',
  'Только администратор может перевыпускать ссылки',
  'rotate_client_token требует прав админа'
);

-- эмулируем саму ротацию (как сделал бы админ через RPC)
update clients set token = 'newtok' where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

-- 2) старый токен больше не резолвит клиента
select is( client_by_token('oldtok'), null, 'старый токен мёртв после ротации' );

-- 3) новый токен работает
select is( client_by_token('newtok'), 'RotCo', 'новый токен резолвится' );

-- 4) по старому токену платежи не отдаются
select is(
  (select count(*)::int from list_payments_by_token('oldtok')),
  0,
  'старый токен не отдаёт платежи'
);

select * from finish();
rollback;
