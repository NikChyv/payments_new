-- pgTAP: схема ссылки на файл и экранирование HTML (находки M2.1 и M4.3).
--
-- Ради чего тест написан:
--   1) ссылка на вложение уходит в href бухгалтеру. Схема `javascript:`
--      выполняется при клике в ЕГО сессии, а экранирование от неё не спасает —
--      значит проверять надо схему, и во всех трёх дверях: заявка, правка
--      заявки клиентом и ответ в переписке;
--   2) утренняя рассылка уходит с parse_mode=HTML, а payee и purpose пишет
--      клиент: без экранирования сообщение разваливается или подменяется.
--
-- Проверяем и обратную сторону: обычная https-ссылка обязана проходить.
-- Сломать её значит отобрать у клиента возможность приложить счёт.

begin;
select plan(16);

insert into auth.users (id) values ('000000ee-0000-0000-0000-0000000000ee');
insert into staff (id, name, is_admin)
  values ('000000ee-0000-0000-0000-0000000000ee', 'Валентина', false);

insert into clients (id, name, token, staff_id)
  values ('eeee0000-eeee-0000-eeee-000000000000', 'Урл Ко', 'tokUrl',
          '000000ee-0000-0000-0000-0000000000ee');

-- ---- 1-8) сама проверка ссылки ----
select ok(is_safe_file_url('https://gmvhphuabiyggfurfhmc.supabase.co/storage/v1/object/public/files/a.pdf'),
  'боевая ссылка Storage проходит');
select ok(is_safe_file_url('http://127.0.0.1:18321/storage/v1/object/public/files/a.pdf'),
  'локальный стек ходит по http — тоже проходит, иначе встанут db reset и CI');
select ok(not is_safe_file_url('javascript:alert(1)'),
  'javascript: не проходит — ради этого всё и делалось');
select ok(not is_safe_file_url('JaVaScRiPt:alert(1)'),
  'регистр схемы не помогает обойти проверку');
select ok(not is_safe_file_url('data:text/html;base64,PHNjcmlwdD4='),
  'data: не проходит');
select ok(not is_safe_file_url('https://s/a b.pdf'),
  'пробел в ссылке не проходит: в настоящей его нет, а в href он разрывает атрибут');
select ok(not is_safe_file_url('https://s/a" onclick="alert(1)'),
  'кавычка не проходит — ею выходят из href');
select ok(not is_safe_file_url(null),
  'null не проходит');

-- ---- 9-11) три двери, через которые ссылка попадает в заявку ----
select throws_ok(
  $$ select submit_payment('tokUrl','X',1,'U',next_working_day(current_date + 1),
       'once','p',false,null,null,
       '[{"url":"javascript:alert(1)","name":"счёт.pdf"}]'::jsonb) $$,
  'P0001',
  'Недопустимая ссылка на файл',
  'заявка с javascript:-вложением не принимается'
);

select submit_payment('tokUrl', 'Стройтехснаб', 1840, 'УНП 191847213',
  next_working_day(current_date + 1), 'once', 'Материалы', false, null, null,
  '[{"url":"https://x/schet.pdf","name":"счёт.pdf"}]'::jsonb) as pid \gset

select throws_ok(
  format($$ select edit_payment_by_token('tokUrl', %L, 'X',1,'U',
       next_working_day(current_date + 1),'once','p',false,null,null,
       '[{"url":"javascript:alert(1)","name":"счёт.pdf"}]'::jsonb) $$, :'pid'),
  'P0001',
  'Недопустимая ссылка на файл',
  'правка заявки клиентом тоже не пропускает javascript:'
);

select throws_ok(
  format($$ select reply_by_token('tokUrl', %L, 'вот счёт',
       '[{"url":"javascript:alert(1)","name":"счёт.pdf"}]'::jsonb) $$, :'pid'),
  'P0001',
  'Недопустимая ссылка на файл',
  'ответ в переписке не пропускает javascript: — он кладёт файл прямо во вложения'
);

-- ---- 12) рабочий путь не сломан ----
select reply_by_token('tokUrl', :'pid', 'вот накладная',
  '[{"url":"https://x/nakladnaya.pdf","name":"накладная.pdf"}]'::jsonb);
select is(
  (select files -> 1 ->> 'url' from payments where id = :'pid'),
  'https://x/nakladnaya.pdf',
  'обычная https-ссылка из ответа по-прежнему ложится во вложения заявки'
);

-- ---- 13) экранирование ----
select is(
  tg_esc('<b>Рога & Копыта</b>'),
  '&lt;b&gt;Рога &amp; Копыта&lt;/b&gt;',
  'tg_esc закрывает & < > — этих трёх Telegram и хватает'
);

-- ---- 14-16) утренняя рассылка ----
-- Заявку правим напрямую: так выглядит запись, заведённая ДО проверки ссылки,
-- а рассылка обязана быть готова и к таким. Дату ставим сегодняшнюю по Минску —
-- рассылка отбирает заявки именно по ней.
update payments set
  payee     = '<b>Хакер</b>',
  purpose   = 'счёт <script>',
  due       = (now() at time zone 'Europe/Minsk')::date,
  status    = 'new',
  file_url  = 'javascript:alert(1)',
  file_name = 'счёт.pdf'
where id = :'pid';

select ok(
  daily_reminder_message() like '%&lt;b&gt;Хакер&lt;/b&gt;%',
  'получатель в утренней рассылке экранирован'
);
select ok(
  daily_reminder_message() not like '%javascript:%',
  'небезопасная ссылка из старой заявки в рассылку не попадает'
);

update payments set file_url = 'https://x/schet.pdf' where id = :'pid';
select ok(
  daily_reminder_message() like '%<a href="https://x/schet.pdf">%',
  'нормальная ссылка в рассылке остаётся кликабельной'
);

select * from finish();
rollback;
