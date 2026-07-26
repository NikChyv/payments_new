-- pgTAP: перенос даты платежа по рабочему графику (пн–пт до 17:00).

begin;
select plan(9);

-- ---- next_working_day ----
-- 2026-07-24 — пятница, 25 сб, 26 вс, 27 пн
select is( next_working_day(date '2026-07-24'), date '2026-07-27', 'после пятницы — понедельник' );
select is( next_working_day(date '2026-07-25'), date '2026-07-27', 'после субботы — понедельник' );
select is( next_working_day(date '2026-07-26'), date '2026-07-27', 'после воскресенья — понедельник' );
select is( next_working_day(date '2026-07-27'), date '2026-07-28', 'после понедельника — вторник' );

-- ---- adjust_due_date: будущее ----
-- ближайшая будущая суббота/воскресенье и будний день считаются от «сегодня»
select throws_ok(
  format($$ select adjust_due_date(date %L) $$,
         (current_date + (13 - extract(isodow from current_date))::int)),  -- ближайшая будущая суббота
  'P0001',
  'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
  'будущая суббота — ошибка'
);

select throws_ok(
  format($$ select adjust_due_date(date %L) $$,
         (current_date + (14 - extract(isodow from current_date))::int)),  -- ближайшее будущее воскресенье
  'P0001',
  'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
  'будущее воскресенье — ошибка'
);

-- будущий будний день проходит без изменений
select is(
  adjust_due_date(current_date + (15 - extract(isodow from current_date))::int),
  (current_date + (15 - extract(isodow from current_date))::int)::date,
  'будущий будний день не меняется'
);

-- ---- adjust_due_date: прошлое не трогаем ----
select is( adjust_due_date(current_date - 10), current_date - 10, 'прошлая дата остаётся как есть' );
select is( adjust_due_date(current_date - 3),  current_date - 3,  'прошлая дата (в т.ч. выходной) не меняется' );

select * from finish();
rollback;
