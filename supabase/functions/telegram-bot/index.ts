import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT            = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TG_WEBHOOK_SECRET")!;

// service_role подставляется Supabase автоматически — бот ходит в БД напрямую
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  // SB_SECRET_KEY — новый ключ (sb_secret_…); SUPABASE_SERVICE_ROLE_KEY —
  // legacy, который платформа подставляет сама. Читаем новый с откатом на
  // старый, чтобы функция работала и до отключения legacy-ключей, и после.
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- форматирование ----------

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const recLbl: Record<string, string> = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

// Все сообщения уходят с parse_mode: HTML, а получателя, назначение, реквизиты,
// имя файла и название фирмы пишет человек. Без экранирования `<` в названии
// получателя ломал разметку, и Telegram отказывался принимать сообщение целиком:
// экран подтверждения не приходил, человек застревал на шаге без кнопок и не
// понимал, что делать (M5.3). Та же функция, что в notify-client.
function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!));
}

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

// Работаем пн–пт: платёж на будущие сб/вс не проводится (сегодняшний выходной
// сервер сам перенесёт на ближайший рабочий день).
function isWeekend(iso: string) {
  const g = new Date(iso + "T00:00:00Z").getUTCDay();
  return g === 0 || g === 6;
}
function isFuture(iso: string) { return iso > isoLocal(minskNow()); }

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

// Ответ бота. Раньше результат не смотрели вовсе: отказ Telegram (битая разметка,
// заблокированный бот) проходил молча, и в логах функции не оставалось ничего,
// по чему можно понять, почему человек «ничего не получил». Теперь отказ виден,
// а сетевая ошибка не роняет обработку апдейта целиком — fetch при ней бросает.
//
// В notify_failures ответы бота не пишем намеренно: это диалог, человек сидит
// в чате и повторит команду сам, а health.yml краснел бы от каждого, кто
// заблокировал бота посреди разговора.
async function send(chatId: number, text: string, keyboard?: unknown): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`Telegram sendMessage ${chatId}: ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error(`Telegram недоступен (${chatId}):`, e);
    return false;
  }
}

// Подтверждение нажатия кнопки. Зовётся ДО обработки нажатия, поэтому бросать
// не имеет права: сетевая ошибка здесь съела бы само действие — «Подтвердить»
// не создало бы заявку.
async function answerCallback(id: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id }),
    });
  } catch (e) {
    console.error("answerCallbackQuery:", e);
  }
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
type Session = { step: string; draft: Draft; updated_at?: string };

async function getSession(tgId: number) {
  const { data } = await sb.from("tg_sessions").select("step,draft,updated_at").eq("telegram_id", tgId).maybeSingle();
  return data as Session | null;
}

// Режим ответа на вопрос бухгалтера остаётся открытым после отправки: человек
// почти всегда дописывает («вот счёт» + файл следом), и терять второе сообщение
// нельзя. Но висеть вечно он не должен — иначе завтрашнее «спасибо» уедет в
// переписку по позавчерашней заявке. Через 12 часов режим сам закрывается.
const REPLY_TTL = 12 * 3600 * 1000;
function replyAlive(s: Session | null) {
  if (!s || s.step !== "reply") return false;
  const t = Date.parse(String(s.updated_at ?? ""));
  return !isFinite(t) || (Date.now() - t) < REPLY_TTL;
}
async function setSession(tgId: number, step: string, draft: Draft) {
  await sb.from("tg_sessions").upsert({ telegram_id: tgId, step, draft, updated_at: new Date().toISOString() });
}
async function clearSession(tgId: number) {
  await sb.from("tg_sessions").delete().eq("telegram_id", tgId);
}

type ClientRow = { id: string; name: string; token: string };

// Один Telegram-аккаунт может быть привязан к НЕСКОЛЬКИМ фирмам: у части клиентов
// их две (одно физлицо ведёт две компании). Раньше `/start` затирал прежнюю
// привязку, и человек с двумя фирмами получал уведомления только по последней.
//
// Уведомлениям множественность не мешает: они идут от заявки к фирме
// (payments.client_id → clients.telegram_id), а не наоборот. Мешает она только
// диалогу, которому нужно знать, ОТ ЧЬЕГО ИМЕНИ заводить заявку, — поэтому
// здесь список, а не одна запись, и `.maybeSingle()` тут больше нельзя: на двух
// строках он возвращает ошибку, и бот отвечал бы «вы ещё не привязаны».
async function getClients(tgId: number): Promise<ClientRow[]> {
  const { data } = await sb.from("clients")
    .select("id,name,token").eq("telegram_id", tgId).order("name");
  return (data ?? []) as ClientRow[];
}

const NOT_BOUND = "Вы ещё не привязаны. Откройте персональную ссылку от бухгалтера и нажмите «Старт».";

// Заявку вслепую за человека с двумя фирмами создавать нельзя: попадёт не в ту
// компанию, и это увидят только на сверке. Пока выбор фирмы в боте не сделан,
// честно отправляем такого человека на персональную ссылку. Сами ссылки в чат
// не пишем — токен в переписке остаётся навсегда, а у клиента они уже есть.
function manyFirms(list: ClientRow[]) {
  return "У вас привязано несколько фирм: " + list.map((c) => `«${esc(c.name)}»`).join(", ") + ".\n\n" +
    "✅ Уведомления об оплате приходят по всем — делать ничего не нужно.\n\n" +
    "А вот новую заявку через бота я принять не могу: не пойму, от какой фирмы она. " +
    "Откройте персональную ссылку нужной фирмы — ту, что присылал бухгалтер, — и заведите заявку там.";
}

// Активные платежи по всем фирмам чата. Заголовок с названием фирмы печатаем
// только когда фирм несколько: у остальных он был бы лишним шумом.
async function sendPayments(chatId: number, list: ClientRow[]) {
  const { data: items } = await sb.from("payments")
    .select("payee,amount,paid_amount,due,status,client_id")
    .in("client_id", list.map((c) => c.id))
    .in("status", ["new", "in_progress"]).order("due");

  if (!items || items.length === 0) { await send(chatId, "Активных платежей нет. 🎉"); return; }

  // При частичной оплате — остаток, как в уведомлении «оплачено X, остаток Y»:
  // минуту назад бот сказал «остаток 300», и полная сумма здесь спорила бы с ним.
  const amountText = (it: any) => {
    const paid = Number(it.paid_amount ?? 0);
    const rest = Math.max(Math.round((Number(it.amount) - paid) * 100) / 100, 0);
    return paid > 0 ? `остаток ${fmtMoney(rest)} из ${fmtMoney(Number(it.amount))}` : fmtMoney(it.amount);
  };
  const line = (it: any, i: number) =>
    `${i + 1}. <b>${esc(it.payee)}</b> — ${amountText(it)}\n   📅 ${fmtDate(it.due)} · ${statusLabel(it.status)}`;

  if (list.length === 1) {
    await send(chatId, `<b>Ваши платежи (${esc(list[0].name)})</b>\n\n` + items.map(line).join("\n\n"));
    return;
  }

  const blocks: string[] = [];
  for (const c of list) {
    const own = items.filter((it: any) => it.client_id === c.id);
    if (!own.length) continue;
    blocks.push(`<b>${esc(c.name)}</b>\n\n` + own.map(line).join("\n\n"));
  }
  await send(chatId, "<b>Ваши платежи</b>\n\n" + blocks.join("\n\n———\n\n"));
}

// ---------- загрузка файла из Telegram в Storage ----------

// Бакет принимает только перечисленные типы и только до 10 МБ (миграция
// 20260826000003_storage_limits.sql). Лимиты бакета действуют и на service_role,
// так что бот под них тоже попадает. Проверяем здесь же, до скачивания файла:
// иначе отказ прилетит от Storage уже после закачки, и человек увидит невнятное
// «файл не загрузился» вместо причины.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  jpg:  "image/jpeg",  jpeg: "image/jpeg", png: "image/png",
  heic: "image/heic",  heif: "image/heif", webp: "image/webp",
  pdf:  "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:  "application/vnd.ms-excel",
  doc:  "application/msword",
  rtf:  "application/rtf",
};
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT));

// Telegram присылает mime_type не всегда, и раньше на этот случай подставлялся
// application/octet-stream — бакет такой тип больше не принимает (под ним прошло
// бы что угодно). Определяем тип по расширению; если и оно ни о чём не говорит,
// честно отказываем, а не подписываем файл наугад.
function resolveMime(name: string, declared?: string): string | null {
  if (declared && ALLOWED_MIME.has(declared)) return declared;
  const ext = (name.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

type UploadResult =
  | { ok: true; url: string; name: string }
  | { ok: false; reason: "type" | "size" | "fail" };

async function uploadTelegramFile(
  fileId: string, fallbackName: string, mime?: string, sizeHint?: number,
): Promise<UploadResult> {
  const contentType = resolveMime(fallbackName || "", mime);
  if (!contentType) return { ok: false, reason: "type" };
  if (sizeHint && sizeHint > MAX_FILE_BYTES) return { ok: false, reason: "size" };

  const r1 = await fetch(`https://api.telegram.org/bot${BOT}/getFile?file_id=${fileId}`);
  const j1 = await r1.json();
  if (!j1.ok) return { ok: false, reason: "fail" };
  const filePath: string = j1.result.file_path;
  const r2 = await fetch(`https://api.telegram.org/file/bot${BOT}/${filePath}`);
  const buf = await r2.arrayBuffer();
  // file_size Telegram присылает не всегда — перепроверяем по факту
  if (buf.byteLength > MAX_FILE_BYTES) return { ok: false, reason: "size" };

  const rand = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(rand, b => b.toString(16).padStart(2, "0")).join("");
  const name = (fallbackName || "file").replace(/[^\w.\-]+/g, "_");
  const storagePath = hex + "/" + name;
  const up = await sb.storage.from("files").upload(storagePath, buf, { contentType });
  if (up.error) { console.error(up.error); return { ok: false, reason: "fail" }; }
  const pub = sb.storage.from("files").getPublicUrl(storagePath);
  return { ok: true, url: pub.data.publicUrl, name: fallbackName || "файл" };
}

// ---------- экран подтверждения ----------

function summary(d: Draft) {
  return [
    "<b>Проверьте заявку:</b>", "",
    `💳 Кому: ${esc(d.payee)}`,
    `💰 Сумма: ${fmtMoney(d.amount as number)}`,
    d.requisites ? `🔢 Реквизиты: ${esc(d.requisites)}` : null,
    `📅 Дата: ${fmtDate(d.due as string)}`,
    `🔁 Периодичность: ${esc(recLbl[d.recurrence as string] || d.recurrence)}`,
    d.purpose ? `📝 Назначение: ${esc(d.purpose)}` : null,
    `🧾 Документ после оплаты: ${d.need_receipt ? "да" : "нет"}`,
    d.file_name ? `📎 Файл: ${esc(d.file_name)}` : "📎 Файл: нет",
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

// Те же пределы, что проверяет база (validate_payment_fields, M2.2). Здесь —
// только чтобы сказать о них на этом шаге: иначе человек прошёл бы все восемь
// шагов и получил отказ на «Подтвердить».
const MAX_LEN: Record<string, [number, string]> = {
  payee:      [200,  "Получатель"],
  requisites: [1000, "Реквизиты"],
  purpose:    [1000, "Назначение"],
};

async function routeText(chatId: number, tgId: number, step: string, draft: Draft, text: string) {
  const lim = MAX_LEN[step];
  if (lim && text.length > lim[0]) {
    await send(chatId, `${lim[1]} не длиннее ${lim[0]} символов, а у вас ${text.length}. Сократите и пришлите ещё раз.`);
    return;
  }
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
      if (isFuture(dt) && isWeekend(dt)) {
        await send(chatId, "🚫 В выходной платёж не проводится. Укажите рабочий день (пн–пт).", KB.due);
        return;
      }
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

// ---------- ответ на вопрос бухгалтера ----------

// Ответ уходит через тот же reply_by_token, что и кабинет: лимит частоты,
// проверка токена и запись файла во вложения заявки — всё уже в БД, дублировать
// это в боте не нужно. Сессию НЕ закрываем: человек почти всегда дописывает
// следом («вот счёт» → файл), и второе сообщение терять нельзя.
async function sendReply(
  chatId: number, tgId: number, d: Draft, text: string, file: {url: string; name: string} | null,
) {
  const { error } = await sb.rpc("reply_by_token", {
    p_token: String(d.token ?? ""),
    p_id:    String(d.pid ?? ""),
    p_text:  text ?? "",
    p_files: file ? [file] : [],
  });

  if (error) {
    console.error(error);
    // показываем настоящую причину (закрытая заявка, лимит частоты и т.п.)
    const why = (error as {message?: string}).message || "";
    await send(chatId, why
      ? `Не получилось отправить: ${esc(why)}`
      : "Не получилось отправить ответ. Попробуйте ещё раз.");
    return;
  }

  await setSession(tgId, "reply", d);   // продлеваем режим ответа
  await send(chatId, "Передал бухгалтеру ✅\n\n" +
    "Можно дослать ещё файл или сообщение по этой заявке. Закончить — /cancel");
}

async function submit(chatId: number, tgId: number, token: string, d: Draft) {
  const { data: newId, error } = await sb.rpc("submit_payment", {
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

  if (error) {
    console.error(error);
    // M5.4: черновик НЕ стираем. Раньше сессия чистилась до проверки
    // результата, и лимит частоты или временная ошибка базы уничтожали заявку,
    // которую человек набивал восемь шагов, — «попробуйте ещё раз: /new» с нуля.
    // Оставляем его на экране подтверждения: повторить можно одной кнопкой.
    //
    // Если причина неустранимая (дата на выходной), повтор честно упадёт с той
    // же причиной, и человек отменит сам — это всё равно лучше, чем потерять.
    // Ошибка от самой базы значит, что заявка не записалась: submit_payment
    // пишет одной транзакцией. Остаётся редкий случай, когда связь оборвалась
    // уже ПОСЛЕ записи, — тогда повтор создаст дубль. Он будет виден в очереди,
    // а потерянная заявка не видна никому, поэтому выбираем дубль.
    await setSession(tgId, "confirm", d);
    const why = (error as {message?: string}).message || "";
    await send(chatId,
      (why ? `Не удалось создать заявку: ${esc(why)}` : "Не удалось создать заявку.") +
      "\n\nЧерновик сохранён — нажмите «Подтвердить», чтобы попробовать ещё раз, или отмените.",
      KB.confirm);
    return;
  }

  await clearSession(tgId);
  // M2.4: «сегодня» после 17:00 база переносит на следующий рабочий день.
  // Называем дату, на которую заявка встала на самом деле, а не ту, что выбрал
  // человек, — и говорим о переносе прямо.
  let due = d.due as string;
  if (newId) {
    const { data: row } = await sb.from("payments").select("due").eq("id", newId).maybeSingle();
    if (row?.due) due = row.due;
  }
  const moved = due !== d.due
    ? `\n\n⏭ Рабочий день бухгалтерии закончился (пн–пт до 17:00), поэтому платёж перенесён на ${fmtDate(due)}.`
    : "";
  await send(chatId, `✅ Заявка отправлена бухгалтеру. Платёж «${esc(d.payee)}» на ${fmtDate(due)} в очереди.${moved}\n\nПосмотреть статус: /payments`);
}

// ---------- обработчики ----------

async function handleMessage(msg: any) {
  const chatId = msg.chat.id as number;
  const tgId = chatId;

  // вложение (фото/документ) — на шаге file (новая заявка) или reply (ответ)
  if (msg.photo || msg.document) {
    const list = await getClients(tgId);
    if (list.length === 0) { await send(chatId, NOT_BOUND); return; }
    const session = await getSession(tgId);
    const answering = replyAlive(session);

    // Ответ привязан к конкретной заявке, поэтому фирма известна однозначно —
    // проверку «несколько фирм» здесь применять нельзя, иначе человек с двумя
    // компаниями не сможет прислать счёт.
    if (!answering) {
      if (list.length > 1) { await send(chatId, manyFirms(list)); return; }
      if (!session || session.step !== "file") { await send(chatId, "Чтобы создать заявку: /new"); return; }
    }

    let up: UploadResult;
    if (msg.document) {
      up = await uploadTelegramFile(
        msg.document.file_id, msg.document.file_name || "файл",
        msg.document.mime_type, msg.document.file_size,
      );
    } else {
      const ph = msg.photo[msg.photo.length - 1]; // самый крупный размер
      up = await uploadTelegramFile(ph.file_id, "photo.jpg", "image/jpeg", ph.file_size);
    }
    if (!up.ok) {
      // причина отказа человеку важнее факта отказа: иначе он шлёт то же самое по кругу
      await send(chatId, {
        type: "Такой файл не принимается. Пришлите фото счёта, PDF или документ Word/Excel.",
        size: "Файл больше 10 МБ. Сфотографируйте счёт с меньшим качеством или пришлите PDF.",
        fail: answering
          ? "Файл не загрузился. Попробуйте ещё раз."
          : "Файл не загрузился. Попробуйте ещё раз или нажмите «Пропустить».",
      }[up.reason], answering ? undefined : KB.skip);
      return;
    }

    // Подпись к файлу — это и есть текст ответа: «вот счёт С-2211» люди пишут
    // прямо в подписи, отдельным сообщением слать не будут.
    if (answering) {
      await sendReply(chatId, tgId, session!.draft,
        String(msg.caption ?? "").trim(), { url: up.url, name: up.name });
      return;
    }

    session!.draft.file_url = up.url; session!.draft.file_name = up.name;
    await setSession(tgId, "confirm", session!.draft);
    await showConfirm(chatId, session!.draft);
    return;
  }

  if (!msg.text) return;
  const text = (msg.text as string).trim();

  // привязка по deep-link
  if (text.startsWith("/start")) {
    // M5.2. Фирма привязывается только к личному чату. В группе chat.id —
    // это вся группа: платёжные документы видел бы каждый участник, в том
    // числе добавленный позже, и любой мог бы заводить заявки от имени фирмы.
    // Решение владельца 16.09: новые привязки к группам запрещены. Уже
    // привязанные группы не трогаем — они продолжают работать.
    // Проверка стоит до поиска по токену: в группе не отвечаем даже тем,
    // живая ли ссылка.
    if (msg.chat.type !== "private") {
      await send(chatId, "Привязать фирму можно только в личном чате с ботом, не в группе: " +
        "иначе платёжные документы увидят все участники.\n\n" +
        "Откройте персональную ссылку от бухгалтера сами — бот откроется в личном чате — и нажмите «Старт».");
      return;
    }
    const token = text.split(/\s+/)[1];
    if (!token) { await send(chatId, "Привет! Откройте персональную ссылку от бухгалтера и нажмите «Старт»."); return; }

    // Порядок здесь принципиален. Раньше привязка сначала снималась, и только
    // потом искался клиент по токену — если токен оказывался недействительным
    // (например, открыта старая ссылка после перевыпуска), человек оставался
    // вообще без привязки и молча переставал получать уведомления. Так у одного
    // клиента уведомления пропали почти на месяц, и заметил это только он сам.
    // Поэтому: сперва убеждаемся, что токен живой, и лишь затем трогаем привязки.
    const { data: target, error: findErr } = await sb
      .from("clients").select("id,name,telegram_id").eq("token", token).maybeSingle();

    if (findErr || !target) {
      await send(chatId, "Ссылка недействительна. Обратитесь к бухгалтеру.\n\nПрежняя привязка сохранена — уведомления продолжат приходить.");
      return;
    }

    // Привязку с других фирм НЕ снимаем. Раньше снимали — из-за этого человек,
    // ведущий две компании, физически не мог получать уведомления по обеим:
    // вторая ссылка отключала первую. Несколько фирм на одном чате база
    // допускает (на clients.telegram_id обычный индекс, не уникальный), а
    // уведомления идут от заявки к фирме и от множественности не страдают.
    const { error: bindErr } = await sb
      .from("clients").update({ telegram_id: chatId }).eq("id", target.id);

    if (bindErr) {
      await send(chatId, "Не удалось привязать аккаунт. Попробуйте ещё раз или напишите бухгалтеру.");
      return;
    }

    // M5.1. У фирмы одна привязка, и новый /start по той же ссылке её
    // перезаписывает. Раньше прежний человек ни о чём не узнавал: коллега
    // директора, пересланное сообщение или утёкшая ссылка — и директор молча
    // переставал получать «оплачено» и документы, а получал их кто-то другой.
    // Это тот же класс, что инцидент «месяц без уведомлений», только с другой
    // стороны.
    //
    // Перепривязку не запрещаем и подтверждения не спрашиваем: сменить телефон
    // или передать фирму коллеге — законное дело, и держать человека без
    // уведомлений до ответа прежнего владельца было бы хуже. Но прежний владелец
    // обязан узнать, что это произошло, — тогда утечку ссылки заметят за минуту,
    // а не через месяц.
    if (target.telegram_id && Number(target.telegram_id) !== chatId) {
      await send(Number(target.telegram_id),
        `⚠️ Фирма «${esc(target.name)}» привязана к другому аккаунту Telegram.\n\n` +
        "Уведомления по ней теперь приходят туда, а сюда больше не придут.\n\n" +
        "Если это сделали не вы или не по вашей просьбе — сообщите бухгалтеру: " +
        "он перевыпустит ссылку, и чужая привязка отпадёт.");
    }

    const list = await getClients(chatId);
    if (list.length > 1) {
      await send(chatId,
        `Готово! Фирма «${esc(target.name)}» привязана.\n\n` +
        `Теперь уведомления приходят по ${list.length} фирмам: ` +
        list.map((c) => `«${esc(c.name)}»`).join(", ") + ".\n\n" +
        "Заявки заводите по персональной ссылке нужной фирмы — так она точно не уйдёт не на ту компанию.");
    } else {
      await send(chatId, `Готово! Аккаунт «${esc(target.name)}» привязан.\n\n${HELP}`);
    }
    return;
  }
  if (text === "/help") { await send(chatId, HELP); return; }
  if (text === "/myid") { await send(chatId, `Ваш chat_id: <code>${chatId}</code>`); return; }

  const list = await getClients(tgId);
  if (list.length === 0) { await send(chatId, NOT_BOUND); return; }

  // «Мои платежи» работает и с несколькими фирмами: это чтение, перепутать
  // ничего нельзя, а человеку с двумя компаниями список нужен как раз целиком.
  if (text === "/payments" || /мои платеж/i.test(text)) {
    await sendPayments(chatId, list);
    return;
  }

  // Ответ на вопрос бухгалтера. Стоит ДО проверки «несколько фирм»: заявка
  // указана в самой кнопке «Ответить», поэтому фирма известна однозначно —
  // в отличие от /new, где выбрать её не из чего.
  const answering = await getSession(tgId);
  if (replyAlive(answering)) {
    if (text === "/cancel") {
      await clearSession(tgId);
      await send(chatId, "Хорошо, больше ничего по этой заявке не передаю.");
      return;
    }
    if (!text.startsWith("/")) {
      await sendReply(chatId, tgId, answering!.draft, text, null);
      return;
    }
    // остальные команды выводят из режима ответа и работают как обычно
    await clearSession(tgId);
  }

  // Всё остальное — диалог заведения заявки, он требует одной конкретной фирмы.
  if (list.length > 1) { await send(chatId, manyFirms(list)); return; }

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

  const list = await getClients(tgId);

  // «✍️ Ответить» под вопросом бухгалтера.
  //
  // Разбирается ПЕРВОЙ и до всех проверок ниже. Двух причин достаточно:
  // проверка «несколько фирм» здесь неуместна (заявка названа в самой кнопке),
  // а проверка «сессия не найдена» отсекла бы кнопку под вчерашним вопросом —
  // именно тогда по ней и жмут.
  //
  // Заявку ищем сами и сверяем с фирмами этого чата: бот ходит в базу под
  // service_role, RLS его не остановит, так что чужой id из подделанного
  // callback_data пустил бы человека в чужую переписку.
  if (data.startsWith("reply:")) {
    if (list.length === 0) { await send(chatId, NOT_BOUND); return; }
    const pid = data.slice(6);
    const { data: pay } = await sb
      .from("payments").select("id,client_id,payee,status").eq("id", pid).maybeSingle();
    const own = pay ? list.find((c) => c.id === pay.client_id) : null;

    if (!pay || !own) { await send(chatId, "Заявка не найдена. Напишите бухгалтеру напрямую."); return; }
    if (pay.status === "sent") { await send(chatId, "Эта заявка уже закрыта — ответить по ней нельзя."); return; }

    await setSession(tgId, "reply", { pid: pay.id, token: own.token, payee: pay.payee });
    await send(chatId,
      `✍️ Напишите ответ по заявке «${esc(pay.payee)}» — текстом, файлом или тем и другим сразу.\n\n` +
      "Фото или PDF счёта можно прислать прямо сюда. Передумали — /cancel");
    return;
  }

  // Кнопка могла прилететь из старого сообщения — например, человек начал
  // заявку одной фирмой, а потом привязал вторую. Заявку от имени наугад
  // выбранной фирмы отправлять нельзя, поэтому здесь та же проверка.
  if (list.length > 1) { await clearSession(tgId); await send(chatId, manyFirms(list)); return; }
  const client = list[0];
  const session = await getSession(tgId);
  if (!client || !session) { await send(chatId, "Сессия не найдена. Начните заново: /new"); return; }
  const d = session.draft;

  if (data.startsWith("due:") && session.step === "due") {
    const picked = data === "due:today"
      ? isoLocal(minskNow())
      : isoLocal((() => { const x = minskNow(); x.setUTCDate(x.getUTCDate()+1); return x; })());
    // «Сегодня» в выходной сервер сам перенесёт; «Завтра» на сб/вс — не примет
    if (isFuture(picked) && isWeekend(picked)) {
      await send(chatId, "🚫 Завтра выходной — платёж не проводится. Укажите рабочий день (пн–пт) в формате ДД.ММ.ГГГГ.");
      return;
    }
    d.due = picked;
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
