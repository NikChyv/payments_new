# Передача проекта в Claude Code — «Платежи под контролем»

Этот файл — точка входа для продолжения проекта в Claude Code. Прочти его и
`CONTEXT.md` (общее описание проекта, грабли, роадмап). Ниже: что сделано, где
остановились, как развернуть репозиторий и первое задание (разбить app.html на модули).

## 1. Как развернуть репозиторий

Вся история и теги лежат в `payments-baseline.bundle`. Разворачивается одной командой:

```
git clone payments-baseline.bundle payments
cd payments
git log --oneline --decorate   # увидишь теги v1.0 … v1.7
```

(Если открываешь уже распакованную папку — это и есть рабочая копия, просто
`git status`.) Дальше заведи нормальный remote на GitHub и `git push`.

## 2. Файлы

- `index.html` — ПРОД-версия для клиентов (тег v1.4). Сейчас её и видят клиенты по
  публичной ссылке (GitHub Pages). Не ломать.
- `app.html` — НОВАЯ многопользовательская версия (тег v1.7): вход, роли, экран
  «Клиенты». Её развиваем и в конце заменим ею index.html.
- `supabase_setup.sql` — SQL безопасности (Фаза 1 выполнена в базе; Фаза 2 — нет).
- `CONTEXT.md` — исходный контекст проекта и роадмап.
- `payments-baseline.bundle` — резервная копия всей истории (можно удалить после push).

## 3. Стек и доступы

- Хостинг: GitHub Pages (статика). Бэкенд: Supabase (БД + Storage + REST + Auth).
- Ключи Supabase вписаны вверху `<script>` в `app.html`/`index.html`
  (`SUPABASE_URL`, `SUPABASE_KEY` — это публичный anon-ключ, ему так и положено).
- Учётки входа (Supabase Auth, заведены):
  - `nikitacyv@gmail.com` — админ (в таблице `staff`, is_admin = true)
  - `buhtest@itnimax.by` — бухгалтер (is_admin = false)
- Тестовый клиент «ООО «Тест»» заведён в таблице `clients` (привязан к buhtest), у него есть token.

## 4. Модель данных (Supabase)

- `payments` — платежи (как раньше) + колонка `client_id` (FK на clients).
- `staff` — сотрудники: id = auth.users.id, name, is_admin.
- `clients` — клиенты: id, name, token (секрет для ссылки), staff_id (закреплённый бухгалтер).
- Функции для клиента (anon, по токену, SECURITY DEFINER):
  `client_by_token(token)`, `list_payments_by_token(token)`,
  `submit_payment(token, …)`.
- RLS: включён на `staff` и `clients`; на `payments` ПОКА ВЫКЛЮЧЕН (это Фаза 2).
  Политики для payments уже созданы, но не действуют, пока RLS не включён.

## 5. Где именно остановились

Готово в `app.html` (v1.7):
- Вход бухгалтера/админа (Supabase Auth), роль из `staff`, выход.
- Экран «Клиенты» (только админ): завести клиента, выбрать бухгалтера, ссылка с токеном + копирование.
- Очередь фильтруется по бухгалтеру (админ видит всё; бухгалтер — только своих клиентов).

НЕ сделано (следующие шаги роадмапа):
- **Шаг 7 (следующий):** клиентская часть по токену. Сейчас клиент в app.html всё ещё
  работает по старому `?client=Имя`. Нужно перевести на `?t=<token>`:
  - по токену получать имя компании (`client_by_token`),
  - список своих платежей (`list_payments_by_token`),
  - отправку заявки через `submit_payment` (а не прямой insert).
  Тогда заявки клиента сами привязываются к нему (client_id) и попадают нужному бухгалтеру.
- **Шаг 8 (переезд, Фаза 2):** выполнить нижнюю (закомментированную) часть
  `supabase_setup.sql`: `enable row level security` на payments + `revoke all on payments
  from anon`. После этого прямой доступ к таблице закрыт, клиент работает только через функции.
  Проверить ИЗОЛЯЦИЮ: бухгалтер не видит чужих платежей даже через DevTools; клиент по
  токену видит только своё.
- Затем заменить `index.html` новой версией и обновить GitHub Pages.
- Дальше по роадмапу (CONTEXT.md): Telegram-уведомления бухгалтеру; AI-распознавание счёта.

## 6. Грабли (не повторять)

- В `SUPABASE_URL` НЕ должно быть `/rest/v1`.
- Дату собирать локально (`isoLocal`), не через `toISOString()` — иначе в поясе РБ был «вчера». (Уже починено.)
- Валюта — белорусский рубль «Br»; реквизиты — «УНП», не «ИНН».
- Бэкап перед рискованными шагами: коммит + тег.

## 7. ПЕРВОЕ ЗАДАНИЕ ДЛЯ CLAUDE CODE — разбить app.html на модули

Сейчас `app.html` — один файл (~970 строк) с инлайновыми `<style>` и `<script>`.
Из-за этого любая мелкая правка требует читать весь файл. Разбей на части
(поведение должно остаться идентичным), затем продолжай роадмап уже по модулям.

Рекомендуемая структура (без сборщика, на нативных ES-модулях — работает на GitHub Pages как есть):

```
/app/
  index.html          # каркас: разметка экранов + <link css> + <script type="module">
  styles.css          # все стили из <style>
  js/
    config.js         # SUPABASE_URL, SUPABASE_KEY, TABLE, BUCKET
    supabase.js       # createClient; load/save/uploadFile/removeRemote; toRow/fromRow
    dates.js          # isoLocal, todayStr, daysBetween, addDays, addMonths, fmtDate, fmtMoney
    state.js          # общее состояние: items, currentStaff, clientsList, staffList, quickFilter, CLIENT
    auth.js           # doLogin, doLogout, onLoggedIn
    clients.js        # экран «Клиенты»: loadClients, loadStaffList, renderClients, addClient, baseLink, genToken
    queue.js          # очередь бухгалтера: render, rowHtml, computeCounts, onListClick, markPaid, undoPaid
    client_view.js    # клиентский режим по токену: client_by_token/list/submit, renderClient, clSteps
    main.js           # init, switchView, навешивание слушателей, склейка модулей
```

Правила рефактора:
- Поведение 1-в-1 как в текущем `app.html` (никаких новых фич в этом коммите).
- Никаких сборщиков на старте — `<script type="module">` и `import`/`export`. (Vite можно
  ввести позже, если понадобится dev-сервер/минификация.)
- После рефактора проверить: открывается, вход работает, экран «Клиенты» работает,
  очередь фильтруется. Закоммитить отдельным коммитом + тег (напр. `v2.0-modular`).
- Только потом реализовывать Шаг 7 (клиент по токену) уже в модульной структуре.

Стартовое сообщение для Claude Code (скопировать):

> Прочитай HANDOFF.md и CONTEXT.md. Разверни репозиторий, разбей app.html на модули по
> структуре из раздела 7 HANDOFF (поведение без изменений), проверь, закоммить с тегом
> v2.0-modular. Затем продолжи Шаг 7 из раздела 5: перевести клиентскую часть на токен
> (?t=…) через функции client_by_token / list_payments_by_token / submit_payment.
