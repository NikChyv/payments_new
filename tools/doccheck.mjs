// Проверяет заявку «по документу»: с приложенным файлом получатель, сумма и
// дата необязательны (решение 05.10, миграция 20261005000001) — кнопками в
// браузере, с записью в локальную базу и сверкой того, что записалось.
//
// Зачем отдельный скрипт: правило держится на трёх местах сразу — форма
// снимает `required`, когда файл выбран, база проверяет «либо поля, либо
// документ», а экраны показывают заявку без суммы. Разойтись они могут молча:
// форма пропустит пустую заявку без файла, файл не загрузится и заявка уйдёт
// без ничего, или в очереди вместо «в документе» встанет «0,00».
//
//   supabase start
//   node tools/doccheck.mjs
//
// Сценарий: клиент без файла (форма не пускает) → с файлом и пустыми полями
// (заявка названа по файлу, сумма пустая, дата — ближайший рабочий день) →
// файл не того типа (заявка не уходит) → правка: убрал файл — поля снова
// обязательны → бухгалтер: «в документе» в очереди, части не предлагаются,
// «Оплачено» работает → правка суммы → бухгалтер заводит заявку по документу.
// Живых данных не трогает: свои заявки помечает назначением и удаляет.

import { API, ANON, SRV, STAFF, TOKEN, sleep, serve, ensureStaff, cdp, launchChrome } from "./stand.mjs";

const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
const ROM = "11111111-0000-0000-0000-000000000001";
const MARK = "doccheck";   // назначение платежа — по нему находим и убираем своё

const mine = async () => (await fetch(
  `${API}/rest/v1/payments?purpose=eq.${MARK}&select=*&order=created_at`, { headers: H })).json();
const cleanup = () => fetch(`${API}/rest/v1/payments?purpose=eq.${MARK}`, { method: "DELETE", headers: H });

// «Сегодня» по Минску и дата, на которую сервер ставит заявку без даты
const todayMinsk = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk" }).format(new Date());
const nearest = await (await fetch(`${API}/rest/v1/rpc/adjust_due_date`,
  { method: "POST", headers: H, body: JSON.stringify({ p_due: todayMinsk }) })).json();

const fails = [];
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails.push(msg); };

const server = await serve();
await ensureStaff();
await cleanup();

const chrome = launchChrome("doccheck-chrome");
try {
  const { ws, send, waitFor, problems } = await cdp();
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  const base = `http://localhost:${server.port}/app/`;
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) problems.push("EVAL: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  };
  const go = async (url, settle = 2500) => {
    const done = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url }); await done; await sleep(settle);
  };
  const toast = () => ev(`document.getElementById('toast').textContent`);
  // Файл в поле кладём как человек — через сам input, с событием change.
  // Содержимое — заголовок PDF: бакету важен тип, а не то, что внутри.
  const attach = (name, type) => ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([37,80,68,70,45,49,46,52,10])], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const i = document.getElementById('fileInput'); i.files = dt.files;
    i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const fill = (vals) => ev(`(() => { const f = document.getElementById('payForm');
    const v = ${JSON.stringify(vals)}; for (const k in v) f[k].value = v[k];
    f.due.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const formState = () => ev(`(() => { const f = document.getElementById('payForm');
    const star = f.querySelector('.req.doc-opt');
    return { req: [f.payee.required, f.amount.required, f.due.required], valid: f.checkValidity(),
             star: getComputedStyle(star).display !== 'none',
             note: document.getElementById('docNote').textContent }; })()`);
  const submit = async () => { await ev(`document.getElementById('payForm').requestSubmit()`); await sleep(3500); };

  // ------------------------------------------------------------------ клиент
  console.log("Клиент, без файла:");
  await go(`${base}?t=${TOKEN}`);
  await ev(`document.getElementById('tabForm').click()`); await sleep(400);
  await fill({ payee: "", amount: "", due: "", purpose: MARK });
  let st = await formState();
  ok(st.req.every(Boolean) && st.star, "получатель, сумма и дата обязательны, звёздочки на месте");
  ok(st.valid === false, "пустую заявку без файла форма не отправляет");
  ok(/Приложите счёт/.test(st.note), `подсказка под файлами: «${st.note}»`);

  console.log("\nКлиент, файл приложен, поля пустые:");
  await attach("dc-schet.pdf", "application/pdf");
  st = await formState();
  ok(st.req.every((x) => x === false) && !st.star, "поля стали необязательными, звёздочки пропали");
  ok(st.valid === true && /Документ приложен/.test(st.note), `форма готова к отправке: «${st.note}»`);
  await submit();
  let list = await mine();
  let r = list[0];
  ok(list.length === 1, `заявка записана (в базе ${list.length})`);
  ok(r && r.payee === "По документу: dc-schet.pdf", `получатель — по имени файла: «${r && r.payee}»`);
  ok(r && r.amount === null, `сумма пустая, а не ноль (в базе ${r && JSON.stringify(r.amount)})`);
  ok(r && r.due === nearest, `дата — ближайший рабочий день: ${r && r.due} (ждали ${nearest})`);
  ok(r && Array.isArray(r.files) && r.files.length === 1 && r.files[0].name === "dc-schet.pdf", "файл лёг в заявку");
  const card = await ev(`(() => { const c = [...document.querySelectorAll('.c-card')]
    .find(x => x.textContent.includes('dc-schet.pdf')); return c ? c.textContent : ''; })()`);
  ok(/сумма в документе/.test(card), "в кабинете у заявки «сумма в документе», а не 0,00 Br");
  const okMsg = await ev(`document.getElementById('clOk').textContent`);
  ok(/По документу: dc-schet\.pdf/.test(okMsg) && !/перенесена/.test(okMsg), `клиенту сказали: «${okMsg}»`);
  const docId = r && r.id;

  console.log("\nКлиент, файл не того типа и пустые поля:");
  await ev(`document.getElementById('tabForm').click()`); await sleep(400);
  await fill({ payee: "", amount: "", due: "", purpose: MARK });
  await attach("dc-virus.exe", "application/x-msdownload");
  await submit();
  ok((await mine()).length === 1, "заявка без документа и без данных не ушла");
  ok(/Без документа нужны/.test(await toast()), `клиенту сказали: «${await toast()}»`);
  st = await formState();
  ok(st.req.every(Boolean), "негодный файл убран из формы — поля снова обязательны");

  console.log("\nКлиент правит заявку и убирает документ:");
  await go(`${base}?t=${TOKEN}`);
  await ev(`document.querySelector('button[data-edit="${docId}"]').click()`); await sleep(500);
  st = await formState();
  ok(st.req.every((x) => x === false), "файл на месте — поля необязательны и при правке");
  await ev(`document.querySelector('#fileList button[data-rmfile]').click()`); await sleep(300);
  st = await formState();
  ok(st.req.every(Boolean) && st.valid === false, "убрал файл — без суммы форма не сохраняет");

  // --------------------------------------------------------------- бухгалтер
  console.log("\nБухгалтер, очередь:");
  await go(base, 1500);
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
  })()`);
  const open = async () => {
    await go(base, 3000);
    await ev(`(() => { window.confirm = () => true;
      document.querySelector('#qFilters button[data-f=""]').click();
      const s = document.getElementById('fStatus'); s.value = 'all';
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
  };
  await open();
  const cell = await ev(`(document.querySelector('.qr[data-id="${docId}"] .q-c-amt') || {}).textContent`);
  ok(cell === "в документе", `в колонке суммы — «${cell}», а не 0,00`);
  const total = await ev(`document.getElementById('qBig').textContent`);
  ok(!/NaN/.test(total), `«к оплате сегодня» посчиталось: ${total}`);
  const acts = await ev(`(() => { document.querySelector('.qr[data-id="${docId}"] button[data-menu]').click();
    return [...document.querySelectorAll('#qMenu button[data-act]')].map(b => b.getAttribute('data-act')); })()`);
  ok(acts && !acts.includes("part") && acts.includes("pay"),
     `«Оплатить часть» не предлагается, «Отметить оплаченной» есть (${(acts || []).join(", ")})`);

  const primary = async (act) => {
    const found = await ev(`(() => { const b = document.querySelector('.qr[data-id="${docId}"] .q-go[data-act="${act}"]');
      if (b) b.click(); return !!b; })()`);
    if (!found) fails.push(`нет главной кнопки «${act}»`);
    await sleep(1500);
  };
  await ev(`document.body.click()`);
  await primary("take");
  await primary("pay");
  r = (await mine()).find((x) => x.id === docId);
  ok(r.status === "paid" && r.amount === null, `оплачена как есть, сумму вписывать не пришлось (статус «${r.status}»)`);

  console.log("\nБухгалтер вписывает сумму:");
  await ev(`(() => { document.querySelector('.qr[data-id="${docId}"]').click(); })()`); await sleep(400);
  await ev(`document.querySelector('.qr[data-id="${docId}"] button[data-edit]').click()`); await sleep(500);
  await fill({ amount: "250.5" });
  await submit();
  r = (await mine()).find((x) => x.id === docId);
  ok(Number(r.amount) === 250.5 && r.payee === "По документу: dc-schet.pdf",
     `сумма записалась: ${r.amount}, получатель не тронут`);

  console.log("\nБухгалтер заводит заявку по документу:");
  await open();
  await ev(`document.getElementById('tabForm').click()`); await sleep(400);
  await ev(`(() => { const s = document.getElementById('ncFormClient'); s.value = ${JSON.stringify(ROM)};
    s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await fill({ payee: "", amount: "", due: "", purpose: MARK });
  await attach("dc-nalog.pdf", "application/pdf");
  await submit();
  r = (await mine()).find((x) => x.id !== docId);
  ok(r && r.payee === "По документу: dc-nalog.pdf" && r.amount === null && r.client_id === ROM,
     `заявка сотрудника: «${r && r.payee}», сумма ${r && JSON.stringify(r.amount)}`);
  ok(r && r.due === nearest, `дата — тем же правилом, что у клиента: ${r && r.due}`);
  const shown = await ev(`(document.querySelector('.qr[data-id="${r && r.id}"] .q-payee') || {}).textContent`);
  ok(/По документу: dc-nalog\.pdf/.test(shown || ""), "в очереди она названа сразу, без ожидания опроса");

  const noise = [...new Set(problems)].filter((p) => !/400|409|415|Bad Request|Failed to load resource/.test(p));
  if (noise.length) { console.log("\nОшибки в консоли:"); noise.forEach((p) => console.log("  " + p)); }
  console.log(fails.length ? `\nПРОВАЛ: ${fails.length}\n  ${fails.join("\n  ")}` : "\nВсё сошлось.");
  ws.close();
  process.exitCode = fails.length || noise.length ? 1 : 0;
} finally {
  await cleanup();
  chrome.kill();
  server.close();
}
