// Проверяет оплату по частям в очереди бухгалтера — кнопками в браузере,
// с записью в локальную базу и сверкой того, что записалось.
//
// Зачем отдельный скрипт: каждое действие с частями — это деньги, и у каждого
// есть гонка двух вкладок. «Оплачено» из отставшей вкладки закрыло бы заявку,
// по которой только что прошла часть, как целую; «Остаток оплачен» задвоил бы
// оплату. Руками такое не воспроизвести, а по коду не видно.
//
//   supabase start
//   node tools/partcheck.mjs
//
// Сценарий: часть через окно → чужая часть и «Остаток оплачен» в отставшей
// вкладке (отказ) → «Остаток оплачен» (копия повторяющегося от ИСХОДНОЙ даты)
// → «Отменить оплату» (снимает последнюю часть, копия удаляется) → «Закрыть с
// недоплатой» → отмена без снятия частей → «Отменить последнюю часть» →
// документ на часть и его гонка → «Оплачено» без частей в отставшей вкладке.
// Живых данных не трогает: заявки pc-* заводит и удаляет сам.

import { API, ANON, SRV, STAFF, sleep, serve, ensureStaff, cdp, launchChrome } from "./stand.mjs";

const H = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
const ROM = "11111111-0000-0000-0000-000000000001";

const rows = async (q) => (await fetch(`${API}/rest/v1/payments?${q}&select=*`, { headers: H })).json();
const row  = async (id) => (await rows(`id=eq.${id}`))[0];
const cleanup = () => Promise.all([
  fetch(`${API}/rest/v1/payments?parent_id=like.pc-*`, { method: "DELETE", headers: H }),
  fetch(`${API}/rest/v1/payments?id=like.pc-*`, { method: "DELETE", headers: H }),
]);

// рабочие дни вперёд: даты в сценарии не должны попасть на выходной
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function workday(n) {
  const d = new Date();
  for (let left = n; left > 0;) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) left--; }
  return iso(d);
}
const plusMonth = (s) => { const d = new Date(s + "T00:00:00"); d.setMonth(d.getMonth() + 1); return iso(d); };

const fails = [];
const ok = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails.push(msg); };

const server = await serve();
await ensureStaff();
await cleanup();
const D1 = workday(3), D2 = workday(6);
for (const r of [
  { id: "pc-1", client_id: ROM, client: "ООО «Ромашка»", payee: "Проверка частей", amount: 500,
    due: D1, recurrence: "monthly", status: "in_progress" },
  { id: "pc-2", client_id: ROM, client: "ООО «Ромашка»", payee: "Проверка без частей", amount: 300,
    due: D1, recurrence: "once", status: "in_progress" },
]) {
  const res = await fetch(`${API}/rest/v1/payments`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(r) });
  if (!res.ok) throw new Error(`заявка ${r.id} не записалась: ` + await res.text());
}

const chrome = launchChrome("partcheck-chrome");
try {
  const { ws, send, waitFor, problems } = await cdp();
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  const base = `http://localhost:${server.port}/app/`;
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) problems.push("EVAL: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  };
  // Вкладка: все статусы, confirm отвечает «да», тост не гаснет до следующего
  // чтения. Поллинг раз в 15 секунд перерисовал бы «отставшую» вкладку —
  // сценарии с гонкой укладываются в пару секунд после загрузки.
  const open = async () => {
    const done = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url: base }); await done; await sleep(3000);
    await ev(`(() => { window.confirm = () => true;
      document.querySelector('#qFilters button[data-f=""]').click();
      const s = document.getElementById('fStatus'); s.value = 'all';
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
  };
  const toast = () => ev(`document.getElementById('toast').textContent`);
  // Действие из меню «…» строки. Меню берём свежим — как человек.
  const menu = async (id, act) => {
    const found = await ev(`(() => {
      document.querySelector('.qr[data-id="${id}"] button[data-menu]').click();
      const b = document.querySelector('#qMenu button[data-act="${act}"]');
      if (b) b.click(); return !!b; })()`);
    if (!found) fails.push(`нет пункта «${act}» в меню ${id}`);
    await sleep(1500);
  };
  const primary = async (id, act) => {
    const found = await ev(`(() => { const b = document.querySelector('.qr[data-id="${id}"] .q-go[data-act="${act}"]');
      if (b) b.click(); return !!b; })()`);
    if (!found) fails.push(`нет главной кнопки «${act}» у ${id}`);
    await sleep(1500);
  };
  // «Вторая вкладка» — отдельный клиент под той же учёткой прямо в странице
  const otherTab = (js) => ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)}, { auth: { storageKey: "other" } });
    await c.auth.signInWithPassword({ email: ${JSON.stringify(STAFF.email)}, password: ${JSON.stringify(STAFF.password)} });
    const r = await ${js}; return r.error ? r.error.message : "ok"; })()`);

  const done0 = waitFor("Page.loadEventFired");
  await send("Page.navigate", { url: base }); await done0; await sleep(1500);
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
  })()`);

  console.log("Часть через окно:");
  await open();
  await menu("pc-1", "part");
  await ev(`(() => { document.getElementById('ppAmt').value = '200';
    document.getElementById('ppAmt').dispatchEvent(new Event('input'));
    document.getElementById('ppDue').value = '${D2}';
    document.getElementById('ppSave').click(); })()`);
  await sleep(2000);
  let r = await row("pc-1");
  ok(Number(r.paid_amount) === 200 && r.parts.length === 1, `записана часть 200 (оплачено ${r.paid_amount}, частей ${r.parts.length})`);
  ok(r.status === "in_progress" && r.due === D2, `заявка в работе, срок остатка ${r.due}`);
  ok(/Записано/.test(await toast()), `бухгалтеру: «${await toast()}»`);
  ok(await ev(`!!document.querySelector('.qr[data-id="pc-1"] .q-go[data-act="pay"]')?.textContent.includes('Остаток')`),
     "главная кнопка стала «Остаток оплачен»");

  console.log("\nОтставшая вкладка: чужая часть, потом «Остаток оплачен»:");
  ok(await otherTab(`c.rpc('pay_part', { p_id: 'pc-1', p_amount: 50, p_new_due: '${D2}', p_seen_paid: 200 })`) === "ok",
     "вторая вкладка записала часть 50");
  await primary("pc-1", "pay");
  r = await row("pc-1");
  ok(Number(r.paid_amount) === 250 && r.status === "in_progress",
     `остаток по старым цифрам не записан: оплачено ${r.paid_amount}, статус «${r.status}»`);
  ok(/изменили/.test(await toast()), `бухгалтеру сказали: «${await toast()}»`);

  console.log("\n«Остаток оплачен»:");
  await open();
  await primary("pc-1", "pay");
  r = await row("pc-1");
  ok(r.status === "paid" && Number(r.paid_amount) === 500 && r.parts.length === 3,
     `оплачено целиком последней частью (статус «${r.status}», оплачено ${r.paid_amount}, частей ${r.parts.length})`);
  let copies = await rows("parent_id=eq.pc-1");
  ok(copies.length === 1 && copies[0].due === plusMonth(D1),
     `копия повторяющегося от исходной даты: ${copies[0]?.due} (ждали ${plusMonth(D1)}, а не от ${D2})`);
  ok(copies.length === 1 && Number(copies[0].paid_amount) === 0 && copies[0].parts.length === 0, "у копии частей нет");

  console.log("\n«Отменить оплату» после финальной части:");
  await menu("pc-1", "unpay");
  r = await row("pc-1");
  ok(r.status === "in_progress" && Number(r.paid_amount) === 250 && r.parts.length === 2 && r.due === D2,
     `снята последняя часть: статус «${r.status}», оплачено ${r.paid_amount}, срок ${r.due}`);
  ok((await rows("parent_id=eq.pc-1")).length === 0, "нетронутая копия удалена");

  console.log("\n«Закрыть с недоплатой» и отмена:");
  await menu("pc-1", "close_under");
  r = await row("pc-1");
  ok(r.status === "paid" && Number(r.paid_amount) === 250 && Number(r.amount) === 500,
     `закрыто: статус «${r.status}», оплачено ${r.paid_amount} из ${r.amount} — сумма заявки прежняя`);
  ok((await rows("parent_id=eq.pc-1")).length === 1, "копия повторяющегося создана");
  ok(await ev(`!!document.querySelector('.qr[data-id="pc-1"] .q-tag.under')`), "в строке метка «с недоплатой»");
  await menu("pc-1", "unpay");
  r = await row("pc-1");
  ok(r.status === "in_progress" && Number(r.paid_amount) === 250 && r.parts.length === 2,
     `вернулась в работу, части на месте (оплачено ${r.paid_amount}, частей ${r.parts.length})`);
  ok((await rows("parent_id=eq.pc-1")).length === 0, "копия удалена");

  console.log("\n«Отменить последнюю часть»:");
  await menu("pc-1", "unpart");
  r = await row("pc-1");
  ok(Number(r.paid_amount) === 200 && r.parts.length === 1 && r.status === "in_progress",
     `осталась одна часть 200 (оплачено ${r.paid_amount})`);

  console.log("\nДокумент на часть:");
  const partId = r.parts[0].id;
  const att = await ev(`(async () => {
    const { state } = await import('./js/state.js');
    const { attachPartDocRemote } = await import('./js/supabase.js');
    const it = state.items.find(x => x.id === 'pc-1');
    const doc = { url: 'http://127.0.0.1:18321/storage/v1/object/public/files/p.pdf', name: 'p.pdf', part_id: '${partId}' };
    const first = await attachPartDocRemote(it, { status: it.status, paid: it.paidAmount, staffFiles: [] }, [doc]);
    // отставшая вкладка видела пустой набор документов и пишет свой поверх
    const stale = await attachPartDocRemote({ ...it, id: 'pc-1' }, { status: 'in_progress', paid: 200, staffFiles: [] },
      [{ ...doc, name: 'чужой.pdf' }]);
    return [first.ok, stale.ok];
  })()`);
  r = await row("pc-1");
  ok(att && att[0] === true && r.staff_files.length === 1 && r.staff_files[0].part_id === partId,
     "документ лёг в staff_files с привязкой к части");
  ok(att && att[1] === false && r.staff_files[0].name === "p.pdf", "отставшая вкладка документ не затёрла");

  console.log("\n«Оплачено» без частей в отставшей вкладке:");
  await open();
  ok(await otherTab(`c.rpc('pay_part', { p_id: 'pc-2', p_amount: 100, p_new_due: '${D2}', p_seen_paid: 0 })`) === "ok",
     "вторая вкладка записала часть 100");
  await primary("pc-2", "pay");
  r = await row("pc-2");
  ok(r.status === "in_progress" && Number(r.paid_amount) === 100,
     `заявку с частью не закрыли как целую (статус «${r.status}», оплачено ${r.paid_amount})`);
  ok(/изменили/.test(await toast()), `бухгалтеру сказали: «${await toast()}»`);

  const noise = [...new Set(problems)].filter((p) => !/400|409|Bad Request|Failed to load resource/.test(p));
  if (noise.length) { console.log("\nОшибки в консоли:"); noise.forEach((p) => console.log("  " + p)); }
  console.log(fails.length ? `\nПРОВАЛ: ${fails.length}\n  ${fails.join("\n  ")}` : "\nВсё сошлось.");
  ws.close();
  process.exitCode = fails.length || noise.length ? 1 : 0;
} finally {
  await cleanup();
  chrome.kill();
  server.close();
}
