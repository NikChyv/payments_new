-- Утреннее письмо: просроченные — отдельным блоком (01.10).
--
-- Письмо показывало только заявки на сегодня. Просроченная заявка в него не
-- попадала ни разу: вчера она была «на сегодня», а сегодня уже нет. Бухгалтер
-- узнавал о ней, только открыв очередь, — а новые бухгалтеры её ещё не
-- открывают первым делом.
--
-- Теперь после списка на сегодня — «⚠️ Просрочено: N»: получатель, остаток,
-- клиент, с какого числа и сколько дней. Самая давняя сверху, как в очереди.
-- Кому что видно — тем же условием, что и для сегодняшних (адресность,
-- 20260910000002): бухгалтеру его клиенты и его личные задачи, админу все.
--
-- Лимит Telegram общий: сегодняшние идут первыми, но если есть просрочка, им
-- отдаётся не больше 2900 знаков — иначе блок просрочки не влез бы как раз
-- тогда, когда заявок много. Не влезшее считаем, а не теряем молча.
--
-- Сигнатура та же, это замена, а не перегрузка. Отправляет письмо по-прежнему
-- send_daily_reminder в проде (с токеном), её трогать не нужно.

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
begin
  if p_staff_id is not null then
    select coalesce(is_admin, false) into v_admin from staff where id = p_staff_id;
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

  msg := '📅 <b>Платежи на ' || to_char(v_today, 'DD.MM.YYYY') || '</b>' || chr(10) || chr(10);

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
      || ' — ' || to_char(rec.left_amount, 'FM999999999.00') || ' Br'
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
      || ' — ' || to_char(rec.left_amount, 'FM999999999.00') || ' Br'
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
