// Снимает экраны приложения против ЛОКАЛЬНОГО стека и печатает всё, что упало
// в консоль браузера.
//
// Зачем: на вёрстке мы уже дважды ловили баги, которых в исходнике не видно, а
// молчаливая ошибка в ES-модуле ломает экран целиком — страница просто остаётся
// пустой. Ручная проверка каждый раз стоила пятнадцати минут и трёх забытых
// шагов, поэтому скрипт делает всё сам: поднимает статику, поднимает headless
// Chrome, заводит локальную учётку бухгалтера, логинится, снимает и прибирает
// за собой.
//
//   supabase start                     # стек должен быть поднят
//   node tools/uicheck.mjs             # все экраны, ширина 1280
//   node tools/uicheck.mjs --width 390 # мобильная ширина (кабинет клиента)
//   node tools/uicheck.mjs --out .      # куда класть снимки
//   node tools/uicheck.mjs --serve      # просто держать стенд для ручного прохода
//
// Экраны: кабинет клиента, окно ответа клиента, форма клиента (новая и
// «Исправить»), вход, очередь
// («нужно сегодня» и «все статусы»), раскрытая строка с частями, меню «…»,
// окно «Оплатить часть», окно переписки, форма сотрудника, «Клиенты».
// Перед съёмкой в локальную базу кладётся фикстура — заявки `ui-*` во всех
// статусах, с перепиской и файлами. Два прогона подряд дают побайтно одинаковые
// снимки, поэтому правку, которая не должна менять вид, проверяем `cmp` старых и
// новых PNG (эталон снимать в тот же день: даты в сиде относительные).
//
// Гонку двух вкладок проверяет соседний tools/racecheck.mjs.
// Общий стенд обоих — tools/stand.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API, ANON, SRV, STAFF, TOKEN, arg, sleep, serve, ensureStaff, cdp, launchChrome } from "./stand.mjs";

const WIDTH = Number(arg("width", 1280));
const OUT   = arg("out", path.join(os.tmpdir(), "uicheck"));

const server = await serve();
const staffId = await ensureStaff();
await fixture(staffId);

// Сид — три новые заявки, и на снимках не было ни одного другого статуса, ни
// переписки, ни вложений: сверка «до/после» (редизайн, шаг 1) такие стили просто
// не видела. Докладываем заявки во всех состояниях. Id с префиксом `ui-`, каждый
// прогон пересоздаются; время в переписке фиксированное, чтобы снимки двух
// прогонов совпадали. Пишем service-ключом только в локальный стек — вебхуков
// уведомлений там нет.
async function fixture(staffId) {
  const h = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
  await fetch(`${API}/rest/v1/payments?id=like.ui-*`, { method: "DELETE", headers: h });
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const ROM = { client_id: "11111111-0000-0000-0000-000000000001", client: "ООО «Ромашка»" };
  const SMI = { client_id: "11111111-0000-0000-0000-000000000002", client: "ИП Смирнов" };
  const file = (name) => ({ url: `http://127.0.0.1:18321/storage/v1/object/public/files/${name}`, name });
  const ask = { id: "ui-m1", who: "staff", kind: "ask", text: "Пришлите, пожалуйста, счёт — в заявке его нет.",
    author: STAFF.name, files: [], at: "2026-09-15T08:30:00Z" };
  const ans = { id: "ui-m2", who: "client", kind: "reply", text: "Прикладываю счёт.",
    author: ROM.client, files: [file("schet.pdf")], at: "2026-09-15T09:10:00Z" };
  const part = (id, amount, before, after) => ({ id, amount, at: "2026-09-15T10:00:00Z", by: staffId,
    by_name: STAFF.name, due_before: before, due_after: after });
  const rows = [
    { id: "ui-1", ...ROM, payee: "ЧУП «Связьинвест»", amount: 312.4, requisites: "УНП 190000001",
      due: day(0), recurrence: "once", purpose: "Связь за сентябрь", status: "in_progress", thread: [ask] },
    { id: "ui-2", ...ROM, payee: "ОАО «Белтелеком»", amount: 96.15, requisites: "счёт 4471",
      due: day(-2), recurrence: "monthly", purpose: "Интернет", status: "paid",
      files: [file("schet.pdf")], file_url: file("schet.pdf").url, file_name: "schet.pdf",
      staff_files: [file("platezhka.pdf")], thread: [ask, ans] },
    { id: "ui-3", ...ROM, payee: "ООО «Канцторг»", amount: 1480, requisites: "УНП 190000002",
      due: day(-5), recurrence: "once", purpose: "Бумага и картриджи", status: "sent" },
    { id: "ui-4", client_id: null, client: null, payee: "Сверка с ФСЗН", amount: 1,
      due: day(-1), recurrence: "once", purpose: "Личная задача", status: "new", created_by_staff: staffId },
    { id: "ui-5", ...SMI, payee: "УП «Минскводоканал»", amount: 210.9, requisites: "УНП 100000003",
      due: day(3), recurrence: "monthly", purpose: "Вода", status: "in_progress", created_by_staff: staffId },
    // Оплата по частям (шаг 5): частично оплаченная с документом на часть и
    // закрытая с недоплатой. Service-ключ сторож частей пропускает, но
    // инвариант «оплачено = сумма частей» держит и для него.
    { id: "ui-6", ...SMI, payee: "ООО «Профснаб»", amount: 500, requisites: "счёт 2211/3",
      due: day(0), recurrence: "monthly", purpose: "Расходные материалы", status: "in_progress",
      paid_amount: 200, parts: [part("ui-p1", 200, day(-2), day(0))],
      staff_files: [{ ...file("platezhka-1.pdf"), part_id: "ui-p1" }] },
    { id: "ui-7", ...SMI, payee: "ИП Ковалёв", amount: 800, requisites: "УНП 190000004",
      due: day(-1), recurrence: "once", purpose: "Аренда склада", status: "paid", need_receipt: true,
      paid_amount: 650, parts: [part("ui-p2", 400, day(-6), day(-3)), part("ui-p3", 250, day(-3), day(-1))] },
    // Те же части глазами клиента (шаг 6): кабинет по токену — это «Ромашка».
    { id: "ui-8", ...ROM, payee: "РУП «Минскэнерго»", amount: 640, requisites: "УНП 100000005",
      due: day(4), recurrence: "monthly", purpose: "Электроэнергия за август", status: "in_progress", need_receipt: true,
      paid_amount: 240, parts: [part("ui-p4", 240, day(-1), day(4))],
      staff_files: [{ ...file("platezhka-2.pdf"), part_id: "ui-p4" }] },
    { id: "ui-9", ...ROM, payee: "ИП Лапицкий", amount: 300, requisites: "счёт 118",
      due: day(-3), recurrence: "once", purpose: "Ремонт принтера", status: "paid",
      paid_amount: 250, parts: [part("ui-p5", 250, day(-3), day(-3))] },
  ];
  for (const row of rows) {   // по одной: пакетная вставка требует одинаковых ключей
    const r = await fetch(`${API}/rest/v1/payments`, { method: "POST",
      headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`фикстура uicheck (${row.id}) не записалась: ` + await r.text());
  }
}

// --serve: не снимать ничего, просто держать стенд открытым для ручного прохода.
// Учётка бухгалтера к этому моменту уже заведена, клиенты к ней привязаны.
if (process.argv.includes("--serve")) {
  console.log(`Стенд поднят. Ctrl+C чтобы остановить.\n`);
  console.log(`  Кабинет клиента  http://localhost:${server.port}/app/?t=${TOKEN}`);
  console.log(`  Очередь и вход   http://localhost:${server.port}/app/`);
  console.log(`  Бухгалтер        ${STAFF.email} / ${STAFF.password}\n`);
  await new Promise(() => {});
}

const chrome = launchChrome();

try {
  fs.mkdirSync(OUT, { recursive: true });
  const { ws, send, waitFor, problems } = await cdp();
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: 1400, deviceScaleFactor: 1, mobile: WIDTH < 700 });

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
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const f = path.join(OUT, `${name}-${WIDTH}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, "base64"));
    const wide = await ev(`document.documentElement.scrollWidth`);
    console.log(`  ${name.padEnd(8)} ${f}${wide > WIDTH ? `  ⚠ страница шире окна: ${wide}px` : ""}`);
    // Битый путь к woff2 не даёт ни ошибки на экране, ни пустой страницы —
    // она тихо рисуется запасным шрифтом. Поэтому спрашиваем браузер, какой
    // шрифт у body и загрузились ли ВСЕ его файлы: у семейства их несколько
    // (кириллица, латиница), и загруженная латиница не значит, что русский
    // текст не в запасном шрифте.
    const font = await ev(`document.fonts.ready.then(() => {
      const fam = getComputedStyle(document.body).fontFamily.split(",")[0].replace(/["']/g, "").trim();
      const faces = [...document.fonts].filter(f => f.family.replace(/["']/g, "") === fam);
      return { fam, loaded: faces.some(f => f.status === "loaded"), failed: faces.filter(f => f.status === "error").length };
    })`);
    if (font && (!font.loaded || font.failed))
      problems.push(`FONT: ${name} — «${font.fam}»: ${font.failed ? font.failed + " файл(а) не загрузилось" : "не загрузился"}, текст в запасном шрифте`);
    // Само число ничего не чинит: нужно знать, ЧТО распирает. Ищем видимые
    // элементы, вылезающие за правый край, и печатаем самые внешние.
    if (wide > WIDTH) {
      const guilty = await ev(`(() => {
        const w = document.documentElement.clientWidth, out = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.right <= w + 1) continue;
          if (out.some(o => o.el.contains(el))) continue;
          out.push({el, s: (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
            (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "")
            ).slice(0, 60) + "  →  " + Math.round(r.right) + "px"});
        }
        return out.slice(0, 5).map(o => o.s);
      })()`);
      (guilty || []).forEach((g) => console.log("           ↳ " + g));
    }
  };

  console.log(`Снимки (${WIDTH}px):`);

  const click = async (sel, settle = 700) => {
    const ok = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
    if (!ok) problems.push(`UICHECK: не нашёл ${sel} — снимок будет не тем экраном`);
    await sleep(settle);
  };

  await go(`${base}?t=${TOKEN}`);          await shot("client");
  await click("button[data-clreply]");     await shot("reply");
  await go(`${base}?t=${TOKEN}`);
  await click("#tabForm");                 await shot("clform");
  await go(`${base}?t=${TOKEN}`);
  await click("button[data-edit]");        await shot("cledit");
  await go(base);                           await shot("login");
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
  })()`);
  await go(base, 3200);                     await shot("queue");
  // по умолчанию очередь показывает только «нужно сегодня» — оплаченные и
  // закрытые строки со своими стилями видны лишь во «всех статусах»
  await click('#qFilters button[data-f=""]');
  await ev(`(() => { const s = document.getElementById('fStatus'); s.value = 'all';
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await sleep(700);
  await shot("queueall");
  // раскрытая строка с частями, меню «…» и окно части
  await click('.qr[data-id="ui-6"] .q-c-payee');                 await shot("qdet");
  // Меню не снимаем: снимок во всю высоту меняет размер окна, а меню по resize
  // закрывается (так и задумано). Проверяем его пункты текстом.
  await click('.qr[data-id="ui-6"] button[data-menu]', 400);
  const menu = await ev(`[...document.querySelectorAll('#qMenu button')].map(b => b.textContent).join(" | ")`);
  console.log(`  меню «…»  ${menu || "—"}`);
  if (!menu) problems.push("UICHECK: меню «…» не открылось");
  await click('#qMenu button[data-act="part"]');                  await shot("part");
  await ev(`document.querySelector('#partBox button[data-pp="close"]').click()`);
  await click('.qr[data-id="ui-2"] button[data-menu]', 400);
  await click('#qMenu button[data-act="thread"]');                await shot("thread");
  await go(base, 3200);
  await click("#tabForm");                  await shot("form");
  await click("#tabClients", 1500);         await shot("clients");

  console.log(problems.length ? "\nОшибки в консоли:" : "\nОшибок в консоли нет.");
  [...new Set(problems)].forEach((p) => console.log("  " + p));
  ws.close();
  process.exitCode = problems.length ? 1 : 0;
} finally {
  chrome.kill();
  server.close();
}
