-- Схема ссылки на файл и экранирование HTML в уведомлениях.
--
-- Две находки ревью 09.09 (docs/REVIEW-2026-09-09.md, план — docs/FIXPLAN.md,
-- этап 1). Обе бьются снаружи, поэтому идут одной миграцией.
--
-- M2.1. `normalize_files` проверяла у файла только непустоту `url`, а фронт
-- подставляет её в `href` как есть. Клиент кладёт в заявку файл со ссылкой
-- `javascript:…`, бухгалтер жмёт на скрепку — скрипт выполняется в ЕГО сессии,
-- то есть от лица вошедшего сотрудника. `esc()` тут не спасает: он экранирует
-- кавычки и угловые скобки, но `javascript:` внутри href остаётся рабочим.
-- Тот же путь у `reply_by_token`: файл из ответа клиента ложится во вложения
-- заявки, минуя `normalize_files`.
--
-- M4.3. Уведомления уходят в Telegram с `parse_mode: HTML`, а поля заявки
-- (получатель, назначение, реквизиты) подставляются в них без экранирования.
-- Достаточно `<b` в названии получателя, чтобы сообщение развалилось или
-- пришло не тем, чем является. Здесь закрываем серверную часть — сборку
-- утренней рассылки; `notify-payment` правится в коде функции.

-- ---------------------------------------------------------------------------
-- Допустимая ссылка на файл
--
-- Пускаем только http и https. Опасна именно СХЕМА: `javascript:`, `data:`,
-- `vbscript:` выполняются при клике, а `http(s)` — нет. Ограничивать вдобавок
-- домен не стали: ссылки собирает Storage, и его адрес разный в проде
-- (https://<ref>.supabase.co), в локальном стеке (http://127.0.0.1:18321) и
-- внутри контейнера функций (http://kong:8000) — белый список хостов сломал бы
-- бота и CI, не добавив защиты от того, ради чего всё затевалось.
--
-- Пробелы, управляющие символы, кавычки и угловые скобки запрещены отдельно:
-- в настоящей ссылке их не бывает, а в href они позволяют выйти из атрибута.
-- Проверка одна на все места, где ссылка попадает в заявку.
-- ---------------------------------------------------------------------------
create or replace function public.is_safe_file_url(p_url text)
returns boolean language sql immutable set search_path = public as $$
  select p_url is not null
     and p_url !~ '[[:space:][:cntrl:]<>"'']'
     and lower(p_url) ~ '^https?://.';
$$;

comment on function public.is_safe_file_url(text) is
  'Ссылка годится для href: только http/https, без пробелов и кавычек (M2.1).';

-- Служебная проверка, наружу не нужна (CLAUDE.md, грабли №3: новая функция по
-- умолчанию доступна PUBLIC).
revoke all on function public.is_safe_file_url(text) from public, anon;
grant execute on function public.is_safe_file_url(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Экранирование для Telegram HTML
--
-- Telegram разбирает подмножество HTML, и ему достаточно трёх символов:
-- & < >. Кавычки в текст сообщения не попадают — ссылки в href мы теперь
-- пропускаем через is_safe_file_url, а она их не пускает.
-- ---------------------------------------------------------------------------
create or replace function public.tg_esc(p_text text)
returns text language sql immutable set search_path = public as $$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

comment on function public.tg_esc(text) is
  'Экранирует & < > для parse_mode=HTML в Telegram (M4.3).';

revoke all on function public.tg_esc(text) from public, anon;
grant execute on function public.tg_esc(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- normalize_files: та же функция, добавлена проверка схемы
--
-- Сигнатура не меняется, значит это замена, а не перегрузка, и права остаются
-- при функции. Revoke ниже повторён намеренно — чтобы файл читался целиком,
-- не сверяясь с 20260826000002_edit_tracking.sql.
--
-- Порядок проверок важен: лимит в 10 файлов остаётся первым, иначе заявка с
-- одиннадцатью мусорными ссылками пожалуется на ссылку вместо количества
-- (на это опирается multi_files_test).
-- ---------------------------------------------------------------------------
create or replace function public.normalize_files(
  p_files jsonb, p_file_url text, p_file_name text
) returns jsonb language plpgsql immutable set search_path = public as $$
declare v jsonb;
begin
  v := coalesce(p_files, '[]'::jsonb);

  if jsonb_typeof(v) <> 'array' then
    raise exception 'files должен быть массивом';
  end if;

  -- совместимость: старый вызов с одним файлом (бот, невыкаченный фронт)
  if jsonb_array_length(v) = 0 and coalesce(p_file_url, '') <> '' then
    v := jsonb_build_array(jsonb_build_object('url', p_file_url,
                                              'name', coalesce(nullif(p_file_name, ''), 'файл')));
  end if;

  if jsonb_array_length(v) > 10 then
    raise exception 'Слишком много файлов: % (максимум 10)', jsonb_array_length(v);
  end if;

  -- элемент без ссылки бесполезен и ломает показ — отсекаем сразу
  if exists (select 1 from jsonb_array_elements(v) e where coalesce(e ->> 'url', '') = '') then
    raise exception 'У каждого файла должна быть ссылка';
  end if;

  -- M2.1: ссылка уходит в href у бухгалтера, поэтому схема — только http(s)
  if exists (select 1 from jsonb_array_elements(v) e
              where not is_safe_file_url(e ->> 'url')) then
    raise exception 'Недопустимая ссылка на файл';
  end if;

  return v;
end; $$;

revoke all on function public.normalize_files(jsonb, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- reply_by_token: та же функция, добавлена та же проверка
--
-- Ответ клиента кладёт файлы прямо во вложения заявки, не заходя в
-- normalize_files, — значит проверять надо и здесь. Тело ниже повторяет
-- 20260909000001_payment_thread.sql, изменение одно и помечено M2.1.
-- ---------------------------------------------------------------------------
create or replace function public.reply_by_token(
  p_token text, p_id text, p_text text, p_files jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client clients;
  v_pay    payments;
  v_text   text;
  v_files  jsonb;
  v_msg    jsonb;
begin
  perform check_rate_limit(p_token, 'reply', 20, interval '1 minute');

  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;

  select * into v_pay from payments where id = p_id and client_id = v_client.id;
  if v_pay.id is null then
    raise exception 'Заявка не найдена';
  end if;
  -- Закрытая заявка закрыта: дописывать в неё задним числом нельзя — тем же
  -- правилом мы отказались от «попросить документ потом».
  if v_pay.status = 'sent' then
    raise exception 'Заявка закрыта — ответить по ней уже нельзя';
  end if;

  v_text  := btrim(coalesce(p_text, ''));
  v_files := coalesce(p_files, '[]'::jsonb);
  if jsonb_typeof(v_files) <> 'array' then
    raise exception 'Файлы должны быть массивом';
  end if;
  if v_text = '' and jsonb_array_length(v_files) = 0 then
    raise exception 'Пустой ответ';
  end if;
  if length(v_text) > 1000 then
    raise exception 'Сообщение длиннее 1000 символов';
  end if;
  if jsonb_array_length(v_files) > 10 then
    raise exception 'Не больше 10 файлов за раз';
  end if;
  if jsonb_array_length(v_pay.thread) >= 100 then
    raise exception 'В переписке уже 100 сообщений — дальше только по телефону';
  end if;

  -- оставляем только url и name: что бы ни прислал браузер, в заявку попадёт
  -- ровно та же форма, что кладёт submit_payment
  select coalesce(jsonb_agg(jsonb_build_object(
           'url',  e ->> 'url',
           'name', coalesce(nullif(btrim(coalesce(e ->> 'name', '')), ''), 'файл')
         )), '[]'::jsonb)
    into v_files
    from jsonb_array_elements(v_files) e
   where coalesce(e ->> 'url', '') <> '';

  -- M2.1: файл из ответа ложится во вложения заявки и оттуда попадает в href
  if exists (select 1 from jsonb_array_elements(v_files) e
              where not is_safe_file_url(e ->> 'url')) then
    raise exception 'Недопустимая ссылка на файл';
  end if;

  v_msg := jsonb_build_object(
    'id',     gen_random_uuid()::text,
    'who',    'client',
    'kind',   'reply',
    'text',   v_text,
    'author', v_client.name,
    'files',  v_files,
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  update payments p set
    thread    = p.thread || jsonb_build_array(v_msg),
    files     = p.files  || v_files,
    -- зеркало трогаем только если файлы реально пришли: у старых заявок files
    -- пуст, а file_url заполнен, и обнулить его значит потерять вложение
    file_url  = case when jsonb_array_length(v_files) > 0
                     then (p.files || v_files) -> 0 ->> 'url'  else p.file_url  end,
    file_name = case when jsonb_array_length(v_files) > 0
                     then (p.files || v_files) -> 0 ->> 'name' else p.file_name end
  where p.id = p_id;

  return v_msg;
end; $$;

-- Права после замены остаются при функции (сигнатура та же), но повторяем их
-- явно: цена ошибки — вставший кабинет клиента.
revoke all on function public.reply_by_token(text, text, text, jsonb) from public;
grant execute on function public.reply_by_token(text, text, text, jsonb)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Текст утренней рассылки — отдельной функцией
--
-- Раньше сообщение собиралось прямо в теле `send_daily_reminder`, а в нём же
-- лежит боевой токен бота (в репозитории — плейсхолдер, CLAUDE.md, грабли №2).
-- Значит починить экранирование миграцией было нельзя: `create or replace`
-- затёр бы токен и утренние уведомления встали бы.
--
-- Поэтому текст переезжает сюда, где токена нет и где его можно покрыть
-- тестами. За `send_daily_reminder` остаётся оболочка: взять текст и разослать.
-- Оболочку владелец накатывает руками из `supabase/daily_reminder.sql`,
-- подставив токен, — это единственный оставшийся ручной шаг.
--
-- Формат сообщения не меняется: те же строки, порядок и эмодзи, добавлено
-- только экранирование и проверка ссылки.
-- ---------------------------------------------------------------------------
create or replace function public.daily_reminder_message()
returns text language plpgsql stable security definer set search_path = public as $$
declare
  rec   record;
  msg   text;
  today text;
  cnt   int := 0;
begin
  today := to_char(now() at time zone 'Europe/Minsk', 'YYYY-MM-DD');
  msg := '📅 <b>Платежи на ' || to_char(now() at time zone 'Europe/Minsk', 'DD.MM.YYYY') || '</b>'
      || chr(10) || chr(10);

  for rec in
    select payee, amount, client, purpose, file_url, file_name
    from payments
    where due::text = today
      and status in ('new', 'in_progress')
    order by amount desc
  loop
    cnt := cnt + 1;
    msg := msg
      || cnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || to_char(rec.amount, 'FM999999999.00') || ' Br' || chr(10)
      || '   👤 ' || tg_esc(coalesce(nullif(rec.client, ''), '—')) || chr(10)
      || case when rec.purpose is not null and rec.purpose <> ''
              then '   📝 ' || tg_esc(rec.purpose) || chr(10)
              else '' end
      -- ссылку в href пускаем только проверенную: у старых заявок в file_url
      -- может лежать что угодно, они завелись до этой проверки
      || case when is_safe_file_url(rec.file_url)
              then '   📎 <a href="' || rec.file_url || '">'
                   || tg_esc(coalesce(nullif(rec.file_name, ''), 'файл')) || '</a>' || chr(10)
              else '' end
      || chr(10);
  end loop;

  if cnt = 0 then
    msg := msg || 'Нет платежей на сегодня 🎉';
  else
    msg := msg || '💼 Всего: ' || cnt;
  end if;

  return msg;
end; $$;

comment on function public.daily_reminder_message() is
  'Текст утренней рассылки. Отдельно от send_daily_reminder, потому что там боевой токен.';

-- Функция читает все заявки всех клиентов — снаружи ей делать нечего.
-- Вызывает её только send_daily_reminder, а он security definer и владельцем
-- postgres, то есть в правах не нуждается.
revoke all on function public.daily_reminder_message() from public, anon, authenticated;
