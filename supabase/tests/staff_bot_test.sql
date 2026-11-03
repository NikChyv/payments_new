-- pgTAP: бухгалтер заводит заявку клиента через бота (03.11).
--
-- Бот ходит в базу под service_role, RLS его не держит. Поэтому всё, что
-- отделяет бухгалтера от чужих клиентов, — staff_bot_clients и проверка внутри
-- staff_bot_submit. Проверяем то же правило, что у очереди: бухгалтер — свои,
-- админ — все, общий Telegram — фирмы всех его учёток; и что автором заявки
-- становится бухгалтер этой фирмы, а не случайная учётка общего чата.
begin;
select plan(22);

insert into auth.users (id) values
  ('00000b01-0000-0000-0000-000000000b01'),
  ('00000b02-0000-0000-0000-000000000b02'),
  ('00000b03-0000-0000-0000-000000000b03'),
  ('00000b04-0000-0000-0000-000000000b04'),
  ('00000b05-0000-0000-0000-000000000b05');

-- Валентина и Елена — один Telegram; у Татьяны свой; админ отдельно; у
-- последнего Telegram не внесён: «нет номера» не должно открывать ничего.
insert into staff (id, name, is_admin, telegram_id) values
  ('00000b01-0000-0000-0000-000000000b01', 'Валентина', false, 770001),
  ('00000b02-0000-0000-0000-000000000b02', 'Елена',     false, 770001),
  ('00000b03-0000-0000-0000-000000000b03', 'Татьяна',   false, 770002),
  ('00000b04-0000-0000-0000-000000000b04', 'Админ',     true,  770003),
  ('00000b05-0000-0000-0000-000000000b05', 'Без номера', false, null);

insert into clients (id, name, token, staff_id) values
  ('b0000000-0000-0000-0000-00000000000a', 'Фирма Валентины', 'tokSbV', '00000b01-0000-0000-0000-000000000b01'),
  ('b0000000-0000-0000-0000-00000000000b', 'Фирма Елены',     'tokSbE', '00000b02-0000-0000-0000-000000000b02'),
  ('b0000000-0000-0000-0000-00000000000c', 'Фирма Татьяны',   'tokSbT', '00000b03-0000-0000-0000-000000000b03'),
  ('b0000000-0000-0000-0000-00000000000d', 'Ничья фирма',     'tokSbN', null),
  ('b0000000-0000-0000-0000-00000000000e', 'Фирма без номера', 'tokSbX', '00000b05-0000-0000-0000-000000000b05');

-- ---- 1-6) какие фирмы видит чат ----
select is((select array_agg(client_name order by client_name) from staff_bot_clients(770001)),
          array['Фирма Валентины', 'Фирма Елены'],
          'общий Telegram — фирмы обеих учёток, и только их');
select is((select staff_name from staff_bot_clients(770001)
            where client_id = 'b0000000-0000-0000-0000-00000000000b'),
          'Елена', 'у фирмы назван её бухгалтер — по нему бот группирует кнопки');
select is((select array_agg(client_name) from staff_bot_clients(770002)),
          array['Фирма Татьяны'], 'отдельный Telegram — только свои фирмы');
select is((select count(*)::int from staff_bot_clients(770003)),
          (select count(*)::int from clients), 'админ видит всех клиентов');
select is((select count(*)::int from staff_bot_clients(770003) where staff_id is null and
                  client_id = 'b0000000-0000-0000-0000-00000000000d'),
          1, 'у админа и фирма без бухгалтера');
select is((select count(*)::int from staff_bot_clients(999999)) + (select count(*)::int from staff_bot_clients(null)),
          0, 'чужой Telegram и пустой номер — ни одной фирмы');

-- ---- 7-13) заявка от общего чата по фирме Елены ----
select lives_ok($$
  select set_config('t.id', staff_bot_submit(770001, 'b0000000-0000-0000-0000-00000000000b',
                                             next_working_day(current_date + 3),
                                             'https://x.test/a.pdf', 'Счёт №5.pdf', '  аренда, ноябрь  '), true)
$$, 'общий чат заводит заявку по фирме одной из своих учёток');
select is((select created_by_staff from payments where id = current_setting('t.id')),
          '00000b02-0000-0000-0000-000000000b02'::uuid,
          'автор — бухгалтер этой фирмы (Елена), а не первая учётка чата');
select is((select client_id::text || ' | ' || client from payments where id = current_setting('t.id')),
          'b0000000-0000-0000-0000-00000000000b | Фирма Елены', 'заявка у своей фирмы, имя скопировано');
select is((select payee from payments where id = current_setting('t.id')),
          'По документу: Счёт №5.pdf', 'получатель — по файлу, как у заявки клиента по документу');
select ok((select amount is null and status = 'new' and recurrence = 'once' and not need_receipt
             from payments where id = current_setting('t.id')),
          'сумма неизвестна (NULL), статус «принята», разовый');
select is((select due from payments where id = current_setting('t.id')),
          next_working_day(current_date + 3), 'выбранная дата легла как есть');
select ok((select file_url = 'https://x.test/a.pdf' and jsonb_array_length(files) = 1
                  and purpose = 'аренда, ноябрь'
             from payments where id = current_setting('t.id')),
          'файл во вложениях, зеркало file_url заполнено, подпись — в назначении без пробелов по краям');

-- ---- 14-16) админ ----
-- id сохраняем через set_config: функция в where вызывалась бы на каждой строке
select set_config('t.a', staff_bot_submit(770003, 'b0000000-0000-0000-0000-00000000000a',
                                          null, 'https://x.test/b.pdf', 'b.pdf', ''), true);
select set_config('t.c', staff_bot_submit(770003, 'b0000000-0000-0000-0000-00000000000d',
                                          null, 'https://x.test/c.pdf', 'c.pdf', null), true);
select is((select created_by_staff from payments where id = current_setting('t.a')),
          '00000b04-0000-0000-0000-000000000b04'::uuid,
          'админ по чужой фирме — автор админ');
select is((select due from payments where id = current_setting('t.c')),
          adjust_due_date((now() at time zone 'Europe/Minsk')::date),
          'без даты — ближайший рабочий день');
select is((select purpose from payments where id = current_setting('t.a')),
          null, 'пустая подпись — назначение пустое, а не ""');

-- ---- 17-20) отказы ----
select throws_ok($$ select staff_bot_submit(770001, 'b0000000-0000-0000-0000-00000000000c',
                                            null, 'https://x.test/d.pdf', 'd.pdf') $$,
                 'Эта фирма вам недоступна', 'чужая фирма из подделанной кнопки — отказ');
select throws_ok($$ select staff_bot_submit(770001, 'b0000000-0000-0000-0000-00000000000a',
                                            (date_trunc('week', current_date) + interval '12 days')::date,
                                            'https://x.test/e.pdf', 'e.pdf') $$,
                 'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
                 'будущий выходной — отказ, как везде');
select throws_ok($$ select staff_bot_submit(770001, 'b0000000-0000-0000-0000-00000000000a',
                                            null, null, null) $$,
                 'Приложите файл', 'без файла — отказ');
select throws_ok($$ select staff_bot_submit(770001, 'b0000000-0000-0000-0000-00000000000a',
                                            null, 'javascript:alert(1)', 'x.pdf') $$,
                 'Недопустимая ссылка на файл', 'ссылка не http(s) — отказ (is_safe_file_url)');

-- ---- 21-22) у Telegram без номера ничего нет, лишнего не создано ----
select is((select count(*)::int from payments where client_id = 'b0000000-0000-0000-0000-00000000000e'),
          0, 'фирма бухгалтера без Telegram никому из чатов не досталась');
select is((select count(*)::int from payments where client_id::text like 'b0000000-%'),
          3, 'создано ровно три заявки — отказы ничего не записали');

select * from finish();
rollback;
