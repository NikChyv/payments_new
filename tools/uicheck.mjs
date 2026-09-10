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
// Гонку двух вкладок проверяет соседний tools/racecheck.mjs.
// Общий стенд обоих — tools/stand.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API, ANON, STAFF, TOKEN, arg, sleep, serve, ensureStaff, cdp, launchChrome } from "./stand.mjs";

const WIDTH = Number(arg("width", 1280));
const OUT   = arg("out", path.join(os.tmpdir(), "uicheck"));

const server = await serve();
await ensureStaff();

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

  await go(`${base}?t=${TOKEN}`);          await shot("client");
  await go(base);
  await ev(`(async () => {
    const c = window.supabase.createClient(${JSON.stringify(API)}, ${JSON.stringify(ANON)});
    await c.auth.signInWithPassword({email:${JSON.stringify(STAFF.email)}, password:${JSON.stringify(STAFF.password)}});
  })()`);
  await go(base, 3200);                     await shot("queue");
  await ev(`document.getElementById('tabForm')?.click(); true`); await sleep(700);
  await shot("form");

  console.log(problems.length ? "\nОшибки в консоли:" : "\nОшибок в консоли нет.");
  [...new Set(problems)].forEach((p) => console.log("  " + p));
  ws.close();
  process.exitCode = problems.length ? 1 : 0;
} finally {
  chrome.kill();
  server.close();
}
