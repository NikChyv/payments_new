import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

// service_role подставляется Supabase автоматически
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function fmtMoney(v: number) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}

serve(async (req) => {
  try {
    const body = await req.json();
    const rec = body.record;
    const old = body.old_record;

    // только реальная смена статуса на «оплачено» / «документ отправлен»
    if (body.type !== "UPDATE" || !rec || !old) return new Response("skip");
    if (old.status === rec.status) return new Response("skip");
    if (rec.status !== "paid" && rec.status !== "sent") return new Response("skip");
    if (!rec.client_id) return new Response("no client");

    // telegram_id привязанного клиента
    const { data: client } = await sb
      .from("clients")
      .select("telegram_id")
      .eq("id", rec.client_id)
      .maybeSingle();

    if (!client || !client.telegram_id) return new Response("no telegram");

    let text: string;
    if (rec.status === "paid") {
      text = `✅ Ваш платёж «${rec.payee}» на ${fmtMoney(Number(rec.amount))} оплачен.`
           + (rec.need_receipt ? "\n📄 Готовим платёжный документ." : "");
    } else {
      text = `📄 Платёжный документ по «${rec.payee}» отправлен.`;
    }

    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: client.telegram_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response("ok");
  }
});
