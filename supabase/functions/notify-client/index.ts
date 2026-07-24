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

    if (body.type !== "UPDATE" || !rec || !old) return new Response("skip");
    if (!rec.client_id) return new Response("no client");

    // Уведомляем только при ПЕРВОМ переходе в статус и только один раз за жизнь
    // платежа (флаг). Двойной клик (old.status === new.status) отсекается сам;
    // сценарий «оплатил → отменил → снова оплатил» гасится флагом.
    let text: string | null = null;
    let flagField: "client_paid_notified" | "client_sent_notified" | null = null;

    if (rec.status === "paid" && old.status !== "paid" && !rec.client_paid_notified) {
      text = `✅ Ваш платёж «${rec.payee}» на ${fmtMoney(Number(rec.amount))} оплачен.`
           + (rec.need_receipt ? "\n📄 Готовим платёжный документ." : "");
      flagField = "client_paid_notified";
    } else if (rec.status === "sent" && old.status !== "sent" && !rec.client_sent_notified) {
      text = `📄 Платёжный документ по «${rec.payee}» отправлен.`;
      flagField = "client_sent_notified";
    }

    if (!text || !flagField) return new Response("skip");

    // telegram_id привязанного клиента
    const { data: client } = await sb
      .from("clients")
      .select("telegram_id")
      .eq("id", rec.client_id)
      .maybeSingle();

    if (!client || !client.telegram_id) return new Response("no telegram");

    const resp = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: client.telegram_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    // помечаем как уведомлённого только при успешной отправке
    // (обновление флага снова триггерит webhook, но там old.status === new.status → skip)
    if (resp.ok) {
      await sb.from("payments").update({ [flagField]: true }).eq("id", rec.id);
    } else {
      console.error("Telegram error:", await resp.text());
    }

    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response("ok");
  }
});
