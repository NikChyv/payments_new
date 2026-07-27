-- Перевыпуск ссылки должен отзывать доступ ПОЛНОСТЬЮ.
--
-- Было: rotate_client_token меняла только token. Но бот ищет клиента по
-- clients.telegram_id, а не по токену — значит тот, кто успел привязаться
-- по утёкшей ссылке, сохранял доступ через бота даже после перевыпуска.
--
-- Стало: ротация сбрасывает и telegram_id. Клиент заново нажимает «Старт»
-- по новой ссылке бота — это и есть смысл отзыва.

create or replace function public.rotate_client_token(p_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_new text;
begin
  if not is_admin() then
    raise exception 'Только администратор может перевыпускать ссылки';
  end if;
  v_new := encode(gen_random_bytes(16), 'hex');
  update clients
     set token = v_new,
         telegram_id = null      -- отвязываем Telegram: старая привязка недействительна
   where id = p_id;
  if not found then
    raise exception 'Клиент не найден';
  end if;
  return v_new;
end; $$;
