-- pgTAP: журнал отказов доставки и утренняя рассылка (M4.4, M4.5, M4.6).
--
-- Ради чего тест написан:
--   1) личная задача бухгалтера не должна утром уходить другому бухгалтеру —
--      в очереди она видна только автору и админу, а рассылка это правило
--      обходила и слала всем всё;
--   2) журнал отказов бесполезен, если в него можно заглянуть снаружи или
--      если счётчик врёт: на нём висит внешний сторож;
--   3) получатели рассылки должны браться из `staff`, а не из тела функции,
--      где их было двое из трёх.

begin;
select plan(16);

insert into auth.users (id) values
  ('000000aa-0000-0000-0000-0000000000aa'),
  ('000000bb-0000-0000-0000-0000000000bb');

insert into staff (id, name, is_admin, telegram_id) values
  ('000000aa-0000-0000-0000-0000000000aa', 'Анна',  false, 111111),
  ('000000bb-0000-0000-0000-0000000000bb', 'Борис', false, null);

insert into clients (id, name, token, staff_id)
  values ('aaaa0000-aaaa-0000-aaaa-000000000000', 'Рассылка Ко', 'tokDaily',
          '000000aa-0000-0000-0000-0000000000aa');

-- ---- 1-3) журнал отказов закрыт снаружи ----
select ok((select relrowsecurity from pg_class where oid = 'public.notify_failures'::regclass),
          'RLS включён на notify_failures');
select ok(not has_table_privilege('anon', 'public.notify_failures', 'SELECT'),
          'anon не читает журнал отказов');
select ok(not has_table_privilege('authenticated', 'public.notify_failures', 'SELECT'),
          'вошедший сотрудник тоже не читает журнал напрямую');

-- ---- 4-7) счётчик отказов ----
-- Журнал чистим внутри транзакции: иначе тест зависит от того, что в него
-- успели написать до нас (например, ручная проверка функций на стенде), и
-- краснеет не по делу. Откат вернёт всё как было.
delete from notify_failures;

select is(notify_failures_recent(24), 0, 'пока отказов нет — ноль');

insert into notify_failures (fn, branch, payment_id, chat_id, detail) values
  ('notify-client', 'статус', 'p1', '111', '400 chat not found'),
  ('notify-payment', 'новая заявка', 'p2', '222', '429 too many requests');

select is(notify_failures_recent(24), 2, 'считает свежие отказы');

-- Старую запись за окно не берём: иначе сторож будет вечно красным из-за
-- давно разобранного инцидента.
insert into notify_failures (at, fn, branch, detail)
  values (now() - interval '3 days', 'notify-client', 'статус', 'старое');
select is(notify_failures_recent(24), 2, 'вчерашнее окно не тянет старые записи');
select is(notify_failures_recent(96), 3, 'окно шире — видно и старую запись');
-- Окно ограничено неделей: запрос на 10 000 часов не превращается в
-- «посчитай весь журнал целиком».
select is(notify_failures_recent(10000), notify_failures_recent(168),
          'слишком широкое окно подрезается до недели');

-- Счётчик открыт наружу намеренно: он отдаёт число и ничего больше.
select ok(has_function_privilege('anon', 'public.notify_failures_recent(integer)', 'EXECUTE'),
          'сторож может звать счётчик публичным ключом');

-- ---- 8-9) кому уходит рассылка ----
select is(
  (select count(*)::int from daily_reminder_targets()),
  1,
  'в получателях только тот, у кого проставлен telegram_id'
);
select is(
  (select chat_id from daily_reminder_targets()),
  '111111',
  'chat_id берётся из staff, а не из тела функции'
);

-- ---- 10-14) личные задачи в рассылке ----
-- Заявка клиента и две личные задачи разных бухгалтеров, все на сегодня.
insert into payments (id, client, client_id, payee, amount, requisites, due, recurrence,
                      purpose, status, need_receipt, created_at)
  values ('dailyC', 'Рассылка Ко', 'aaaa0000-aaaa-0000-aaaa-000000000000', 'Белтелеком',
          100, 'УНП 1', (now() at time zone 'Europe/Minsk')::date, 'once', 'Связь', 'new', false, now());

insert into payments (id, client, client_id, created_by_staff, payee, amount, requisites, due,
                      recurrence, purpose, status, need_receipt, created_at)
  values
  ('dailyA', 'Личное · Анна',  null, '000000aa-0000-0000-0000-0000000000aa', 'Задача Анны',
   200, '', (now() at time zone 'Europe/Minsk')::date, 'once', '', 'new', false, now()),
  ('dailyB', 'Личное · Борис', null, '000000bb-0000-0000-0000-0000000000bb', 'Задача Бориса',
   300, '', (now() at time zone 'Europe/Minsk')::date, 'once', '', 'new', false, now());

select ok(daily_reminder_message() like '%Белтелеком%',
          'заявка клиента в общем письме есть');
select ok(daily_reminder_message() not like '%Задача Анны%',
          'в общем письме личных задач нет вовсе');

select ok(daily_reminder_message('000000aa-0000-0000-0000-0000000000aa') like '%Задача Анны%',
          'свою личную задачу человек в письме видит');
select ok(daily_reminder_message('000000aa-0000-0000-0000-0000000000aa') not like '%Задача Бориса%',
          'чужую личную задачу — нет, ради этого всё и делалось');
select ok(daily_reminder_message('000000aa-0000-0000-0000-0000000000aa') like '%Белтелеком%',
          'заявки клиентов при этом на месте');

select * from finish();
rollback;
