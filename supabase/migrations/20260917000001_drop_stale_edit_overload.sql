-- Лишняя перегрузка edit_payment_by_token на проде
--
-- Найдено 16.09.2026 при проверке прода снаружи: вызов
-- edit_payment_by_token без p_files отвечает PGRST203 «Could not choose the
-- best candidate function» — в базе живут ДВЕ версии, 11 аргументов (без
-- p_files, эпоха до 26.08) и 12 (с p_files jsonb default null). PostgREST не
-- может выбрать между ними, когда p_files не передан.
--
-- Локально старой версии нет: 20260826000001_multi_files.sql её удаляет. То
-- есть это расхождение прода с миграциями — ровно то, о чём CLAUDE.md, грабли
-- №1: добавление параметра — перегрузка, а не замена.
--
-- Сегодняшний фронт всегда передаёт p_files, поэтому клиенты не спотыкаются.
-- Но старый вызов обязан работать (тот же CLAUDE.md: между накатом миграции и
-- выкладкой фронта прод зовёт функцию по-старому) — и любой кэшированный у
-- клиента client_view.js прежней версии сейчас получил бы отказ на «Сохранить».
--
-- Удаляем старую версию; права у 12-аргументной остаются при ней, но выдаём
-- повторно — цена ошибки здесь встающая правка заявки у всех клиентов.
-- Локально и в CI миграция — no-op.
-- ---------------------------------------------------------------------------
drop function if exists public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text);

grant execute on function public.edit_payment_by_token(
  text, text, text, numeric, text, date, text, text, boolean, text, text, jsonb)
  to anon, authenticated;
