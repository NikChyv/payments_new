-- pgTAP: несколько файлов в заявке.
--
-- Ключевое, что проверяем: старые колонки file_url/file_name продолжают
-- показывать ПЕРВЫЙ файл. На них завязаны утренняя рассылка, уведомление о
-- новой заявке и бот — если зеркало разъедется, они молча перестанут
-- показывать вложение.

begin;
select plan(13);

insert into clients (id, name, token, staff_id)
  values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Files Co', 'tokFiles', null);

-- ---- 1-4) заявка с двумя файлами ----
select submit_payment('tokFiles','FP',100,'U',current_date,'once','p',false,null,null,
  '[{"url":"https://s/1.pdf","name":"счёт.pdf"},{"url":"https://s/2.jpg","name":"акт.jpg"}]'::jsonb) as p2 \gset

select is(
  (select jsonb_array_length(files) from payments where id = :'p2'),
  2,
  'сохранены оба файла'
);
select is(
  (select files -> 1 ->> 'name' from payments where id = :'p2'),
  'акт.jpg',
  'порядок файлов сохранён'
);
select is(
  (select file_url from payments where id = :'p2'),
  'https://s/1.pdf',
  'file_url — зеркало первого файла (его читает утренняя рассылка)'
);
select is(
  (select file_name from payments where id = :'p2'),
  'счёт.pdf',
  'file_name — зеркало первого файла'
);

-- ---- 5-6) старый способ: один файл отдельными параметрами ----
-- так ходит бот и фронт, который ещё не выкачен
select submit_payment('tokFiles','FP2',100,'U',current_date,'once','p',false,
  'https://s/old.pdf','старый.pdf') as p1 \gset

select is(
  (select files from payments where id = :'p1'),
  '[{"url": "https://s/old.pdf", "name": "старый.pdf"}]'::jsonb,
  'одиночный файл превращается в массив из одного элемента'
);
select is(
  (select file_url from payments where id = :'p1'),
  'https://s/old.pdf',
  'зеркало на месте и при старом способе'
);

-- ---- 7) заявка вообще без файлов ----
select submit_payment('tokFiles','FP3',100,'U',current_date,'once','p',false,null,null) as p0 \gset
select is(
  (select files from payments where id = :'p0'),
  '[]'::jsonb,
  'без файлов — пустой массив, а не null'
);

-- ---- 8-9) защита от мусора ----
select throws_ok(
  $$ select submit_payment('tokFiles','X',1,'U',current_date,'once','p',false,null,null,
       '[{"name":"без ссылки"}]'::jsonb) $$,
  'P0001',
  'У каждого файла должна быть ссылка',
  'файл без ссылки не принимается'
);
select throws_ok(
  $$ select submit_payment('tokFiles','X',1,'U',current_date,'once','p',false,null,null,
       (select jsonb_agg(jsonb_build_object('url','u'||g,'name','n'||g)) from generate_series(1,11) g)) $$,
  'P0001',
  'Слишком много файлов: 11 (максимум 10)',
  'больше десяти файлов не принимается'
);

-- ---- 10-12) правка клиентом заменяет набор файлов ----
select edit_payment_by_token('tokFiles', :'p2', 'FP',100,'U',current_date,'once','p',false,null,null,
  '[{"url":"https://s/3.pdf","name":"новый.pdf"}]'::jsonb);
select is(
  (select jsonb_array_length(files) from payments where id = :'p2'),
  1,
  'правка заменила набор файлов целиком'
);
select is(
  (select file_url from payments where id = :'p2'),
  'https://s/3.pdf',
  'зеркало обновилось вместе с файлами'
);

-- ---- 13) правка без файловых параметров их не трогает ----
select edit_payment_by_token('tokFiles', :'p2', 'FP-изменён',200,'U',current_date,'once','p',false,null,null);
select is(
  (select files -> 0 ->> 'name' from payments where id = :'p2'),
  'новый.pdf',
  'если файлы не переданы — прежние остаются на месте'
);

-- ---- 14) пустой массив = «удалить все файлы» ----
select edit_payment_by_token('tokFiles', :'p2', 'FP',100,'U',current_date,'once','p',false,null,null,
  '[]'::jsonb);
select is(
  (select files from payments where id = :'p2'),
  '[]'::jsonb,
  'явно переданный пустой массив очищает файлы'
);

select * from finish();
rollback;
