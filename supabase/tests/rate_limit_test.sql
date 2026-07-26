-- pgTAP: rate-limiting anon-RPC (пункт 4).

begin;
select plan(5);

insert into clients (id, name, token, staff_id) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'RateCo',  'tokRate',  null),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'OtherCo', 'tokOther', null);

-- 1) в пределах лимита (10/мин) заявки проходят
select lives_ok(
  $$ do $x$ begin
       for i in 1..10 loop
         perform submit_payment('tokRate','P',10,'U',current_date,'once','p',false,null,null);
       end loop;
     end $x$ $$,
  'submit_payment: 10 вызовов в минуту проходят'
);

-- 2) 11-й вызов блокируется
select throws_ok(
  $$ select submit_payment('tokRate','P',10,'U',current_date,'once','p',false,null,null) $$,
  'P0001',
  'Слишком много запросов. Подождите немного и попробуйте снова.',
  'submit_payment: 11-й вызов за минуту отбивается'
);

-- 3) лимит НЕ задевает другого клиента (ключ = токен)
select lives_ok(
  $$ select submit_payment('tokOther','P',10,'U',current_date,'once','p',false,null,null) $$,
  'лимит считается по токену — другой клиент не затронут'
);

-- 4) заблокированные вызовы не создали лишних платежей
select is(
  (select count(*)::int from payments p join clients c on c.id = p.client_id where c.token = 'tokRate'),
  10,
  'сверхлимитный вызов не записал платёж'
);

-- 5) служебная таблица недоступна anon
select ok(
  not has_table_privilege('anon', 'public.rpc_rate_limit', 'SELECT'),
  'anon без доступа к rpc_rate_limit'
);

select * from finish();
rollback;
