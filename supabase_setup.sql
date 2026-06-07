-- =============================================================================
--  «Платежи под контролем» — настройка безопасности и многопользовательского
--  режима в Supabase.  Выполнять в Supabase → SQL Editor.
--
--  РОЛИ:
--    • staff  — бухгалтеры и админ (вход по email+паролю через Supabase Auth)
--    • clients — клиенты: компания + секретный токен ссылки + закреплённый бухгалтер
--    • payments — платежи; теперь привязаны к клиенту (client_id) → наследуют бухгалтера
--
--  ПОРЯДОК:
--    ФАЗА 1 (ниже) — безопасно выполнить СЕЙЧАС. RLS на payments ещё НЕ включаем,
--                    поэтому текущее приложение продолжает работать без изменений.
--    ФАЗА 2 — выполнить ПОЗЖЕ, в момент «переезда», когда будет готово новое
--             приложение. Тогда включается защита и закрывается прямой доступ.
--
--  Перед ФАЗОЙ 2 нужно один раз создать учётки в Supabase → Authentication → Users
--  (Add user, email+пароль) и внести их в таблицу staff (шаблон — в конце ФАЗЫ 1).
-- =============================================================================


-- ========================= ФАЗА 1 — безопасно сейчас =========================

create extension if not exists pgcrypto;   -- для gen_random_uuid / gen_random_bytes

-- 1) Бухгалтеры и админ. id совпадает с id пользователя входа (auth.users).
create table if not exists staff (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  is_admin   boolean not null default false,
  created_at timestamptz default now()
);

-- 2) Клиенты: компания, секретный токен для ссылки, закреплённый бухгалтер.
create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  token      text not null unique,
  staff_id   uuid references staff(id) on delete set null,
  created_at timestamptz default now()
);

-- 3) Привязка платежей к клиенту (платёж наследует бухгалтера от клиента).
alter table payments add column if not exists client_id uuid references clients(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Вспомогательная функция: текущий пользователь — админ?
-- ---------------------------------------------------------------------------
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from staff where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- Функции для КЛИЕНТА (роль anon). Доступ только по токену, напрямую к
-- таблице у клиента доступа не будет (после ФАЗЫ 2). SECURITY DEFINER —
-- функция сама проверяет токен и отдаёт только данные этого клиента.
-- ---------------------------------------------------------------------------

-- имя компании по токену (чтобы подставить в форму)
create or replace function client_by_token(p_token text)
returns text language sql stable security definer set search_path = public as $$
  select name from clients where token = p_token;
$$;

-- список платежей клиента по токену (read-only)
create or replace function list_payments_by_token(p_token text)
returns setof payments language sql stable security definer set search_path = public as $$
  select p.* from payments p
  join clients c on c.id = p.client_id
  where c.token = p_token
  order by p.due;
$$;

-- создать заявку по токену клиента
create or replace function submit_payment(
  p_token text, p_payee text, p_amount numeric, p_requisites text,
  p_due date, p_recurrence text, p_purpose text, p_need_receipt boolean,
  p_file_url text, p_file_name text
) returns text language plpgsql security definer set search_path = public as $$
declare v_client clients; v_id text;
begin
  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;
  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, coalesce(p_amount,0), p_requisites, p_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,true),
          p_file_url, p_file_name, v_client.id, now());
  return v_id;
end; $$;

-- разрешить клиенту (anon) вызывать только эти функции
grant execute on function client_by_token(text)            to anon;
grant execute on function list_payments_by_token(text)     to anon;
grant execute on function submit_payment(text,text,numeric,text,date,text,text,boolean,text,text) to anon;

-- ---------------------------------------------------------------------------
-- RLS для staff и clients (их включаем сразу — текущее приложение их не трогает).
-- ---------------------------------------------------------------------------
alter table staff enable row level security;
drop policy if exists staff_read   on staff;
drop policy if exists staff_admin  on staff;
create policy staff_read  on staff for select to authenticated using (id = auth.uid() or is_admin());
create policy staff_admin on staff for all    to authenticated using (is_admin()) with check (is_admin());

alter table clients enable row level security;
drop policy if exists clients_read  on clients;
drop policy if exists clients_admin on clients;
create policy clients_read  on clients for select to authenticated using (is_admin() or staff_id = auth.uid());
create policy clients_admin on clients for all    to authenticated using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Политики для payments (создаём заранее; СРАБОТАЮТ только после включения RLS
-- в ФАЗЕ 2). Бухгалтер — только свои клиенты; админ — всё.
-- ---------------------------------------------------------------------------
drop policy if exists pay_staff_read   on payments;
drop policy if exists pay_staff_insert on payments;
drop policy if exists pay_staff_update on payments;
drop policy if exists pay_staff_delete on payments;
create policy pay_staff_read   on payments for select to authenticated
  using (is_admin() or client_id in (select id from clients where staff_id = auth.uid()));
create policy pay_staff_insert on payments for insert to authenticated
  with check (is_admin() or client_id in (select id from clients where staff_id = auth.uid()));
create policy pay_staff_update on payments for update to authenticated
  using (is_admin() or client_id in (select id from clients where staff_id = auth.uid()))
  with check (is_admin() or client_id in (select id from clients where staff_id = auth.uid()));
create policy pay_staff_delete on payments for delete to authenticated
  using (is_admin() or client_id in (select id from clients where staff_id = auth.uid()));


-- ----------------------- ШАБЛОНЫ (заполнить и выполнить) ----------------------
-- 1) Создать пользователей в Supabase → Authentication → Users (email+пароль),
--    скопировать их UID и внести сюда:
--
-- insert into staff (id, name, is_admin) values ('UID-ВЛАДЕЛЬЦА', 'Владелец',        true);
-- insert into staff (id, name, is_admin) values ('UID-БУХГАЛТЕРА','Анна Бухгалтер',  false);
--
-- 2) Завести клиента и получить токен (позже это будет делать экран «Клиенты»):
--
-- insert into clients (name, token, staff_id)
-- values ('ООО «Ромашка»', encode(gen_random_bytes(12),'hex'), 'UID-БУХГАЛТЕРА')
-- returning name, token;   -- ссылка клиента: АДРЕС/?t=<token>
--
-- 3) (Необязательно) Привязать УЖЕ существующие платежи к заведённым клиентам
--    по совпадению названия компании:
--
-- update payments p set client_id = c.id
-- from clients c where p.client_id is null and p.client = c.name;


-- ============================ ФАЗА 2 — при переезде ===========================
-- Выполнять ТОЛЬКО после деплоя нового приложения и проверки.
-- Включает защиту payments и закрывает клиенту прямой доступ к таблице
-- (клиент остаётся работать через функции выше).
--
-- alter table payments enable row level security;
-- revoke all on payments from anon;
--
-- Откат при необходимости:
-- alter table payments disable row level security;
-- grant all on payments to anon;
