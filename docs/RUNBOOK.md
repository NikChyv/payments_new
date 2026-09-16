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
supabase test db      # прогнать тесты (ожидается 298 PASS)
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
**Сайт обновляется только после зелёных тестов** (с 16.09, M11.4). Push в
main запускает workflow **Deploy site** (`.github/workflows/deploy.yml`):
тесты бэкенда и сторож секретов → если оба зелёные → публикация. Это 5–7 минут
от пуша до сайта. Красный прогон — на сайте остаётся прежняя версия, GitHub
присылает письмо; смотреть Actions → Deploy site.

Работает при настройке **Settings → Pages → Source: GitHub Actions**. Если там
снова «Deploy from a branch», Pages публикует ветку сам, мимо тестов.

Срочно выкатить фронт при красном CI нельзя и не нужно: красный CI значит, что
сломано что-то, что до клиентов доезжать не должно. Если причина в самом CI
(как было с 27.08 по 16.09), чинить CI.

### 2.3 Ручные шаги (вне миграций)
- **`send_daily_reminder`** — в проде хранит реальный токен внутри тела, поэтому
  миграцией не правится. Меняли `supabase/daily_reminder.sql` — выполнить его в
  SQL Editor, подставив токен и chat_id. Строго ПОСЛЕ `db push`: оболочка зовёт
  `daily_reminder_message`, которая появляется миграцией.
- **`staff.telegram_id`** — единственное место, где живут номера сотрудников.
  С 14.09 отсюда берут адресатов и мгновенные уведомления («новая заявка»,
  «клиент ответил», «клиент изменил»), и утреннее письмо. Заполняется руками, по
  id — так надёжнее, чем по имени:
  ```sql
  update staff set telegram_id = <chat_id> where id = '<uid>';
  select id, name, is_admin, telegram_id from staff;
  ```
  Свой `chat_id` человек узнаёт командой `/myid` у бота. Секрет
  `TELEGRAM_CHAT_ID` у Edge Functions больше не читается — можно не трогать.

### 2.4 Смоук-тест после деплоя
1. Открыть ссылку клиента `?t=<token>` — форма грузится, галочка «документ» снята.
2. Создать заявку → «новая заявка» пришла **бухгалтеру этого клиента и админу**, другим бухгалтерам — нет.
3. На новой заявке видна «✏️ Редактировать» → правка сохраняется.
4. В боте `/payments` — заявка видна.
5. Бухгалтер жмёт «Оплачено» → клиенту в бот пришло «✅ оплачено» (один раз).
6. Экран «Клиенты» → «🔄 Перевыпустить» → старая ссылка перестала открываться.
7. Приложить к заявке фото или PDF — файл загрузился и открывается по ссылке.
   Трогали ограничения бакета — проверить и отказ: файл заведомо не того типа
   должен получить внятное сообщение о причине, а не «файл не загрузился».

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

**Файлы Storage** (счета, платёжные документы) — тот же workflow, отдельная job
`files` (с 16.09, M3.1): `scripts/backup_files.sh` берёт список объектов бакета
`files` из базы, скачивает каждый по публичной ссылке, пакует в tar.gz и
шифрует тем же `BACKUP_PASSPHRASE` → артефакт `files-backup` (14 дней). Каждый
день — полная копия. Новых секретов не нужно.

Если хоть один файл не скачался, job красная, но частичный архив всё равно
сохраняется. Какие именно не скачались — в логе строками `не скачан:`.

Объём смотреть в логе строкой «Объектов в бакете: …, объём: …». Если архив
вырастет до гигабайтов — переходить на еженедельную полную копию.

Первый прогон 16.09.2026: **103 файла, 187 МБ**, все скачаны. Файлы копятся с
конца июня, это около 60 МБ в месяц. При 14 днях хранения выходит порядка
2,6 ГБ артефактов. Для публичного репозитория это бесплатно. **Если закрывать
репозиторий** — артефакты начнут тратить платную квоту хранилища: перед этим
сократить `retention-days` у `files-backup` или перейти на еженедельную копию.

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
| Файлы — отдельным архивом, §5.1 | Настройки Auth, адрес проекта во фронте и CI |

**Полный порядок восстановления с нуля — §5.2**, одним списком.

⚠️ **Логины бухгалтеров в бэкап не входят** — схема `auth` управляется Supabase
и не выгружается. При полном восстановлении сотрудников нужно завести заново
(Auth → Add user → `insert into staff …`, см. §7), после чего связь
`clients.staff_id` восстановится по существующим id только если использовать
**те же UID**. Иначе переназначить бухгалтеров вручную во вкладке «Клиенты».

> При восстановлении в чистую базу ожидаемы безобидные ошибки:
> `schema "public" already exists`, `permission denied to change default privileges`
> (системные роли Supabase) и `staff_id_fkey` — последняя как раз из-за
> отсутствующих `auth.users`. На данные это не влияет.

### 5.1 Восстановление файлов Storage

Файлы кладутся обратно **по прежним путям**, поэтому ссылки в заявках снова
открываются — базу править не нужно. Уже существующие файлы не трогаются,
скрипт можно запускать повторно.

```bash
# 1. Actions → DB backup → нужный запуск → скачать артефакт files-backup, распаковать zip
# 2. Git Bash, из корня репозитория. SB_SECRET_KEY — Project Settings → API Keys → secret
STORAGE_URL=https://gmvhphuabiyggfurfhmc.supabase.co \
SB_SECRET_KEY=sb_secret_... \
BACKUP_PASSPHRASE=... \
  bash scripts/restore_files.sh files-YYYYMMDD-HHMMSS.tar.gz.gpg
```
В конце: «Залито: N, уже были на месте: M, ошибок: 0».

Проверено 16.09 на локальном стеке: бэкап → удаление файлов → восстановление →
файлы совпали побайтно, в том числе с пробелами и скобками в имени; повторный
запуск ничего не дублирует.

### 5.2 Проект Supabase потерян — полное восстановление, один список

Сюда собрано **всё**, что не лежит в дампе и миграциях (находка M11.3: раньше
это было разбросано по §2.3, §5, §6.3 и §6.5). Идти строго по порядку: шаги
зависят друг от друга. Отмечать галочками.

Если проект жив и пропала одна заявка — это не сюда, а в §6.8. Пропали файлы —
§5.1.

Понадобятся: последний артефакт `db-backup` и `files-backup` (Actions → DB backup),
`BACKUP_PASSPHRASE`, токен бота (@BotFather → /mybots → API Token), email'ы
сотрудников и **их старые UID** (первая колонка в `staff` из дампа:
`grep -A5 'COPY public.staff' restore.sql`).

**А. Новый проект**
- [ ] 1. Supabase → New project, регион тот же (eu-west-1). Записать новый
      `<NEWREF>` (из адреса проекта) и пароль БД.
- [ ] 2. Database → Extensions: включить **pg_cron** и **pg_net**.
      Integrations → **Database Webhooks** → Enable.
- [ ] 3. Authentication → Sign In / Providers: **выключить регистрацию**
      (Allow new users to sign up — off). Иначе любой заведёт учётку (SECURITY.md 5.7).

**Б. Данные**
- [ ] 4. Расшифровать дамп (§5) и накатить в новый проект:
      `psql "<строка Session pooler нового проекта>" -f restore.sql`.
      Безобидные ошибки перечислены в §5.
- [ ] 5. Сказать CLI, что миграции уже в базе (дамп создал схему целиком; без
      этого `db push` начнёт накатывать всё с baseline). PowerShell, папка `payments`:
      ```powershell
      supabase link --project-ref <NEWREF>
      supabase migration repair --status applied (Get-ChildItem supabase\migrations\*.sql | ForEach-Object { $_.Name.Split('_')[0] })
      supabase db push --dry-run     # должно сказать, что применять нечего
      ```
- [ ] 6. Переписать ссылки на файлы: в заявках они содержат адрес старого
      проекта. SQL Editor, подставив `<NEWREF>`. Триггеры выключаются на время
      запроса: иначе проверка полей споткнётся о старые заявки, а журнал
      получит сотни ложных правок. Проверено на локальном стеке 16.09.
      ```sql
      begin;
      alter table public.payments disable trigger user;
      update public.payments set
        files       = replace(files::text,       'gmvhphuabiyggfurfhmc.supabase.co', '<NEWREF>.supabase.co')::jsonb,
        staff_files = replace(staff_files::text, 'gmvhphuabiyggfurfhmc.supabase.co', '<NEWREF>.supabase.co')::jsonb,
        thread      = replace(thread::text,      'gmvhphuabiyggfurfhmc.supabase.co', '<NEWREF>.supabase.co')::jsonb,
        file_url    = replace(file_url,          'gmvhphuabiyggfurfhmc.supabase.co', '<NEWREF>.supabase.co')
      where (files::text || staff_files::text || thread::text || coalesce(file_url, '')) like '%gmvhphuabiyggfurfhmc%';
      alter table public.payments enable trigger user;
      commit;
      ```
- [ ] 7. Файлы: §5.1 с `STORAGE_URL=https://<NEWREF>.supabase.co` и secret-ключом
      нового проекта. Бакет с лимитами уже создан дампом/миграцией.
- [ ] 8. Сотрудники — **с прежними UID**, тогда клиенты и личные задачи сами
      окажутся у своих бухгалтеров. Через Admin API (панель UID задать не даёт;
      проверено на локальном стеке), по разу на человека, Git Bash:
      ```bash
      curl -X POST "https://<NEWREF>.supabase.co/auth/v1/admin/users" \
        -H "apikey: <sb_secret_…>" -H "Authorization: Bearer <sb_secret_…>" \
        -H "Content-Type: application/json" \
        -d '{"id":"<старый UID>","email":"<email>","password":"<временный>","email_confirm":true}'
      ```
      Пароли сообщить людям, попросить сменить.

**В. Функции и уведомления**
- [ ] 9. Edge Functions → Secrets: `TELEGRAM_BOT_TOKEN`, `TG_WEBHOOK_SECRET`
      (новая случайная строка), `SB_SECRET_KEY` (secret-ключ нового проекта),
      `WEBHOOK_SECRET` (новая случайная строка, `openssl rand -hex 32`).
- [ ] 10. `supabase functions deploy notify-client`, `… notify-payment`, `… telegram-bot`.
- [ ] 11. `scripts/webhooks.sql` в SQL Editor: заменить в нём адрес проекта на
      `<NEWREF>`, подставить `<SECRET_KEY>` и `<WEBHOOK_SECRET>` (тот же, что в п. 9).
      Это же перезаписывает триггеры, приехавшие из дампа со старым адресом.
- [ ] 12. `supabase/daily_reminder.sql` в SQL Editor с настоящим токеном бота —
      оболочка рассылки и расписание `pg_cron` (8:30 Минск).
- [ ] 13. Telegram webhook на новый адрес (§6.5, с `<NEWREF>` и `TG_WEBHOOK_SECRET` из п. 9).

**Г. Фронт и GitHub**
- [ ] 14. Заменить `gmvhphuabiyggfurfhmc` на `<NEWREF>` и publishable-ключ на
      новый: `app/js/config.js`, `.github/workflows/health.yml` (`SB_REST`,
      `SB_BOTFN`, `SB_PUBKEY`), `.github/workflows/backup.yml` (`STORAGE_URL`),
      `scripts/webhooks.sql`, этот RUNBOOK. Найти всё: `git grep gmvhphuabiyggfurfhmc`.
- [ ] 15. GitHub → Settings → Secrets → Actions: `SUPABASE_DB_URL` — строка
      Session pooler нового проекта. `BACKUP_PASSPHRASE`, `TELEGRAM_BOT_TOKEN`,
      `TELEGRAM_CHAT_ID` — прежние.
- [ ] 16. Коммит, `git push` → дождаться зелёного **Deploy site**.

**Д. Проверка**
- [ ] 17. Смоук-тест §2.4 целиком. Отдельно: скрепка на старой заявке открывает
      файл (проверка п. 6–7), бухгалтер видит **своих** клиентов (п. 8).
- [ ] 18. Actions → Health check и DB backup → Run workflow — оба зелёные.
- [ ] 19. Утром следующего дня — письмо в 8:30 пришло троим.

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

**Проверить, жив ли утёкший ключ** (не «наверное», а фактом):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<ref>.supabase.co/rest/v1/clients?select=id&limit=1" \
  -H "apikey: <ключ>" -H "Authorization: Bearer <ключ>"
```
200 — ключ читает токены всех клиентов мимо RLS. 401 — уже мёртв.

**Проект на новых ключах** (Settings → API Keys → вкладка «Publishable and
secret»). Тогда ротировать JWT-секрет **не нужно** — legacy отключается
кнопкой, а переход идёт без простоя, потому что старые и новые ключи работают
параллельно:

1. фронт → `sb_publishable_…` в `app/js/config.js`, пуш;
2. секрет `SB_SECRET_KEY` = `sb_secret_…` в Edge Functions → Secrets,
   передеплоить функции (код читает его с откатом на legacy);
3. `scripts/webhooks.sql` в SQL Editor — пересоздаёт оба Database Webhook
   с новым ключом и заголовком `x-webhook-secret`;
4. секрет `WEBHOOK_SECRET` в Edge Functions → Secrets (та же строка, что в
   триггерах) — только теперь включается проверка в функциях;
5. проверить сквозной сценарий на тестовой фирме;
6. Settings → API Keys → Legacy → **Disable JWT-based API keys**;
7. проверить ещё раз и повторить curl выше — должно быть 401;
8. через неделю: JWT Keys → Previously used → Revoke старому HS256.

**Проект только на legacy-ключах.** Ротация JWT-секрета бьёт по всему разом:
фронт, вебхуки, сессии сотрудников. Простой 3–5 минут, поэтому только после
17:00 и с заранее подготовленными правками.

**Из истории git ключ не вычистить** (форки, кэши сканеров). Спасает только то,
что старый ключ становится мёртвым.

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

**Начинать отсюда — журнал отказов.** Каждая неудачная отправка пишется в
`notify_failures` с веткой, заявкой, чатом и ответом Telegram. Это быстрее
любых логов и покрывает случай «всё выглядит рабочим, а сообщения не идут»:

```sql
select at, fn, branch, payment_id, chat_id, detail
from notify_failures order by at desc limit 50;
```

Пусто, а жалобы есть — значит функция вообще не вызывалась: смотреть Database
Webhooks и логи функции. `health.yml` краснеет сам, если за сутки был хоть один
отказ (`notify_failures_recent(24)`).

Разобрали инцидент — записи можно почистить, чтобы сторож позеленел:
`delete from notify_failures where at < now() - interval '1 day';`

- **О новой заявке** — проверить Database Webhook на INSERT `payments` и логи
  `notify-payment`.
- **Бухгалтеру не приходят уведомления по его клиентам** — у него не проставлен
  `staff.telegram_id`, и они уходят только админу. В журнале это видно сразу:
  запись «у бухгалтера «Имя» не указан telegram_id». Проверить и починить:
  `select name, telegram_id from staff;` → `update staff set telegram_id = …`.
- **Уведомление пришло не тому бухгалтеру** — у клиента не тот `staff_id`:
  `select c.name, s.name from clients c left join staff s on s.id = c.staff_id;`.
  Уведомления идут бухгалтеру клиента и админам, больше никому.
- **Клиенту об оплате** — первым делом проверить привязку:
  ```sql
  select name, telegram_id from clients where name ilike '%часть названия%';
  ```
  `telegram_id is null` — клиент не привязан, уведомления физически некуда слать.
  Лечится тем, что клиент открывает ссылку на бота и жмёт «Старт».

  Если человек ведёт **несколько фирм**, каждая привязывается отдельно — и до
  августа 2026 вторая ссылка отключала первую. У таких людей смотреть все фирмы
  разом, а не одну:
  ```sql
  select name, telegram_id from clients where telegram_id = <chat_id>;
  ```
  Нашлась одна фирма, а компаний у человека две — вторую надо привязать заново
  (открыть её ссылку бота и нажать «Старт»); прежняя при этом уже не слетит.

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

### 6.8 Заявку удалили по ошибке
С 14.09 удаление пишет в журнал снимок всей строки. Найти:
```sql
select changed_at, changed_by, changes -> 'deleted' as row
from payments_audit
where action = 'DELETE' and changes ? 'deleted'
order by id desc limit 20;
```
Восстановить конкретную (подставив `payment_id`):
```sql
insert into payments
select * from jsonb_populate_record(null::payments,
  (select changes -> 'deleted' from payments_audit
    where action = 'DELETE' and payment_id = '<id>' order by id desc limit 1));
```
Проверено на стенде: строка встаёт побайтно той же. Флаги уведомлений
восстанавливаются вместе с ней, поэтому **клиенту** «оплачено» и документ
повторно не уйдут. А вот **бухгалтеру клиента и админу** придёт «новая заявка»:
вставка будит `notify-payment`, а у него флага «уже уведомляли» нет. Предупредите
их, что это восстановление, а не новый платёж.

Удаления до 14.09 снимка не имеют — там только id и статус.

### 6.9 Человеку пришло «фирма привязана к другому аккаунту Telegram»
Кто-то открыл ссылку бота этой фирмы и нажал «Старт» — с 14.09 прежний
владелец привязки об этом узнаёт. Если это законно (сменил телефон, передал фирму
коллеге) — ничего делать не надо. Если человек говорит «это не я» — ссылка
утекла: **«🔄 Перевыпустить»** у этой фирмы на экране «Клиенты». Старая ссылка
умрёт, чужая привязка сбросится, а законному владельцу надо заново прислать новую
ссылку и попросить нажать «Старт».

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
| **Добавить получателя уведомлений** | его chat_id (`/myid` в боте) → `update staff set telegram_id = <chat_id> where id = '<uid>';`. Больше никуда: с 14.09 и мгновенные уведомления, и утреннее письмо берут номера только из `staff` |
| **Передать клиента другому бухгалтеру** | `update clients set staff_id = '<uid бухгалтера>' where id = '<id клиента>';` — уведомления по клиенту сразу пойдут новому бухгалтеру (и админам) |
| **Посмотреть историю платежа** | `select * from payments_audit where payment_id = '<id>' order by changed_at;` |
| **Удалить файл из Storage** | только через Storage API, см. ниже |

### 7.1 Удалить файл из Storage

Через SQL нельзя: `delete from storage.objects` перехватывает триггер
`storage.protect_delete()` («Direct deletion from storage tables is not allowed»).
Он защищает от осиротевших объектов — строку удалить, а файл в хранилище оставить.
Обычный `delete` вдобавок молча не сработает и без триггера: RLS на
`storage.objects` не имеет политики `DELETE`, а `postgres` не обходит RLS.

Нужен `service_role`-ключ; вытащить его можно CLI, в панель лезть не обязательно:

```bash
supabase projects api-keys --project-ref gmvhphuabiyggfurfhmc   # взять service_role
curl -X DELETE "https://gmvhphuabiyggfurfhmc.supabase.co/storage/v1/object/files/<путь>" \
  -H "Authorization: Bearer $SERVICE_ROLE" -H "apikey: $SERVICE_ROLE"
```

Ключ в историю команд и в репозиторий не класть.

## 8. Контрольный список перед релизом

- [ ] `supabase test db` — все тесты зелёные
- [ ] CI на GitHub зелёный
- [ ] Изменения схемы оформлены миграцией (не кликами в проде)
- [ ] Секреты не попали в репозиторий (в файлах — плейсхолдеры)
- [ ] Деплой в порядке: миграции → функции → фронт
- [ ] Пройден смоук-тест (§2.4)
