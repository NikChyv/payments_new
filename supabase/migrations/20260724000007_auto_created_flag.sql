-- Признак «платёж создан автоматически» — следующая копия повторяющегося платежа,
-- которую система заводит после отметки «Оплачено». Такие заявки клиент не подавал,
-- поэтому notify-payment не шлёт по ним уведомление «новая заявка».

alter table public.payments
  add column if not exists auto_created boolean not null default false;
