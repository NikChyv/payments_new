import { state } from './state.js';
import { esc } from './utils.js';
import { daysBetween, fmtDate, fmtMoney } from './dates.js';

const recLbl = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

function activeOpen(it) { return it.status === "new" || it.status === "in_progress"; }

function clStatusInfo(it) {
  if (it.status === "in_progress") return {cls:"s-prog", icon:"⏳", text:"Бухгалтер взял в работу"};
  if (it.status === "paid")        return {cls:"s-paid", icon:"✅", text: it.needReceipt ? "Оплачено, готовим документ" : "Оплачено"};
  if (it.status === "sent")        return {cls:"s-sent", icon:"✅", text: it.needReceipt ? "Оплачено, документ отправлен" : "Оплачено"};
  return {cls:"s-new", icon:"🕓", text:"Принята, ждёт оплаты"};
}

export function clSteps(it) {
  const withReceipt = it.needReceipt;
  const labels = withReceipt ? ["Принята","В работе","Оплачено","Документ"] : ["Принята","В работе","Оплачено"];
  const stage = ({new:1, in_progress:2, paid:3, sent:4})[it.status] || 1;
  const fullyDone = withReceipt ? it.status === "sent" : (it.status === "paid" || it.status === "sent");
  const parts = [];
  for (let i = 0; i < labels.length; i++) {
    let cls = "", dot = String(i + 1);
    if (fullyDone || i + 1 < stage)  { cls = "done";   dot = "✓"; }
    else if (i + 1 === stage)         { cls = "active"; }
    if (i > 0) {
      const prevDone = fullyDone || i < stage;
      parts.push(`<div class="bar${prevDone ? " done" : ""}"></div>`);
    }
    parts.push(`<div class="step ${cls}"><span class="dot">${dot}</span><span class="lab">${labels[i]}</span></div>`);
  }
  return `<div class="steps">${parts.join("")}</div>`;
}

function rowHtmlClient(it) {
  const done = it.status === "paid" || it.status === "sent";
  const s = clStatusInfo(it);
  const fileBadge = it.file ? (it.file.url
    ? `<a class="badge b-file" href="${esc(it.file.url)}" target="_blank" rel="noopener" title="Открыть файл">📎 ${esc(it.file.name)}</a>`
    : `<span class="badge b-file" title="${esc(it.file.name)}">📎 ${esc(it.file.name)}</span>`) : "";
  const recBadge = it.recurrence !== "once" ? `<span class="badge b-rec">🔁 ${recLbl[it.recurrence]}</span>` : "";
  return `<div class="row b-${done ? "green" : "gray"}">` +
    `<div class="main">` +
      `<div class="head"><span class="payee">${esc(it.payee)}</span><span class="amount">${fmtMoney(it.amount)}</span></div>` +
      `<div class="meta">` +
        `<span>📅 ${fmtDate(it.due)}</span>` +
        (it.purpose    ? `<span>${esc(it.purpose)}</span>`    : "") +
        (it.requisites ? `<span>${esc(it.requisites)}</span>` : "") +
      `</div>` +
      `<div class="cl-status"><span class="cl-now ${s.cls}">${s.icon} ${s.text}</span>${recBadge}${fileBadge}</div>` +
      clSteps(it) +
    `</div>` +
  `</div>`;
}

export function renderClient() {
  const list = document.getElementById("list");
  const rows = state.items
    .filter(it => it.client === state.CLIENT)
    .sort((a, b) => {
      const ao = activeOpen(a) ? 0 : 1, bo = activeOpen(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    });
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">Здесь появятся ваши платежи после отправки заявки.</div>';
    return;
  }
  list.innerHTML = rows.map(rowHtmlClient).join("");
}
