-- Приглашение клиента: кто и когда отправил ему ссылки (18.10).
--
-- Зачем. Клиентов подключают к сервису сами бухгалтеры: каждому — сообщение с
-- его персональными ссылками на сайт и на бота. Клиентов десятки, пишут им
-- несколько человек, и без отметки никто не знает, кому уже написали: одному
-- придёт два приглашения, другому ни одного. Кнопка «Пригласить» во вкладке
-- «Клиенты» собирает готовый текст, а «Я отправил» ставит отметку — её видят
-- все, у кого есть доступ к этому клиенту.
--
-- Отметку ставит только mark_client_invited: прямой записи в clients у
-- бухгалтера нет (менять клиента может только админ, политика clients_admin),
-- и давать её ради одной даты незачем.
--
-- Перевыпуск ссылки снимает отметку: старое приглашение после него ведёт в
-- никуда, и клиент снова в списке «не приглашены». Сделано триггером на смену
-- токена, а не правкой rotate_client_token, — так отметка снимется при любой
-- смене токена, в том числе руками из SQL Editor.

alter table public.clients
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid references public.staff(id) on delete set null;

comment on column public.clients.invited_at is
  'Когда клиенту отправили приглашение с персональными ссылками (кнопка «Я отправил»). Сбрасывается при смене токена.';
comment on column public.clients.invited_by is
  'Кто из сотрудников отправил приглашение.';

create or replace function public.mark_client_invited(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me     staff;
  v_client clients;
  v_at     timestamptz := now();
begin
  select * into v_me from staff where id = auth.uid();
  if v_me.id is null then
    raise exception 'Отмечать приглашения могут только сотрудники';
  end if;

  select * into v_client from clients where id = p_id;
  if v_client.id is null then
    raise exception 'Клиент не найден';
  end if;
  -- бухгалтер — только своих, как и видит их в списке; админ — любого
  if not coalesce(v_me.is_admin, false) and v_client.staff_id is distinct from v_me.id then
    raise exception 'Это клиент другого бухгалтера';
  end if;

  update clients set invited_at = v_at, invited_by = v_me.id where id = p_id;
  return jsonb_build_object('invited_at', v_at, 'invited_by', v_me.id);
end; $$;

comment on function public.mark_client_invited(uuid) is
  'Отметка «приглашение отправлено»: бухгалтер — своему клиенту, админ — любому.';

revoke all on function public.mark_client_invited(uuid) from public, anon;
grant execute on function public.mark_client_invited(uuid) to authenticated;

-- Новая ссылка — старое приглашение недействительно.
create or replace function public.clients_reset_invite()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.token is distinct from old.token then
    new.invited_at := null;
    new.invited_by := null;
  end if;
  return new;
end; $$;

revoke all on function public.clients_reset_invite() from public, anon, authenticated;

drop trigger if exists clients_reset_invite on public.clients;
create trigger clients_reset_invite
  before update of token on public.clients
  for each row execute function public.clients_reset_invite();
