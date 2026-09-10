import { state } from './state.js';
import { postStaffMessage } from './supabase.js';
import { esc, safeUrl, toast } from './utils.js';
import { fmtDate, fmtMoney } from './dates.js';

// Переписка по заявке: бухгалтер спрашивает недостающее, клиент отвечает из
// бота или из кабинета. Всё в одном окне — вопрос, история и напоминание:
// заводить под них три разных места не за что, работа одна и та же.

// Готовые формулировки. Смысл не в экономии букв, а в том, чтобы вопрос
// улетал одним кликом: печатать одно и то же по десять раз в день никто не
// станет, и всё вернётся в личный чат — ровно туда, откуда мы уходим.
export const QUESTION_TEMPLATES = [
  "Прислали накладную — для оплаты нужен счёт с номером.",
  "В документе не указан номер счёта.",
  "Не хватает реквизитов получателя: УНП или расчётный счёт.",
  "Файл не открывается — пришлите, пожалуйста, ещё раз.",
  "Сумма в документе не совпадает с заявкой — уточните.",
];

// Состояние выводим из самой переписки, а не из отдельного поля: см. комментарий
// в миграции 20260909000001 — любое поле, которое пишет и клиент, и общий
// upsert очереди, рано или поздно будет затёрто сталым значением из браузера.
export function threadState(it) {
  const t = it.thread || [];
  if (!t.length) return "none";
  return t[t.length - 1].who === "client" ? "answered" : "waiting";
}

// Привязан ли клиент к боту. Без привязки вопрос никуда не «прилетит» — он
// будет ждать, пока человек сам откроет свою ссылку. Сказать об этом надо ДО
// отправки, иначе бухгалтер будет ждать ответа, которого клиент не видел.
function clientHasBot(it) {
  if (!it.client_id) return true;               // личная задача бухгалтера
  const c = state.clientsList.find(x => x.id === it.client_id);
  return !c || !!c.telegram_id;                 // не знаем — не пугаем зря
}

function fmtAt(at) {
  const d = new Date(at);
  if (isNaN(d)) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

export function threadHtml(it) {
  const list = it.thread || [];
  if (!list.length) {
    return '<div class="th-empty">Переписки по этой заявке ещё не было.</div>';
  }
  return list.map(m => {
    const files = (m.files || [])
      .filter(f => f && f.url)
      .map(f => `<a class="th-file" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">📎 ${esc(f.name || "файл")}</a>`)
      .join("");
    const who = m.who === "client" ? esc(m.author || it.client) : esc(m.author || "Бухгалтер");
    const kind = m.kind === "reminder" ? " · напоминание" : "";
    return `<div class="th-msg ${m.who === "client" ? "cl" : "st"}">` +
      `<div class="th-who">${who}${kind}</div>` +
      `<div class="th-text">${esc(m.text || "")}</div>` +
      (files ? `<div class="th-files">${files}</div>` : "") +
      `<div class="th-at">${fmtAt(m.at)}</div>` +
    `</div>`;
  }).join("");
}

// ---------- окно ----------

let current = null;   // заявка, открытая сейчас
let afterChange = null;

export function openThread(it, onChange) {
  current = it;
  afterChange = onChange || null;

  const box = document.getElementById("thBox");
  const st = threadState(it);

  document.getElementById("thPayee").textContent = it.payee || "—";
  document.getElementById("thAmount").textContent = fmtMoney(it.amount);
  document.getElementById("thMeta").textContent =
    `${it.client || "личная задача"} · срок ${fmtDate(it.due)}` + (it.purpose ? ` · ${it.purpose}` : "");

  document.getElementById("thList").innerHTML = threadHtml(it);
  document.getElementById("thChips").innerHTML = QUESTION_TEMPLATES
    .map((t, i) => `<button type="button" class="th-chip" data-tpl="${i}">${esc(t)}</button>`).join("");
  document.getElementById("thText").value = "";

  // Напоминать есть смысл, только пока ждём ответа — иначе это сообщение
  // в пустоту: клиент уже ответил, вопрос за бухгалтером.
  const remind = document.getElementById("thRemind");
  remind.classList.toggle("hidden", st !== "waiting");

  const warn = document.getElementById("thWarn");
  if (clientHasBot(it)) {
    warn.className = "th-warn hidden";
    warn.textContent = "";
  } else {
    warn.className = "th-warn";
    warn.innerHTML = `⚠️ <b>${esc(it.client)}</b> не подключён к боту — в Telegram сообщение не придёт. ` +
      `Клиент увидит его, когда откроет свою ссылку.`;
  }

  box.classList.remove("hidden");
  setTimeout(() => { const t = document.getElementById("thText"); if (t) t.focus(); }, 30);
  // прокручиваем переписку к последнему сообщению
  const list = document.getElementById("thList");
  list.scrollTop = list.scrollHeight;
}

export function closeThread() {
  document.getElementById("thBox").classList.add("hidden");
  current = null;
}

async function post(text, kind) {
  const it = current;
  if (!it) return;
  const btns = document.querySelectorAll("#thBox .th-act");
  btns.forEach(b => { b.disabled = true; });
  try {
    await postStaffMessage(it, text, kind);
    document.getElementById("thList").innerHTML = threadHtml(it);
    document.getElementById("thText").value = "";
    document.getElementById("thRemind").classList.remove("hidden");
    const list = document.getElementById("thList");
    list.scrollTop = list.scrollHeight;
    toast(kind === "reminder"
      ? (clientHasBot(it) ? "Напомнили клиенту" : "Напоминание сохранено — клиент увидит его в кабинете")
      : (clientHasBot(it) ? "Вопрос отправлен клиенту" : "Вопрос сохранён — клиент увидит его в кабинете"));
    if (afterChange) afterChange();
  } catch (e) {
    console.error(e);
    toast(e && e.message ? `Не отправилось: ${e.message}` : "Не отправилось — попробуйте ещё раз");
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}

// Вешаем один раз на всё окно: разметка статична, а заявка внутри меняется.
export function initThreadDialog() {
  const box = document.getElementById("thBox");
  if (!box) return;

  box.addEventListener("click", e => {
    // клик по подложке закрывает окно, клик внутри карточки — нет
    if (e.target === box) { closeThread(); return; }

    const chip = e.target.closest && e.target.closest("button[data-tpl]");
    if (chip) {
      const t = QUESTION_TEMPLATES[+chip.getAttribute("data-tpl")];
      const ta = document.getElementById("thText");
      ta.value = ta.value.trim() ? ta.value.trim() + " " + t : t;
      ta.focus();
      return;
    }

    const btn = e.target.closest && e.target.closest("button[data-th]");
    if (!btn) return;
    const act = btn.getAttribute("data-th");

    if (act === "close") { closeThread(); return; }
    if (act === "remind") {
      post("Напоминаю: жду вашего ответа по этой заявке.", "reminder");
      return;
    }
    if (act === "send") {
      const text = document.getElementById("thText").value.trim();
      if (!text) { toast("Напишите вопрос или выберите готовый"); return; }
      post(text, "question");
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) closeThread();
  });
}
