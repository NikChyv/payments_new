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

-- Хранилище файлов: повторяем боевую конфигурацию, иначе локально загрузка
-- молча падает (uploadFile ловит ошибку и сохраняет заявку без вложения),
-- и многофайловые сценарии невозможно проверить.
insert into storage.buckets (id, name, public)
values ('files', 'files', true)
on conflict (id) do nothing;

-- в проде вставка в этот бакет разрешена всем (клиент грузит счёт по токену)
drop policy if exists "files_insert_any" on storage.objects;
create policy "files_insert_any" on storage.objects
  for insert to public with check (bucket_id = 'files');
