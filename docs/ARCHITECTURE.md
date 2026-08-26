# Архитектура — «Платежи ITnimax»

Технический обзор системы: из чего состоит, как связано, где что лежит.
Эксплуатация и процедуры — в [RUNBOOK.md](RUNBOOK.md). Безопасность — в
[../SECURITY.md](../SECURITY.md).

## 1. Общая схема

```
┌─ КЛИЕНТ ──────────────┐        ┌─ БУХГАЛТЕР / АДМИН ───┐
│ веб: ?t=<token>       │        │ веб: email + пароль   │
│ Telegram-бот          │        │ Telegram: уведомления │
└───────────┬───────────┘        └───────────┬───────────┘
            │                                │
            ▼                                ▼
  ┌─────────────────────────────────────────────────────┐
  │  GitHub Pages — статика (app/), CDN Fastly, HTTPS   │
  └─────────────────────────┬───────────────────────────┘
                            │ supabase-js (anon key)
                            ▼
  ┌─────────────────────────────────────────────────────┐
  │  SUPABASE (за Cloudflare)                           │
  │                                                     │
  │  PostgreSQL 17 + RLS                                │
  │    таблицы: payments, clients, staff, tg_sessions,  │
  │             payments_audit, rpc_rate_limit          │
  │    RPC (SECURITY DEFINER) ← единственный путь anon  │
  │                                                     │
  │  Auth (JWT)      Storage (bucket files)             │
  │                                                     │
  │  Edge Functions (service_role):                     │
  │    notify-payment · notify-client · telegram-bot    │
  │                                                     │
  │  pg_cron: send_daily_reminder (8:30 Минск)          │
  └─────────────────────────┬───────────────────────────┘
                            │ net.http_post / fetch
                            ▼
                   Telegram Bot API
```

## 2. Компоненты

### 2.1 Фронтенд — `app/` (GitHub Pages)
Статика без сборщика, нативные ES-модули. Адрес:
`https://nikchyv.github.io/payments_new/app/`

| Файл | Ответственность |
|------|-----------------|
| `index.html` | разметка: очередь, форма, вход, экран клиентов |
| `styles.css` | все стили |
| `js/config.js` | URL и anon-ключ Supabase, имена таблицы/бакета |
| `js/state.js` | общее изменяемое состояние |
| `js/supabase.js` | клиент SB, load/save, upload файлов, маппинг row↔объект |
| `js/auth.js` | вход/выход сотрудника, определение роли из `staff` |
| `js/clients.js` | экран «Клиенты»: список, добавление, ссылки, ротация токена |
| `js/queue.js` | очередь бухгалтера: рендер, счётчики, смена статусов |
| `js/client_view.js` | клиентский режим: RPC по токену, рендер своих платежей |
| `js/main.js` | оркестратор: init, навигация, поллинг (15с), submit/edit |
| `js/dates.js`, `js/utils.js` | даты (пояс Минска) и мелкие хелперы |

Граф зависимостей без циклов: `config/dates/utils/state → supabase → clients/queue/client_view/auth → main`.
`main.js` — единственный, кто переключает экраны.

> В корне репозитория лежат легаси `index.html` (прод v1.4) и `app.html`
> (монолит v1.7) — историческое, не развиваются.

### 2.2 База данных

| Таблица | Назначение |
|---------|-----------|
| `payments` | платёжные поручения; статусы `new → in_progress → paid → sent` |
| `clients` | компании: имя, `token` (ссылка), `staff_id`, `telegram_id` |
| `staff` | сотрудники; `id` = `auth.users.id`, флаг `is_admin` |
| `tg_sessions` | состояние пошагового диалога бота (шаг + черновик jsonb) |
| `payments_audit` | журнал: создание/удаление/смена статуса, кто и когда |
| `rpc_rate_limit` | счётчики частоты вызовов anon-RPC |

**RPC — единственный путь для anon** (прямой доступ к таблицам отозван):

| Функция | Кто | Что делает |
|---------|-----|-----------|
| `client_by_token` | anon | имя компании по токену |
| `list_payments_by_token` | anon | платежи только этого клиента |
| `submit_payment` | anon | создать заявку (лимит 10/мин, 60/час) |
| `edit_payment_by_token` | anon | правка своей заявки, только `status='new'` (20/мин) |
| `rotate_client_token` | admin | перевыпуск ссылки, старый токен мёртв |
| `is_admin` | внутр. | проверка роли для RLS-политик |
| `check_rate_limit` | внутр. | учёт частоты, бросает исключение при превышении |
| `send_daily_reminder` | cron | утренний список платежей в Telegram |

### 2.3 Edge Functions

| Функция | Триггер | Verify JWT | Что делает |
|---------|---------|-----------|------------|
| `notify-payment` | DB Webhook: INSERT `payments` | вкл | «новая заявка» бухгалтерам |
| `notify-client` | DB Webhook: UPDATE `payments` | вкл | клиенту «оплачено»/«документ», ровно один раз (флаги) |
| `telegram-bot` | Telegram webhook | **выкл** | `/start`, `/payments`, `/new` (диалог), `/cancel`, `/myid` |

`telegram-bot` защищён секретным заголовком `TG_WEBHOOK_SECRET`, поэтому JWT
у него выключен (Telegram его не пришлёт).

### 2.4 Telegram-бот
Бот `@paymentITNIMAX_bot` совмещает две роли:
- **для клиента** — привязка по deep-link `t.me/paymentITNIMAX_bot?start=<token>`,
  просмотр платежей, пошаговое создание заявки с фото счёта;
- **для бухгалтера** — только приём уведомлений (командами не пользуется).

Создание заявки ботом идёт через тот же `submit_payment`, поэтому запись,
уведомления и лимиты работают одинаково в обоих каналах.

## 3. Ключевые потоки

**Клиент создаёт заявку (веб или бот)**
`submit_payment` → запись в `payments` → DB Webhook → `notify-payment` →
Telegram бухгалтерам. Триггер аудита пишет `INSERT` в `payments_audit`.

**Бухгалтер проводит платёж**
Смена статуса в очереди → upsert в `payments` → DB Webhook → `notify-client`
(шлёт только при первом переходе, затем ставит флаг) → клиенту в бот.
Аудит фиксирует переход `old_status → new_status`.

**Утренний список**
`pg_cron` в 05:30 UTC (8:30 Минск) → `send_daily_reminder()` → `net.http_post`
→ Telegram бухгалтерам: платежи на сегодня со ссылками на файлы.

## 4. Инфраструктура как код

```
supabase/
  config.toml            конфиг локального стека (порты 483xx)
  migrations/            схема БД по порядку (baseline + 6 миграций)
  functions/             исходники Edge Functions
  tests/                 pgTAP: 24 теста
  seed.sql               демо-данные (только локально)
  daily_reminder.sql     утренняя рассылка (токен подставляется в проде)
.github/workflows/
  test.yml               CI: supabase start + supabase test db
  backup.yml             ежедневный шифрованный pg_dump
```

Локальный стек поднимается одной командой (`supabase start`) и содержит полную
копию бэкенда — см. RUNBOOK.

## 5. Что живёт вне миграций

Эти вещи задаются в панели Supabase и при восстановлении с нуля настраиваются
руками (процедуры — в RUNBOOK):

- **Database Webhooks** для `notify-payment` и `notify-client`;
- **Секреты** функций (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TG_WEBHOOK_SECRET`);
- **Учётки сотрудников** в Auth (данные, не схема);
- **Реальный токен бота** внутри `send_daily_reminder` (в репозитории — плейсхолдер);
- **Публичность бакета** `files`.
