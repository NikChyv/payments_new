-- pgTAP: жёлтые находки ревью вне этапов (миграция 20260916000001).
--
-- Что доказывается:
--   M2.2  кривая сумма, длина и периодичность не проходят ни через RPC, ни
--         прямой записью сотрудника; старая кривая заявка при этом всё ещё
--         переводится по статусам;
--   M7.2  вопрос по закрытой заявке не задаётся;
--   M7.3  ответ клиента не раздувает заявку больше 10 файлов;
--   M2.4  правка без смены даты дату не двигает;
--   M9.1/M9.2  админ меняет бухгалтера и имя, имя доезжает до заявок, а
--         вебхуки при этом молчат и после включаются обратно;
--   письмо  утреннее письмо админу не вылезает за лимит Telegram.

begin;
select plan(35);

insert into auth.users (id) values
  ('0000aaaa-0000-0000-0000-00000000aaaa'),
  ('0000bbbb-0000-0000-0000-00000000bbbb'),
  ('0000cccc-0000-0000-0000-00000000cccc');
insert into staff (id, name, is_admin) values
  ('0000aaaa-0000-0000-0000-00000000aaaa', 'Админ',     true),
  ('0000bbbb-0000-0000-0000-00000000bbbb', 'Бухгалтер', false),
  ('0000cccc-0000-0000-0000-00000000cccc', 'Второй',    false);

insert into clients (id, name, token, staff_id) values
  ('f0000000-0000-0000-0000-000000000001', 'Старое имя', 'tokY1', '0000bbbb-0000-0000-0000-00000000bbbb'),
  ('f0000000-0000-0000-0000-000000000002', 'Соседи',     'tokY2', '0000bbbb-0000-0000-0000-00000000bbbb');

-- ===========================================================================
-- M2.2. Поля заявки
-- ===========================================================================
select throws_ok(
  $$ select submit_payment('tokY1','Получатель',0,'U',current_date,'once','p',false,null,null) $$,
  'P0001', 'Сумма должна быть больше нуля',
  'клиент не заводит заявку на ноль');
select throws_ok(
  $$ select submit_payment('tokY1','Получатель',-5000,'U',current_date,'once','p',false,null,null) $$,
  'P0001', 'Сумма должна быть больше нуля',
  'и на отрицательную сумму');
select throws_ok(
  $$ select submit_payment('tokY1',repeat('я',201),100,'U',current_date,'once','p',false,null,null) $$,
  'P0001', 'Получатель длиннее 200 символов',
  'получатель в 201 символ не пролезает — уведомление не упрётся в лимит Telegram');
select throws_ok(
  $$ select submit_payment('tokY1','   ',100,'U',current_date,'once','p',false,null,null) $$,
  'P0001', 'Укажите получателя',
  'получатель из одних пробелов — не получатель');
select throws_ok(
  $$ select submit_payment('tokY1','Получатель',100,'U',current_date,'once',repeat('я',1001),false,null,null) $$,
  'P0001', 'Назначение длиннее 1000 символов',
  'назначение ограничено');
select throws_ok(
  $$ select submit_payment('tokY1','Получатель',100,repeat('1',1001),current_date,'once','p',false,null,null) $$,
  'P0001', 'Реквизиты длиннее 1000 символов',
  'реквизиты ограничены');
select throws_ok(
  $$ select submit_payment('tokY1','Получатель',100,'U',current_date,'daily','p',false,null,null) $$,
  'P0001', 'Неизвестная периодичность: daily',
  'периодичность только из трёх известных — иначе в очереди «🔁 undefined»');

select lives_ok(
  $$ select submit_payment('tokY1','Получатель',100,'U',current_date,'monthly','p',false,null,null) $$,
  'нормальная заявка проходит');

-- прямая запись сотрудника — та же проверка
select throws_ok(
  $$ insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt, client_id, created_at)
     values ('y-direct0', 'Старое имя', 'П', 0, current_date, 'once', 'new', false,
             'f0000000-0000-0000-0000-000000000001', now()) $$,
  'P0001', 'Сумма должна быть больше нуля',
  'прямая запись в таблицу (форма сотрудника, копия повторяющегося) проверяется так же');

-- старая заявка, заведённая до проверки: сумма 0. Заводим в обход триггера.
alter table payments disable trigger trg_payments_validate;
insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt, client_id, created_at)
values ('y-legacy', 'Старое имя', 'Давняя', 0, current_date, 'once', 'new', false,
        'f0000000-0000-0000-0000-000000000001', now());
alter table payments enable trigger trg_payments_validate;

select lives_ok(
  $$ update payments set status = 'in_progress' where id = 'y-legacy' $$,
  'старая кривая заявка всё ещё переводится по статусам — проверка только на правку содержания');
select throws_ok(
  $$ update payments set purpose = 'новое' where id = 'y-legacy' $$,
  'P0001', 'Сумма должна быть больше нуля',
  'а правка её содержания требует починить сумму');

-- ===========================================================================
-- M1.4. Колонка для ссылки на исходную заявку
-- ===========================================================================
select has_column('public', 'payments', 'parent_id', 'копия повторяющегося платежа помнит исходник');

-- ===========================================================================
-- M7.2. Вопрос по закрытой заявке
-- ===========================================================================
insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt, client_id, created_at)
values ('y-sent', 'Старое имя', 'Закрытая', 10, current_date, 'once', 'sent', false,
        'f0000000-0000-0000-0000-000000000001', now()),
       ('y-paid', 'Старое имя', 'Оплаченная', 10, current_date, 'once', 'paid', false,
        'f0000000-0000-0000-0000-000000000001', now());

set local request.jwt.claims = '{"sub":"0000bbbb-0000-0000-0000-00000000bbbb","role":"authenticated"}';

select throws_ok(
  $$ select post_staff_message('y-sent', 'Где счёт?') $$,
  'P0001', 'Заявка закрыта — клиент ответить по ней уже не сможет',
  'по закрытой заявке вопрос не задаётся');
select is(jsonb_array_length((select thread from payments where id = 'y-sent')), 0,
          'и в переписку ничего не легло');
select lives_ok(
  $$ select post_staff_message('y-paid', 'Пришлите акт') $$,
  'по оплаченной, но не закрытой — можно: клиент ещё отвечает');

reset request.jwt.claims;

-- ===========================================================================
-- M7.3. Потолок файлов при ответе
-- ===========================================================================
insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt,
                      client_id, created_at, files)
select 'y-files', 'Старое имя', 'С файлами', 10, current_date, 'once', 'new', false,
       'f0000000-0000-0000-0000-000000000001', now(),
       (select jsonb_agg(jsonb_build_object('url', 'https://x.test/' || g, 'name', 'f' || g))
          from generate_series(1, 9) g);

select throws_ok(
  $$ select reply_by_token('tokY1', 'y-files', 'вот', '[{"url":"https://x.test/a","name":"a"},{"url":"https://x.test/b","name":"b"}]') $$,
  'P0001', 'В заявке уже 9 файлов из 10 — приложить ещё 2 не получится. Напишите ответ текстом или уберите лишние файлы в заявке',
  '9 + 2 файла — отказ с понятной причиной');
select is(jsonb_array_length((select files from payments where id = 'y-files')), 9,
          'заявка не распухла');
select lives_ok(
  $$ select reply_by_token('tokY1', 'y-files', 'вот', '[{"url":"https://x.test/a","name":"a"}]') $$,
  '9 + 1 — ровно предел, проходит');
select lives_ok(
  $$ select reply_by_token('tokY1', 'y-files', 'а файлов больше нет') $$,
  'на пределе ответ текстом всё равно проходит');
-- главное следствие: правка клиентом после ответов не ломается
select lives_ok(
  $$ select edit_payment_by_token('tokY1', 'y-files', 'С файлами', 10, null, current_date - 1,
                                  'once', 'p', false, null, null, null) $$,
  'после ответов клиент по-прежнему может поправить заявку');

-- ===========================================================================
-- M2.4. Правка без смены даты
-- Берём будущую субботу: adjust_due_date на неё бросает всегда, в любое время
-- суток, — значит тест не зависит от того, до или после 17:00 его запустили.
-- Заявку на субботу заводим в обход RPC (так выглядит заявка, чья дата стала
-- нерабочей уже после подачи).
-- ===========================================================================
select (current_date + ((6 - extract(isodow from current_date)::int + 7) % 7) + 7) as sat \gset

insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt, client_id, created_at)
values ('y-due', 'Старое имя', 'Дата', 10, :'sat', 'once', 'new', false,
        'f0000000-0000-0000-0000-000000000001', now());

select lives_ok(
  format($$ select edit_payment_by_token('tokY1', 'y-due', 'Дата', 20, null, %L::date,
                                         'once', 'новое назначение', false, null, null, null) $$, :'sat'),
  'дату не меняли — правилу рабочего графика она не подвергается');
select is((select due from payments where id = 'y-due'), :'sat'::date,
          'и осталась ровно той, что была');
select is((select purpose from payments where id = 'y-due'), 'новое назначение',
          'а само изменение записалось');
select throws_ok(
  format($$ select edit_payment_by_token('tokY1', 'y-due', 'Дата', 20, null, %L::date,
                                         'once', 'p', false, null, null, null) $$, (:'sat'::date + 7)),
  'P0001', 'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
  'новую дату правило рабочего графика по-прежнему проверяет');

-- ===========================================================================
-- M9.1 + M9.2. Админ меняет клиента
-- ===========================================================================
set local request.jwt.claims = '{"sub":"0000bbbb-0000-0000-0000-00000000bbbb","role":"authenticated"}';
select throws_ok(
  $$ select update_client('f0000000-0000-0000-0000-000000000001', 'Захват', '0000bbbb-0000-0000-0000-00000000bbbb') $$,
  'P0001', 'Менять клиента может только администратор',
  'бухгалтер клиента не переименовывает и себе не переводит');

set local request.jwt.claims = '{"sub":"0000aaaa-0000-0000-0000-00000000aaaa","role":"authenticated"}';
select throws_ok(
  $$ select update_client('f0000000-0000-0000-0000-000000000001', 'Новое имя', gen_random_uuid()) $$,
  'P0001', 'Выберите бухгалтера из списка сотрудников',
  'несуществующий бухгалтер не принимается');

-- Вебхук, как на проде: тот же supabase_functions.http_request. Срабатывание
-- видно по очереди pg_net — запрос ложится в неё внутри транзакции.
create trigger "y-hook" after update on public.payments
  for each row execute function supabase_functions.http_request(
    'http://127.0.0.1:9/y-hook', 'POST', '{"Content-type":"application/json"}', '{}', '1000');
select count(*) as q0 from net.http_request_queue \gset

select lives_ok(
  $$ select update_client('f0000000-0000-0000-0000-000000000001', '  Новое имя  ',
                          '0000cccc-0000-0000-0000-00000000cccc') $$,
  'админ переименовывает и меняет бухгалтера');
select is((select name || ' / ' || staff_id from clients where id = 'f0000000-0000-0000-0000-000000000001'),
          'Новое имя / 0000cccc-0000-0000-0000-00000000cccc',
          'имя без пробелов по краям, бухгалтер сменился');
select is((select count(*)::int from payments
            where client_id = 'f0000000-0000-0000-0000-000000000001' and client <> 'Новое имя'), 0,
          'имя доехало до всех заявок клиента');
select is((select count(*)::int from payments
            where client_id = 'f0000000-0000-0000-0000-000000000002' and client = 'Новое имя'), 0,
          'чужие заявки не задеты');
select is((select count(*)::int from net.http_request_queue), :q0::int,
          'переписывание имени в заявках не дёрнуло вебхук — старые уведомления не уйдут пачкой');
select is((select tgenabled::text from pg_trigger where tgname = 'y-hook'), 'O',
          'вебхук после переименования снова включён');
update payments set status = 'paid' where id = 'y-due';
select is((select count(*)::int from net.http_request_queue), :q0::int + 1,
          'и обычная запись в заявку его снова дёргает');

drop trigger "y-hook" on public.payments;
reset request.jwt.claims;

-- ===========================================================================
-- Утреннее письмо не вылезает за лимит Telegram
-- ===========================================================================
insert into payments (id, client, payee, amount, due, recurrence, status, need_receipt,
                      client_id, created_at, purpose, file_url, file_name)
select 'y-many-' || g, 'Соседи', 'Получатель номер ' || g, 100 + g,
       (now() at time zone 'Europe/Minsk')::date, 'once', 'new', false,
       'f0000000-0000-0000-0000-000000000002', now(), repeat('назначение ', 60),
       'https://example.test/storage/v1/object/public/files/' || md5(g::text) || '/schet.pdf', 'schet.pdf'
from generate_series(1, 40) g;

select cmp_ok(length(daily_reminder_message('0000aaaa-0000-0000-0000-00000000aaaa')), '<=', 4096,
              'письмо админу на 40 заявок укладывается в лимит Telegram');
select matches(daily_reminder_message('0000aaaa-0000-0000-0000-00000000aaaa'),
               '…и ещё \d+ — полный список в приложении',
               'не влезшие заявки посчитаны, а не потеряны молча');

select * from finish();
rollback;
