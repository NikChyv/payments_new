import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
// TELEGRAM_CHAT_ID — чаты бухгалтеров, через запятую (тот же секрет, что у notify-payment)
const STAFF_CHATS = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// service_role подставляется Supabase автоматически
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  // SB_SECRET_KEY — новый ключ (sb_secret_…); SUPABASE_SERVICE_ROLE_KEY —
  // legacy, который платформа подставляет сама. Читаем новый с откатом на
  // старый, чтобы функция работала и до отключения legacy-ключей, и после.
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Кто имеет право дёргать эту функцию.
//
// Verify JWT у вебхуков включён, но он принимает ЛЮБОЙ валидный ключ проекта —
// в том числе публичный, который лежит во фронте. То есть кто угодно мог бы
// прислать сюда произвольный record: подделать сообщение клиента в чат
// бухгалтеров, проставить флаги уведомлений чужой заявке или заставить функцию
// скачать любой URL и переслать его в Telegram. Поэтому проверяем собственный
// секрет, как это уже сделано у бота (TG_WEBHOOK_SECRET).
//
// Пока WEBHOOK_SECRET не задан в окружении, проверка выключена: это позволяет
// выкатить функцию раньше, чем секрет появится в триггерах, и не уронить
// уведомления на время перехода.
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
function fromWebhook(req: Request) {
  if (!WEBHOOK_SECRET) return true;
  return req.headers.get("x-webhook-secret") === WEBHOOK_SECRET;
}

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

// Одно сообщение переписки по заявке (payments.thread). Форму задаёт БД —
// post_staff_message и reply_by_token, миграция 20260909000001.
type ThreadMsg = {
  who?: string;                 // 'staff' | 'client'
  kind?: string;                // 'question' | 'reminder' | 'reply'
  text?: string;
  author?: string;
  files?: Array<{ url?: string; name?: string }>;
  at?: string;
};

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

async function tg(chatId: string | number, text: string, keyboard?: unknown) {
  const body: Record<string, unknown> = {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`Telegram error for ${chatId}:`, await res.text());
  return res.ok;
}

// Отправка документа клиенту.
//
// Шлём именно sendDocument и именно БАЙТАМИ, а не ссылкой. Две причины:
//
// 1. Пересылка. Клиент перешлёт сообщение поставщику как подтверждение оплаты —
//    Telegram передаст сам файл, и наша вечная публичная ссылка никуда не уйдёт.
// 2. Имя файла. Если отдать Telegram URL, он возьмёт имя из адреса, а в пути
//    кириллица заменена подчёркиваниями при загрузке — клиент получил бы
//    «________.pdf» и переслал бы это поставщику. Подставляя байты, имя задаём
//    сами и человеческое.
//
// sendPhoto не годится даже для фотографии платёжки: Telegram её пережмёт.
async function tgDocument(chatId: string | number, url: string, name: string, caption?: string) {
  const file = await fetch(url);
  if (!file.ok) { console.error(`Не скачался файл ${url}: ${file.status}`); return false; }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([await file.arrayBuffer()]), name || "document");
  if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }

  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) console.error(`Telegram sendDocument error for ${chatId}:`, await res.text());
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
  if (!fromWebhook(req)) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json();
    const rec = body.record;
    const old = body.old_record;

    if (body.type !== "UPDATE" || !rec || !old) return new Response("skip");

    // ---------- 0. платёжный документ от бухгалтера ----------
    // Стоит ПЕРЕД разбором статуса и правок намеренно. Прикрепление документа
    // приходит сюда как обычный UPDATE от сотрудника: не перехвати мы его
    // здесь, ниже сработала бы ветка «изменил заявку», а diffLines про
    // staff_files не знает и вернула бы «skip» — клиент не получил бы ничего.
    const docs: Array<{ url?: string; name?: string }> = Array.isArray(rec.staff_files) ? rec.staff_files : [];
    const alreadySent = Number(rec.client_docs_notified ?? 0);
    const fresh = docs.slice(alreadySent).filter((d) => d && d.url);

    if (fresh.length && rec.client_id) {
      const { data: client } = await sb
        .from("clients").select("telegram_id").eq("id", rec.client_id).maybeSingle();
      if (!client || !client.telegram_id) return new Response("no telegram");

      // Подпись только у первого файла — иначе один и тот же текст повторится
      // под каждым вложением. Пишем её так, чтобы пересылка поставщику была
      // самодостаточной: из сообщения понятно, что за платёж и что он прошёл.
      const caption = `✅ Платёж «${esc(rec.payee)}» на ${fmtMoney(Number(rec.amount))} оплачен.`
        + `\n📄 Во вложении — платёжный документ.`
        + await firmSuffix(client.telegram_id, rec.client);

      let sent = 0;
      for (const d of fresh) {
        const ok = await tgDocument(client.telegram_id, d.url!, d.name || "документ", sent === 0 ? caption : undefined);
        if (!ok) break;   // не дошёл — счётчик не двигаем, при следующем касании допошлём
        sent++;
      }

      if (sent > 0) {
        await sb.from("payments").update({
          client_docs_notified: alreadySent + sent,
          // документ ушёл — текстовое «документ отправлен» теперь только дублировало бы
          client_sent_notified: true,
        }).eq("id", rec.id);
      }
      return new Response("ok");
    }

    // ---------- 0.5. переписка по заявке ----------
    // Стоит перед разбором статуса и правок по той же причине, что и документ:
    // сообщение приходит сюда обычным UPDATE, а diffLines про thread не знает и
    // вернула бы «skip» — ни клиент, ни бухгалтер ничего бы не получили.
    //
    // Счётчики client_thread_notified / staff_thread_notified — это ИНДЕКСЫ в
    // переписке, а не количество отправленного: в ней вперемешку лежат реплики
    // обеих сторон, и считать «сколько своих отправил» пришлось бы дважды.
    // Не дошло — оставляем индекс на неудачном сообщении и допошлём при
    // следующем касании заявки.
    const thread: ThreadMsg[] = Array.isArray(rec.thread) ? rec.thread : [];

    if (thread.length) {
      const fromClient = Number(rec.client_thread_notified ?? 0);
      const fromStaff  = Number(rec.staff_thread_notified ?? 0);
      const hasForClient = thread.slice(fromClient).some((m) => m && m.who === "staff");
      const hasForStaff  = thread.slice(fromStaff).some((m) => m && m.who === "client");

      if (hasForClient || hasForStaff) {
        const patch: Record<string, unknown> = {};

        // сообщение бухгалтера → клиенту, с кнопкой «Ответить» под ним
        if (hasForClient && rec.client_id) {
          const { data: client } = await sb
            .from("clients").select("telegram_id").eq("id", rec.client_id).maybeSingle();

          // Не привязан к боту — индекс НЕ двигаем: привяжется, и вопрос дойдёт.
          // Пока же он виден ему в кабинете, туда сообщение попало сразу.
          if (client && client.telegram_id) {
            const suffix = await firmSuffix(client.telegram_id, rec.client);
            const card = `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}`;
            let i = fromClient;
            for (; i < thread.length; i++) {
              const m = thread[i];
              if (!m || m.who !== "staff") continue;
              const head = m.kind === "reminder"
                ? "🔔 <b>Напоминание от бухгалтера</b>"
                : "❗ <b>Бухгалтер спрашивает по вашей заявке</b>";
              const ok = await tg(client.telegram_id,
                `${head}\n\n${card}\n\n${esc(m.text)}${suffix}`,
                [[{ text: "✍️ Ответить", callback_data: `reply:${rec.id}` }]]);
              if (!ok) break;
            }
            if (i > fromClient) patch.client_thread_notified = i;
          }
        }

        // ответ клиента → в общий чат бухгалтеров
        if (hasForStaff && STAFF_CHATS.length) {
          const card = `👤 ${esc(rec.client)}\n`
                     + `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}`;
          let i = fromStaff;
          for (; i < thread.length; i++) {
            const m = thread[i];
            if (!m || m.who !== "client") continue;
            // Файл клиент прислал в ответ, и он уже лежит во вложениях заявки —
            // ссылкой, чтобы открыть его можно было прямо из чата.
            const files = (m.files ?? [])
              .filter((f) => f && f.url)
              .map((f) => `📎 <a href="${esc(f.url)}">${esc(f.name || "файл")}</a>`)
              .join("\n");
            const text = `💬 <b>Клиент ответил по заявке</b>\n\n${card}\n\n`
                       + (m.text ? `«${esc(m.text)}»` : "<i>без текста</i>")
                       + (files ? `\n\n${files}` : "");
            const results = await Promise.all(STAFF_CHATS.map((chat) => tg(chat, text)));
            if (!results.some(Boolean)) break;   // не дошло вообще никому — повторим позже
          }
          if (i > fromStaff) patch.staff_thread_notified = i;
        }

        if (Object.keys(patch).length) {
          await sb.from("payments").update(patch).eq("id", rec.id);
        }
        return new Response("ok");
      }
    }

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
