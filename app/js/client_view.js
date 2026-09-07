import { sb, useRemote, fromRow } from './supabase.js';
import { state } from './state.js';
import { esc } from './utils.js';
import { fmtDate, fmtMoney } from './dates.js';
import { fileBadges, staffFileBadges } from './queue.js';

const recLbl = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

// ---------- Supabase RPC (Шаг 7) ----------

export async function loadClientByToken(token) {
  if (!useRemote) return null;
  const res = await sb.rpc("client_by_token", {p_token: token});
  if (res.error || res.data == null) return null;
  return res.data; // text — название компании
}

export async function loadPaymentsByToken(token) {
  if (!useRemote) { state.items = []; return; }
  const res = await sb.rpc("list_payments_by_token", {p_token: token});
  if (res.error) { console.error(res.error); state.items = []; return; }
  state.items = (res.data || []).map(fromRow);
}

export async function submitPaymentByToken(token, payee, amount, requisites, due, recurrence, purpose, needReceipt, files) {
  const res = await sb.rpc("submit_payment", {
    p_token:        token,
    p_payee:        payee,
    p_amount:       amount,
    p_requisites:   requisites || null,
    p_due:          due,
    p_recurrence:   recurrence,
    p_purpose:      purpose    || null,
    p_need_receipt: needReceipt,
    p_file_url:     null,
    p_file_name:    null,
    p_files:        files || [],
  });
  if (res.error) throw res.error;
  return res.data; // id нового платежа
}

// Фича 2: клиент правит свою заявку, пока она 'new'.
// Файлы передаём полным списком — то, что клиент убрал в форме, исчезнет.
export async function editPaymentByToken(token, id, payee, amount, requisites, due, recurrence, purpose, needReceipt, files) {
  const res = await sb.rpc("edit_payment_by_token", {
    p_token:        token,
    p_id:           id,
    p_payee:        payee,
    p_amount:       amount,
    p_requisites:   requisites || null,
    p_due:          due,
    p_recurrence:   recurrence,
    p_purpose:      purpose    || null,
    p_need_receipt: needReceipt,
    p_file_url:     null,
    p_file_name:    null,
    p_files:        files || [],
  });
  if (res.error) throw res.error;
  return res.data;
}

// ---------- Рендер клиентского списка ----------

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
  const fileBadge = fileBadges(it);
  const recBadge = it.recurrence !== "once" ? `<span class="badge b-rec">🔁 ${recLbl[it.recurrence]}</span>` : "";
  // Пока заявка не взята в работу (status 'new') — клиент может её отредактировать.
  const editBtn = it.status === "new"
    ? `<button class="ghost cl-edit" data-edit="${esc(it.id)}">✏️ Редактировать</button>`
    : "";
  // Повторить платёж можно с любой заявки, в том числе давно оплаченной —
  // именно этого и просили: не вбивать одно и то же заново.
  const dupBtn = `<button class="ghost cl-edit" data-dup="${esc(it.id)}">⧉ Повторить</button>`;
  return `<div class="row b-${done ? "green" : "gray"}">` +
    `<div class="main">` +
      `<div class="head"><span class="payee">${esc(it.payee)}</span><span class="amount">${fmtMoney(it.amount)}</span></div>` +
      `<div class="meta">` +
        `<span>📅 ${fmtDate(it.due)}</span>` +
        (it.purpose    ? `<span>${esc(it.purpose)}</span>`    : "") +
        (it.requisites ? `<span>${esc(it.requisites)}</span>` : "") +
      `</div>` +
      `<div class="cl-status"><span class="cl-now ${s.cls}">${s.icon} ${s.text}</span>${recBadge}${fileBadge}${staffFileBadges(it)}${editBtn}${dupBtn}</div>` +
      clSteps(it) +
    `</div>` +
  `</div>`;
}

// ---------- Поиск и фильтр по своим платежам ----------

// Три группы кнопок-фильтров. Ключи совпадают с data-clf в разметке.
const CL_GROUPS = {
  all:  ()   => true,
  open: activeOpen,
  done: (it) => it.status === "paid" || it.status === "sent",
};

// Ищем по получателю и реквизитам. Отдельного поля УНП нет — он лежит строкой
// внутри реквизитов («УНП 191234567»), поэтому поиск по ним его и накрывает.
// Назначение платежа в поиск намеренно не входит.
function clMatch(it, q) {
  if (!q) return true;
  return (it.payee || "").toLowerCase().includes(q) ||
         (it.requisites || "").toLowerCase().includes(q);
}

// Счётчики на кнопках считаем по ВСЕМ платежам клиента и намеренно не сужаем
// строкой поиска: иначе цифры прыгали бы при каждой набранной букве. У
// бухгалтера карточки-счётчики устроены так же.
function syncClientTools(all) {
  const box = document.getElementById("clientTools");
  if (!box) return;
  // На пустом кабинете искать нечего — панель только мешала бы.
  box.classList.toggle("hidden", all.length === 0);
  if (!all.length) return;

  // Поллинг перерисовывает кабинет раз в 15 секунд; значение в поле трогаем,
  // только если оно разошлось с состоянием, чтобы не сбить каретку при наборе.
  const search = document.getElementById("clSearch");
  if (search && search.value !== state.clQuery) search.value = state.clQuery;

  box.querySelectorAll("button[data-clf]").forEach(btn => {
    const f = btn.getAttribute("data-clf");
    const on = state.clFilter === f;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const cnt = btn.querySelector(".cnt");
    if (cnt) cnt.textContent = all.filter(CL_GROUPS[f] || CL_GROUPS.all).length;
  });
}

// Сброс поиска и фильтра. Нужен не только по кнопке в пустом списке: после
// отправки новой заявки кабинет обещает «статус виден ниже», а под активным
// поиском или фильтром «Оплаченные» свежая заявка не отрисовалась бы.
export function resetClientFilter() {
  state.clQuery  = "";
  state.clFilter = "all";
  const search = document.getElementById("clSearch");
  if (search) search.value = "";
}

export function renderClient() {
  const list = document.getElementById("list");
  const all  = state.items;
  syncClientTools(all);

  const q = state.clQuery.trim().toLowerCase();
  const inGroup = CL_GROUPS[state.clFilter] || CL_GROUPS.all;
  // Фильтруем только на этапе рендера: state.items мутировать нельзя — кнопки
  // «Повторить» и «Редактировать» ищут заявку именно в нём, а не в DOM.
  const rows = all.filter(it => inGroup(it) && clMatch(it, q));

  // Пока не ищут — привычный порядок: открытые сверху, внутри группы по сроку.
  // Как только в поиске что-то ввели — свежие сверху: ищут обычно недавнее.
  rows.sort(q
    ? (a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0)
    : (a, b) => {
        const ao = activeOpen(a) ? 0 : 1, bo = activeOpen(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      });

  // Тихая подсказка: видно, что часть платежей скрыта фильтром, а не пропала.
  const shown = document.getElementById("clShown");
  if (shown) shown.textContent = rows.length < all.length
    ? `Показано ${rows.length} из ${all.length}`
    : "";

  if (rows.length === 0) {
    // При активном фильтре обещание «здесь появятся ваши платежи» было бы
    // враньём: платежи есть, просто не попали под условие.
    list.innerHTML = (q || state.clFilter !== "all")
      ? '<div class="empty">По этому запросу платежей нет.<br>' +
        '<button class="linkbtn" id="clReset">Сбросить поиск и фильтр</button></div>'
      : '<div class="empty">Здесь появятся ваши платежи после отправки заявки.</div>';
    return;
  }
  list.innerHTML = rows.map(rowHtmlClient).join("");
}
