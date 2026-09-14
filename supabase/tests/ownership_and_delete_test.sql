-- pgTAP: принадлежность заявки и след удаления (M6.3, M6.4).
--
-- Ради чего тест написан:
--   1) бухгалтер не должен иметь возможности превратить заявку клиента в свою
--      личную — она пропадала бы из очереди коллег и из кабинета клиента. При
--      этом обычная работа бухгалтера (правка, смена статуса) и служебные пути
--      (функции под service_role, SQL Editor) ломаться не должны;
--   2) удалённая заявка должна оставлять в журнале всё, что в ней было, —
--      иначе оплаченный платёж можно стереть без следа.
--
-- Тест идёт под postgres, поэтому RLS здесь не участвует: проверяется именно
-- триггер, а роль изображается через request.jwt.claims.

begin;
select plan(12);

insert into auth.users (id) values
  ('00000f11-0000-0000-0000-000000000f11'),
  ('00000f22-0000-0000-0000-000000000f22');

insert into staff (id, name, is_admin) values
  ('00000f11-0000-0000-0000-000000000f11', 'Бухгалтер', false),
  ('00000f22-0000-0000-0000-000000000f22', 'Админ',     true);

insert into clients (id, name, token, staff_id) values
  ('f0000000-0000-0000-0000-00000000000a', 'Фирма', 'tokOwn', '00000f11-0000-0000-0000-000000000f11');

insert into payments (id, client, client_id, payee, amount, requisites, due, recurrence,
                      purpose, status, need_receipt, files, created_at) values
  ('own1', 'Фирма', 'f0000000-0000-0000-0000-00000000000a', 'Белтелеком', 214.60, 'УНП 100633744',
   next_working_day(current_date + 1), 'once', 'Связь', 'paid', true,
   '[{"url":"https://x/schet.pdf","name":"счёт.pdf"}]'::jsonb, now());

-- ---- 1-4) вошедший бухгалтер ----
set local request.jwt.claims = '{"sub":"00000f11-0000-0000-0000-000000000f11","role":"authenticated"}';

select throws_ok(
  $$ update payments set client_id = null, created_by_staff = '00000f11-0000-0000-0000-000000000f11'
     where id = 'own1' $$,
  'P0001',
  'Менять клиента или автора заявки может только администратор',
  'бухгалтер не уводит заявку клиента в свои личные — ради этого всё и делалось'
);
select throws_ok(
  $$ update payments set created_by_staff = '00000f11-0000-0000-0000-000000000f11' where id = 'own1' $$,
  'P0001',
  'Менять клиента или автора заявки может только администратор',
  'и автора заявки себе не приписывает — иначе клиент перестал бы получать уведомления о правках'
);
select lives_ok(
  $$ update payments set payee = 'Белтелеком РУП' where id = 'own1' $$,
  'обычная правка бухгалтера проходит'
);
select lives_ok(
  $$ update payments set status = 'sent' where id = 'own1' $$,
  'смена статуса тоже проходит'
);

-- ---- 5) админ ----
set local request.jwt.claims = '{"sub":"00000f22-0000-0000-0000-000000000f22","role":"authenticated"}';
select lives_ok(
  $$ update payments set created_by_staff = '00000f22-0000-0000-0000-000000000f22' where id = 'own1' $$,
  'админ менять автора вправе'
);

-- ---- 6-7) служебные пути ----
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$ update payments set created_by_staff = null where id = 'own1' $$,
  'функции и бот под service_role не упираются в запрет'
);

set local request.jwt.claims = '';
select lives_ok(
  $$ update payments set created_by_staff = '00000f11-0000-0000-0000-000000000f11' where id = 'own1' $$,
  'SQL Editor без JWT — тоже, это рабочий инструмент админа'
);

select is(
  (select client_id from payments where id = 'own1'),
  'f0000000-0000-0000-0000-00000000000a'::uuid,
  'после всех попыток заявка по-прежнему у своего клиента'
);

-- ---- 9-12) удаление оставляет снимок ----
set local request.jwt.claims = '{"sub":"00000f11-0000-0000-0000-000000000f11","role":"authenticated"}';
delete from payments where id = 'own1';

select is(
  (select changes -> 'deleted' ->> 'payee' from payments_audit
    where payment_id = 'own1' and action = 'DELETE' order by id desc limit 1),
  'Белтелеком РУП',
  'в журнале остался получатель удалённой заявки'
);
select is(
  (select (changes -> 'deleted' ->> 'amount')::numeric from payments_audit
    where payment_id = 'own1' and action = 'DELETE' order by id desc limit 1),
  214.60,
  'и сумма — оплаченный платёж больше нельзя стереть без следа'
);
select is(
  (select changes -> 'deleted' -> 'files' -> 0 ->> 'url' from payments_audit
    where payment_id = 'own1' and action = 'DELETE' order by id desc limit 1),
  'https://x/schet.pdf',
  'и файлы'
);
select is(
  (select changed_by from payments_audit
    where payment_id = 'own1' and action = 'DELETE' order by id desc limit 1),
  '00000f11-0000-0000-0000-000000000f11'::uuid,
  'и кто удалил'
);

select * from finish();
rollback;
