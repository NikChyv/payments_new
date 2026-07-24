-- pgTAP: журнал изменений payments (пункт 8).
-- Проверяет: INSERT/UPDATE(смена статуса)/DELETE логируются, no-op апдейт — нет,
-- порядок переходов, anon без доступа к журналу.

begin;
select plan(6);

insert into clients (id, name, token, staff_id)
  values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Audit Co', 'tokAudit', null);

select submit_payment('tokAudit','PA',100,'U',current_date,'once','p',null,null,null) as pid \gset

-- 1) создание залогировано как new
select is(
  (select new_status from payments_audit where payment_id = :'pid' and action = 'INSERT'),
  'new',
  'INSERT логируется с new_status=new'
);

update payments set status = 'in_progress' where id = :'pid';
update payments set status = 'paid'        where id = :'pid';
update payments set payee  = 'PA2'         where id = :'pid';  -- не-статусное: не логируется

-- 2) ровно 2 записи смены статуса
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid' and action = 'UPDATE'),
  2,
  'ровно 2 UPDATE-записи (no-op изменение не логируется)'
);

-- 3) переходы в правильном порядке
select is(
  (select array_agg(old_status || '->' || new_status order by changed_at)
     from payments_audit where payment_id = :'pid' and action = 'UPDATE'),
  array['new->in_progress','in_progress->paid'],
  'переходы статуса записаны по порядку'
);

delete from payments where id = :'pid';

-- 4) удаление залогировано
select is(
  (select old_status from payments_audit where payment_id = :'pid' and action = 'DELETE'),
  'paid',
  'DELETE логируется с old_status=paid'
);

-- 5) всего 4 записи по платежу
select is(
  (select count(*)::int from payments_audit where payment_id = :'pid'),
  4,
  'всего 4 записи журнала (insert + 2 смены + delete)'
);

-- 6) anon не имеет доступа к журналу
select ok(
  not has_table_privilege('anon', 'public.payments_audit', 'SELECT'),
  'anon без SELECT на payments_audit'
);

select * from finish();
rollback;
