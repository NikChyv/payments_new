-- Делаем правило рабочего графика проверяемым: добавляем перегрузку, которой
-- можно передать «текущий момент». Поведение не меняется — версия с одним
-- аргументом просто подставляет реальное время (Europe/Minsk).
--
-- Зачем: главный сценарий («сегодня выходной / уже после 17:00 → переносим
-- на следующий рабочий день») зависит от now() и иначе не тестируется.

create or replace function public.adjust_due_date(p_due date, p_now timestamp)
returns date language plpgsql immutable set search_path = public as $$
declare v_today date := p_now::date;
begin
  if p_due is null then return p_due; end if;

  -- будущее: выходной запрещаем явной ошибкой
  if p_due > v_today then
    if extract(isodow from p_due) >= 6 then
      raise exception 'В выходной платёж не проводится. Выберите рабочий день (пн–пт).';
    end if;
    return p_due;
  end if;

  -- сегодня: если рабочий день уже закончился или это выходной — на следующий рабочий
  if p_due = v_today then
    if extract(isodow from v_today) >= 6 or p_now::time >= time '17:00' then
      return next_working_day(v_today);
    end if;
  end if;

  return p_due;   -- прошлые даты оставляем как есть
end; $$;

-- боевая версия: тот же алгоритм, время берётся реальное
create or replace function public.adjust_due_date(p_due date)
returns date language sql stable set search_path = public as $$
  select public.adjust_due_date(p_due, (now() at time zone 'Europe/Minsk')::timestamp);
$$;
