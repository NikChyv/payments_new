-- Сообщения сотрудникам подписаны именем бухгалтера, если Telegram у него
-- общий с кем-то ещё (13.10).
--
-- Что было. У двух пар бухгалтеров один телефон и один Telegram на двоих, а
-- учётки в приложении разные: клиенты у каждого свои. В общий чат падает всё
-- по клиентам обоих, и ни в одном сообщении не сказано, кому из двоих оно.
--
-- Что стало. Имя — в заголовке сообщения, и только когда тот же telegram_id
-- записан ещё у кого-то из сотрудников: у остальных не меняется ни знака.
--
-- 1. Утреннее письмо (daily_reminder_message). send_daily_reminder шлёт по
--    письму на учётку, то есть в общий чат их приходит два. В пустой день это
--    были два одинаковых «Нет платежей на сегодня», в непустой — письмо со
--    списком и рядом «платежей нет». Теперь «Платежи на 13.10.2026 · Елена».
--    Запасное письмо без адресата (p_staff_id is null) прежнее. Сигнатура та
--    же, send_daily_reminder с токеном в проде не трогаем — она берёт текст
--    отсюда. Остальное тело — как в 20261005000001.
--
-- 2. Мгновенные уведомления (notify_staff_chats): «новая заявка», «клиент
--    ответил», «клиент изменил». База по-прежнему только называет адресатов,
--    текст собирают функции — поэтому она отдаёт им новое поле `shared`: чат
--    и имя бухгалтера клиента, если этот чат у него общий; иначе null.
--    Функция подписывает сообщение только в этот чат: админу, который получает
--    всё по всем, имя в заголовке не нужно. Поле добавлено, прежние (`chats`,
--    `unreachable`) не тронуты — функции старой версии его просто не читают.

create or replace function public.daily_reminder_message(p_staff_id uuid default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  rec       record;
  msg       text;
  item      text;
  v_today   date := (now() at time zone 'Europe/Minsk')::date;
  cnt       int := 0;
  shown     int := 0;
  ocnt      int := 0;
  oshown    int := 0;
  v_overdue int;
  v_budget  int;
  v_admin   boolean := false;
  v_name    text;
begin
  if p_staff_id is not null then
    select coalesce(is_admin, false) into v_admin from staff where id = p_staff_id;
    -- имя — только если этот же Telegram записан ещё у кого-то из сотрудников
    select s.name into v_name
      from staff s
     where s.id = p_staff_id
       and exists (select 1 from staff o where o.id <> s.id and o.telegram_id = s.telegram_id);
  end if;

  -- сколько просрочки, считаем заранее: от этого зависит, сколько места
  -- отдать сегодняшним
  select count(*) into v_overdue
    from payments p left join clients c on c.id = p.client_id
   where p.due < v_today
     and p.status in ('new', 'in_progress')
     and ((p.client_id is not null and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
          or (p.client_id is null and p_staff_id is not null and p.created_by_staff = p_staff_id));
  v_budget := case when v_overdue > 0 then 2900 else 3500 end;

  msg := '📅 <b>Платежи на ' || to_char(v_today, 'DD.MM.YYYY')
         -- не coalesce: tg_esc(null) возвращает пустую строку, а не null,
         -- и в заголовке у всех остался бы висеть пустой « · »
         || case when v_name is not null then ' · ' || tg_esc(v_name) else '' end || '</b>' || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.paid_amount,
           greatest(p.amount - p.paid_amount, 0) as left_amount,
           p.client, p.purpose, p.file_url, p.file_name
    from payments p
    left join clients c on c.id = p.client_id
    where p.due = v_today
      and p.status in ('new', 'in_progress')
      and (
        -- заявка клиента: бухгалтеру только его, админу и запасному письму — все
        (p.client_id is not null
         and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
        -- личная задача — только автору
        or (p.client_id is null
            and p_staff_id is not null and p.created_by_staff = p_staff_id)
      )
    order by greatest(p.amount - p.paid_amount, 0) desc
  loop
    cnt := cnt + 1;
    item := cnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || case when rec.amount is null then 'сумма в документе'
                       else to_char(rec.left_amount, 'FM999999999.00') || ' Br' end
      || case when rec.paid_amount > 0
              then ' (остаток из ' || to_char(rec.amount, 'FM999999999.00') || ')'
              else '' end
      || chr(10)
      || '   👤 ' || tg_esc(coalesce(nullif(rec.client, ''), '—')) || chr(10)
      || case when rec.purpose is not null and rec.purpose <> ''
              then '   📝 ' || tg_esc(case when length(rec.purpose) > 150
                                            then left(rec.purpose, 150) || '…'
                                            else rec.purpose end) || chr(10)
              else '' end
      -- ссылку в href пускаем только проверенную: у старых заявок в file_url
      -- может лежать что угодно, они завелись до этой проверки
      || case when is_safe_file_url(rec.file_url)
              then '   📎 <a href="' || rec.file_url || '">'
                   || tg_esc(coalesce(nullif(rec.file_name, ''), 'файл')) || '</a>' || chr(10)
              else '' end
      || chr(10);

    if shown = cnt - 1 and length(msg) + length(item) <= v_budget then
      msg := msg || item;
      shown := cnt;
    end if;
  end loop;

  if cnt = 0 then
    msg := msg || case when v_overdue > 0 then 'На сегодня платежей нет.' else 'Нет платежей на сегодня 🎉' end;
  else
    if shown < cnt then
      msg := msg || '…и ещё ' || (cnt - shown) || ' — полный список в приложении' || chr(10) || chr(10);
    end if;
    msg := msg || '💼 Всего: ' || cnt;
  end if;

  if v_overdue = 0 then
    return msg;
  end if;

  msg := msg || chr(10) || chr(10) || '⚠️ <b>Просрочено: ' || v_overdue || '</b>' || chr(10) || chr(10);

  for rec in
    select p.payee, p.amount, p.paid_amount, p.due,
           greatest(p.amount - p.paid_amount, 0) as left_amount,
           p.client
    from payments p
    left join clients c on c.id = p.client_id
    where p.due < v_today
      and p.status in ('new', 'in_progress')
      and ((p.client_id is not null and (p_staff_id is null or v_admin or c.staff_id = p_staff_id))
           or (p.client_id is null and p_staff_id is not null and p.created_by_staff = p_staff_id))
    order by p.due, greatest(p.amount - p.paid_amount, 0) desc
  loop
    ocnt := ocnt + 1;
    item := ocnt || '. <b>' || tg_esc(rec.payee) || '</b>'
      || ' — ' || case when rec.amount is null then 'сумма в документе'
                       else to_char(rec.left_amount, 'FM999999999.00') || ' Br' end
      || case when rec.paid_amount > 0
              then ' (остаток из ' || to_char(rec.amount, 'FM999999999.00') || ')'
              else '' end
      || chr(10)
      || '   👤 ' || tg_esc(coalesce(nullif(rec.client, ''), '—'))
      || ' · с ' || to_char(rec.due, 'DD.MM') || ', ' || (v_today - rec.due) || ' дн.' || chr(10);

    -- 3500, а не 4096: запас на хвост письма и на то, что Telegram считает
    -- длину по-своему
    if oshown = ocnt - 1 and length(msg) + length(item) <= 3500 then
      msg := msg || item;
      oshown := ocnt;
    end if;
  end loop;

  if oshown < ocnt then
    msg := msg || '…и ещё ' || (ocnt - oshown) || ' просроченных — в приложении';
  end if;

  return rtrim(msg, chr(10));
end; $$;

revoke all on function public.daily_reminder_message(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Адресаты мгновенных уведомлений. Тело — как в 20260914000001, добавлено
-- только поле `shared`.
-- ---------------------------------------------------------------------------
create or replace function public.notify_staff_chats(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_staff  staff;
  v_chats  text[];
  v_shared boolean := false;
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

  if v_staff.telegram_id is not null then
    select exists (select 1 from staff o
                    where o.id <> v_staff.id and o.telegram_id = v_staff.telegram_id)
      into v_shared;
  end if;

  return jsonb_build_object(
    'chats', to_jsonb(v_chats),
    'unreachable', case when v_staff.id is not null and v_staff.telegram_id is null
                        then v_staff.name end,
    'shared', case when v_shared
                   then jsonb_build_object('chat', v_staff.telegram_id::text, 'name', v_staff.name) end
  );
end; $$;

comment on function public.notify_staff_chats(uuid) is
  'Номера сотрудников для уведомления по клиенту: его бухгалтер плюс админы; shared — чьё сообщение, если чат бухгалтера общий. Зовут Edge Functions.';

-- create or replace права сохраняет, но объявляем заново: номера сотрудников
-- наружу не отдаются, и это должно читаться из самой миграции
revoke all on function public.notify_staff_chats(uuid) from public, anon, authenticated;
grant execute on function public.notify_staff_chats(uuid) to service_role;
