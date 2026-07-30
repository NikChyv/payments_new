-- Демо-данные для ЛОКАЛЬНОЙ разработки. Загружаются при supabase start / db reset.
-- В прод НЕ попадают (сиды применяются только к локальному стеку).

insert into clients (id, name, token, staff_id) values
  ('11111111-0000-0000-0000-000000000001', 'ООО «Ромашка»', 'demotoken1', null),
  ('11111111-0000-0000-0000-000000000002', 'ИП Смирнов',     'demotoken2', null)
on conflict (token) do nothing;

-- Пара платежей через боевой RPC (реалистичные данные + сразу проверка, что RPC жив).
-- Будущую дату берём через next_working_day: жёсткое current_date + 2 в некоторые
-- дни недели попадает на выходной, и правило рабочего графика роняет весь сид
-- (а вместе с ним supabase start и CI).
select submit_payment('demotoken1', 'Яндекс Директ',    4500,  'УНП 191234567', next_working_day(current_date + 1), 'monthly', 'Пополнение рекламы', true,  null, null);
select submit_payment('demotoken1', 'Поставщик «Техно»',12750, 'счёт А-1188',    current_date,     'once',    'Оплата по счёту',    false, null, null);
select submit_payment('demotoken2', 'Аренда офиса',     8000,  'р/с 40702810',   current_date - 1, 'monthly', 'Аренда за месяц',    true,  null, null);
