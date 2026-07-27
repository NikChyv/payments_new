-- pgTAP: сквозные сценарии клиента через боевые RPC.
-- Закрывает то, что не проверялось: утечка личной задачи бухгалтера,
-- жизнь токена после ротации, выходной через submit_payment, сохранение файла.

begin;
select plan(7);

-- сотрудник (для личной задачи) и клиент
insert into auth.users (id) values ('0000000b-0000-0000-0000-00000000000b');
insert into staff (id, name, is_admin)
  values ('0000000b-0000-0000-0000-00000000000b', 'Бух Флоу', false);
insert into clients (id, name, token, staff_id)
  values ('c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0', 'FlowCo', 'tokFlow',
          '0000000b-0000-0000-0000-00000000000b');

-- ---- 1) личная задача бухгалтера (без клиента) не должна утечь клиенту ----
insert into payments (id, client, payee, amount, due, recurrence, status,
                      need_receipt, client_id, created_at, created_by_staff)
values ('personal1', 'Личное · Бух Флоу', 'Аренда офиса', 999, current_date,
        'once', 'new', false, null, now(), '0000000b-0000-0000-0000-00000000000b');

select is(
  (select count(*)::int from list_payments_by_token('tokFlow') where id = 'personal1'),
  0,
  'личная задача бухгалтера не видна клиенту'
);

-- ---- 2-3) ротация токена: старый мёртв даже для создания заявки ----
update clients set token = 'tokFlowNew' where token = 'tokFlow';

select throws_ok(
  $$ select submit_payment('tokFlow','X',10,null,current_date,'once',null,false,null,null) $$,
  'P0001',
  'Неверный токен клиента',
  'по отозванному токену нельзя создать заявку'
);

select lives_ok(
  $$ select submit_payment('tokFlowNew','ПоНовому',100,null,
       next_working_day(current_date),'once',null,false,null,null) $$,
  'новый токен после ротации работает'
);

-- ---- 4) выходной отсекается на уровне submit_payment (не только хелпера) ----
select throws_ok(
  format($$ select submit_payment('tokFlowNew','Сб',10,null,date %L,'once',null,false,null,null) $$,
         (current_date + (13 - extract(isodow from current_date))::int)),
  'P0001',
  'В выходной платёж не проводится. Выберите рабочий день (пн–пт).',
  'заявка на будущую субботу отклоняется целиком'
);

-- ---- 5-6) файл сохраняется при правке, если новый не приложен ----
select submit_payment('tokFlowNew','СФайлом',300,null,next_working_day(current_date),
                      'once',null,true,'https://x/invoice.pdf','invoice.pdf') as fid \gset

select lives_ok(
  format($$ select edit_payment_by_token('tokFlowNew', %L, 'СФайлом2', 350, null,
             next_working_day(current_date), 'once', null, true, null, null) $$, :'fid'),
  'правка без нового файла проходит'
);

select is(
  (select file_url from payments where id = :'fid'),
  'https://x/invoice.pdf',
  'прежний файл сохраняется, когда новый не приложен'
);

-- ---- 7) явный запрос документа сохраняется (не только дефолт false) ----
select is(
  (select need_receipt from payments where id = :'fid'),
  true,
  'need_receipt=true сохраняется, когда клиент документ запросил'
);

select * from finish();
rollback;
