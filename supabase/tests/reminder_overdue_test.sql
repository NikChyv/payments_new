-- pgTAP: просроченные в утреннем письме (01.10).
--
-- Ради чего тест написан: письмо показывало только заявки на сегодня, и
-- просроченная заявка в него не попадала никогда — вчера она была «на
-- сегодня», а сегодня уже нет. Проверяем, что просрочка приходит отдельным
-- блоком, по тем же правилам адресности, что и сегодняшние, и не теряется при
-- длинном списке.

begin;
select plan(12);

insert into auth.users (id) values
  ('00000e01-0000-0000-0000-000000000e01'),
  ('00000e02-0000-0000-0000-000000000e02'),
  ('00000e03-0000-0000-0000-000000000e03');

insert into staff (id, name, is_admin) values
  ('00000e01-0000-0000-0000-000000000e01', 'Админ просрочки', true),
  ('00000e02-0000-0000-0000-000000000e02', 'Елена',           false),
  ('00000e03-0000-0000-0000-000000000e03', 'Наталья',         false);

insert into clients (id, name, token, staff_id) values
  ('e0000000-0000-0000-0000-00000000000e', 'Фирма Елены',   'tokOverE', '00000e02-0000-0000-0000-000000000e02'),
  ('e0000000-0000-0000-0000-00000000000f', 'Фирма Натальи', 'tokOverN', '00000e03-0000-0000-0000-000000000e03');

-- Чужие заявки из сида не должны мешать: письмо админу видит всех.
delete from payments;

-- ---- 1-2) только сегодняшние — блока просрочки нет ----
insert into payments (id, client, client_id, payee, amount, due, recurrence, status, created_at) values
  ('ov-today', 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Сегодняшний',
   100, (now() at time zone 'Europe/Minsk')::date, 'once', 'new', now());

select ok(daily_reminder_message('00000e02-0000-0000-0000-000000000e02') like '%Сегодняшний%',
          'сегодняшняя заявка в письме, как и раньше');
select ok(daily_reminder_message('00000e02-0000-0000-0000-000000000e02') not like '%Просрочено%',
          'нет просрочки — нет и блока, письмо не шумит');

-- ---- 3-7) просрочка Елены ----
insert into payments (id, client, client_id, payee, amount, due, recurrence, status, created_at,
                      parts, paid_amount) values
  ('ov-old', 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Белмедпоставка',
   1576.11, (now() at time zone 'Europe/Minsk')::date - 19, 'once', 'new', now(), '[]', 0),
  ('ov-new', 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Полиграфия ЛЕО',
   500, (now() at time zone 'Europe/Minsk')::date - 1, 'once', 'in_progress', now(),
   '[{"id":"p1","amount":200}]', 200),
  ('ov-done', 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Давно оплачено',
   300, (now() at time zone 'Europe/Minsk')::date - 5, 'once', 'paid', now(), '[]', 0),
  ('ov-nat', 'Фирма Натальи', 'e0000000-0000-0000-0000-00000000000f', 'Чужая просрочка',
   700, (now() at time zone 'Europe/Minsk')::date - 3, 'once', 'new', now(), '[]', 0);

select matches(daily_reminder_message('00000e02-0000-0000-0000-000000000e02'),
               'Просрочено: 2</b>',
               'у Елены отдельный блок «Просрочено» и в нём ровно её две заявки');
select matches(daily_reminder_message('00000e02-0000-0000-0000-000000000e02'),
               '1\. <b>Белмедпоставка</b> — 1576\.11 Br\n   👤 Фирма Елены · с \d\d\.\d\d, 19 дн\.',
               'давняя просрочка сверху: остаток, клиент, с какого числа и сколько дней');
select matches(daily_reminder_message('00000e02-0000-0000-0000-000000000e02'),
               'Полиграфия ЛЕО</b> — 300\.00 Br \(остаток из 500\.00\)',
               'частично оплаченная — по остатку, как и сегодняшние');
select ok(daily_reminder_message('00000e02-0000-0000-0000-000000000e02') not like '%Давно оплачено%',
          'оплаченная просроченной не считается');
select ok(daily_reminder_message('00000e02-0000-0000-0000-000000000e02') not like '%Чужая просрочка%',
          'просрочка клиента Натальи Елене не уходит');

-- ---- 8-9) адресность для Натальи и админа ----
select ok(daily_reminder_message('00000e03-0000-0000-0000-000000000e03') like '%Просрочено: 1</b>%Чужая просрочка%',
          'Наталья получает только свою просрочку');
select ok(daily_reminder_message('00000e01-0000-0000-0000-000000000e01') like '%Просрочено: 3</b>%',
          'админ видит просрочку всех бухгалтеров');

-- ---- 10) сегодня пусто, а просрочка есть ----
delete from payments where id = 'ov-today';
select matches(daily_reminder_message('00000e02-0000-0000-0000-000000000e02'),
               'На сегодня платежей нет\.\n\n⚠️ <b>Просрочено: 2</b>',
               'нечего платить сегодня — письмо всё равно напоминает о просрочке, без «🎉»');

-- ---- 11-12) длинный список: лимит Telegram и блок просрочки не теряется ----
insert into payments (id, client, client_id, payee, amount, due, recurrence, status, created_at, purpose)
select 'ov-many-' || g, 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Получатель ' || g,
       100 + g, (now() at time zone 'Europe/Minsk')::date, 'once', 'new', now(), repeat('назначение ', 60)
from generate_series(1, 40) g;
insert into payments (id, client, client_id, payee, amount, due, recurrence, status, created_at)
select 'ov-late-' || g, 'Фирма Елены', 'e0000000-0000-0000-0000-00000000000e', 'Просроченный ' || g,
       100 + g, (now() at time zone 'Europe/Minsk')::date - 2, 'once', 'new', now()
from generate_series(1, 60) g;

select cmp_ok(length(daily_reminder_message('00000e02-0000-0000-0000-000000000e02')), '<=', 4096,
              '40 сегодняшних и 62 просроченных укладываются в лимит Telegram');
select matches(daily_reminder_message('00000e02-0000-0000-0000-000000000e02'),
               'Просрочено: 62</b>[\s\S]*…и ещё \d+ просроченных — в приложении',
               'при длинном списке блок просрочки всё равно есть, а не влезшие посчитаны');

select * from finish();
rollback;
