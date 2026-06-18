import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const BOT   = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
// TELEGRAM_CHAT_ID — один или несколько chat_id через запятую, напр. "111,222"
const CHATS = Deno.env.get("TELEGRAM_CHAT_ID")!.split(",").map(s => s.trim()).filter(Boolean);

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

function fmtMoney(v: number) {
  return v.toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}

serve(async (req) => {
  try {
    const { record } = await req.json();
    if (!record) return new Response("no record", { status: 400 });

    const lines = [
      `📋 <b>Новая заявка на оплату</b>`,
      ``,
      `👤 Клиент: ${record.client || "—"}`,
      `💳 Кому: ${record.payee || "—"}`,
      `💰 Сумма: ${fmtMoney(Number(record.amount || 0))}`,
      `📅 Срок: ${record.due ? fmtDate(record.due) : "—"}`,
      record.purpose    ? `📝 ${record.purpose}`    : null,
      record.requisites ? `🔢 ${record.requisites}` : null,
      record.file_url   ? `📎 <a href="${record.file_url}">Открыть файл</a>` : null,
    ].filter(Boolean).join("\n");

    // шлём каждому получателю отдельно; ошибка одного не блокирует остальных
    await Promise.all(CHATS.map(async (chat) => {
      const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: lines,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) console.error(`Telegram error for ${chat}:`, await res.text());
    }));

    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
