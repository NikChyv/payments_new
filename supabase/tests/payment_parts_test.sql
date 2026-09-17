-- pgTAP: оплата по частям (миграция 20260917000002, решения — REDESIGN.md §5а).
--
-- Вызовы идут под ролью authenticated, а не суперпользователем теста: pay_part
-- и undo_part — security invoker, и доступ к чужой заявке закрывает RLS. Под
-- суперпользователем RLS не действует, и тест «чужую заявку оплатить нельзя»
-- был бы зелёным при любом коде.

begin;
select plan(40);

insert into auth.users (id) values
  ('0000aaaa-0000-0000-0000-00000000000a'),
  ('0000bbbb-0000-0000-0000-00000000000b');
insert into staff (id, name, is_admin) values
  ('0000aaaa-0000-0000-0000-00000000000a', 'Валентина', false),
  ('0000bbbb-0000-0000-0000-00000000000b', 'Татьяна',   false);
insert into clients (id, name, token, staff_id) values
  ('aaaa0000-aaaa-0000-aaaa-000000000000', 'Часть Ко', 'tokParts', '0000aaaa-0000-0000-0000-00000000000a');

select submit_payment('tokParts', 'Аренда офиса', 1000, 'УНП 190000001',
  next_working_day(current_date + 1), 'monthly', 'Аренда', false, null, null) as pid \gset
select due as due0 from payments where id = :'pid' \gset
select next_working_day(current_date + 5) as due1 \gset
-- ближайшая суббота после завтра — будущий выходной
select (current_date + ((6 - extract(isodow from current_date)::int + 7) % 7) + 7) as saturday \gset

select is((select parts from payments where id = :'pid'), '[]'::jsonb, 'у новой заявки частей нет');
select is((select paid_amount from payments where id = :'pid'), 0::numeric, 'оплачено ноль');

-- ---------------------------------------------------------------- первая часть
set local request.jwt.claims = '{"sub":"0000aaaa-0000-0000-0000-00000000000a","role":"authenticated"}';
set local role authenticated;

select lives_ok(format($$ select pay_part(%L, 300, %L::date, 0) $$, :'pid', :'due1'),
  'бухгалтер клиента записывает часть');
select is((select paid_amount from payments where id = :'pid'), 300::numeric, 'оплачено 300');
select is((select status from payments where id = :'pid'), 'in_progress',
  'остаток больше нуля — заявка в работе, а не «оплачено»');
select is((select due from payments where id = :'pid'), :'due1'::date, 'срок — дата остатка');
select is((select amount from payments where id = :'pid'), 1000::numeric, 'сумма заявки осталась исходной');
select is((select jsonb_array_length(parts) from payments where id = :'pid'), 1, 'часть записана в историю');
select is((select parts -> 0 ->> 'due_before' from payments where id = :'pid'), :'due0',
  'в части запомнена исходная дата');
select is((select parts -> 0 ->> 'by_name' from payments where id = :'pid'), 'Валентина',
  'автор части взят из JWT');
select is((select parts -> 0 ->> 'due_after' from payments where id = :'pid'), :'due1',
  'в части записана новая дата остатка');

-- ---------------------------------------------------------------- отказы
select throws_ok(format($$ select pay_part(%L, 100, %L::date, 0) $$, :'pid', :'due1'),
  'Заявку тем временем изменили — обновите экран',
  'часть поверх чужой части не записывается (видел 0, а уже 300)');
select throws_ok(format($$ select pay_part(%L, 100, null, 300) $$, :'pid'),
  'Укажите дату оплаты остатка', 'остаток есть — без даты нельзя');
select throws_ok(format($$ select pay_part(%L, 0, %L::date, 300) $$, :'pid', :'due1'),
  'Сумма части должна быть больше нуля', 'нулевая часть не записывается');
select throws_ok(format($$ select pay_part(%L, 100, %L::date, 300) $$, :'pid', :'saturday'),
  'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
  'дата остатка проходит рабочий график');
select throws_ok(format($$ update payments set paid_amount = 0, parts = '[]' where id = %L $$, :'pid'),
  'Части оплаты меняются только через pay_part / undo_part',
  'прямой update частей от бухгалтера запрещён');
select throws_ok($$ insert into payments (id, client_id, client, payee, amount, due, recurrence, status, parts, paid_amount)
                   values ('parts-forged', 'aaaa0000-aaaa-0000-aaaa-000000000000', 'Часть Ко', 'X', 10,
                           current_date + 30, 'once', 'new', '[{"amount":10}]', 10) $$,
  'Части оплаты записываются только через pay_part',
  'новая заявка с готовыми частями не заводится');

-- чужой бухгалтер заявку не видит — RLS
set local request.jwt.claims = '{"sub":"0000bbbb-0000-0000-0000-00000000000b","role":"authenticated"}';
select throws_ok(format($$ select pay_part(%L, 100, %L::date, 300) $$, :'pid', :'due1'),
  'Заявка не найдена или не ваша', 'бухгалтер чужого клиента часть не записывает');
set local request.jwt.claims = '{"sub":"0000aaaa-0000-0000-0000-00000000000a","role":"authenticated"}';

-- ---------------------------------------------------------------- финальная часть
select lives_ok(format($$ select pay_part(%L, 700, null, 300) $$, :'pid'),
  'остаток оплачен — дата не нужна');
select is((select status from payments where id = :'pid'), 'paid', 'оплачено целиком — «оплачено»');
select is((select due from payments where id = :'pid'), :'due1'::date, 'при полной оплате срок не трогаем');
select is((select parts -> 1 ->> 'due_after' from payments where id = :'pid'), null,
  'у финальной части новой даты нет');
select throws_ok(format($$ select pay_part(%L, 1, null, 1000) $$, :'pid'),
  'Заявка уже оплачена — часть не записана', 'по оплаченной часть не пишется');

-- ---------------------------------------------------------------- отмена
select parts -> 0 ->> 'id' as part1, parts -> 1 ->> 'id' as part2 from payments where id = :'pid' \gset
select throws_ok(format($$ select undo_part(%L, %L) $$, :'pid', :'part1'),
  'Отменить можно только последнюю часть — обновите экран', 'отменяется только последняя часть');

reset role;
update payments set staff_files = jsonb_build_array(
  jsonb_build_object('url', 'https://x/p2.pdf', 'name', 'п2.pdf', 'part_id', :'part2'),
  jsonb_build_object('url', 'https://x/other.pdf', 'name', 'прочее.pdf'))
 where id = :'pid';
set local role authenticated;

select lives_ok(format($$ select undo_part(%L, %L) $$, :'pid', :'part2'), 'последняя часть отменяется');
select is((select status from payments where id = :'pid'), 'in_progress', 'после отмены финальной — снова в работе');
select is((select paid_amount from payments where id = :'pid'), 300::numeric, 'оплачено снова 300');
select is((select jsonb_array_length(parts) from payments where id = :'pid'), 1, 'ранняя часть осталась');
select is((select due from payments where id = :'pid'), :'due1'::date, 'срок — как был до отменённой части');
select is((select staff_files -> 0 ? 'part_id' from payments where id = :'pid'), false,
  'документ отменённой части остался, привязка снята');
select is((select jsonb_array_length(staff_files) from payments where id = :'pid'), 2, 'документы не удалены');

-- переплата разрешена
select lives_ok(format($$ select pay_part(%L, 900, null, 300) $$, :'pid'), 'переплата записывается');
select is((select paid_amount from payments where id = :'pid'), 1200::numeric, 'оплачено больше суммы заявки');

-- по закрытой — отказ
reset role;
update payments set status = 'sent' where id = :'pid';
set local role authenticated;
select parts -> 1 ->> 'id' as part3 from payments where id = :'pid' \gset
select throws_ok(format($$ select undo_part(%L, %L) $$, :'pid', :'part3'),
  'Заявка закрыта — сначала верните её в «Оплачено»', 'по закрытой заявке часть не отменяется');

-- ---------------------------------------------------------------- журнал и инвариант
-- служебный путь (SQL Editor): ни роли, ни JWT сотрудника
reset role;
set local request.jwt.claims = '';
select is((select count(*)::int from payments_audit where payment_id = :'pid' and action = 'PART'), 3,
  'каждая часть — запись PART в журнале');
select is((select count(*)::int from payments_audit where payment_id = :'pid' and action = 'PART_UNDO'), 1,
  'отмена части — запись PART_UNDO');
select is((select count(*)::int from payments_audit where payment_id = :'pid' and action = 'EDIT'), 0,
  'смена даты частью не дублируется записью EDIT');
select throws_ok(format($$ update payments set paid_amount = 5 where id = %L $$, :'pid'),
  'paid_amount (5) не совпадает с суммой частей (1200)',
  'даже служебный путь не разводит оплаченное и части');

-- ---------------------------------------------------------------- утреннее письмо — по остатку
insert into payments (id, client_id, client, payee, amount, due, recurrence, status, parts, paid_amount)
values ('parts-today', 'aaaa0000-aaaa-0000-aaaa-000000000000', 'Часть Ко', 'Связьинвест', 1000,
        (now() at time zone 'Europe/Minsk')::date, 'once', 'in_progress',
        '[{"id":"x","amount":400}]', 400);
select matches(daily_reminder_message('0000aaaa-0000-0000-0000-00000000000a'),
  'Связьинвест</b> — 600\.00 Br \(остаток из 1000\.00\)',
  'утреннее письмо показывает остаток, а не полную сумму');

-- «Закрыть с недоплатой» — обычная смена статуса, части не трогает: бухгалтеру
-- её не запрещают
set local request.jwt.claims = '{"sub":"0000aaaa-0000-0000-0000-00000000000a","role":"authenticated"}';
set local role authenticated;
select lives_ok($$ update payments set status = 'paid' where id = 'parts-today' and status = 'in_progress' and paid_amount = 400 $$,
  'закрыть с недоплатой — точечный update статуса проходит');

select * from finish();
rollback;
