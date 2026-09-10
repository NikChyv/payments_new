-- Уведомления: журнал отказов, получатели утренней рассылки, личные задачи.
--
-- Этап 3 плана docs/FIXPLAN.md. Здесь серверная часть — M4.4, M4.5, M4.6.
-- Ветвление notify-client (M4.1) и текст «документ отправлен» (M1.5) правятся
-- в коде функций.

-- ---------------------------------------------------------------------------
-- M4.4. Журнал отказов доставки
--
-- Сейчас отказ Telegram уходит в console.error и растворяется: у Database
-- Webhooks нет ретраев, а health.yml сторожит доступность бота, а не доставку.
-- Ровно так и получился боевой инцидент — клиент почти месяц не получал
-- уведомлений, и никто этого не видел.
--
-- Пишем сюда каждую неудачную отправку. Таблица служебная: RLS включена,
-- политик нет — значит ни anon, ни вошедший сотрудник не читают её вовсе,
-- а функции ходят под service_role и RLS не стесняются.
-- ---------------------------------------------------------------------------
create table if not exists public.notify_failures (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  fn         text not null,          -- notify-client / notify-payment
  branch     text not null,          -- какая ветка не смогла отправить
  payment_id text,
  chat_id    text,
  detail     text
);

create index if not exists notify_failures_at_idx on public.notify_failures (at desc);

alter table public.notify_failures enable row level security;

revoke all on table public.notify_failures from public, anon, authenticated;

comment on table public.notify_failures is
  'Неудачные отправки уведомлений. Пишут Edge Functions под service_role, читать — через notify_failures_recent или в SQL Editor.';

-- Сколько отказов за последние N часов. Наружу отдаём ТОЛЬКО число: по нему
-- health.yml поднимает тревогу, не получая доступа к самим записям. Поэтому
-- функцию можно открыть anon — публичным ключом из фронта её и зовёт сторож.
create or replace function public.notify_failures_recent(p_hours int default 24)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from notify_failures
   where at > now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 168)));
$$;

comment on function public.notify_failures_recent(int) is
  'Число неудачных отправок за N часов (1..168). Только счётчик — для внешнего сторожа.';

revoke all on function public.notify_failures_recent(int) from public;
grant execute on function public.notify_failures_recent(int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M4.6. Получатели утренней рассылки — из таблицы, а не из тела функции
--
-- Сейчас список зашит массивом внутри send_daily_reminder: там два chat_id из
-- трёх, и третий бухгалтер рассылку не получает вовсе. Заодно этот список
-- живёт отдельно от секрета TELEGRAM_CHAT_ID у функций, и они уже разъехались.
--
-- Кладём chat_id туда, где и так лежат сотрудники. Заполняется вручную:
--   update staff set telegram_id = 670574684 where name = 'Никита';
-- ---------------------------------------------------------------------------
alter table public.staff
  add column if not exists telegram_id bigint;

comment on column public.staff.telegram_id is
  'Чат сотрудника для утренней рассылки. Пусто — сотрудник её не получает.';

-- Кому слать. Отдаём вместе с id сотрудника: по нему рассылка решает, чьи
-- личные задачи можно показать в этом письме.
create or replace function public.daily_reminder_targets()
returns table (staff_id uuid, chat_id text)
language sql stable security definer set search_path = public as $$
  select id, telegram_id::text from staff where telegram_id is not null order by name;
$$;

revoke all on function public.daily_reminder_targets() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- M4.5. Личные задачи не уходят чужим людям
--
-- send_daily_reminder брала все заявки на сегодня без разбора и слала их обоим
-- чатам. Личная напоминалка одного бухгалтера («Личное · Имя») утром приходила
-- другому — при том что в очереди она видна только автору и админу.
--
-- Теперь у сообщения есть адресат: если он известен, в письмо попадают заявки
-- клиентов плюс СОБСТВЕННЫЕ личные задачи этого человека. Если адресат
-- неизвестен (запасной путь по зашитым chat_id) — только заявки клиентов,
-- личных задач в таком письме нет вовсе.
--
-- Параметр добавляется со значением по умолчанию, поэтому старый вызов
-- `select daily_reminder_message()` продолжает работать. Но добавление
-- параметра — это ПЕРЕГРУЗКА, а не замена (CLAUDE.md, грабли №1), поэтому
-- прежнюю версию удаляем явно, иначе вызов без аргументов станет
-- неоднозначным.
-- ---------------------------------------------------------------------------
drop function if exists public.daily_reminder_message();

create or replace function public.daily_reminder_message(p_staff_id uuid default null)
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
      -- личная задача — это заявка без клиента; чужую в письмо не кладём
      and (client_id is not null
           or (p_staff_id is not null and created_by_staff = p_staff_id))
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

comment on function public.daily_reminder_message(uuid) is
  'Текст утренней рассылки для конкретного получателя. Отдельно от send_daily_reminder, потому что там боевой токен.';

revoke all on function public.daily_reminder_message(uuid) from public, anon, authenticated;
