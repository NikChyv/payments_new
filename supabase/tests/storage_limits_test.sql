-- pgTAP: ограничения бакета файлов.
--
-- Сама проверка загрузки живёт в Storage API, а не в базе, поэтому отсюда её не
-- дёрнуть. Но конфигурация бакета лежит в обычной таблице — и именно её ставит
-- миграция. Тест страхует от того, что кто-то снова снимет лимиты кликами в
-- панели: локально и в CI это сразу покраснеет.

begin;
select plan(13);

-- ---- сам бакет ----
select ok((select exists(select 1 from storage.buckets where id = 'files')),
          'бакет files существует');

select ok((select public from storage.buckets where id = 'files'),
          'бакет публичный — на это опираются ссылки в Telegram');

-- ---- потолок размера ----
select ok((select file_size_limit is not null from storage.buckets where id = 'files'),
          'у бакета выставлен потолок размера');

select is((select file_size_limit from storage.buckets where id = 'files'),
          10485760::bigint,
          'потолок размера — 10 МБ');

-- ---- белый список типов ----
select ok((select allowed_mime_types is not null and cardinality(allowed_mime_types) > 0
             from storage.buckets where id = 'files'),
          'белый список типов не пуст');

select ok((select 'image/jpeg' = any(allowed_mime_types) from storage.buckets where id = 'files'),
          'фото счёта (jpeg) принимается');

select ok((select 'application/pdf' = any(allowed_mime_types) from storage.buckets where id = 'files'),
          'счёт в pdf принимается');

-- Обратная страховка: список ценен ровно тем, чего в нём нет. Тип, под которым
-- браузер выполнит содержимое, не должен попасть в него ни при каком расширении.
select ok((select not ('text/html' = any(allowed_mime_types)) from storage.buckets where id = 'files'),
          'html залить нельзя — иначе бакет становится хостингом для фишинга');

select ok((select not ('image/svg+xml' = any(allowed_mime_types)) from storage.buckets where id = 'files'),
          'svg залить нельзя — это картинка, но со скриптом внутри');

select ok((select not ('text/javascript' = any(allowed_mime_types)
                    or 'application/javascript' = any(allowed_mime_types))
             from storage.buckets where id = 'files'),
          'javascript залить нельзя');

-- Под octet-stream проходит вообще что угодно: разреши его — и весь список
-- перестаёт что-либо значить. Именно им бот подписывал файлы без mime-типа.
select ok((select not ('application/octet-stream' = any(allowed_mime_types))
             from storage.buckets where id = 'files'),
          'octet-stream залить нельзя — под ним прошло бы что угодно');

-- ---- политики ----
select ok((select exists(
             select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and cmd = 'INSERT' and with_check like '%files%')),
          'клиенту оставлена вставка в files — он грузит счёт не логинясь');

-- Перезапись и удаление закрыты: зная точный путь, чужой файл не подменить.
select is((select count(*)::int from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and cmd in ('UPDATE', 'DELETE')),
          0,
          'политик на изменение и удаление файлов нет');

select * from finish();
rollback;
