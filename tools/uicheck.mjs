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
//
// Локальные ключи и пароль ниже секретом не являются: у Supabase CLI они
// одинаковы у всех и работают только против 127.0.0.1.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const API  = "http://127.0.0.1:18321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SRV  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const STAFF = { email: "admin@local.test", password: "local12345", name: "Проверка" };
const TOKEN = "demotoken1";           // клиент из supabase/seed.sql
const PORT  = 8099, CDP = 9222;

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const WIDTH = Number(arg("width", 1280));
const OUT   = arg("out", path.join(os.tmpdir(), "uicheck"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html":"text/html;charset=utf-8", ".js":"text/javascript;charset=utf-8",
  ".css":"text/css;charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };

// Порт подбираем, а не занимаем жёстко: рядом легко оказаться забытому серверу
// из прошлого запуска, и падать из-за этого скрипт не должен.
function serve(port = PORT, left = 12) {
  return new Promise((res, rej) => {
    const s = http.createServer((req, rq) => {
      let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      if (req.url.split("?")[0].endsWith("/")) f = path.join(f, "index.html");
      fs.readFile(f, (e, d) => {
        if (e) { rq.writeHead(404); rq.end("no"); return; }
        rq.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
        rq.end(d);
      });
    });
    s.once("error", (e) => {
      if (e.code === "EADDRINUSE" && left > 0) serve(port + 1, left - 1).then(res, rej);
      else rej(e);
    });
    s.listen(port, () => { s.port = port; res(s); });
  });
}

function chromePath() {
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p));
  if (!c) throw new Error("Chrome не найден — поправь путь в tools/uicheck.mjs");
  return c;
}

// Учётка бухгалтера в локальном стеке живёт до ближайшего `supabase db reset`,
// поэтому заводим её каждый раз заново, а не надеемся, что она есть.
async function ensureStaff() {
  const h = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };
  await fetch(`${API}/auth/v1/admin/users`, { method: "POST", headers: h,
    body: JSON.stringify({ ...STAFF, email_confirm: true }) }).catch(() => {});
  const list = await (await fetch(`${API}/auth/v1/admin/users`, { headers: h })).json();
  const user = (list.users || []).find((u) => u.email === STAFF.email);
  if (!user) throw new Error("не удалось завести локального бухгалтера");
  await fetch(`${API}/rest/v1/staff`, { method: "POST",
    headers: { ...h, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: user.id, name: STAFF.name, is_admin: true }) });
  // без привязки клиентов бухгалтер увидит пустую очередь
  await fetch(`${API}/rest/v1/clients?id=not.is.null`, { method: "PATCH",
    headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify({ staff_id: user.id }) });
  return user.id;
}

async function cdp() {
  let list;
  for (let i = 0; i < 40; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (list.find((t) => t.type === "page")) break; } catch {}
    await sleep(500);
  }
  const target = list.find((t) => t.type === "page");
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(target.webSocketDebuggerUrl);
    w.onopen = () => res(w); w.onerror = rej;
  });

  let seq = 0; const pending = new Map(); const waiters = []; const problems = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result); pending.delete(j.id); return; }
    if (j.method === "Runtime.exceptionThrown")
      problems.push("ИСКЛЮЧЕНИЕ: " + (j.params.exceptionDetails.exception?.description || j.params.exceptionDetails.text));
    if (j.method === "Runtime.consoleAPICalled" && j.params.type === "error")
      problems.push("КОНСОЛЬ: " + j.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    if (j.method === "Log.entryAdded" && j.params.entry.level === "error")
      problems.push("СЕТЬ/ЛОГ: " + j.params.entry.text + " " + (j.params.entry.url || ""));
    waiters.forEach((w) => w(j));
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const waitFor = (method, ms = 20000) => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("нет события " + method)), ms);
    waiters.push((j) => { if (j.method === method) { clearTimeout(to); res(j); } });
  });
  return { ws, send, waitFor, problems };
}

const server = await serve();
const staffId = await ensureStaff();
const profile = path.join(os.tmpdir(), "uicheck-chrome");
const chrome = spawn(chromePath(), ["--headless=new", "--disable-gpu", "--no-sandbox",
  "--hide-scrollbars", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore", detached: false });

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
