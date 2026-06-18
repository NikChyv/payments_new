import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT            = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET")!;

// service_role подставляется Supabase автоматически — бот ходит в БД напрямую
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

function fmtMoney(v: number) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}

function statusLabel(s: string) {
  return ({
    new:         "🕓 принята",
    in_progress: "⏳ в работе",
    paid:        "✅ оплачено",
    sent:        "✅ документ отправлен",
  } as Record<string, string>)[s] || s;
}

const HELP =
  "Команды:\n" +
  "📋 /payments — мои платежи\n" +
  "ℹ️ /help — помощь";

async function send(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

serve(async (req) => {
  // защита: Telegram шлёт секрет в заголовке (задаётся при setWebhook)
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const update = await req.json();
    const msg = update.message;
    // Фаза A работает только с текстом; остальное игнорируем (отвечаем 200)
    if (!msg || !msg.text) return new Response("ok");

    const chatId = msg.chat.id as number;
    const text   = (msg.text as string).trim();

    // ---- /start [token] — привязка аккаунта по deep-link ----
    if (text.startsWith("/start")) {
      const token = text.split(/\s+/)[1];
      if (!token) {
        await send(chatId,
          "Привет! Чтобы пользоваться ботом, откройте персональную ссылку, " +
          "которую дал бухгалтер, и нажмите «Старт».");
        return new Response("ok");
      }
      const { data, error } = await sb
        .from("clients")
        .update({ telegram_id: chatId })
        .eq("token", token)
        .select("name")
        .maybeSingle();

      if (error || !data) {
        await send(chatId, "Ссылка недействительна. Обратитесь к бухгалтеру.");
      } else {
        await send(chatId, `Готово! Аккаунт «${data.name}» привязан.\n\n${HELP}`);
      }
      return new Response("ok");
    }

    // ---- определяем клиента по telegram_id ----
    const { data: client } = await sb
      .from("clients")
      .select("id,name")
      .eq("telegram_id", chatId)
      .maybeSingle();

    if (!client) {
      await send(chatId,
        "Вы ещё не привязаны. Откройте персональную ссылку от бухгалтера и нажмите «Старт».");
      return new Response("ok");
    }

    // ---- /payments — активные платежи клиента ----
    if (text === "/payments" || /мои платеж/i.test(text)) {
      const { data: items } = await sb
        .from("payments")
        .select("payee,amount,due,status")
        .eq("client_id", client.id)
        .in("status", ["new", "in_progress"])
        .order("due");

      if (!items || items.length === 0) {
        await send(chatId, "Активных платежей нет. 🎉");
      } else {
        const lines = items.map((it, i) =>
          `${i + 1}. <b>${it.payee}</b> — ${fmtMoney(it.amount)}\n` +
          `   📅 ${fmtDate(it.due)} · ${statusLabel(it.status)}`,
        );
        await send(chatId, `<b>Ваши платежи (${client.name})</b>\n\n` + lines.join("\n\n"));
      }
      return new Response("ok");
    }

    // ---- всё остальное — подсказка ----
    await send(chatId, HELP);
    return new Response("ok");
  } catch (e) {
    console.error(e);
    // всегда 200 — иначе Telegram будет долбить ретраями
    return new Response("ok");
  }
});
