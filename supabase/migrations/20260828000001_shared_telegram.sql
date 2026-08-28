-- Один Telegram-аккаунт — несколько фирм.
--
-- Часть клиентов ведёт две компании (например «Блэк Хейз» и «Найс Тайм»).
-- Раньше `/start` в боте снимал привязку со всех прочих фирм этого чата, и
-- человек с двумя компаниями физически не мог получать уведомления по обеим:
-- вторая ссылка отключала первую. Он оставался без уведомлений вообще — просто
-- не понимал, какую из двух выбрать.
--
-- Сама база множественность разрешала всегда: на clients.telegram_id обычный
-- индекс, не уникальный. Ограничение жило в коде бота, там оно и снимается.
-- Уведомлениям множественность не мешает: они идут ОТ ЗАЯВКИ К ФИРМЕ
-- (payments.client_id → clients.telegram_id), а не от чата к фирме.
--
-- В базе остаётся одно место, которое от этого ломается, — delete_client.

-- ---------------------------------------------------------------------------
-- delete_client: чистить переписку с ботом можно, только если у этого чата не
-- осталось других фирм.
--
-- Было: удаляем клиента → безусловно удаляем tg_sessions по его telegram_id.
-- Стало опасным: у человека две компании, бухгалтер удаляет пустую вторую —
-- и вместе с ней стирается незаконченная заявка, которую человек в этот момент
-- набирает по ПЕРВОЙ фирме. Он теряет введённое и не понимает почему.
--
-- Функция пересоздаётся целиком, поэтому проверки is_admin() и «нет заявок»
-- обязаны остаться на месте (см. CLAUDE.md). Сигнатура не меняется —
-- перегрузки не возникает, но право выдаём заново по правилу проекта.
-- ---------------------------------------------------------------------------
create or replace function public.delete_client(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_cnt  int;
  v_tg   bigint;
begin
  if not is_admin() then
    raise exception 'Только администратор может удалять клиентов';
  end if;

  select name, telegram_id into v_name, v_tg from clients where id = p_id;
  if v_name is null then
    raise exception 'Клиент не найден';
  end if;

  select count(*) into v_cnt from payments where client_id = p_id;
  if v_cnt > 0 then
    raise exception 'У клиента «%» заявок: %. Удалить нельзя — история платежей потеряет привязку.',
      v_name, v_cnt;
  end if;

  -- у клиента могла остаться незавершённая переписка с ботом; без клиента она
  -- бессмысленна. Но чат общий на все фирмы человека, поэтому сессию трогаем,
  -- только если удаляемая фирма у этого чата последняя.
  if v_tg is not null then
    if not exists (
      select 1 from clients
      where telegram_id = v_tg and id <> p_id
    ) then
      delete from tg_sessions where telegram_id = v_tg;
    end if;
  end if;

  delete from clients where id = p_id;
end; $$;

grant execute on function public.delete_client(uuid) to authenticated;
