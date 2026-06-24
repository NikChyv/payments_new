


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."client_by_token"("p_token" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select name from clients where token = p_token;
$$;


ALTER FUNCTION "public"."client_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((select is_admin from staff where id = auth.uid()), false);
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "text" NOT NULL,
    "client" "text",
    "payee" "text",
    "amount" numeric,
    "requisites" "text",
    "due" "date",
    "recurrence" "text",
    "purpose" "text",
    "status" "text",
    "need_receipt" boolean,
    "file_url" "text",
    "file_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "client_id" "uuid"
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_payments_by_token"("p_token" "text") RETURNS SETOF "public"."payments"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.* from payments p
  join clients c on c.id = p.client_id
  where c.token = p_token
  order by p.due;
$$;


ALTER FUNCTION "public"."list_payments_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_daily_reminder"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  rec       record;
  msg       text;
  today     text;
  cnt       int  := 0;
  bot_token text   := '<TELEGRAM_BOT_TOKEN>';  -- секрет: реальное значение только в проде, в репо плейсхолдер
  chat_ids  text[] := array['670574684', '744619432'];  -- ты, Валентина
  cid       text;
begin
  today := to_char(now() at time zone 'Europe/Minsk', 'YYYY-MM-DD');
  msg := '📅 <b>Платежи на ' || to_char(now() at time zone 'Europe/Minsk', 'DD.MM.YYYY') || '</b>'
      || chr(10) || chr(10);

  for rec in
    select payee, amount, client, purpose, file_url, file_name
    from payments
    where due::text = today
      and status in ('new', 'in_progress')
    order by amount desc
  loop
    cnt := cnt + 1;
    msg := msg
      || cnt || '. <b>' || rec.payee || '</b>'
      || ' — ' || to_char(rec.amount, 'FM999999999.00') || ' Br' || chr(10)
      || '   👤 ' || coalesce(nullif(rec.client, ''), '—') || chr(10)
      || case when rec.purpose is not null and rec.purpose <> ''
              then '   📝 ' || rec.purpose || chr(10)
              else '' end
      || case when rec.file_url is not null and rec.file_url <> ''
              then '   📎 <a href="' || rec.file_url || '">'
                   || coalesce(nullif(rec.file_name, ''), 'файл') || '</a>' || chr(10)
              else '' end
      || chr(10);
  end loop;

  if cnt = 0 then
    msg := msg || 'Нет платежей на сегодня 🎉';
  else
    msg := msg || '💼 Всего: ' || cnt;
  end if;

  foreach cid in array chat_ids loop
    perform net.http_post(
      url     := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := json_build_object(
                   'chat_id',                 cid,
                   'text',                    msg,
                   'parse_mode',              'HTML',
                   'disable_web_page_preview', true
                 )::jsonb
    );
  end loop;
end;
$$;


ALTER FUNCTION "public"."send_daily_reminder"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_payment"("p_token" "text", "p_payee" "text", "p_amount" numeric, "p_requisites" "text", "p_due" "date", "p_recurrence" "text", "p_purpose" "text", "p_need_receipt" boolean, "p_file_url" "text", "p_file_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare v_client clients; v_id text;
begin
  select * into v_client from clients where token = p_token;
  if v_client.id is null then
    raise exception 'Неверный токен клиента';
  end if;
  v_id := encode(gen_random_bytes(8), 'hex');
  insert into payments(id, client, payee, amount, requisites, due, recurrence,
                       purpose, status, need_receipt, file_url, file_name,
                       client_id, created_at)
  values (v_id, v_client.name, p_payee, coalesce(p_amount,0), p_requisites, p_due,
          coalesce(p_recurrence,'once'), p_purpose, 'new', coalesce(p_need_receipt,true),
          p_file_url, p_file_name, v_client.id, now());
  return v_id;
end; $$;


ALTER FUNCTION "public"."submit_payment"("p_token" "text", "p_payee" "text", "p_amount" numeric, "p_requisites" "text", "p_due" "date", "p_recurrence" "text", "p_purpose" "text", "p_need_receipt" boolean, "p_file_url" "text", "p_file_name" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "token" "text" NOT NULL,
    "staff_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "telegram_id" bigint
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "is_admin" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."staff" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tg_sessions" (
    "telegram_id" bigint NOT NULL,
    "step" "text",
    "draft" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tg_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff"
    ADD CONSTRAINT "staff_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tg_sessions"
    ADD CONSTRAINT "tg_sessions_pkey" PRIMARY KEY ("telegram_id");



CREATE INDEX "clients_telegram_id_idx" ON "public"."clients" USING "btree" ("telegram_id");



CREATE OR REPLACE TRIGGER "notify-client" AFTER UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"('https://gmvhphuabiyggfurfhmc.supabase.co/functions/v1/notify-client', 'POST', '{"Content-type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtdmhwaHVhYml5Z2dmdXJmaG1jIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU2ODU0MSwiZXhwIjoyMDk2MTQ0NTQxfQ.3KxULW9agd7pcgSa32EGMAh3QLVFnySsAYPa8XPMzvk"}', '{}', '5000');



CREATE OR REPLACE TRIGGER "notify-payment" AFTER INSERT ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"('https://gmvhphuabiyggfurfhmc.supabase.co/functions/v1/notify-payment', 'POST', '{"Content-type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtdmhwaHVhYml5Z2dmdXJmaG1jIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU2ODU0MSwiZXhwIjoyMDk2MTQ0NTQxfQ.3KxULW9agd7pcgSa32EGMAh3QLVFnySsAYPa8XPMzvk"}', '{}', '5000');



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."staff"
    ADD CONSTRAINT "staff_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_admin" ON "public"."clients" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "clients_read" ON "public"."clients" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("staff_id" = "auth"."uid"())));



CREATE POLICY "pay_staff_delete" ON "public"."payments" FOR DELETE TO "authenticated" USING (("public"."is_admin"() OR ("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE ("clients"."staff_id" = "auth"."uid"())))));



CREATE POLICY "pay_staff_insert" ON "public"."payments" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_admin"() OR ("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE ("clients"."staff_id" = "auth"."uid"())))));



CREATE POLICY "pay_staff_read" ON "public"."payments" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE ("clients"."staff_id" = "auth"."uid"())))));



CREATE POLICY "pay_staff_update" ON "public"."payments" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR ("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE ("clients"."staff_id" = "auth"."uid"()))))) WITH CHECK (("public"."is_admin"() OR ("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE ("clients"."staff_id" = "auth"."uid"())))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff_admin" ON "public"."staff" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "staff_read" ON "public"."staff" FOR SELECT TO "authenticated" USING ((("id" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."tg_sessions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."client_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."client_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."client_by_token"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON FUNCTION "public"."list_payments_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."list_payments_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_payments_by_token"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."send_daily_reminder"() TO "anon";
GRANT ALL ON FUNCTION "public"."send_daily_reminder"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_daily_reminder"() TO "service_role";



GRANT ALL ON FUNCTION "public"."submit_payment"("p_token" "text", "p_payee" "text", "p_amount" numeric, "p_requisites" "text", "p_due" "date", "p_recurrence" "text", "p_purpose" "text", "p_need_receipt" boolean, "p_file_url" "text", "p_file_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_payment"("p_token" "text", "p_payee" "text", "p_amount" numeric, "p_requisites" "text", "p_due" "date", "p_recurrence" "text", "p_purpose" "text", "p_need_receipt" boolean, "p_file_url" "text", "p_file_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_payment"("p_token" "text", "p_payee" "text", "p_amount" numeric, "p_requisites" "text", "p_due" "date", "p_recurrence" "text", "p_purpose" "text", "p_need_receipt" boolean, "p_file_url" "text", "p_file_name" "text") TO "service_role";
























GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."staff" TO "anon";
GRANT ALL ON TABLE "public"."staff" TO "authenticated";
GRANT ALL ON TABLE "public"."staff" TO "service_role";



GRANT ALL ON TABLE "public"."tg_sessions" TO "anon";
GRANT ALL ON TABLE "public"."tg_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."tg_sessions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































