-- Бухгалтер заводит заявку клиента через бота (03.11).
--
-- Часть клиентов в бот не придёт ни при каких уговорах и продолжит слать счета
-- бухгалтеру в личку. Раньше бухгалтер шёл с этим файлом на сайт; теперь
-- пересылает его боту, выбирает кнопками фирму и дату — заявка встаёт в
-- очередь как заведённая сотрудником (created_by_staff), как с сайта.
--
-- Бот ходит в базу под service_role, RLS его не останавливает. Поэтому «какие
-- фирмы этому Telegram можно» решает база, здесь, одним правилом на оба шага —
-- показ кнопок и создание заявки: подделанный callback_data с чужой фирмой
-- упрётся в ту же проверку, что и список.
--
-- Правило то же, что у очереди (clients_read): бухгалтер — свои клиенты, админ —
-- все. Telegram у сотрудников бывает общий на двоих-троих (13.10), поэтому
-- сотрудников у чата может быть несколько — фирмы всех их складываются.

create or replace function public.staff_bot_clients(p_telegram_id bigint)
returns table (client_id uuid, client_name text, staff_id uuid, staff_name text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.staff_id, s.name
    from clients c
    left join staff s on s.id = c.staff_id
   where p_telegram_id is not null
     and (c.staff_id in (select id from staff where telegram_id = p_telegram_id)
          or exists (select 1 from staff where telegram_id = p_telegram_id and is_admin))
   order by s.name nulls last, c.name;
$$;

-- Заявка по документу от имени сотрудника. Как у файла от клиента
-- (20261005000001): получатель, сумма пустые — их дописывает триггер
-- («По документу: <файл>», сумма неизвестна). Дата — та, что выбрали кнопкой
-- или набрали, через тот же adjust_due_date: будущий выходной — отказ,
-- «сегодня» после 17:00 — следующий рабочий день.
--
-- Автор — бухгалтер этой фирмы, если он среди сотрудников чата: в общем
-- Telegram заявку по клиенту Елены заводит Елена, а не первая попавшаяся
-- учётка. Иначе — админ этого чата (он видит всех).
create or replace function public.staff_bot_submit(
  p_telegram_id bigint, p_client_id uuid, p_due date,
  p_file_url text, p_file_name text, p_purpose text default null
) returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_client clients; v_author uuid; v_id text; v_files jsonb;
begin
  if not exists (select 1 from staff_bot_clients(p_telegram_id) f where f.client_id = p_client_id) then
    raise exception 'Эта фирма вам недоступна';
  end if;
  if coalesce(p_file_url, '') = '' then
    raise exception 'Приложите файл';
  end if;

  select * into v_client from clients where id = p_client_id;

  select id into v_author from staff
   where telegram_id = p_telegram_id and id = v_client.staff_id;
  if v_author is null then
    select id into v_author from staff
     where telegram_id = p_telegram_id and is_admin order by name limit 1;
  end if;

  v_files := normalize_files(null, p_file_url, p_file_name);
  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, due, recurrence, purpose, status,
                       need_receipt, file_url, file_name, files, client_id,
                       created_by_staff, created_at)
  values (v_id, v_client.name, null, null, adjust_due_date(p_due), 'once',
          nullif(btrim(coalesce(p_purpose, '')), ''), 'new', false,
          v_files -> 0 ->> 'url', v_files -> 0 ->> 'name', v_files, v_client.id,
          v_author, now());
  return v_id;
end; $$;

-- Только для бота. Сотруднику из браузера они ни к чему: у него есть очередь,
-- а telegram_id в параметре он подставил бы чужой.
revoke all on function public.staff_bot_clients(bigint) from public, anon, authenticated;
revoke all on function public.staff_bot_submit(bigint, uuid, date, text, text, text) from public, anon, authenticated;
grant execute on function public.staff_bot_clients(bigint) to service_role;
grant execute on function public.staff_bot_submit(bigint, uuid, date, text, text, text) to service_role;
