-- Хранилище файлов: потолок размера и белый список типов.
--
-- Бакет `files` был заведён кликами в панели и остался без единого ограничения:
-- `file_size_limit` и `allowed_mime_types` пустые, а политика разрешает INSERT
-- роли `public`. Анонимный ключ по своей природе публичный (он лежит во фронте),
-- поэтому залить в бакет файл любого типа и любого размера мог кто угодно, а
-- бакет публичный — ссылка на залитое сразу отдаётся наружу. Это бесплатный
-- файловый хостинг на домене, которому доверяют.
--
-- Закрываем ограничениями самого бакета, а не политикой: они действуют на любую
-- загрузку, включая те, что идут из Edge Functions под service_role — политику
-- RLS этот ключ обходит, а лимиты бакета нет. Значит и бот попадает под правило.
--
-- Что это на самом деле даёт. Storage сверяет ЗАЯВЛЕННЫЙ Content-Type, а не
-- содержимое файла, так что подделать заголовок можно. Но отдаётся файл потом с
-- тем же типом: html, залитый как image/jpeg, браузер покажет мусором, а не
-- страницей. То есть выложить через нас работающую фишинговую страницу или
-- скрипт уже нельзя — а это и было главным риском публичного бакета.
--
-- Чего это НЕ закрывает: заливку множества допустимых файлов подряд. Storage не
-- ходит через наш rate-limit на RPC. Настоящее лечение — принимать файл через
-- функцию с проверкой токена клиента; вынесено в задачи, см. SECURITY.md.
--
-- Вставку анониму оставляем: клиент грузит счёт по персональной ссылке, не
-- логинясь, и другого пути у него нет.
--
-- На уже загруженные файлы ограничения не распространяются — они про новые
-- загрузки. Три исторических RAW-снимка по 29 МБ останутся лежать и открываться.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'files', 'files', true,
  10485760,  -- 10 МБ: самый большой реальный счёт за всё время — 5 МБ
  array[
    -- фото счёта: то, чем пользуются в 90% случаев
    'image/jpeg',
    'image/png',
    'image/heic',   -- айфон снимает в heic, если не переключали
    'image/heif',
    'image/webp',
    -- счёт файлом
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',    -- xlsx
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- docx
    'application/vnd.ms-excel',  -- xls: 1С выгружает счета в старом формате
    'application/msword'         -- doc
  ]
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Политику перекладываем в код под внятным именем. В проде она называется
-- «Give anon users access to JPG images in folder 1m0cqf_0» — автоимя из панели,
-- не имеющее отношения к тому, что политика делает (никаких JPG и никакой папки).
drop policy if exists "Give anon users access to JPG images in folder 1m0cqf_0" on storage.objects;
drop policy if exists "files_insert_any" on storage.objects;
drop policy if exists "files_client_upload" on storage.objects;

create policy "files_client_upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'files');

-- Политик на UPDATE и DELETE нет и быть не должно: перезаписать или удалить
-- чужой файл нельзя даже зная точный путь.
