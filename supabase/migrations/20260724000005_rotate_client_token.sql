-- Пункт 5: отзыв/ротация токена клиента. Админ перевыпускает персональную ссылку —
-- старый токен мгновенно перестаёт работать (client_by_token / list_payments_by_token
-- / submit_payment по нему больше ничего не находят). Закрывает риск «утёкшего токена».

create or replace function public.rotate_client_token(p_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_new text;
begin
  if not is_admin() then
    raise exception 'Только администратор может перевыпускать ссылки';
  end if;
  v_new := encode(gen_random_bytes(16), 'hex');
  update clients set token = v_new where id = p_id;
  if not found then
    raise exception 'Клиент не найден';
  end if;
  return v_new;
end; $$;

-- вызывать может только вошедший сотрудник; внутри — гейт is_admin()
grant execute on function public.rotate_client_token(uuid) to authenticated;
