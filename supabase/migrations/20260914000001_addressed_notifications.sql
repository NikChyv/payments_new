-- Адресные уведомления бухгалтерам.
--
-- В приложении бухгалтер видит только своих клиентов (clients.staff_id), а в
-- Telegram это правило не действовало: «новая заявка», «клиент ответил» и
-- «клиент изменил заявку» уходили ВСЕМ номерам из секрета TELEGRAM_CHAT_ID, а
-- утреннее письмо содержало заявки всех клиентов. С приходом ещё одного
-- бухгалтера уведомления по чужим клиентам стали падать в одну общую корзину.
--
-- Правило теперь одно на все каналы:
--   • бухгалтеру — только по его клиентам;
--   • админу — по всем (страховка на случай, если бухгалтер недоступен);
--   • клиент без бухгалтера — админу;
--   • у бухгалтера не указан Telegram — уходит админу, а функция пишет отказ в
--     notify_failures, иначе ответственный молча ничего не получит.
--
-- Номера берутся только из staff.telegram_id. Секрет TELEGRAM_CHAT_ID функциям
-- больше не нужен — это было второе место, где номера жили отдельно и уже
-- однажды разъехались (M4.6).

-- ---------------------------------------------------------------------------
-- Кому из сотрудников слать уведомление по клиенту
--
-- Возвращает jsonb, а не просто список: функции нужно знать ещё и то, что
-- ответственный бухгалтер недоступен, чтобы записать это в журнал отказов.
--   { "chats": ["670574684", ...],       -- отсортировано, без повторов
--     "unreachable": "Валентина" | null } -- бухгалтер клиента без telegram_id
--
-- Повторы убираются: если бухгалтер клиента сам админ, сообщение он получит
-- один раз, а не два.
-- ---------------------------------------------------------------------------
create or replace function public.notify_staff_chats(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff staff;
  v_chats text[];
begin
  if p_client_id is not null then
    select s.* into v_staff
      from clients c join staff s on s.id = c.staff_id
     where c.id = p_client_id;
  end if;

  select coalesce(array_agg(distinct chat order by chat), '{}') into v_chats
    from (
      -- бухгалтер этого клиента
      select v_staff.telegram_id::text as chat where v_staff.telegram_id is not null
      union
      -- и все админы
      select telegram_id::text from staff where is_admin and telegram_id is not null
    ) q;

  return jsonb_build_object(
    'chats', to_jsonb(v_chats),
    'unreachable', case when v_staff.id is not null and v_staff.telegram_id is null
                        then v_staff.name end
  );
end; $$;

comment on function public.notify_staff_chats(uuid) is
  'Номера сотрудников для уведомления по клиенту: его бухгалтер плюс админы. Зовут Edge Functions.';

-- Функция отдаёт chat_id сотрудников — снаружи ей делать нечего. Зовут её
-- notify-payment и notify-client под service_role.
revoke all on function public.notify_staff_chats(uuid) from public, anon, authenticated;
grant execute on function public.notify_staff_chats(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Утреннее письмо: бухгалтеру — только его клиенты
--
-- Сигнатура та же, что в 20260910000002_notifications.sql, значит это замена,
-- а не перегрузка. Меняется одно условие отбора; личные задачи работают как
-- раньше — только автору.
--
-- Кто что получает:
--   • бухгалтер — заявки своих клиентов + свои личные задачи;
--   • админ     — заявки всех клиентов (включая клиентов без бухгалтера)
--                 + свои личные задачи;
--   • без адресата (запасной путь по зашитым chat_id) — все заявки клиентов,
--     личных задач нет вовсе.
-- ---------------------------------------------------------------------------
create or replace function public.daily_reminder_message(p_staff_id uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  rec      record;
  msg      text;
  today    text;
  cnt      int := 0;
  v_admin  boolean := false;
begin
  if p_staff_id is not null then
    select coalesce(is_admin, false) into v_admin from staff where id = p_staff_id;
  end if;

  today := to_char(now() at time zone 'Europe/Minsk', 'YYYY-MM-DD');
  msg := '📅 <b>Платежи на ' || to_char(now() at time zone 'Europe/Minsk', 'DD.MM.YYYY') || '</b>'
      || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.client, p.purpose, p.file_url, p.file_name
    from payments p
    left join clients c on c.id = p.client_id
    where p.due::text = today
      and p.status in ('new', 'in_progress')
      and (
        -- заявка клиента: бухгалтеру только его, админу и запасному письму — все
        (p.client_id is not null
         and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
        -- личная задача — только автору
        or (p.client_id is null
            and p_staff_id is not null and p.created_by_staff = p_staff_id)
      )
    order by p.amount desc
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

revoke all on function public.daily_reminder_message(uuid) from public, anon, authenticated;
