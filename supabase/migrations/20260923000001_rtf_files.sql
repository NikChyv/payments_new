-- RTF к заявке и платёжкам (23.09). Бухгалтер не смог приложить платёжное
-- поручение: банк-клиент выгружает его в .rtf, а бакет такого типа не знал и
-- отвечал «mime type not supported». Список типов — 20260826000003_storage_limits.
--
-- application/rtf, а не text/rtf: тип при загрузке ставим сами по расширению
-- (MIME_BY_EXT на сайте и в боте), и там он один. RTF браузер не исполняет —
-- открывает загрузкой или в Word, как doc/docx.

update storage.buckets
   set allowed_mime_types = array_append(allowed_mime_types, 'application/rtf')
 where id = 'files'
   and not ('application/rtf' = any(allowed_mime_types));
