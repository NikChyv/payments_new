import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT            = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET")!;

// service_role подставляется Supabase автоматически — бот ходит в БД напрямую
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- форматирование ----------

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const recLbl: Record<string, string> = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}
function fmtMoney(v: number) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}
function statusLabel(s: string) {
  return ({new:"🕓 принята", in_progress:"⏳ в работе", paid:"✅ оплачено", sent:"✅ документ отправлен"} as Record<string,string>)[s] || s;
}

// время «сейчас» в поясе Минска (UTC+3), чтобы Сегодня/Завтра не уезжали
function minskNow() { return new Date(Date.now() + 3 * 3600 * 1000); }
function isoLocal(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function parseAmount(s: string): number | null {
  const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return (isFinite(n) && n > 0) ? n : null;
}

function parseDate(s: string): string | null {
  s = s.trim().toLowerCase();
  if (s === "сегодня") return isoLocal(minskNow());
  if (s === "завтра")  { const d = minskNow(); d.setUTCDate(d.getUTCDate()+1); return isoLocal(d); }
  const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})(?:[.\-\/](\d{2,4}))?$/);
  if (!m) return null;
  const dd = parseInt(m[1]), mm = parseInt(m[2]);
  let yy = m[3] ? parseInt(m[3]) : minskNow().getUTCFullYear();
  if (yy < 100) yy += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1) return null; // напр. 31 февраля
  return `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}

// ---------- Telegram API ----------

async function send(chatId: number, text: string, keyboard?: unknown) {
  const body: Record<string, unknown> = {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
async function answerCallback(id: string) {
  await fetch(`https://api.telegram.org/bot${BOT}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id }),
  });
}

const KB = {
  due:        [[{text:"Сегодня",callback_data:"due:today"},{text:"Завтра",callback_data:"due:tomorrow"}]],
  recurrence: [[{text:"Разовый",callback_data:"rec:once"}],[{text:"Еженедельно",callback_data:"rec:weekly"}],[{text:"Ежемесячно",callback_data:"rec:monthly"}]],
  needReceipt:[[{text:"Да",callback_data:"nr:1"},{text:"Нет",callback_data:"nr:0"}]],
  skip:       [[{text:"Пропустить",callback_data:"skip"}]],
  confirm:    [[{text:"✅ Подтвердить",callback_data:"ok"}],[{text:"✖️ Отменить",callback_data:"cancel"}]],
};

const HELP =
  "Команды:\n" +
  "🆕 /new — новая заявка на оплату\n" +
  "📋 /payments — мои платежи\n" +
  "✖️ /cancel — отменить заполнение\n" +
  "ℹ️ /help — помощь";

// ---------- сессии диалога ----------

type Draft = Record<string, unknown>;
async function getSession(tgId: number) {
  const { data } = await sb.from("tg_sessions").select("step,draft").eq("telegram_id", tgId).maybeSingle();
  return data as { step: string; draft: Draft } | null;
}
async function setSession(tgId: number, step: string, draft: Draft) {
  await sb.from("tg_sessions").upsert({ telegram_id: tgId, step, draft, updated_at: new Date().toISOString() });
}
async function clearSession(tgId: number) {
  await sb.from("tg_sessions").delete().eq("telegram_id", tgId);
}

async function getClient(tgId: number) {
  const { data } = await sb.from("clients").select("id,name,token").eq("telegram_id", tgId).maybeSingle();
  return data as { id: string; name: string; token: string } | null;
}

// ---------- загрузка файла из Telegram в Storage ----------

async function uploadTelegramFile(fileId: string, fallbackName: string, mime?: string) {
  const r1 = await fetch(`https://api.telegram.org/bot${BOT}/getFile?file_id=${fileId}`);
  const j1 = await r1.json();
  if (!j1.ok) return null;
  const filePath: string = j1.result.file_path;
  const r2 = await fetch(`https://api.telegram.org/file/bot${BOT}/${filePath}`);
  const buf = await r2.arrayBuffer();
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(rand, b => b.toString(16).padStart(2, "0")).join("");
  const name = (fallbackName || "file").replace(/[^\w.\-]+/g, "_");
  const storagePath = hex + "/" + name;
  const up = await sb.storage.from("files").upload(storagePath, buf, { contentType: mime || "application/octet-stream" });
  if (up.error) { console.error(up.error); return null; }
  const pub = sb.storage.from("files").getPublicUrl(storagePath);
  return { url: pub.data.publicUrl, name: fallbackName || "файл" };
}

// ---------- экран подтверждения ----------

function summary(d: Draft) {
  return [
    "<b>Проверьте заявку:</b>", "",
    `💳 Кому: ${d.payee}`,
    `💰 Сумма: ${fmtMoney(d.amount as number)}`,
    d.requisites ? `🔢 Реквизиты: ${d.requisites}` : null,
    `📅 Дата: ${fmtDate(d.due as string)}`,
    `🔁 Периодичность: ${recLbl[d.recurrence as string] || d.recurrence}`,
    d.purpose ? `📝 Назначение: ${d.purpose}` : null,
    `🧾 Документ после оплаты: ${d.need_receipt ? "да" : "нет"}`,
    d.file_name ? `📎 Файл: ${d.file_name}` : "📎 Файл: нет",
  ].filter(x => x !== null).join("\n");
}

// ---------- шаги диалога ----------

async function askAmount(c: number)     { await send(c, "💰 Сумма к оплате (Br)?"); }
async function askRequisites(c: number) { await send(c, "🔢 УНП / реквизиты или счёт? Можно пропустить.", KB.skip); }
async function askDue(c: number)        { await send(c, "📅 Дата платежа? Формат ДД.ММ.ГГГГ — или кнопкой ниже.", KB.due); }
async function askRecurrence(c: number) { await send(c, "🔁 Периодичность платежа?", KB.recurrence); }
async function askPurpose(c: number)    { await send(c, "📝 Назначение платежа? Можно пропустить.", KB.skip); }
async function askReceipt(c: number)    { await send(c, "🧾 Нужен платёжный документ после оплаты?", KB.needReceipt); }
async function askFile(c: number)       { await send(c, "📎 Приложите фото или PDF счёта — или пропустите.", KB.skip); }
async function showConfirm(c: number, d: Draft) { await send(c, summary(d), KB.confirm); }

// ---------- обработка текстового шага ----------

async function routeText(chatId: number, tgId: number, step: string, draft: Draft, text: string) {
  switch (step) {
    case "payee":
      draft.payee = text;
      await setSession(tgId, "amount", draft); await askAmount(chatId); break;
    case "amount": {
      const a = parseAmount(text);
      if (a === null) { await send(chatId, "Не похоже на сумму. Введите число, напр. 1500 или 1500.50"); return; }
      draft.amount = a;
      await setSession(tgId, "requisites", draft); await askRequisites(chatId); break;
    }
    case "requisites":
      draft.requisites = text;
      await setSession(tgId, "due", draft); await askDue(chatId); break;
    case "due": {
      const dt = parseDate(text);
      if (!dt) { await send(chatId, "Не понял дату. Формат ДД.ММ.ГГГГ, напр. 25.06.2026 — или кнопкой.", KB.due); return; }
      draft.due = dt;
      await setSession(tgId, "recurrence", draft); await askRecurrence(chatId); break;
    }
    case "purpose":
      draft.purpose = text;
      await setSession(tgId, "need_receipt", draft); await askReceipt(chatId); break;
    case "recurrence": await send(chatId, "Выберите периодичность кнопкой ниже.", KB.recurrence); break;
    case "need_receipt": await send(chatId, "Ответьте кнопкой ниже.", KB.needReceipt); break;
    case "file": await send(chatId, "Приложите файл или нажмите «Пропустить».", KB.skip); break;
    case "confirm": await send(chatId, "Подтвердите или отмените кнопкой ниже.", KB.confirm); break;
    default: await send(chatId, HELP);
  }
}

// ---------- финал: создание поручения ----------

async function submit(chatId: number, tgId: number, token: string, d: Draft) {
  const { error } = await sb.rpc("submit_payment", {
    p_token:        token,
    p_payee:        d.payee,
    p_amount:       d.amount,
    p_requisites:   d.requisites ?? null,
    p_due:          d.due,
    p_recurrence:   d.recurrence,
    p_purpose:      d.purpose ?? null,
    p_need_receipt: d.need_receipt,
    p_file_url:     d.file_url ?? null,
    p_file_name:    d.file_name ?? null,
  });
  await clearSession(tgId);
  if (error) {
    console.error(error);
    await send(chatId, "Не удалось создать заявку. Попробуйте ещё раз: /new");
  } else {
    await send(chatId, `✅ Заявка отправлена бухгалтеру. Платёж «${d.payee}» на ${fmtDate(d.due as string)} в очереди.\n\nПосмотреть статус: /payments`);
  }
}

// ---------- обработчики ----------

async function handleMessage(msg: any) {
  const chatId = msg.chat.id as number;
  const tgId = chatId;

  // вложение (фото/документ) — только на шаге file
  if (msg.photo || msg.document) {
    const client = await getClient(tgId);
    if (!client) { await send(chatId, "Вы ещё не привязаны. Откройте персональную ссылку и нажмите «Старт»."); return; }
    const session = await getSession(tgId);
    if (!session || session.step !== "file") { await send(chatId, "Чтобы создать заявку: /new"); return; }
    let up = null;
    if (msg.document) {
      up = await uploadTelegramFile(msg.document.file_id, msg.document.file_name || "файл", msg.document.mime_type);
    } else {
      const ph = msg.photo[msg.photo.length - 1]; // самый крупный размер
      up = await uploadTelegramFile(ph.file_id, "photo.jpg", "image/jpeg");
    }
    if (!up) { await send(chatId, "Файл не загрузился. Попробуйте ещё раз или нажмите «Пропустить».", KB.skip); return; }
    session.draft.file_url = up.url; session.draft.file_name = up.name;
    await setSession(tgId, "confirm", session.draft);
    await showConfirm(chatId, session.draft);
    return;
  }

  if (!msg.text) return;
  const text = (msg.text as string).trim();

  // привязка по deep-link
  if (text.startsWith("/start")) {
    const token = text.split(/\s+/)[1];
    if (!token) { await send(chatId, "Привет! Откройте персональную ссылку от бухгалтера и нажмите «Старт»."); return; }
    const { data, error } = await sb.from("clients").update({ telegram_id: chatId }).eq("token", token).select("name").maybeSingle();
    if (error || !data) await send(chatId, "Ссылка недействительна. Обратитесь к бухгалтеру.");
    else await send(chatId, `Готово! Аккаунт «${data.name}» привязан.\n\n${HELP}`);
    return;
  }
  if (text === "/help") { await send(chatId, HELP); return; }

  const client = await getClient(tgId);
  if (!client) { await send(chatId, "Вы ещё не привязаны. Откройте персональную ссылку от бухгалтера и нажмите «Старт»."); return; }

  if (text === "/cancel") {
    await clearSession(tgId);
    await send(chatId, "Заполнение отменено. Новая заявка — /new");
    return;
  }

  if (text === "/new" || /нов(ая|ое) (заявк|поручени)/i.test(text)) {
    await setSession(tgId, "payee", {});
    await send(chatId, "Создаём заявку. В любой момент — /cancel.\n\n💳 Кому платим (получатель)?");
    return;
  }

  if (text === "/payments" || /мои платеж/i.test(text)) {
    const { data: items } = await sb.from("payments")
      .select("payee,amount,due,status").eq("client_id", client.id)
      .in("status", ["new", "in_progress"]).order("due");
    if (!items || items.length === 0) { await send(chatId, "Активных платежей нет. 🎉"); return; }
    const lines = items.map((it: any, i: number) =>
      `${i + 1}. <b>${it.payee}</b> — ${fmtMoney(it.amount)}\n   📅 ${fmtDate(it.due)} · ${statusLabel(it.status)}`);
    await send(chatId, `<b>Ваши платежи (${client.name})</b>\n\n` + lines.join("\n\n"));
    return;
  }

  // текст внутри диалога
  const session = await getSession(tgId);
  if (session) { await routeText(chatId, tgId, session.step, session.draft, text); return; }

  await send(chatId, "Не понял. " + HELP);
}

async function handleCallback(cq: any) {
  const chatId = cq.message.chat.id as number;
  const tgId = chatId;
  const data = cq.data as string;
  await answerCallback(cq.id);

  const client = await getClient(tgId);
  const session = await getSession(tgId);
  if (!client || !session) { await send(chatId, "Сессия не найдена. Начните заново: /new"); return; }
  const d = session.draft;

  if (data.startsWith("due:") && session.step === "due") {
    d.due = data === "due:today" ? isoLocal(minskNow()) : isoLocal((() => { const x = minskNow(); x.setUTCDate(x.getUTCDate()+1); return x; })());
    await setSession(tgId, "recurrence", d); await askRecurrence(chatId); return;
  }
  if (data.startsWith("rec:") && session.step === "recurrence") {
    d.recurrence = data.slice(4);
    await setSession(tgId, "purpose", d); await askPurpose(chatId); return;
  }
  if (data.startsWith("nr:") && session.step === "need_receipt") {
    d.need_receipt = data === "nr:1";
    await setSession(tgId, "file", d); await askFile(chatId); return;
  }
  if (data === "skip") {
    if (session.step === "requisites") { d.requisites = null; await setSession(tgId, "due", d); await askDue(chatId); return; }
    if (session.step === "purpose")    { d.purpose = null;    await setSession(tgId, "need_receipt", d); await askReceipt(chatId); return; }
    if (session.step === "file")       { await setSession(tgId, "confirm", d); await showConfirm(chatId, d); return; }
    return;
  }
  if (data === "ok" && session.step === "confirm") { await submit(chatId, tgId, client.token, d); return; }
  if (data === "cancel") { await clearSession(tgId); await send(chatId, "Заявка отменена. Новая — /new"); return; }
}

// ---------- вход ----------

serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message)   await handleMessage(update.message);
    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response("ok"); // всегда 200 — иначе Telegram ретраит
  }
});
