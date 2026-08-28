import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
// TELEGRAM_CHAT_ID — чаты бухгалтеров, через запятую (тот же секрет, что у notify-payment)
const STAFF_CHATS = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// service_role подставляется Supabase автоматически
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

function fmtMoney(v: number) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}
function fmtDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}
const recLbl: Record<string, string> = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!));
}

async function tg(chatId: string | number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) console.error(`Telegram error for ${chatId}:`, await res.text());
  return res.ok;
}

// Один Telegram-аккаунт может быть привязан к нескольким фирмам сразу (человек
// ведёт две компании). Тогда «Ваш платёж «Белтелеком» оплачен» бесполезен — он
// не понимает, чей это платёж. Подписываем фирму, но только таким людям:
// остальным это лишняя строка в каждом сообщении.
async function firmSuffix(telegramId: number, firm: unknown) {
  const name = String(firm ?? "").trim();
  if (!name) return "";
  const { count } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).eq("telegram_id", telegramId);
  return (count ?? 1) > 1 ? `\n\n🏢 ${esc(name)}` : "";
}

// Что именно изменилось — списком «было → стало». Только те поля, которые видит
// человек: служебные флаги уведомлений сюда попадать не должны, иначе функция
//сама себе устроит рассылку, проставив флаг после отправки.
function diffLines(oldRec: Record<string, unknown>, rec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pair = (label: string, a: string, b: string) => out.push(`• ${label}: ${esc(a)} → <b>${esc(b)}</b>`);

  if (oldRec.payee !== rec.payee) pair("Получатель", String(oldRec.payee ?? "—"), String(rec.payee ?? "—"));
  if (Number(oldRec.amount) !== Number(rec.amount))
    pair("Сумма", fmtMoney(Number(oldRec.amount ?? 0)), fmtMoney(Number(rec.amount ?? 0)));
  if (oldRec.due !== rec.due) pair("Дата", fmtDate(String(oldRec.due ?? "")), fmtDate(String(rec.due ?? "")));
  if (oldRec.requisites !== rec.requisites)
    pair("Реквизиты", String(oldRec.requisites || "—"), String(rec.requisites || "—"));
  if (oldRec.purpose !== rec.purpose)
    pair("Назначение", String(oldRec.purpose || "—"), String(rec.purpose || "—"));
  if (oldRec.recurrence !== rec.recurrence)
    pair("Периодичность",
         recLbl[String(oldRec.recurrence)] ?? String(oldRec.recurrence),
         recLbl[String(rec.recurrence)] ?? String(rec.recurrence));
  if (oldRec.need_receipt !== rec.need_receipt)
    pair("Платёжный документ", oldRec.need_receipt ? "нужен" : "не нужен", rec.need_receipt ? "нужен" : "не нужен");

  const oldN = Array.isArray(oldRec.files) ? oldRec.files.length : 0;
  const newN = Array.isArray(rec.files) ? rec.files.length : 0;
  if (oldN !== newN) pair("Файлов", String(oldN), String(newN));

  return out;
}

serve(async (req) => {
  try {
    const body = await req.json();
    const rec = body.record;
    const old = body.old_record;

    if (body.type !== "UPDATE" || !rec || !old) return new Response("skip");

    // ---------- 1. смена статуса: уведомляем клиента ----------
    let text: string | null = null;
    let flagField: "client_paid_notified" | "client_sent_notified" | null = null;

    if (rec.status === "paid" && old.status !== "paid" && !rec.client_paid_notified) {
      text = `✅ Ваш платёж «${esc(rec.payee)}» на ${fmtMoney(Number(rec.amount))} оплачен.`
           + (rec.need_receipt ? "\n📄 Готовим платёжный документ." : "");
      flagField = "client_paid_notified";
    } else if (rec.status === "sent" && old.status !== "sent" && !rec.client_sent_notified) {
      text = `📄 Платёжный документ по «${esc(rec.payee)}» отправлен.`;
      flagField = "client_sent_notified";
    }

    if (text && flagField && rec.client_id) {
      const { data: client } = await sb
        .from("clients").select("telegram_id").eq("id", rec.client_id).maybeSingle();
      if (!client || !client.telegram_id) return new Response("no telegram");

      text += await firmSuffix(client.telegram_id, rec.client);

      // флаг ставим только после успешной отправки — иначе уведомление потеряется
      // навсегда: повторно оно уже не уйдёт
      if (await tg(client.telegram_id, text)) {
        await sb.from("payments").update({ [flagField]: true }).eq("id", rec.id);
      }
      return new Response("ok");
    }

    // ---------- 2. правка заявки ----------
    // Направление определяет БД: last_edit_role проставляет триггер по JWT,
    // подделать его из браузера нельзя.
    const changes = diffLines(old, rec);
    if (changes.length === 0) return new Response("skip");

    // правил сотрудник → сообщаем клиенту, но только про ЕГО собственную заявку:
    // заявки, заведённые бухгалтером, клиент и так не редактирует
    if (rec.last_edit_role === "authenticated" && !rec.created_by_staff && rec.client_id) {
      const { data: client } = await sb
        .from("clients").select("telegram_id").eq("id", rec.client_id).maybeSingle();
      if (!client || !client.telegram_id) return new Response("no telegram");

      await tg(client.telegram_id,
        `✏️ Бухгалтер изменил вашу заявку «${esc(rec.payee)}»:\n\n` + changes.join("\n") +
        await firmSuffix(client.telegram_id, rec.client));
      return new Response("ok");
    }

    // правил клиент → сообщаем бухгалтерам
    if (rec.last_edit_role === "anon" && STAFF_CHATS.length) {
      const head = `✏️ <b>Клиент изменил заявку</b>\n\n`
                 + `👤 ${esc(rec.client)}\n`
                 + `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}\n\n`;
      await Promise.all(STAFF_CHATS.map((chat) => tg(chat, head + changes.join("\n"))));
      return new Response("ok");
    }

    return new Response("skip");
  } catch (e) {
    console.error(e);
    return new Response("ok");
  }
});
