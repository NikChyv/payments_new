-- pgTAP: ограничение частоты вызовов anon-RPC.

begin;
select plan(10);

insert into clients (id, name, token, staff_id) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'RateCo',  'tokRate',  null),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'OtherCo', 'tokOther', null);

-- ---------- сам примитив check_rate_limit ----------
select lives_ok(
  $$ do $x$ begin
       perform check_rate_limit('k1','act', 2, interval '1 minute');
       perform check_rate_limit('k1','act', 2, interval '1 minute');
     end $x$ $$,
  'check_rate_limit: вызовы в пределах лимита проходят'
);

select throws_ok(
  $$ select check_rate_limit('k1','act', 2, interval '1 minute') $$,
  'P0001',
  'Слишком много запросов. Подождите немного и попробуйте снова.',
  'check_rate_limit: превышение лимита отбивается'
);

-- счётчики независимы по ДЕЙСТВИЮ (иначе submit съедал бы лимит edit)
select lives_ok(
  $$ select check_rate_limit('k1','other_act', 2, interval '1 minute') $$,
  'check_rate_limit: у другого действия свой счётчик'
);

-- и по КЛЮЧУ (иначе один клиент блокировал бы всех)
select lives_ok(
  $$ select check_rate_limit('k2','act', 2, interval '1 minute') $$,
  'check_rate_limit: у другого ключа свой счётчик'
);

-- пустой ключ не должен ронять вызов
select lives_ok(
  $$ select check_rate_limit('', 'act', 1, interval '1 minute') $$,
  'check_rate_limit: пустой ключ не ломает вызов'
);

-- ---------- боевые лимиты submit_payment ----------
select lives_ok(
  $$ do $x$ begin
       for i in 1..10 loop
         perform submit_payment('tokRate','P',10,'U',current_date,'once','p',false,null,null);
       end loop;
     end $x$ $$,
  'submit_payment: 10 вызовов в минуту проходят'
);

select throws_ok(
  $$ select submit_payment('tokRate','P',10,'U',current_date,'once','p',false,null,null) $$,
  'P0001',
  'Слишком много запросов. Подождите немного и попробуйте снова.',
  'submit_payment: 11-й вызов за минуту отбивается'
);

-- лимит НЕ задевает другого клиента (ключ = токен)
select lives_ok(
  $$ select submit_payment('tokOther','P',10,'U',current_date,'once','p',false,null,null) $$,
  'лимит считается по токену — другой клиент не затронут'
);

-- заблокированные вызовы не создали лишних платежей
select is(
  (select count(*)::int from payments p join clients c on c.id = p.client_id where c.token = 'tokRate'),
  10,
  'сверхлимитный вызов не записал платёж'
);

-- служебная таблица недоступна anon
select ok(
  not has_table_privilege('anon', 'public.rpc_rate_limit', 'SELECT'),
  'anon без доступа к rpc_rate_limit'
);

select * from finish();
rollback;
