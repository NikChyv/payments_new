import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Нужен только ради журнала отказов. SB_SECRET_KEY — новый ключ,
// SUPABASE_SERVICE_ROLE_KEY — legacy, который платформа подставляет сама.
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Читаем через ?? "", а не через `!`: восклицательный знак — это обещание
// компилятору, а не проверка. Пропади секрет — функция падала прямо на импорте
// с невнятным 500 и не успевала даже записать отказ в журнал (M4.4).
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

// Номеров бухгалтеров здесь больше нет. Раньше «новая заявка» уходила всем из
// секрета TELEGRAM_CHAT_ID, чей бы клиент ни был, — теперь адресатов по каждой
// заявке считает база (notify_staff_chats, см. staffChats ниже).

// Кто имеет право дёргать эту функцию. Verify JWT принимает любой валидный ключ
// проекта, включая публичный из фронта, — то есть без своей проверки кто угодно
// мог бы слать бухгалтерам «новую заявку» с произвольным текстом и ссылкой.
// Пока WEBHOOK_SECRET не задан, проверка выключена: см. notify-client.
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
function fromWebhook(req: Request) {
  if (!WEBHOOK_SECRET) return true;
  return req.headers.get("x-webhook-secret") === WEBHOOK_SECRET;
}

// Неудачная отправка — в журнал, а не только в консоль. У Database Webhooks
// нет ретраев, console.error никто не читает, и уведомление просто исчезает.
// Сам журнал падать не имеет права.
async function logFailure(branch: string, paymentId: unknown, chatId: unknown, detail: string) {
  try {
    await sb.from("notify_failures").insert({
      fn: "notify-payment", branch,
      payment_id: paymentId == null ? null : String(paymentId),
      chat_id: chatId == null ? null : String(chatId),
      detail: detail.slice(0, 2000),
    });
  } catch (e) {
    console.error("не записался notify_failures:", e);
  }
}

// Кому из сотрудников слать: бухгалтер клиента плюс админы. Правило живёт в
// базе (notify_staff_chats) — одно на обе функции уведомлений и на утреннее
// письмо. Та же обёртка есть в notify-client.
async function staffChats(rec: Record<string, unknown>): Promise<string[]> {
  const { data, error } = await sb.rpc("notify_staff_chats", { p_client_id: rec.client_id ?? null });
  if (error) {
    console.error("notify_staff_chats:", error);
    await logFailure("новая заявка", rec.id, null, `не удалось получить адресатов: ${error.message}`);
    return [];
  }
  if (data?.unreachable) {
    await logFailure("новая заявка", rec.id, null,
      `у бухгалтера «${data.unreachable}» не указан telegram_id — уведомление ушло только админу`);
  }
  return Array.isArray(data?.chats) ? data.chats : [];
}

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

// Сообщение уходит с parse_mode: HTML, а поля заявки пишет клиент. Без
// экранирования `<b` в названии получателя ломает разметку, а `<a href=…>`
// подменяет ссылку в уведомлении бухгалтеру (находка M4.3).
// Telegram разбирает подмножество HTML — ему хватает трёх символов.
function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!));
}

// Ссылка идёт в href, поэтому проверяем схему, а не экранируем: `javascript:`
// экранирование пережил бы. Зеркалит is_safe_file_url в базе — та не пускает
// такие ссылки в новые заявки, эта прикрывает те, что завелись раньше.
function safeUrl(u: unknown) {
  const s = String(u ?? "");
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

function fmtMoney(v: number) {
  return v.toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}

serve(async (req) => {
  if (!fromWebhook(req)) return new Response("forbidden", { status: 403 });
  try {
    const { record } = await req.json();
    if (!record) return new Response("no record", { status: 400 });

    // следующая копия повторяющегося платежа создаётся системой после «Оплачено» —
    // клиент такую заявку не подавал, уведомлять о ней не нужно
    if (record.auto_created) return new Response("skip: auto-created");

    // заявку завёл сам сотрудник (для клиента или личную задачу) — бухгалтерам
    // уведомление не нужно, а личная задача вообще приватная.
    // Уведомление клиенту о таких заявках — отдельная задача, пока не делаем.
    if (record.created_by_staff) return new Response("skip: staff-created");

    // Некому слать — это поломка настройки, а не «нечего делать»: заявка есть,
    // а бухгалтеры о ней не узнают. Пишем в журнал, иначе снова тихо.
    // Проверяем ПОСЛЕ пропусков выше: по авто-копиям адресатов искать незачем.
    if (!BOT) {
      await logFailure("новая заявка", record.id, null, "не задан TELEGRAM_BOT_TOKEN");
      return new Response("not configured", { status: 500 });
    }
    const chats = await staffChats(record);
    if (!chats.length) {
      await logFailure("новая заявка", record.id, null,
        "некому отправить: ни у бухгалтера клиента, ни у админов не указан telegram_id");
      return new Response("no recipients", { status: 500 });
    }

    const fileUrl = safeUrl(record.file_url);

    const lines = [
      `📋 <b>Новая заявка на оплату</b>`,
      ``,
      `👤 Клиент: ${esc(record.client || "—")}`,
      `💳 Кому: ${esc(record.payee || "—")}`,
      `💰 Сумма: ${fmtMoney(Number(record.amount || 0))}`,
      `📅 Срок: ${record.due ? fmtDate(record.due) : "—"}`,
      record.purpose    ? `📝 ${esc(record.purpose)}`    : null,
      record.requisites ? `🔢 ${esc(record.requisites)}` : null,
      fileUrl           ? `📎 <a href="${fileUrl}">Открыть файл</a>` : null,
    ].filter(Boolean).join("\n");

    // шлём каждому получателю отдельно; ошибка одного не блокирует остальных
    await Promise.all(chats.map(async (chat) => {
      // fetch БРОСАЕТ при сетевой ошибке, а не возвращает !ok. Необёрнутый, он
      // проходил мимо журнала и ронял Promise.all целиком — тот же класс, что
      // уже закрыт в notify-client.
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text: lines,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
      } catch (e) {
        const detail = `Telegram недоступен: ${e instanceof Error ? e.message : String(e)}`;
        console.error(detail);
        await logFailure("новая заявка", record.id, chat, detail);
        return;
      }
      if (!res.ok) {
        // Без этой записи бухгалтеры просто не узнали бы о заявке, и никто бы
        // этого не заметил (M4.4).
        const detail = await res.text();
        console.error(`Telegram error for ${chat}:`, detail);
        await logFailure("новая заявка", record.id, chat, `${res.status} ${detail}`);
      }
    }));

    return new Response("ok");
  } catch (e) {
    console.error(e);
    await logFailure("вызов целиком", null, null,
      `исключение: ${e instanceof Error ? e.message : String(e)}`);
    return new Response("error", { status: 500 });
  }
});
