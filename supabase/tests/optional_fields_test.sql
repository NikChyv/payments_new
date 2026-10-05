-- pgTAP: с приложенным документом получатель, сумма и дата необязательны (05.10).
--
-- Ради чего тест написан: правило «либо поля, либо документ» живёт в одном
-- триггере на все двери, и ошибиться в нём можно в обе стороны. Строже нужного —
-- клиент со счётом снова упрётся в «укажите сумму». Мягче нужного — в очередь
-- поедут пустые заявки без документа, по которым платить нечего. Отдельно
-- проверяем то, что ломается молча: копия повторяющегося платежа без суммы,
-- часть оплаты по заявке без суммы и «0.00 Br» в утреннем письме.

begin;
select plan(24);

insert into auth.users (id) values ('0000dddd-0000-0000-0000-00000000000d');
insert into staff (id, name, is_admin)
  values ('0000dddd-0000-0000-0000-00000000000d', 'Елена', false);
insert into clients (id, name, token, staff_id) values
  ('d0c00000-0000-0000-0000-000000000001', 'Документ Ко',   'tokDoc1', '0000dddd-0000-0000-0000-00000000000d'),
  ('d0c00000-0000-0000-0000-000000000002', 'Без документа', 'tokDoc2', '0000dddd-0000-0000-0000-00000000000d');

\set f1 '[{"url":"https://example.test/storage/v1/object/public/files/aa/schet-118.pdf","name":"schet-118.pdf"}]'

-- ---- 1-3) без документа поля обязательны, как раньше ----
select throws_ok(
  $$ select submit_payment('tokDoc2', null, 100, null, current_date, 'once', null, false, null, null) $$,
  'P0001', 'Укажите получателя или приложите документ',
  'без документа получатель обязателен');
select throws_ok(
  $$ select submit_payment('tokDoc2', 'Поставщик', null, null, current_date, 'once', null, false, null, null) $$,
  'P0001', 'Укажите сумму или приложите документ',
  'без документа сумма обязательна');
select throws_ok(
  $$ select submit_payment('tokDoc2', 'Поставщик', 100, null, null, 'once', null, false, null, null) $$,
  'P0001', 'Укажите дату платежа или приложите документ',
  'без документа дата обязательна');

-- ---- 4-8) документ приложен — три поля можно не заполнять ----
select submit_payment('tokDoc1', null, null, null, null, 'once', null, false, null, null, :'f1'::jsonb) as did \gset

select is((select payee from payments where id = :'did'), 'По документу: schet-118.pdf',
  'получателя нет — заявка называется по имени файла, а не остаётся безымянной');
select is((select amount from payments where id = :'did'), null::numeric,
  'суммы нет — в базе NULL, а не ноль');
select is((select due from payments where id = :'did'),
          adjust_due_date((now() at time zone 'Europe/Minsk')::date),
  'даты нет — заявка встаёт на ближайший рабочий день');
select is((select status from payments where id = :'did'), 'new', 'заявка в очереди как обычная новая');
select is((select amount from list_payments_by_token('tokDoc1') where id = :'did'), null::numeric,
  'клиент в кабинете получает «сумма неизвестна», а не ноль');

-- ---- 9-11) послабление — только про пустые поля, а не про любые ----
select throws_ok(format(
  $$ select submit_payment('tokDoc1', null, -5, null, null, 'once', null, false, null, null, %L::jsonb) $$, :'f1'),
  'P0001', 'Сумма должна быть больше нуля',
  'с документом отрицательная сумма всё равно не проходит');
select lives_ok(format(
  $$ select submit_payment('tokDoc1', null, 0, null, null, 'once', null, false, null, null, %L::jsonb) $$, :'f1'),
  'ноль от старой вкладки с документом — это «не указано», а не ошибка');
select lives_ok(format(
  $$ select submit_payment('tokDoc1', null, null, null, null, 'once', null, false, null, null, %L::jsonb) $$,
  '[{"url":"https://example.test/storage/v1/object/public/files/bb/x.pdf","name":"' || repeat('я', 300) || '.pdf"}]'),
  'длинное имя файла не роняет заявку');
select cmp_ok((select max(length(payee)) from payments where client_id = 'd0c00000-0000-0000-0000-000000000001'),
  '<=', 200, 'получатель по имени файла обрезан до лимита — уведомление пролезет в Telegram');

-- ---- 13-15) правка клиентом ----
select throws_ok(format(
  $$ select edit_payment_by_token('tokDoc1', %L, 'По документу: schet-118.pdf', null, null, null, 'once', null, false, null, null, '[]'::jsonb) $$, :'did'),
  'P0001', 'Укажите сумму или приложите документ',
  'убрал документ и не указал сумму — правка не проходит: платить стало бы не по чему');
select lives_ok(format(
  $$ select edit_payment_by_token('tokDoc1', %L, 'ИП Лапицкий', 300, null, next_working_day(current_date), 'once', null, false, null, null, '[]'::jsonb) $$, :'did'),
  'убрал документ, но вписал получателя и сумму — обычная заявка');
select is((select amount from payments where id = :'did'), 300::numeric, 'сумма записалась');

-- вернём заявку без суммы для проверок ниже
select lives_ok(format(
  $$ select edit_payment_by_token('tokDoc1', %L, null, null, null, null, 'monthly', null, false, null, null, %L::jsonb) $$,
  :'did', :'f1'), 'клиент заменил данные документом — снова без суммы');

-- ---- 17-18) запись сотрудника и копия повторяющегося ----
select throws_ok(
  $$ insert into payments (id, client_id, client, payee, amount, due, recurrence, status)
     values ('opt-staff', 'd0c00000-0000-0000-0000-000000000001', 'Документ Ко', 'Налог', null,
             current_date, 'once', 'new') $$,
  'P0001', 'Укажите сумму или приложите документ',
  'сотрудник без документа сумму тоже указывает');
select lives_ok(format(
  $$ insert into payments (id, client_id, client, payee, amount, due, recurrence, status, parent_id, auto_created)
     values ('opt-copy', 'd0c00000-0000-0000-0000-000000000001', 'Документ Ко', 'По документу: schet-118.pdf', null,
             current_date + 30, 'monthly', 'new', %L, true) $$, :'did'),
  'копия повторяющегося платежа без суммы создаётся: файлы в копию не идут, а молча пропасть она не должна');

-- ---- 19-21) бухгалтер: оплатить можно, а часть — нельзя ----
set local request.jwt.claims = '{"sub":"0000dddd-0000-0000-0000-00000000000d","role":"authenticated"}';
set local role authenticated;

select throws_ok(format($$ select pay_part(%L, 100, null, 0) $$, :'did'),
  'У заявки не указана сумма — впишите её («Редактировать»), и часть можно будет записать',
  'часть по заявке без суммы не записывается: иначе первая же часть закрыла бы её как оплаченную целиком');
select lives_ok(format($$ update payments set status = 'in_progress' where id = %L and status = 'new' $$, :'did'),
  'в работу заявка без суммы берётся');
select lives_ok(format($$ update payments set status = 'paid' where id = %L and status = 'in_progress' $$, :'did'),
  'и оплачивается как есть — вписывать сумму бухгалтер не обязан');

reset role;
reset request.jwt.claims;

-- ---- 22-24) утреннее письмо ----
delete from payments;
insert into payments (id, client_id, client, payee, amount, due, recurrence, status, files) values
  ('opt-today', 'd0c00000-0000-0000-0000-000000000001', 'Документ Ко', 'По документу: akt.pdf', null,
   (now() at time zone 'Europe/Minsk')::date, 'once', 'new', :'f1'::jsonb),
  ('opt-late', 'd0c00000-0000-0000-0000-000000000001', 'Документ Ко', 'По документу: old.pdf', null,
   (now() at time zone 'Europe/Minsk')::date - 3, 'once', 'new', :'f1'::jsonb),
  ('opt-sum', 'd0c00000-0000-0000-0000-000000000001', 'Документ Ко', 'С суммой', 150,
   (now() at time zone 'Europe/Minsk')::date, 'once', 'new', '[]'::jsonb);

select matches(daily_reminder_message('0000dddd-0000-0000-0000-00000000000d'),
  'По документу: akt\.pdf</b> — сумма в документе',
  'в письме на сегодня — «сумма в документе», а не «0.00 Br»');
select matches(daily_reminder_message('0000dddd-0000-0000-0000-00000000000d'),
  'По документу: old\.pdf</b> — сумма в документе',
  'и в блоке просрочки тоже');
select ok(daily_reminder_message('0000dddd-0000-0000-0000-00000000000d') not like '% 0.00 Br%'
      and daily_reminder_message('0000dddd-0000-0000-0000-00000000000d') like '%С суммой</b> — 150.00 Br%',
  'нулей в письме нет, обычная заявка — с суммой, как раньше');

select * from finish();
rollback;
