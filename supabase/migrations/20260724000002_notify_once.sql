-- Фича 3: уведомление клиенту («оплачено» / «документ отправлен») ровно один
-- раз за всю жизнь платежа. Флаги ставит Edge Function notify-client после
-- успешной отправки; при повторной смене статуса (отменил → снова оплатил)
-- уведомление больше не уходит.

alter table public.payments
  add column if not exists client_paid_notified boolean not null default false;
alter table public.payments
  add column if not exists client_sent_notified boolean not null default false;

-- Существующие оплаченные/отправленные считаем уже уведомлёнными, чтобы
-- ретро-платежи не слали сообщения при первом же касании после апдейта.
update public.payments set client_paid_notified = true where status in ('paid','sent');
update public.payments set client_sent_notified = true where status = 'sent';
