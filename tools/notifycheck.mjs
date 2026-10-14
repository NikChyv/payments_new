// Проверяет подпись «чьё это» в мгновенных уведомлениях сотрудникам, когда у
// двух бухгалтеров один Telegram на двоих (13.10): «новая заявка», «клиент
// ответил», «клиент изменил заявку».
//
// Зачем отдельный скрипт: кому и чьё сообщение, решает база, и это покрыто
// pgTAP (shared_telegram_test.sql). Но сам текст собирают две Edge Functions,
// и до Telegram с фиктивным токеном он не доходит — увидеть, что в заголовке
// действительно стоит имя и что админу оно не приписано, больше негде. Здесь
// на месте Telegram заглушка, которая запоминает всё отправленное.
//
// Как запускать (из корня репозитория):
//   supabase start
//   в файл окружения (вне репозитория):
//     TELEGRAM_BOT_TOKEN=000000:FAKE
//     TELEGRAM_API=http://host.docker.internal:18390
//   supabase functions serve --env-file <абсолютный путь> --no-verify-jwt
//   node tools/notifycheck.mjs
//
// Живых данных не трогает: заводит своих сотрудников и клиентов и убирает их.
// Заявок в базу не пишет — функциям передаётся запись, как её прислал бы вебхук.

import http from "node:http";
import { API, SRV, arg } from "./stand.mjs";

const TG_PORT = Number(arg("tg-port", 18390));
const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
const SHARED = "990001", OWN = "990002", ADMIN = "990009";

const fails = [];
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails.push(msg); };

// ---------- заглушка Telegram ----------

let sent = [];   // { chat_id, text }
const tg = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => raw += c);
  req.on("end", () => {
    if (req.url.endsWith("/sendMessage")) { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => tg.listen(TG_PORT, "0.0.0.0", r));

// ---------- стенд ----------

const rest = (path, init = {}) => fetch(`${API}/rest/v1/${path}`, { headers: H, ...init });
const fn = async (name, body) => {
  sent = [];
  const r = await fetch(`${API}/functions/v1/${name}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return r.status;
};
// первая строка сообщения, ушедшего в этот чат
const title = (chat) => (sent.find((m) => m.chat_id === chat)?.text ?? "").split("\n")[0];

const people = [
  { key: "val", name: "Валентина",       admin: false, tg: SHARED },
  { key: "el",  name: "Елена <Е>",       admin: false, tg: SHARED },   // «<» — имя обязано уйти экранированным
  { key: "tat", name: "Татьяна",         admin: false, tg: OWN },
  { key: "adm", name: "Админ проверки",  admin: true,  tg: ADMIN },
];
const firms = [
  { id: "c0ffee00-0000-0000-0000-00000000000a", name: "Фирма Валентины", staff: "val" },
  { id: "c0ffee00-0000-0000-0000-00000000000b", name: "Фирма Елены",     staff: "el" },
  { id: "c0ffee00-0000-0000-0000-00000000000c", name: "Фирма Татьяны",   staff: "tat" },
];

const cleanup = async () => {
  await rest(`clients?id=in.(${firms.map((f) => f.id).join(",")})`, { method: "DELETE" });
  const list = await (await fetch(`${API}/auth/v1/admin/users?per_page=200`, { headers: H })).json();
  for (const u of list.users ?? []) {
    if (!/^notifycheck-/.test(u.email ?? "")) continue;
    await rest(`staff?id=eq.${u.id}`, { method: "DELETE" });
    await fetch(`${API}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: H });
  }
};

const record = (firm, extra = {}) => ({
  id: "notifycheck-1", client_id: firm.id, client: firm.name, payee: "Белтелеком", amount: 184.5,
  due: "2026-10-14", recurrence: "once", need_receipt: false, status: "new", files: [], thread: [],
  purpose: null, requisites: null, ...extra,
});

try {
  await cleanup();
  for (const p of people) {
    const r = await fetch(`${API}/auth/v1/admin/users`, { method: "POST", headers: H,
      body: JSON.stringify({ email: `notifycheck-${p.key}@local.test`, password: "local12345", email_confirm: true }) });
    p.id = (await r.json()).id;
    if (!p.id) throw new Error("не завёлся пользователь " + p.key);
    await rest("staff", { method: "POST", body: JSON.stringify({ id: p.id, name: p.name, is_admin: p.admin, telegram_id: Number(p.tg) }) });
  }
  for (const f of firms) {
    await rest("clients", { method: "POST", body: JSON.stringify({
      id: f.id, name: f.name, token: "notifycheck" + f.id.slice(-1), staff_id: people.find((p) => p.key === f.staff).id }) });
  }
  const [fVal, fEl, fTat] = firms;

  console.log("Новая заявка");
  await fn("notify-payment", { type: "INSERT", record: record(fEl) });
  ok(title(SHARED) === "📋 <b>Новая заявка на оплату · Елена &lt;Е&gt;</b>", "клиент Елены — в общий чат с её именем, имя экранировано");
  ok(title(ADMIN) === "📋 <b>Новая заявка на оплату</b>", "админу то же сообщение — без имени");
  ok(sent.filter((m) => m.chat_id === SHARED).length === 1, "в общий чат сообщение одно, не по числу учёток");
  ok(!sent.some((m) => m.chat_id === OWN), "чужому бухгалтеру не ушло");
  ok(/👤 Клиент: Фирма Елены\n💳 Кому: Белтелеком/.test(sent.find((m) => m.chat_id === SHARED)?.text ?? ""), "остальной текст на месте, сразу под заголовком");

  await fn("notify-payment", { type: "INSERT", record: record(fVal) });
  ok(title(SHARED) === "📋 <b>Новая заявка на оплату · Валентина</b>", "клиент Валентины — в тот же чат, с её именем");

  await fn("notify-payment", { type: "INSERT", record: record(fTat) });
  ok(title(OWN) === "📋 <b>Новая заявка на оплату</b>", "у Татьяны Telegram свой — заголовок прежний");

  console.log("Клиент ответил");
  const reply = { thread: [{ who: "client", kind: "reply", text: "вот счёт" }], staff_thread_notified: 0, client_thread_notified: 0 };
  await fn("notify-client", { type: "UPDATE", record: record(fEl, reply), old_record: record(fEl) });
  ok(title(SHARED) === "💬 <b>Клиент ответил по заявке · Елена &lt;Е&gt;</b>", "в общий чат — с именем");
  ok(title(ADMIN) === "💬 <b>Клиент ответил по заявке</b>", "админу — без имени");
  ok(/«вот счёт»/.test(sent.find((m) => m.chat_id === SHARED)?.text ?? ""), "сам ответ клиента в сообщении");
  await fn("notify-client", { type: "UPDATE", record: record(fTat, reply), old_record: record(fTat) });
  ok(title(OWN) === "💬 <b>Клиент ответил по заявке</b>", "у Татьяны — заголовок прежний");

  console.log("Клиент изменил заявку");
  const edit = { payee: "Белтелеком-2", last_edit_role: "anon" };
  await fn("notify-client", { type: "UPDATE", record: record(fVal, edit), old_record: record(fVal) });
  ok(title(SHARED) === "✏️ <b>Клиент изменил заявку · Валентина</b>", "в общий чат — с именем");
  ok(title(ADMIN) === "✏️ <b>Клиент изменил заявку</b>", "админу — без имени");
  ok(/Получатель: Белтелеком → <b>Белтелеком-2<\/b>/.test(sent.find((m) => m.chat_id === SHARED)?.text ?? ""), "список изменений на месте");

  console.log("Общий Telegram перестал быть общим");
  await rest(`staff?id=eq.${people[1].id}`, { method: "PATCH", body: JSON.stringify({ telegram_id: 990003 }) });
  await fn("notify-payment", { type: "INSERT", record: record(fVal) });
  ok(title(SHARED) === "📋 <b>Новая заявка на оплату</b>", "Елена завела свой Telegram — имя у Валентины пропало само");
} finally {
  await cleanup();
  tg.close();
}

console.log();
if (fails.length) { console.log(`Провалено проверок: ${fails.length}`); process.exit(1); }
console.log("Все проверки пройдены.");
