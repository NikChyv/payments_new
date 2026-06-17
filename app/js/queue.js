import { state } from './state.js';
import { daysBetween, addDays, addMonths, fmtDate, fmtMoney, todayStr } from './dates.js';
import { save, removeRemote } from './supabase.js';
import { esc, toast, setText, genId } from './utils.js';

const recLbl = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};
const stLbl  = {new:"Новая", in_progress:"В работе", paid:"Оплачено", sent:"Документ отправлен"};
const stCls  = {new:"b-st-new", in_progress:"b-st-prog", paid:"b-st-paid", sent:"b-st-sent"};

export function activeOpen(it) {
  return it.status === "new" || it.status === "in_progress";
}

function urgency(it) {
  if (it.status === "paid") return {key:"green", lbl:"Оплачено", cls:""};
  if (it.status === "sent") return {key:"green", lbl:"Закрыто", cls:""};
  const d = daysBetween(it.due);
  if (d < 0)  return {key:"red",    lbl:"Просрочено на " + Math.abs(d) + " дн.", cls:"b-due-red"};
  if (d === 0)return {key:"orange", lbl:"Сегодня", cls:"b-due-orange"};
  if (d <= 3) return {key:"amber",  lbl:"Через " + d + " дн.", cls:"b-due-amber"};
  return {key:"gray", lbl:"Через " + d + " дн.", cls:""};
}

export function computeCounts() {
  let o = 0, today = 0, week = 0, prog = 0, doc = 0;
  state.items.forEach(it => {
    if (it.status === "paid" && it.needReceipt) doc++;
    if (!activeOpen(it)) return;
    const d = daysBetween(it.due);
    if (d < 0) o++;
    else if (d === 0) today++;
    else if (d <= 7) week++;
    if (it.status === "in_progress") prog++;
  });
  setText("cOverdue", o); setText("cToday", today);
  setText("cWeek", week); setText("cProg", prog); setText("cDoc", doc);

  const b = document.getElementById("banner");
  if (o + today > 0) {
    b.className = "banner show";
    b.textContent = "⚠ " +
      (o > 0 ? (o + " просрочено") : "") +
      (o > 0 && today > 0 ? ", " : "") +
      (today > 0 ? (today + " на сегодня") : "") +
      " — разберите в первую очередь.";
  } else {
    b.className = "banner";
  }
}

export function render() {
  computeCounts();
  const list = document.getElementById("list");
  const q  = (document.getElementById("search").value || "").toLowerCase().trim();
  const fc = document.getElementById("fClient").value;
  const fs = document.getElementById("fStatus").value;

  let rows = state.items.slice().filter(it => {
    if (fc && it.client !== fc) return false;
    if (fs === "active")    { if (!activeOpen(it)) return false; }
    else if (fs === "await_doc") { if (!(it.status === "paid" && it.needReceipt)) return false; }
    else if (fs !== "all") { if (it.status !== fs) return false; }
    if (state.quickFilter) {
      const d = daysBetween(it.due);
      if (state.quickFilter === "overdue"   && !(activeOpen(it) && d < 0))    return false;
      if (state.quickFilter === "today"     && !(activeOpen(it) && d === 0))   return false;
      if (state.quickFilter === "week"      && !(activeOpen(it) && d > 0 && d <= 7)) return false;
      if (state.quickFilter === "prog"      && it.status !== "in_progress")    return false;
      if (state.quickFilter === "await_doc" && !(it.status === "paid" && it.needReceipt)) return false;
    }
    if (q) {
      const hay = (it.client + " " + it.payee + " " + (it.purpose||"") + " " + (it.requisites||"")).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    const ao = activeOpen(a) ? 0 : 1, bo = activeOpen(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  });

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">Нет платежей по выбранному фильтру 🎉</div>';
    return;
  }
  list.innerHTML = rows.map(rowHtml).join("");
}

function rowHtml(it) {
  const u = urgency(it);
  const dueBadge  = u.cls ? `<span class="badge ${u.cls}">${u.lbl}</span>` : "";
  const fileBadge = it.file ? (it.file.url
    ? `<a class="badge b-file" href="${esc(it.file.url)}" target="_blank" rel="noopener" title="Открыть файл">📎 ${esc(it.file.name)}</a>`
    : `<span class="badge b-file" title="${esc(it.file.name)}">📎 ${esc(it.file.name)}</span>`) : "";
  const recBadge = it.recurrence !== "once" ? `<span class="badge b-rec">🔁 ${recLbl[it.recurrence]}</span>` : "";
  let receiptBadge = "";
  if (it.needReceipt && it.status !== "sent") {
    receiptBadge = it.status === "paid"
      ? '<span class="badge b-due-amber">📄 отправить документ</span>'
      : '<span class="badge b-rec">нужен документ</span>';
  }

  let acts = "";
  if (it.status === "new")
    acts = _btn("p","take","Взять в работу") + _btn("ok","pay","Отметить оплаченным");
  else if (it.status === "in_progress")
    acts = _btn("ok","pay","Отметить оплаченным") + _btn("soft","back","↩ Вернуть в «новые»");
  else if (it.status === "paid")
    acts = (it.needReceipt ? _btn("p","send","Документ отправлен клиенту") : _btn("soft","send","Закрыть"))
         + _btn("soft","unpay","↩ Отменить оплату");
  else if (it.status === "sent")
    acts = '<span class="badge b-st-sent" style="text-align:center;padding:9px">✓ Готово</span>'
         + _btn("soft","unsend","↩ Вернуть в «Оплачено»");
  acts += _btn("del","del","Удалить");

  return `<div class="row b-${u.key}" data-id="${it.id}">` +
    `<div class="main">` +
      `<div class="head"><span class="payee">${esc(it.payee)}</span><span class="amount">${fmtMoney(it.amount)}</span></div>` +
      `<div class="meta">` +
        `<span><b>${esc(it.client)}</b></span>` +
        `<span>📅 ${fmtDate(it.due)}</span>` +
        (it.requisites ? `<span>${esc(it.requisites)}</span>` : "") +
        (it.purpose    ? `<span>${esc(it.purpose)}</span>` : "") +
      `</div>` +
      `<div class="badges"><span class="badge ${stCls[it.status]}">${stLbl[it.status]}</span>${dueBadge}${recBadge}${receiptBadge}${fileBadge}</div>` +
    `</div>` +
    `<div class="acts">${acts}</div>` +
  `</div>`;
}

function _btn(kind, act, label) {
  return `<button class="btn ${kind}" data-act="${act}">${label}</button>`;
}

export function onListClick(e) {
  const b = e.target.closest && e.target.closest("button[data-act]");
  if (!b) return;
  const row = e.target.closest(".row");
  if (!row) return;
  const it = state.items.find(x => x.id === row.getAttribute("data-id"));
  if (!it) return;
  const act = b.getAttribute("data-act");

  if (act === "take")   { it.status = "in_progress"; toast("Взято в работу"); }
  else if (act === "back")   { it.status = "new";         toast("Возвращено в «Новые»"); }
  else if (act === "pay")    { markPaid(it); }
  else if (act === "send")   { it.status = "sent";        toast("Платёж закрыт"); }
  else if (act === "unpay")  { undoPaid(it); }
  else if (act === "unsend") { it.status = "paid";        toast("Возвращено в «Оплачено»"); }
  else if (act === "del") {
    if (!confirm("Удалить платёж?")) return;
    removeRemote(it.id);
    state.items = state.items.filter(x => x !== it);
  }
  save();
  render();
}

function nextDueOf(it) {
  return it.recurrence === "weekly" ? addDays(it.due, 7) : addMonths(it.due, 1);
}

export function markPaid(it) {
  it.status = "paid";
  let msg = "Отмечено как оплачено";
  if (it.recurrence !== "once") {
    const nextDue = nextDueOf(it);
    const copy = JSON.parse(JSON.stringify(it));
    copy.id = genId(); copy.status = "new"; copy.due = nextDue; copy.file = null; copy.created = todayStr();
    state.items.push(copy);
    msg = "Оплачено. Создан следующий платёж на " + fmtDate(nextDue);
  }
  toast(msg);
}

export function undoPaid(it) {
  it.status = "in_progress";
  let removed = false;
  if (it.recurrence !== "once") {
    const nd = nextDueOf(it);
    const idx = state.items.findIndex(c =>
      c !== it && c.status === "new" && c.recurrence === it.recurrence &&
      c.client === it.client && c.payee === it.payee &&
      Number(c.amount) === Number(it.amount) && c.due === nd
    );
    if (idx >= 0) { removeRemote(state.items[idx].id); state.items.splice(idx, 1); removed = true; }
  }
  toast(removed ? "Оплата отменена, следующий платёж удалён" : "Оплата отменена");
}
