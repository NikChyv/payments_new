-- Вопрос бухгалтера и ответ клиента — внутри заявки, а не в личном чате.
--
-- Что болело. Клиент прикладывает накладную, в которой нет номера счёта.
-- Заплатить по ней нельзя, и бухгалтер пишет в личный чат — а директор клиента
-- заглядывает туда, когда заглянет. Заявка при этом молча стоит и краснеет как
-- просроченная, хотя ждёт не бухгалтера, а клиента. Ответ, если он приходит,
-- приходит тоже в чат: нужный счёт остаётся в переписке, а не в заявке.
--
-- Что делаем. Короткая переписка, привязанная к платежу: бухгалтер спрашивает,
-- клиент отвечает текстом и файлом (из бота или из кабинета), файл ложится во
-- вложения самой заявки. Уведомления в обе стороны шлёт notify-client.
--
-- Почему jsonb внутри payments, а не отдельная таблица: list_payments_by_token
-- возвращает SETOF payments, поэтому переписка доезжает до кабинета клиента
-- сама — без перегрузки RPC и без повторной выдачи прав (см. CLAUDE.md). Та же
-- причина, по которой отдельно от files живут staff_files.

alter table public.payments
  add column if not exists thread jsonb not null default '[]'::jsonb;

-- Сколько сообщений уже отправлено каждой стороне. Именно счётчики, а не флаги:
-- сообщений в переписке несколько, и после первой отправки остальные обязаны
-- дойти. Функция шлёт элементы начиная с этого номера и двигает счётчик только
-- после подтверждения Telegram — как это уже сделано с client_docs_notified.
alter table public.payments
  add column if not exists client_thread_notified int not null default 0;
alter table public.payments
  add column if not exists staff_thread_notified  int not null default 0;

-- Бэкфилл не нужен: у существующих заявок переписки нет, а 0 значит
-- «ничего не отправляли» — что и есть правда.
--
-- Состояние «ждём ответа клиента» отдельной колонкой НЕ храним: это последнее
-- сообщение в thread. Причина не в экономии — в том, что очередь бухгалтера
-- сохраняется общим upsert всех заявок (supabase.js → save()), и любое поле,
-- которое пишет и клиент, и этот upsert, рано или поздно будет затёрто сталым
-- значением из браузера. Переписка пишется только дописыванием, ниже.
--
-- Статус тоже не трогаем: 'waiting' пришлось бы протаскивать через подписи
-- статусов, шаги в кабинете, счётчики очереди, выгрузку в Excel, /payments в
-- боте и утреннюю рассылку — и всё ради метки в строке.

-- ---------------------------------------------------------------------------
-- Сообщение бухгалтера.
--
-- SECURITY INVOKER намеренно: прав сотрудника на payments достаточно, а «свои
-- клиенты или админ» уже описано политиками pay_staff_*. Продублировать этот
-- предикат внутри функции значит завести вторую копию правила, которая однажды
-- разъедется с первой. Чужая заявка просто не найдётся — RLS её не покажет.
--
-- Автор берётся из JWT, а не из параметра: подписаться чужим именем нельзя.
-- ---------------------------------------------------------------------------
create or replace function public.post_staff_message(
  p_id text, p_text text, p_kind text default 'question'
) returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_text   text;
  v_author text;
  v_kind   text := coalesce(p_kind, 'question');
  v_len    int;
  v_msg    jsonb;
begin
  v_text := btrim(coalesce(p_text, ''));
  if v_text = '' then
    raise exception 'Пустое сообщение';
  end if;
  if length(v_text) > 1000 then
    raise exception 'Сообщение длиннее 1000 символов';
  end if;
  if v_kind not in ('question', 'reminder') then
    raise exception 'Неизвестный тип сообщения: %', v_kind;
  end if;

  select name into v_author from staff where id = auth.uid();
  if v_author is null then
    raise exception 'Писать клиенту может только сотрудник';
  end if;

  select jsonb_array_length(thread) into v_len from payments where id = p_id;
  if v_len is null then
    raise exception 'Заявка не найдена или не ваша';
  end if;
  -- Потолок на переписку. Она лежит в строке заявки и растёт без ограничений,
  -- а половина записей приходит с анонимной стороны (reply_by_token).
  if v_len >= 100 then
    raise exception 'В переписке уже 100 сообщений — дальше только по телефону';
  end if;

  v_msg := jsonb_build_object(
    'id',     gen_random_uuid()::text,
    'who',    'staff',
    'kind',   v_kind,
    'text',   v_text,
    'author', v_author,
    'files',  '[]'::jsonb,
    'at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  update payments set thread = thread || jsonb_build_array(v_msg) where id = p_id;
  if not found then
    raise exception 'Заявка не найдена или не ваша';
  end if;

  return v_msg;
end; $$;

-- ---------------------------------------------------------------------------
-- Ответ клиента: из кабинета по токену и из Telegram-бота (бот зовёт эту же
-- функцию с токеном своей фирмы, поэтому лимит частоты общий на оба канала —
-- ровно как у submit_payment).
--
-- Файлы из ответа попадают ВО ВЛОЖЕНИЯ ЗАЯВКИ, а не только в переписку: чаще
-- всего ответ на вопрос — это и есть недостающий счёт, и нужен он бухгалтеру
-- там, где он платит. Зеркало file_url при этом пересобирается по первому
-- элементу files (см. CLAUDE.md): его читают утренняя рассылка, notify-payment
-- и бот, и разъехаться оно не должно.
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

-- ---------------------------------------------------------------------------
-- Права. Новая функция по умолчанию доступна PUBLIC, а Supabase вдобавок
-- раздаёт её anon и authenticated — то есть grant тут ничего не ограничивает,
-- ограничивает revoke (см. CLAUDE.md, грабли №3).
-- ---------------------------------------------------------------------------

-- писать от имени бухгалтера может только вошедший сотрудник
revoke all on function public.post_staff_message(text, text, text) from public, anon;
grant execute on function public.post_staff_message(text, text, text) to authenticated;

-- отвечать по токену — клиенту (anon из кабинета) и боту (service_role)
revoke all on function public.reply_by_token(text, text, text, jsonb) from public;
grant execute on function public.reply_by_token(text, text, text, jsonb)
  to anon, authenticated, service_role;
