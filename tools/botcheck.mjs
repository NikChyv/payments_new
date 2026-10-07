// Проверяет бота на пути «прислал файл — заявка создана» (решение 07.10):
// файл без команды сразу становится заявкой, при нескольких фирмах бот
// спрашивает фирму кнопкой, а открытый ответ бухгалтеру и диалог /new файл
// по-прежнему забирают себе.
//
// Зачем отдельный скрипт: бот ходит в Telegram за самим файлом, и с фиктивным
// токеном этот путь не проходится вовсе — bind_test.sh его не видит. Здесь на
// месте Telegram стоит заглушка: она отдаёт «файл», запоминает, что бот
// ответил, и, как настоящий Telegram, не даёт снять кнопки с сообщения дважды
// (на этом держится защита от двойного нажатия).
//
// Как запускать (из корня репозитория):
//   supabase start
//   в файл окружения (вне репозитория):
//     TELEGRAM_BOT_TOKEN=000000:FAKE
//     TG_WEBHOOK_SECRET=localsecret
//     TELEGRAM_API=http://host.docker.internal:18390
//   supabase functions serve telegram-bot --env-file <абсолютный путь> --no-verify-jwt
//   node tools/botcheck.mjs
//
// Живых данных не трогает: привязки фирм из seed.sql возвращает как были,
// свои заявки находит по имени файла и подписи и удаляет.

import http from "node:http";
import { API, SRV, arg } from "./stand.mjs";

const FN      = arg("fn", `${API}/functions/v1/telegram-bot`);
const SECRET  = arg("secret", "localsecret");
const TG_PORT = Number(arg("tg-port", 18390));

const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
const ROM = "11111111-0000-0000-0000-000000000001";   // ООО «Ромашка», demotoken1
const SMI = "11111111-0000-0000-0000-000000000002";   // ИП Смирнов, demotoken2
const CHAT = 556001, STRANGER = 556002, GROUP = -100556003;
const MARK = "botcheck";

const fails = [];
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails.push(msg); };

// ---------- заглушка Telegram ----------

const sent = [];              // всё, что бот отправил: { chat_id, text, reply_markup, reply_to_message_id, message_id }
const stripped = new Set();   // сообщения, с которых кнопки уже сняты
let botMsgId = 9000;

const tg = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => raw += c);
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const body = raw ? JSON.parse(raw) : {};

    if (url.pathname.startsWith("/file/")) {
      // Содержимое — заголовок PDF: бакету важен объявленный тип, а не то, что внутри.
      res.writeHead(200); res.end(Buffer.from("%PDF-1.4\n% botcheck\n")); return;
    }
    const method = url.pathname.split("/").pop();
    if (method === "getFile") {
      const id = url.searchParams.get("file_id");
      return id === "gone" ? json(400, { ok: false }) : json(200, { ok: true, result: { file_path: "documents/" + id } });
    }
    if (method === "sendMessage") {
      const m = { ...body, message_id: ++botMsgId };
      sent.push(m);
      return json(200, { ok: true, result: { message_id: m.message_id } });
    }
    if (method === "editMessageReplyMarkup") {
      const key = body.chat_id + ":" + body.message_id;
      if (stripped.has(key)) return json(400, { ok: false, description: "Bad Request: message is not modified" });
      stripped.add(key);
      return json(200, { ok: true });
    }
    return json(200, { ok: true });   // answerCallbackQuery и прочее
  });
});
await new Promise((r) => tg.listen(TG_PORT, "0.0.0.0", r));

// ---------- что шлём боту ----------

let userMsgId = 100;
const post = (update) => fetch(FN, {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
  body: JSON.stringify(update),
});
// Возвращает само сообщение: под вопросом «от какой фирмы?» оно нужно целиком.
const message = async (chat, fields, type = "private") => {
  const msg = { message_id: ++userMsgId, chat: { id: chat, type }, from: { id: CHAT }, ...fields };
  await post({ message: msg });
  return msg;
};
const text = (t, chat = CHAT) => message(chat, { text: t });
const doc = (name, extra = {}, chat = CHAT, type = "private") => message(chat, {
  document: { file_id: "f" + userMsgId, file_name: name, mime_type: "application/pdf", file_size: 2048 }, ...extra,
}, type);
const photo = (extra = {}, chat = CHAT, type = "private") => message(chat, {
  photo: [{ file_id: "small", file_size: 900 }, { file_id: "big", file_size: 90000 }], ...extra,
}, type);
const press = (data, botMessage, chat = CHAT) => post({ callback_query: {
  id: "cb" + (++userMsgId), data, from: { id: chat },
  message: { chat: { id: chat, type: "private" }, ...botMessage },
} });
const lastSent = () => sent[sent.length - 1] ?? {};

// ---------- база ----------

const rest = (path, init = {}) => fetch(`${API}/rest/v1/${path}`, { headers: H, ...init });
const mine = async () => (await rest(
  `payments?or=(file_name.like.${MARK}*,purpose.like.${MARK}*)&select=*&order=created_at`)).json();
const cleanup = () => rest(`payments?or=(file_name.like.${MARK}*,purpose.like.${MARK}*)`, { method: "DELETE" });
const bind = (id, chat) => rest(`clients?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ telegram_id: chat }) });
const session = async () => (await (await rest(`tg_sessions?telegram_id=eq.${CHAT}&select=*`)).json())[0] ?? null;
const setSession = (step, draft, updated_at = new Date().toISOString()) => rest("tg_sessions", {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({ telegram_id: CHAT, step, draft, updated_at }),
});
const dropSession = () => rest(`tg_sessions?telegram_id=eq.${CHAT}`, { method: "DELETE" });

const todayMinsk = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk" }).format(new Date());
const nearest = await (await rest("rpc/adjust_due_date", { method: "POST", body: JSON.stringify({ p_due: todayMinsk }) })).json();

const before = await (await rest(`clients?id=in.(${ROM},${SMI})&select=id,telegram_id`)).json();
const restore = async () => {
  for (const c of before) await bind(c.id, c.telegram_id);
  await dropSession(); await cleanup();
};

try {
  await cleanup(); await dropSession();
  // лимит частоты считается по токену — прошлый прогон минуту назад не должен ронять этот
  await rest("rpc_rate_limit?key=in.(demotoken1,demotoken2)", { method: "DELETE" });
  await bind(ROM, CHAT); await bind(SMI, null);

  console.log("Одна фирма: файл без команды");
  await doc(`${MARK}-1.pdf`);
  let rows = await mine();
  ok(rows.length === 1, "PDF без команды — заявка создана сразу");
  ok(rows[0]?.payee === `По документу: ${MARK}-1.pdf`, "получатель назван по файлу");
  ok(rows[0]?.amount === null, "сумма пустая, а не ноль");
  ok(rows[0]?.due === nearest, `дата — ближайший рабочий день (${nearest})`);
  ok(rows[0]?.client_id === ROM && rows[0]?.status === "new", "заявка у своей фирмы, статус «принята»");
  ok(rows[0]?.files?.length === 1 && /^https?:/.test(rows[0]?.file_url ?? ""), "файл приложен, зеркало file_url заполнено");
  ok(rows[0]?.recurrence === "once" && rows[0]?.need_receipt === false, "разовый, документ после оплаты не запрошен");
  ok(/Заявка по файлу/.test(lastSent().text ?? "") && !lastSent().reply_markup, "бот подтвердил, кнопок не прислал");
  ok(await session() === null, "черновика не осталось");

  await photo({ caption: `${MARK} аренда за октябрь` });
  rows = await mine();
  ok(rows.length === 2 && rows[1]?.payee === "По документу: photo.jpg", "фото — тоже заявка");
  ok(rows[1]?.purpose === `${MARK} аренда за октябрь`, "подпись к фото ушла в назначение");

  await doc(`${MARK}-fwd.pdf`, { forward_origin: { type: "user", sender_user: { id: 777 } }, forward_date: 1 });
  ok((await mine()).length === 3, "пересланный файл — заявка");

  await message(CHAT, { document: { file_id: "z", file_name: `${MARK}.zip`, mime_type: "application/zip", file_size: 10 } });
  ok((await mine()).length === 3 && /не принимается/.test(lastSent().text), "архив — отказ с причиной, заявки нет");
  await doc(`${MARK}-big.pdf`, { document: { file_id: "b", file_name: `${MARK}-big.pdf`, mime_type: "application/pdf", file_size: 11 * 1024 * 1024 } });
  ok((await mine()).length === 3 && /больше 10 МБ/.test(lastSent().text), "файл больше 10 МБ — отказ с причиной, заявки нет");
  await doc(`${MARK}-gone.pdf`, { document: { file_id: "gone", file_name: `${MARK}-gone.pdf`, mime_type: "application/pdf", file_size: 10 } });
  ok((await mine()).length === 3 && /не загрузился/.test(lastSent().text), "Telegram не отдал файл — заявки нет, бот сказал об этом");

  console.log("Одна фирма: файл и диалог /new");
  await text("/new"); await text("Получатель из диалога");
  ok((await session())?.step === "amount", "диалог дошёл до суммы");
  await doc(`${MARK}-mid.pdf`);
  rows = await mine();
  ok(rows.length === 4 && rows[3]?.payee === `По документу: ${MARK}-mid.pdf`, "файл посреди /new — заявка по документу");
  ok(await session() === null && /сбросил/.test(lastSent().text), "незаконченный черновик сброшен, бот об этом сказал");

  await text("/new"); await text("Поставщик botcheck"); await text("150,50");
  await press("skip", { message_id: 1 });            // реквизиты
  await press("due:today", { message_id: 1 });
  await press("rec:once", { message_id: 1 });
  await press("skip", { message_id: 1 });            // назначение
  await press("nr:0", { message_id: 1 });
  let s = await session();
  ok(s?.step === "file", "диалог /new дошёл до шага с файлом");
  await doc(`${MARK}-step.pdf`);
  s = await session();
  ok(s?.step === "confirm" && s?.draft?.file_name === `${MARK}-step.pdf` && (await mine()).length === 4,
    "файл на шаге файла — в черновик, заявка ждёт подтверждения");
  await doc(`${MARK}-step2.pdf`);
  s = await session();
  ok(s?.step === "confirm" && s?.draft?.file_name === `${MARK}-step2.pdf` && (await mine()).length === 4,
    "файл на экране подтверждения — заменил прежний, заявки ещё нет");
  await press("ok", { message_id: 1 });
  rows = await mine();
  ok(rows.length === 5 && rows[4]?.payee === "Поставщик botcheck" && Number(rows[4]?.amount) === 150.5
    && rows[4]?.file_name === `${MARK}-step2.pdf`, "«Подтвердить» — заявка с полями из диалога и вторым файлом");

  await setSession("file", { payee: "Старый черновик", amount: 1 }, new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  await doc(`${MARK}-stale.pdf`);
  rows = await mine();
  ok(rows.length === 6 && rows[5]?.payee === `По документу: ${MARK}-stale.pdf` && await session() === null,
    "брошенный два часа назад черновик файл не перехватил — заявка по документу");

  console.log("Одна фирма: ответ бухгалтеру, группа, чужой чат");
  const target = rows[0];
  await setSession("reply", { pid: target.id, token: "demotoken1", payee: target.payee });
  await doc(`${MARK}-reply.pdf`, { caption: "вот счёт" });
  rows = await mine();
  const after = rows.find((r) => r.id === target.id);
  ok(rows.length === 6, "файл при открытом ответе — новой заявки нет");
  ok(after?.files?.length === 2 && /Передал бухгалтеру/.test(lastSent().text), "файл лёг во вложения той заявки, по которой отвечали");
  await dropSession();

  await bind(SMI, GROUP);
  let n = sent.length;
  await photo({ caption: `${MARK} группа` }, GROUP, "supergroup");
  ok((await mine()).length === 6 && /\/new/.test(sent[n]?.text ?? ""), "фото в группе заявкой не становится");
  await bind(SMI, null);

  await photo({ caption: `${MARK} чужой` }, STRANGER);
  ok((await mine()).length === 6 && /не привязаны/.test(lastSent().text), "непривязанный чат — заявки нет");

  console.log("Две фирмы: выбор кнопкой");
  await bind(SMI, CHAT);
  const asked = await doc(`${MARK}-two.pdf`, { caption: `${MARK} две фирмы` });
  const q = lastSent();
  const buttons = (q.reply_markup?.inline_keyboard ?? []).flat();
  ok((await mine()).length === 6, "файл при двух фирмах — заявки пока нет");
  ok(buttons.length === 2 && buttons.some((b) => b.callback_data === "firm:" + SMI) && buttons.some((b) => b.callback_data === "firm:" + ROM),
    "бот спросил фирму двумя кнопками");
  ok(q.reply_to_message_id === asked.message_id, "вопрос — ответом на сам файл");
  ok(await session() === null, "черновика под вопрос не заведено");

  const question = { message_id: q.message_id, reply_to_message: asked };
  await press("firm:" + SMI, question);
  rows = await mine();
  ok(rows.length === 7 && rows[6]?.client_id === SMI && rows[6]?.client === "ИП Смирнов", "нажал фирму — заявка у неё");
  ok(rows[6]?.purpose === `${MARK} две фирмы` && rows[6]?.payee === `По документу: ${MARK}-two.pdf`, "файл и подпись взяты из исходного сообщения");
  ok(/ИП Смирнов/.test(lastSent().text), "бот назвал фирму в подтверждении");

  await press("firm:" + SMI, question);
  await press("firm:" + ROM, question);
  ok((await mine()).length === 7, "повторное нажатие (той же и другой кнопки) второй заявки не создало");

  const asked2 = await doc(`${MARK}-two2.pdf`);
  const q2 = lastSent();
  await press("firm:11111111-0000-0000-0000-00000000dead", { message_id: q2.message_id, reply_to_message: asked2 });
  ok((await mine()).length === 7, "чужая фирма в кнопке — заявки нет");
  await press("firm:" + ROM, { message_id: q2.message_id });
  ok((await mine()).length === 7 && /Не нашёл файл/.test(lastSent().text), "исходное сообщение удалено — заявки нет, бот просит прислать ещё раз");
  await press("firm:" + ROM, { message_id: q2.message_id, reply_to_message: asked2 });
  rows = await mine();
  ok(rows.length === 8 && rows[7]?.client_id === ROM, "после неудач та же кнопка всё ещё работает");

  n = sent.length;
  await message(CHAT, { document: { file_id: "z", file_name: `${MARK}.zip`, mime_type: "application/zip", file_size: 10 } });
  ok(/не принимается/.test(sent[n]?.text ?? "") && !sent[n]?.reply_markup, "негодный файл при двух фирмах — отказ сразу, без вопроса о фирме");

  await text("/new");
  ok(await session() === null && /пришлите сюда фото или файл/.test(lastSent().text), "/new при двух фирмах — бот отправляет на файл");
} finally {
  await restore();
  tg.close();
}

console.log();
if (fails.length) { console.log(`Провалено проверок: ${fails.length}`); process.exit(1); }
console.log("Все проверки пройдены.");
