# RUNBOOK — эксплуатация системы

Пошаговые процедуры: разработка, деплой, откат, инциденты, восстановление.
Устройство системы — в [ARCHITECTURE.md](ARCHITECTURE.md).

## 0. Что нужно на машине

- **Docker Desktop** (для локального стека Supabase)
- **Supabase CLI** (ставился через Scoop)
- Доступы: GitHub (репо `NikChyv/payments_new`), Supabase (проект
  `gmvhphuabiyggfurfhmc`), Telegram @BotFather (владелец бота)

На Windows CLI и docker могут быть не в `PATH` текущей сессии:
```powershell
$env:Path = "$env:USERPROFILE\scoop\shims;$env:Path"     # supabase
# docker: "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
```

## 1. Локальная разработка

```powershell
# 1. запустить Docker Desktop, дождаться «Engine running»
cd c:\Payment-automation-system\payments
supabase start        # поднять локальный стек
supabase db reset     # пересобрать БД с нуля: миграции + seed
supabase test db      # прогнать тесты (ожидается 135 PASS)
supabase stop         # остановить (данные сохраняются в docker volume)
```

Локальные адреса: Studio `http://127.0.0.1:18323`, API `http://127.0.0.1:18321`,
БД `postgresql://postgres:postgres@127.0.0.1:18322/postgres`.

> Порты сдвинуты с дефолтных `543xx`: Windows раздаёт динамические порты по
> всему диапазону, и Hyper-V периодически резервирует новый кусок — стек
> перестаёт стартовать с «ports are not available». Лечится переносом портов:
> ```powershell
> netsh interface ipv4 show excludedportrange protocol=tcp   # что занято
> ```
> затем поменять порты в `supabase/config.toml` на свободные и `supabase start`.

Фронт для локальной проверки достаточно раздать любым статическим сервером и
открыть `http://localhost:8080/app/` — `app/js/config.js` сам переключается на
локальный стек по имени хоста, править его не нужно.

**Изменение схемы:** новый файл в `supabase/migrations/` с именем
`ГГГГММДДЧЧММСС_описание.sql` → `supabase db reset` → `supabase test db`.
Схему **никогда** не правим кликами в проде — только миграцией.

⚠️ Не применять `.sql` с кириллицей через PowerShell-пайп
(`Get-Content | docker exec -i psql`) — ломается кодировка. Использовать
`supabase db reset` либо веб-редактор Supabase.

## 2. Деплой на прод

Порядок обязателен: **бэкенд → функции → фронт**. Иначе фронт вызовет то,
чего в базе ещё нет.

### 2.1 Первый деплой после перехода на миграции (одноразово)
```powershell
supabase login
supabase link --project-ref gmvhphuabiyggfurfhmc
# пометить baseline применённым — он ОПИСЫВАЕТ уже существующую прод-схему.
# Без этого db push прогонит baseline и перезапишет send_daily_reminder
# плейсхолдер-токеном -> утренние уведомления сломаются.
supabase migration repair --status applied 20260622000000
```

### 2.2 Обычный деплой
```powershell
supabase db push                              # 1. миграции
supabase functions deploy notify-client       # 2. функции (по мере изменений)
supabase functions deploy notify-payment
supabase functions deploy telegram-bot
git push                                      # 3. фронт -> GitHub Pages
```
После пуша фронта Pages обновляется 1–2 минуты.

### 2.3 Ручные шаги (вне миграций)
- **`send_daily_reminder`** — в проде хранит реальный токен внутри тела. Если
  миграция его перезаписала плейсхолдером, восстановить из
  `supabase/daily_reminder.sql`, подставив реальные значения.

### 2.4 Смоук-тест после деплоя
1. Открыть ссылку клиента `?t=<token>` — форма грузится, галочка «документ» снята.
2. Создать заявку → бухгалтерам пришло «новая заявка».
3. На новой заявке видна «✏️ Редактировать» → правка сохраняется.
4. В боте `/payments` — заявка видна.
5. Бухгалтер жмёт «Оплачено» → клиенту в бот пришло «✅ оплачено» (один раз).
6. Экран «Клиенты» → «🔄 Перевыпустить» → старая ссылка перестала открываться.

## 3. Откат

| Что откатывать | Как |
|----------------|-----|
| **Фронт** | `git revert <коммит>` → `git push`. Аварийно: `git checkout v2.1-pilot-ok -- app/` → коммит → пуш |
| **Edge Function** | задеплоить предыдущую версию из git-истории |
| **Миграция** | миграции аддитивные; писать компенсирующую миграцию (`drop`/`alter`). `db reset` против прода **запрещён** |
| **Данные** | восстановление из бэкапа (см. §5) |

Якорь заведомо рабочего состояния: тег **`v2.1-pilot-ok`**.

## 4. Бэкапы

Workflow `.github/workflows/backup.yml` — ежедневно в 02:00 UTC:
`pg_dump` → gzip → GPG AES256 → артефакт (30 дней).

**Требует секретов репозитория** (Settings → Secrets and variables → Actions):
- `SUPABASE_DB_URL` — Supabase → Project Settings → Database → Connection string
  → **Session pooler** (URI с паролем);
- `BACKUP_PASSPHRASE` — пароль шифрования, хранить **отдельно** от репозитория.

Ручной прогон: вкладка Actions → DB backup → Run workflow.

## 5. Восстановление БД из бэкапа

```bash
# 1. скачать артефакт из нужного запуска Actions, распаковать zip
# 2. расшифровать (loopback обязателен для gpg 2.x)
gpg --batch --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" \
  -d payments-YYYYMMDD-HHMMSS.sql.gz.gpg | gunzip > restore.sql
# 3. применить (сначала проверить на локальном стеке!)
psql "$SUPABASE_DB_URL" -f restore.sql
```

### Что бэкап покрывает, а что нет

Дамп — это схема `public` без владельцев. Проверено восстановлением: таблицы,
данные, функции и RLS-политики встают полностью и работают.

| Восстанавливается | Требует ручных действий |
|---|---|
| Клиенты и их **токены** (ссылки продолжат работать) | **Учётки входа сотрудников** (`auth.users`) |
| Платежи, статусы, журнал изменений | Секреты Edge Functions |
| Функции, RPC, RLS-политики | Database Webhooks |
| Привязки Telegram у клиентов | Расписание `pg_cron` и токен в `send_daily_reminder` |

⚠️ **Логины бухгалтеров в бэкап не входят** — схема `auth` управляется Supabase
и не выгружается. При полном восстановлении сотрудников нужно завести заново
(Auth → Add user → `insert into staff …`, см. §7), после чего связь
`clients.staff_id` восстановится по существующим id только если использовать
**те же UID**. Иначе переназначить бухгалтеров вручную во вкладке «Клиенты».

> При восстановлении в чистую базу ожидаемы безобидные ошибки:
> `schema "public" already exists`, `permission denied to change default privileges`
> (системные роли Supabase) и `staff_id_fkey` — последняя как раз из-за
> отсутствующих `auth.users`. На данные это не влияет.

### Проверка восстановления (раз в квартал)
Накатить дамп в **локальный** стек и сверить количество строк с продом:
```bash
supabase start
docker exec -i supabase_db_payments psql -U postgres -d postgres < restore.sql
```
После проверки вернуть локальную базу: `supabase db reset`.

## 6. Инциденты

### 6.1 Утёк токен клиента
Экран «Клиенты» → **«🔄 Перевыпустить»** у нужного клиента. Старая ссылка
мертва мгновенно. Отправить клиенту новую (и новую ссылку на бота, если он им
пользуется).

### 6.2 Утёк токен бота
1. @BotFather → `/revoke` → получить новый токен.
2. Обновить секрет `TELEGRAM_BOT_TOKEN` в Edge Functions.
3. Обновить токен внутри `send_daily_reminder` (SQL Editor).
4. Заново установить webhook (см. 6.5).

### 6.3 Утёк `service_role` / JWT-секрет
Supabase → Settings → API → ротация ключей → передеплоить функции → обновить
заголовок `Authorization` в Database Webhooks.

### 6.4 Бот молчит
```
https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo
```
- `404` — функция `telegram-bot` не задеплоена или имя другое (при деплое из
  панели имя надо вписывать вручную);
- `401` — у функции включён Verify JWT, должен быть **выключен**;
- `403` — не совпадает `TG_WEBHOOK_SECRET`.

Прямой GET адреса функции должен отдавать **403** — это норма.

### 6.5 Пересоздать Telegram webhook
```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://gmvhphuabiyggfurfhmc.supabase.co/functions/v1/telegram-bot&secret_token=<TG_WEBHOOK_SECRET>
```
> После включения webhook `getUpdates` не работает — это ожидаемо. Узнать
> chat_id можно командой `/myid` в боте.

### 6.6 Не приходят уведомления
- **О новой заявке** — проверить Database Webhook на INSERT `payments` и логи
  `notify-payment`.
- **Клиенту об оплате** — первым делом проверить привязку:
  ```sql
  select name, telegram_id from clients where name ilike '%часть названия%';
  ```
  `telegram_id is null` — клиент не привязан, уведомления физически некуда слать.
  Лечится тем, что клиент открывает ссылку на бота и жмёт «Старт».

  Понять, доходили ли уведомления раньше, можно по флагам: они ставятся
  **только после того, как Telegram принял сообщение**, поэтому это надёжный
  журнал доставки.
  ```sql
  select p.due, p.payee, p.status, p.client_paid_notified
  from payments p join clients c on c.id = p.client_id
  where c.name ilike '%…%' order by p.created_at desc limit 20;
  ```
  Момент, где `true` сменяется на `false`, — дата, когда привязка отвалилась.

  Повторное уведомление не придёт по флагам `client_paid_notified` /
  `client_sent_notified` — это by design.

  ⚠️ **Перевыпуск ссылки отвязывает и бота.** После «🔄 Перевыпустить» клиенту
  нужно отправить и новую ссылку на бота, иначе уведомления молча прекратятся.
- **Утренний список** — проверить `cron.job` и что в `send_daily_reminder`
  реальный токен, а не плейсхолдер.

### 6.7 Клиент жалуется «слишком много запросов»
Сработал rate-limit (10/мин, 60/час на заявки). Подождать окно. Лимиты
меняются новой миграцией в `check_rate_limit`-вызовах.

## 7. Регулярные операции

| Что | Как |
|-----|-----|
| **Завести клиента** | экран «Клиенты» → имя + бухгалтер → «Добавить» → скопировать ссылку |
| **Удалить клиента** | экран «Клиенты» → «🗑 Удалить» (только админ). Сработает, **только если заявок 0** — число видно в карточке. С заявками система откажет: удаление осиротило бы платежи |
| **Выгрузить платежи в Excel** | экран «Клиенты» → «📊 Выгрузить в Excel» → период (по умолчанию текущий месяц) → «Скачать». Доступно бухгалтеру и админу; бухгалтер видит только своих клиентов |
| **Ссылка для бота** | `https://t.me/paymentITNIMAX_bot?start=<токен>` (токен = часть после `?t=`) |
| **Завести сотрудника** | Supabase → Auth → Add user → скопировать UID → `insert into staff (id, name, is_admin) values ('UID','Имя',false) on conflict (id) do nothing;` |
| **Добавить получателя уведомлений** | его chat_id (`/myid` в боте) → в секрет `TELEGRAM_CHAT_ID` (через запятую) **и** в массив `chat_ids` в `send_daily_reminder` |
| **Посмотреть историю платежа** | `select * from payments_audit where payment_id = '<id>' order by changed_at;` |

## 8. Контрольный список перед релизом

- [ ] `supabase test db` — все тесты зелёные
- [ ] CI на GitHub зелёный
- [ ] Изменения схемы оформлены миграцией (не кликами в проде)
- [ ] Секреты не попали в репозиторий (в файлах — плейсхолдеры)
- [ ] Деплой в порядке: миграции → функции → фронт
- [ ] Пройден смоук-тест (§2.4)
