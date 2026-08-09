-- Удаление клиента админом: убрать из списка пробных/лишних клиентов, чтобы не
-- забивать экран «Клиенты».
--
-- Почему это функция, а не просто delete из фронта:
-- 1) payments.client_id ссылается на clients с ON DELETE SET NULL. Удалить клиента
--    «как есть» = осиротить его заявки: client_id обнулится, из очереди бухгалтера
--    они пропадут совсем (фильтр требует своего клиента), а у админа повиснут
--    без принадлежности. Поэтому клиента с заявками удалять запрещаем.
-- 2) Проверку «заявок нет» нельзя делать в браузере — она там обходится.
--    Гейт и подсчёт живут в базе, как у rotate_client_token.

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
  -- бессмысленна и мешала бы, если этот telegram_id привяжут к другой компании
  if v_tg is not null then
    delete from tg_sessions where telegram_id = v_tg;
  end if;

  delete from clients where id = p_id;
end; $$;

-- вызывать может только вошедший сотрудник; внутри — гейт is_admin()
grant execute on function public.delete_client(uuid) to authenticated;
