-- pgTAP: заявки, созданные сотрудником.
-- Проверяет, что клиент их видит, но НЕ редактирует, и что обычные заявки
-- (созданные клиентом) по-прежнему редактируются.

begin;
select plan(4);

-- сотрудник (staff.id ссылается на auth.users)
insert into auth.users (id) values ('0000000a-0000-0000-0000-00000000000a');
insert into staff (id, name, is_admin)
  values ('0000000a-0000-0000-0000-00000000000a', 'Тест Бухгалтер', false);

insert into clients (id, name, token, staff_id)
  values ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'StaffCo', 'tokStaff',
          '0000000a-0000-0000-0000-00000000000a');

-- заявка, поданная клиентом
select submit_payment('tokStaff','ByClient',100,'U',current_date,'once','p',false,null,null) as cid \gset

-- заявка, заведённая бухгалтером для этого клиента (created_by_staff проставлен)
insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt,
                      client_id, created_at, created_by_staff)
values ('staffmade1','StaffCo','Налог',500,current_date,'once','new',false,
        'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', now(),
        '0000000a-0000-0000-0000-00000000000a');

-- 1) клиент видит обе заявки
select is(
  (select count(*)::int from list_payments_by_token('tokStaff')),
  2,
  'клиент видит и свою заявку, и заведённую бухгалтером'
);

-- 2) свою заявку клиент правит
select lives_ok(
  $$ select edit_payment_by_token('tokStaff', (select id from payments where payee='ByClient'),
       'ByClient2', 150, null, current_date, 'once', null, false, null, null) $$,
  'свою заявку клиент редактирует'
);

-- 3) заявку бухгалтера — не правит
select throws_ok(
  $$ select edit_payment_by_token('tokStaff', 'staffmade1',
       'ВзломНалога', 1, null, current_date, 'once', null, false, null, null) $$,
  'P0001',
  'Заявку нельзя изменить: не найдена, не ваша или уже в работе',
  'заявку бухгалтера клиент редактировать не может'
);

-- 4) данные заявки бухгалтера не изменились
select is(
  (select payee from payments where id = 'staffmade1'),
  'Налог',
  'заявка бухгалтера осталась нетронутой'
);

select * from finish();
rollback;
