-- Закрываем доступ анонима к служебным RPC.
--
-- Грабли: в PostgreSQL право EXECUTE на новую функцию по умолчанию выдаётся роли
-- PUBLIC, а Supabase вдобавок раздаёт его anon и authenticated. Поэтому
-- `grant execute ... to authenticated` НИЧЕГО не ограничивает — оно лишь
-- дублирует уже выданное. Обнаружено тестом контура безопасности: аноним с
-- публичным ключом мог вызвать rotate_client_token и delete_client.
--
-- Эксплуатировать это было нельзя — внутри обеих стоит гейт is_admin(), и для
-- анонима он ложный. Но гейт не должен оставаться единственной преградой:
-- ровно так же в своё время оказался открыт журнал payments_audit.
--
-- send_daily_reminder опаснее: гейта внутри нет вообще. Аноним мог дёргать её
-- и слать бухгалтерам утренний список сколько угодно раз.
--
-- Клиентские функции (client_by_token, list_payments_by_token, submit_payment,
-- edit_payment_by_token) намеренно НЕ трогаем — это единственный путь клиента
-- по токену, аноним обязан их вызывать.

-- админские: вызывает только вошедший сотрудник, внутри — гейт is_admin()
revoke all on function public.delete_client(uuid)       from public, anon;
revoke all on function public.rotate_client_token(uuid) from public, anon;
grant execute on function public.delete_client(uuid)       to authenticated;
grant execute on function public.rotate_client_token(uuid) to authenticated;

-- служебные: снаружи не вызываются вообще.
-- send_daily_reminder запускает pg_cron (роль postgres), check_rate_limit
-- вызывается изнутри SECURITY DEFINER функций, то есть от имени владельца, —
-- отзыв прав у ролей приложения этот путь не задевает.
revoke all on function public.send_daily_reminder()                 from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, text, int, interval) from public, anon, authenticated;
