-- pgTAP: переписка по заявке (payments.thread).
--
-- Три вещи, ради которых тест написан:
--   1) автор сообщения берётся из JWT, а не из параметра — иначе подписаться
--      бухгалтером сможет кто угодно, кто дотянется до функции;
--   2) файл из ответа клиента попадает во ВЛОЖЕНИЯ ЗАЯВКИ, и зеркало file_url
--      при этом не разъезжается — его читают утренняя рассылка и бот;
--   3) переписка не считается правкой содержимого: иначе каждое сообщение
--      уходило бы клиенту как «бухгалтер изменил вашу заявку» и засоряло журнал.

begin;
select plan(28);

insert into auth.users (id) values ('000000cc-0000-0000-0000-0000000000cc');
insert into staff (id, name, is_admin)
  values ('000000cc-0000-0000-0000-0000000000cc', 'Валентина', false);

insert into clients (id, name, token, staff_id) values
  ('cccc0000-cccc-0000-cccc-000000000000', 'Тред Ко', 'tokThread',
   '000000cc-0000-0000-0000-0000000000cc'),
  ('cccc0000-cccc-0000-cccc-000000000001', 'Чужая Ко', 'tokOther',
   '000000cc-0000-0000-0000-0000000000cc');

-- Заявка со счётом от клиента. Дату берём через next_working_day: жёсткое
-- current_date + N попадает на выходной и роняет submit_payment вместе с CI.
select submit_payment('tokThread', 'Стройтехснаб', 1840, 'УНП 191847213',
  next_working_day(current_date + 1), 'once', 'Материалы', false, null, null,
  '[{"url":"https://x/nakladnaya.pdf","name":"накладная.pdf"}]'::jsonb) as pid \gset

-- Вторая заявка, намеренно без файлов: на ней проверяем, что зеркало file_url
-- проставляется, когда первый файл появляется именно из ответа.
select submit_payment('tokThread', 'Белтелеком', 214.60, 'УНП 100633744',
  next_working_day(current_date + 1), 'once', 'Связь', false, null, null) as pid2 \gset

-- ---- 1-3) значения по умолчанию ----
select is((select thread from payments where id = :'pid'), '[]'::jsonb,
  'у новой заявки переписки нет');
select is((select client_thread_notified from payments where id = :'pid'), 0,
  'счётчик отправленного клиенту начинается с нуля');
select is((select staff_thread_notified from payments where id = :'pid'), 0,
  'счётчик отправленного бухгалтерам начинается с нуля');

-- ---- 4-7) бухгалтер задаёт вопрос ----
set local request.jwt.claims = '{"sub":"000000cc-0000-0000-0000-0000000000cc","role":"authenticated"}';
select post_staff_message(:'pid', 'Прислали накладную — нужен счёт с номером.');

select is((select jsonb_array_length(thread) from payments where id = :'pid'), 1,
  'вопрос записан в переписку');
-- ради этого весь блок: имя не приходит параметром, его негде подделать
select is((select thread -> 0 ->> 'author' from payments where id = :'pid'), 'Валентина',
  'автор сообщения взят из JWT, а не из параметра');
select is((select thread -> 0 ->> 'who' from payments where id = :'pid'), 'staff',
  'сообщение помечено как сообщение сотрудника');
select is((select thread -> 0 ->> 'kind' from payments where id = :'pid'), 'question',
  'по умолчанию это вопрос, а не напоминание');

-- ---- 8-11) что функция не пропускает ----
select throws_ok(
  format($$ select post_staff_message(%L, '   ') $$, :'pid'),
  'Пустое сообщение', 'пустой вопрос не отправляется');
select throws_ok(
  format($$ select post_staff_message(%L, repeat('я', 1001)) $$, :'pid'),
  'Сообщение длиннее 1000 символов', 'простыня в 1001 символ не проходит');
select throws_ok(
  format($$ select post_staff_message(%L, 'текст', 'shout') $$, :'pid'),
  'Неизвестный тип сообщения: shout', 'выдуманный тип сообщения отклонён');

set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  format($$ select post_staff_message(%L, 'я бухгалтер, честное слово') $$, :'pid'),
  'Писать клиенту может только сотрудник', 'аноним не пишет от имени бухгалтера');

-- ---- 12-13) переписка — не правка содержимого ----
-- Если thread попадёт в payment_content_changed, каждое сообщение уедет клиенту
-- как «бухгалтер изменил вашу заявку» и ляжет в журнал как EDIT.
select is((select count(*)::int from payments_audit where payment_id = :'pid' and action = 'EDIT'), 0,
  'сообщение не пишется в журнал как правка заявки');
select is((select last_edit_role from payments where id = :'pid'), null,
  'сообщение не перебивает отметку «кто правил заявку»');

-- ---- 14-18) клиент отвечает и присылает счёт ----
select reply_by_token('tokThread', :'pid', 'Извините, вот счёт С-2211.',
  '[{"url":"https://x/schet_S-2211.pdf","name":"счёт С-2211.pdf"}]'::jsonb);

select is((select jsonb_array_length(thread) from payments where id = :'pid'), 2,
  'ответ клиента лёг в ту же переписку');
select is((select thread -> 1 ->> 'who' from payments where id = :'pid'), 'client',
  'ответ помечен как клиентский');
select is((select thread -> 1 ->> 'author' from payments where id = :'pid'), 'Тред Ко',
  'автором ответа записана фирма клиента');
-- ради этого весь тест: счёт нужен бухгалтеру в заявке, а не в переписке
select is((select jsonb_array_length(files) from payments where id = :'pid'), 2,
  'файл из ответа добавлен во вложения заявки');
-- зеркало остаётся на ПЕРВОМ файле: его читают рассылка, notify-payment и бот
select is((select file_url from payments where id = :'pid'), 'https://x/nakladnaya.pdf',
  'зеркало file_url по-прежнему указывает на первый файл заявки');

-- ---- 19-22) чего клиент сделать не может ----
select throws_ok(
  format($$ select reply_by_token('tokThread', %L, '  ', '[]'::jsonb) $$, :'pid'),
  'Пустой ответ', 'ответ без текста и без файла не принимается');
select throws_ok(
  format($$ select reply_by_token('tokOther', %L, 'подсмотрю чужое', '[]'::jsonb) $$, :'pid'),
  'Заявка не найдена', 'по чужому токену в переписку не попасть');
select lives_ok(
  format($$ select reply_by_token('tokThread', %L, '',
    '[{"url":"https://x/akt.pdf","name":"акт.pdf"}]'::jsonb) $$, :'pid'),
  'ответ без текста, но с файлом — нормальный ответ');

update payments set status = 'sent' where id = :'pid';
select throws_ok(
  format($$ select reply_by_token('tokThread', %L, 'а можно ещё?', '[]'::jsonb) $$, :'pid'),
  'Заявка закрыта — ответить по ней уже нельзя', 'в закрытую заявку не дописать');

-- ---- 23-24) что видит и чего не может клиент в кабинете ----
-- list_payments_by_token возвращает SETOF payments, поэтому переписка доезжает
-- сама. Тест страхует от «оптимизации» на перечисление колонок.
select is(
  (select jsonb_array_length(thread) from list_payments_by_token('tokThread') where id = :'pid'),
  3, 'переписка приезжает клиенту вместе с заявкой по токену');

update payments set status = 'new' where id = :'pid';
select edit_payment_by_token('tokThread', :'pid', 'Стройтехснаб', 1840, 'УНП 191847213',
  next_working_day(current_date + 2), 'once', 'Материалы', false, null, null,
  '[{"url":"https://x/nakladnaya.pdf","name":"накладная.pdf"}]'::jsonb);
select is((select jsonb_array_length(thread) from payments where id = :'pid'), 3,
  'правка заявки клиентом переписку не стирает');

-- ---- 25) первый файл появился из ответа — зеркало обязано его подхватить ----
select reply_by_token('tokThread', :'pid2', 'Держите счёт.',
  '[{"url":"https://x/first.pdf","name":"первый.pdf"}]'::jsonb);
select is((select file_url from payments where id = :'pid2'), 'https://x/first.pdf',
  'у заявки без вложений зеркало file_url встаёт на файл из ответа');

-- ---- 26-28) права ----
-- Новая функция по умолчанию открыта PUBLIC, поэтому проверяем именно отзыв.
select ok(not has_function_privilege('anon', 'public.post_staff_message(text,text,text)', 'EXECUTE'),
  'anon не может писать от имени бухгалтера');
select ok(has_function_privilege('authenticated', 'public.post_staff_message(text,text,text)', 'EXECUTE'),
  'сотрудник может писать клиенту');
select ok(has_function_privilege('anon', 'public.reply_by_token(text,text,text,jsonb)', 'EXECUTE'),
  'клиент по токену может ответить из кабинета');

select * from finish();
rollback;
