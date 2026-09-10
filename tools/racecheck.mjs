// Проверяет, что две вкладки больше не затирают друг друга.
//
// Тот самый сценарий из docs/FIXPLAN.md (этап 2): в одной вкладке заявку
// переводят, в другой в это же время жмут свою кнопку. Раньше выигрывал тот,
// кто нажал последним, — общий save() делал upsert ВСЕХ заявок из состояния
// вкладки, и чужой статус откатывался молча. Для платежей это значит риск
// оплатить дважды (находка M1.1).
//
// Скрипт делает обе половины работы:
//   1) воспроизводит СТАРОЕ поведение — шлёт тот самый upsert сталой строкой
//      и показывает, что статус действительно откатывается. Без этого шага
//      непонятно, чинили ли мы существующую проблему;
//   2) проверяет НОВОЕ — жмёт кнопку в сталой вкладке и убеждается, что база
//      не изменилась, а человеку сказали, что заявку тронули.
//
//   supabase start
//   node tools/racecheck.mjs
//
// Живых данных не трогает: работает против локального стека и возвращает
// заявку в исходный статус.

import { API, ANON, SRV, STAFF, sleep, serve, ensureStaff, cdp, launchChrome } from "./stand.mjs";

const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };

async function getRow(id) {
  const r = await fetch(`${API}/rest/v1/payments?id=eq.${encodeURIComponent(id)}&select=*`, { headers: H });
  return (await r.json())[0];
}

// Так «вторая вкладка» переводит заявку: обычный PATCH одной строки.
async function setStatus(id, status) {
  await fetch(`${API}/rest/v1/payments?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ status }),
  });
}

const fails = [];
const ok    = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails.push(msg); };

const server = await serve();
await ensureStaff();
const chrome = launchChrome("racecheck-chrome");

try {
  const { ws, send, waitFor, problems } = await cdp();
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");

  const base = `http://localhost:${server.port}/app/`;
  const go = async (url, settle = 2500) => {
    const done = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url }); await done; await sleep(settle);
  };
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) problems.push("EVAL: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  };

  // ---- вкладка бухгалтера ----
  await go(base);
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
  })()`);
  await go(base, 3200);

  // Берём любую заявку, которую очередь показывает с кнопкой «Взять в работу»:
  // так тест не привязан к конкретной строке сида.
  const id = await ev(`(() => {
    const b = document.querySelector('.row[data-id] button[data-act="take"]');
    return b ? b.closest('.row').getAttribute('data-id') : null;
  })()`);
  if (!id) throw new Error("в очереди нет ни одной новой заявки — нечего проверять");

  const before = await getRow(id);
  console.log(`Заявка ${id} — «${before.payee}», статус «${before.status}».\n`);

  // -----------------------------------------------------------------------
  // 1. Старое поведение: сталый upsert затирает чужой статус
  // -----------------------------------------------------------------------
  console.log("Старое поведение (общий save):");

  await setStatus(id, "paid");                       // «вторая вкладка» оплатила
  ok((await getRow(id)).status === "paid", "вторая вкладка отметила заявку оплаченной");

  // Ровно то, что слал прежний save(): вся строка целиком из состояния вкладки,
  // где статус ещё «новая».
  const stale = {
    id: before.id, client: before.client, payee: before.payee, amount: before.amount,
    requisites: before.requisites, due: before.due, recurrence: before.recurrence,
    purpose: before.purpose, status: before.status, need_receipt: before.need_receipt,
    files: before.files, file_url: before.file_url, file_name: before.file_name,
    created_at: before.created_at, client_id: before.client_id,
    auto_created: before.auto_created, created_by_staff: before.created_by_staff,
    staff_files: before.staff_files,
  };
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
    await c.from('payments').upsert([${JSON.stringify(stale)}]);
  })()`);
  const afterStale = await getRow(id);
  ok(afterStale.status === before.status,
     `сталый upsert откатил статус обратно в «${afterStale.status}» — так и терялась чужая работа`);

  // -----------------------------------------------------------------------
  // 2. Новое поведение: кнопка в сталой вкладке ничего не затирает
  // -----------------------------------------------------------------------
  console.log("\nНовое поведение (точечный update с проверкой статуса):");

  await setStatus(id, "paid");                       // снова оплачено «второй вкладкой»

  // Вкладка опрашивает базу раз в 15 секунд. Если опрос успел пройти и строку
  // перерисовало, сталого состояния уже нет и проверять нечего — пробуем снова.
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    clicked = await ev(`(() => {
      const b = document.querySelector('.row[data-id="${id}"] button[data-act="take"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) { await go(base, 3200); await setStatus(id, "paid"); }
  }
  ok(clicked, "вкладка всё ещё показывает заявку новой (состояние сталое)");

  await sleep(1500);
  const afterClick = await getRow(id);
  ok(afterClick.status === "paid",
     `после нажатия «Взять в работу» в базе по-прежнему «${afterClick.status}» — чужая отметка цела`);

  const toast = await ev(`document.getElementById('toast')?.textContent || ""`);
  ok(/тем временем/.test(toast), `бухгалтеру сказали, что произошло: «${toast}»`);

  // -----------------------------------------------------------------------
  await setStatus(id, before.status);                // прибираем за собой
  console.log(`\nЗаявка возвращена в «${before.status}».`);

  const noise = [...new Set(problems)];
  if (noise.length) { console.log("\nОшибки в консоли:"); noise.forEach((p) => console.log("  " + p)); }

  console.log(fails.length ? `\nПРОВАЛ: ${fails.length}` : "\nВсё сошлось.");
  ws.close();
  process.exitCode = fails.length || noise.length ? 1 : 0;
} finally {
  chrome.kill();
  server.close();
}
