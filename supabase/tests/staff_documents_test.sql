-- pgTAP: платёжный документ, приложенный бухгалтером (payments.staff_files).
--
-- Главное, что тут доказывается: документ бухгалтера живёт ОТДЕЛЬНО от файлов
-- клиента и правкой заявки не стирается. Если эти два массива когда-нибудь
-- съедутся, клиент, поправив свой счёт, снесёт себе же платёжку — и заметит
-- это только когда пойдёт искать её для поставщика.
--
-- Проверка идёт на заявке в статусе 'new' нарочно: в жизни документ появляется
-- позже, когда клиент уже не может редактировать, но тест обязан краснеть и
-- в том случае, если однажды это ограничение ослабят.

begin;
select plan(9);

insert into clients (id, name, token, staff_id) values
  ('d0c00000-0000-0000-0000-00000000d0c0', 'DocCo', 'doctok', null);

-- Заявка клиента со своим счётом. Дату берём через next_working_day: жёсткое
-- current_date + N попадает на выходной и роняет submit_payment вместе с CI.
select submit_payment('doctok', 'Профснаб', 15400, 'УНП 192887410',
  next_working_day(current_date + 1), 'once', 'Расходники', true, null, null,
  '[{"url":"https://x/schet.pdf","name":"счёт.pdf"}]'::jsonb);

-- ---- 1) значения по умолчанию ----
select is(
  (select staff_files from payments where client = 'DocCo'),
  '[]'::jsonb,
  'новая заявка приходит без документов бухгалтера'
);
select is(
  (select client_docs_notified from payments where client = 'DocCo'),
  0,
  'счётчик отправленных документов начинается с нуля'
);

-- ---- 2) бухгалтер прикладывает платёжный документ ----
update payments
   set staff_files = '[{"url":"https://x/platezhka.pdf","name":"Платёжное поручение.pdf"}]'::jsonb
 where client = 'DocCo';

select is(
  (select jsonb_array_length(staff_files) from payments where client = 'DocCo'),
  1,
  'документ бухгалтера записан'
);

-- Зеркало file_url обязано остаться счётом КЛИЕНТА: его читают утренняя
-- рассылка, notify-payment и бот. Попадёт туда платёжка — в уведомлении о
-- заявке клиенту покажут её вместо его собственного счёта.
select is(
  (select file_url from payments where client = 'DocCo'),
  'https://x/schet.pdf',
  'зеркало file_url по-прежнему указывает на счёт клиента, а не на платёжку'
);

-- ---- 3) клиент правит заявку: свой файл меняется, документ бухгалтера нет ----
select lives_ok(
  $$ select edit_payment_by_token('doctok',
       (select id from payments where client = 'DocCo'),
       'Профснаб', 15400, 'УНП 192887410',
       next_working_day(current_date + 2), 'once', 'Расходники', true,
       null, null, '[{"url":"https://x/schet2.pdf","name":"счёт-2.pdf"}]'::jsonb) $$,
  'клиент правит свою заявку'
);

select is(
  (select files -> 0 ->> 'url' from payments where client = 'DocCo'),
  'https://x/schet2.pdf',
  'файл клиента правкой действительно заменился — значит правка прошла'
);

-- ради этого весь тест
select is(
  (select staff_files -> 0 ->> 'url' from payments where client = 'DocCo'),
  'https://x/platezhka.pdf',
  'документ бухгалтера правкой клиента НЕ затронут'
);

select is(
  (select client_docs_notified from payments where client = 'DocCo'),
  0,
  'счётчик отправленных документов правкой не сбит'
);

-- ---- 4) клиент видит документ по своей ссылке ----
-- list_payments_by_token возвращает SETOF payments, поэтому новая колонка
-- доезжает до кабинета сама. Тест страхует от «оптимизации» на список колонок.
select is(
  (select staff_files -> 0 ->> 'name' from list_payments_by_token('doctok')),
  'Платёжное поручение.pdf',
  'документ приезжает клиенту вместе с заявкой по токену'
);

select * from finish();
rollback;
