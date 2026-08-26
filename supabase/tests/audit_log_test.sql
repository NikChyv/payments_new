-- pgTAP: журнал изменений payments.
-- Проверяет: INSERT/UPDATE(смена статуса)/EDIT(правка содержимого)/DELETE
-- логируются, порядок переходов, состав правок, изоляция журнала от anon.
--
-- Правки содержимого начали писаться, когда бухгалтеру дали возможность менять
-- заявки: без этого изменение суммы уже оплаченного платежа не оставляло следа.

begin;
select plan(13);

insert into clients (id, name, token, staff_id)
  values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Audit Co', 'tokAudit', null);

select submit_payment('tokAudit','PA',100,'U',current_date,'once','p',null,null,null) as pid \gset

-- 1-2) создание залогировано и привязано к клиенту
select is(
  (select new_status from payments_audit where payment_id = :'pid' and action = 'INSERT'),
  'new',
  'INSERT логируется с new_status=new'
);
select is(
  (select client_id from payments_audit where payment_id = :'pid' and action = 'INSERT'),
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  'в журнале сохранён клиент платежа'
);

update payments set status = 'in_progress' where id = :'pid';
update payments set status = 'paid'        where id = :'pid';
update payments set payee  = 'PA2'         where id = :'pid';  -- правка содержимого
update payments set amount = 999           where id = :'pid';  -- ещё одна правка
update payments set status = 'paid'        where id = :'pid';  -- ничего не изменилось
update payments set client_paid_notified = true where id = :'pid';  -- служебный флаг

-- 3) ровно 2 записи смены статуса
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid' and action = 'UPDATE'),
  2,
  'ровно 2 UPDATE-записи (правки содержимого идут отдельным действием)'
);

-- 3a-3d) правки содержимого
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid' and action = 'EDIT'),
  2,
  'ровно 2 EDIT-записи: смена статуса и служебный флаг правкой не считаются'
);
select is(
  (select changes from payments_audit
    where payment_id = :'pid' and action = 'EDIT' order by id limit 1),
  '{"payee": ["PA", "PA2"]}'::jsonb,
  'в журнале записано, что именно поменялось: было → стало'
);
select is(
  (select changes -> 'amount' from payments_audit
    where payment_id = :'pid' and action = 'EDIT' order by id desc limit 1),
  '[100, 999]'::jsonb,
  'изменение суммы зафиксировано с обоими значениями'
);
-- правка не должна выдумывать смену статуса
select is(
  (select array_agg(distinct old_status) from payments_audit
    where payment_id = :'pid' and action = 'EDIT'),
  array['paid'],
  'у правки статус остаётся прежним'
);

-- 4) переходы в правильном порядке
-- сортировка по id, а не по changed_at: внутри транзакции now() одинаков у всех строк
select is(
  (select array_agg(old_status || '->' || new_status order by id)
     from payments_audit where payment_id = :'pid' and action = 'UPDATE'),
  array['new->in_progress','in_progress->paid'],
  'переходы статуса записаны по порядку'
);

delete from payments where id = :'pid';

-- 5-6) удаление залогировано
select is(
  (select old_status from payments_audit where payment_id = :'pid' and action = 'DELETE'),
  'paid',
  'DELETE логируется с old_status=paid'
);
select is(
  (select new_status from payments_audit where payment_id = :'pid' and action = 'DELETE'),
  null,
  'у DELETE нет нового статуса'
);

-- 7) всего 6 записей по платежу
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid'),
  6,
  'всего 6 записей журнала (insert + 2 смены статуса + 2 правки + delete)'
);

-- 8) журнал переживает удаление платежа (история не теряется)
select ok(
  (select count(*) from payments where id = :'pid') = 0
  and (select count(*) from payments_audit where payment_id = :'pid') > 0,
  'история сохраняется после удаления самого платежа'
);

-- 9) anon не имеет доступа к журналу
select ok(
  not has_table_privilege('anon', 'public.payments_audit', 'SELECT'),
  'anon без SELECT на payments_audit'
);

select * from finish();
rollback;
