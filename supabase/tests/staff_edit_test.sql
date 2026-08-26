-- pgTAP: отметка «кто последним правил заявку».
--
-- От этой отметки зависит, в какую сторону уходит уведомление о правке:
-- правил сотрудник — сообщаем клиенту, правил клиент — сообщаем бухгалтерам.
-- Ставит её БД по JWT, а не фронт: значение из браузера можно подделать.

begin;
select plan(11);

insert into auth.users (id) values ('000000ee-0000-0000-0000-0000000000ee');
insert into staff (id, name, is_admin)
  values ('000000ee-0000-0000-0000-0000000000ee', 'Бухгалтер правок', false);

insert into clients (id, name, token, staff_id)
  values ('eeee0000-eeee-0000-eeee-000000000000', 'Edit Co', 'tokEdit',
          '000000ee-0000-0000-0000-0000000000ee');

select submit_payment('tokEdit','EP',100,'U',current_date,'once','p',false,null,null) as pid \gset

-- ---- 1) свежая заявка ещё никем не правилась ----
select is(
  (select last_edit_role from payments where id = :'pid'),
  null,
  'у новой заявки отметки о правке нет'
);

-- ---- 2-4) правка сотрудником ----
set local request.jwt.claims = '{"sub":"000000ee-0000-0000-0000-0000000000ee","role":"authenticated"}';
update payments set amount = 555 where id = :'pid';

select is(
  (select last_edit_role from payments where id = :'pid'),
  'authenticated',
  'правка сотрудника помечена как authenticated'
);
select ok(
  (select last_edit_at from payments where id = :'pid') is not null,
  'время правки проставлено'
);
select is(
  (select changed_by from payments_audit
     where payment_id = :'pid' and action = 'EDIT' order by id desc limit 1),
  '000000ee-0000-0000-0000-0000000000ee'::uuid,
  'в журнале записан конкретный сотрудник'
);

-- ---- 5-6) смена статуса правкой не считается ----
update payments set status = 'in_progress' where id = :'pid';
select is(
  (select last_edit_role from payments where id = :'pid'),
  'authenticated',
  'смена статуса не перебивает отметку о правке'
);
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid' and action = 'EDIT'),
  1,
  'смена статуса не пишется как правка'
);

-- ---- 7-8) служебные флаги уведомлений — тоже не правка ----
update payments set client_paid_notified = true where id = :'pid';
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid' and action = 'EDIT'),
  1,
  'обновление флага уведомления правкой не считается'
);
-- иначе Edge Function, проставляя флаг, сама себе устроила бы вторую рассылку
select is(
  (select last_edit_role from payments where id = :'pid'),
  'authenticated',
  'флаг уведомления не перебивает отметку'
);

-- ---- 9-11) правка клиентом по токену ----
update payments set status = 'new' where id = :'pid';
set local request.jwt.claims = '{"role":"anon"}';
select edit_payment_by_token('tokEdit', :'pid', 'EP-клиент', 777, 'U',
                             current_date, 'once', 'p', false, null, null);
select is(
  (select last_edit_role from payments where id = :'pid'),
  'anon',
  'правка клиента помечена как anon'
);
select is(
  (select changed_by from payments_audit
     where payment_id = :'pid' and action = 'EDIT' order by id desc limit 1),
  null,
  'у правки клиента нет сотрудника в журнале'
);
select is(
  (select changes -> 'amount' from payments_audit
     where payment_id = :'pid' and action = 'EDIT' order by id desc limit 1),
  '[555, 777]'::jsonb,
  'правка клиента записана с обоими значениями суммы'
);

select * from finish();
rollback;
