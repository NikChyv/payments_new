// Общий стенд для инструментов проверки: статика, локальная учётка бухгалтера
// и headless Chrome с подключением по CDP.
//
// Вынесено из uicheck.mjs, когда рядом появился racecheck.mjs: поднимают стенд
// они одинаково, а расходятся только в том, что делают дальше.
//
// Локальные ключи и пароль ниже секретом не являются: у Supabase CLI они
// одинаковы у всех и работают только против 127.0.0.1.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const API  = "http://127.0.0.1:18321";
export const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const SRV  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
export const STAFF = { email: "admin@local.test", password: "local12345", name: "Проверка" };
export const TOKEN = "demotoken1";           // клиент из supabase/seed.sql
export const PORT  = 8099, CDP = 9222;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };

const MIME = { ".html":"text/html;charset=utf-8", ".js":"text/javascript;charset=utf-8",
  ".css":"text/css;charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };

// Порт подбираем, а не занимаем жёстко: рядом легко оказаться забытому серверу
// из прошлого запуска, и падать из-за этого скрипт не должен.
export function serve(port = PORT, left = 12) {
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

export function chromePath() {
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p));
  if (!c) throw new Error("Chrome не найден — поправь путь в tools/stand.mjs");
  return c;
}

export function launchChrome(profileName = "uicheck-chrome") {
  const profile = path.join(os.tmpdir(), profileName);
  return spawn(chromePath(), ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--hide-scrollbars", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore", detached: false });
}

// Учётка бухгалтера в локальном стеке живёт до ближайшего `supabase db reset`,
// поэтому заводим её каждый раз заново, а не надеемся, что она есть.
export async function ensureStaff() {
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

export async function cdp() {
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
