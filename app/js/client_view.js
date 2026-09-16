import { sb, useRemote, fromRow, uploadFiles } from './supabase.js';
import { state } from './state.js';
import { esc, safeUrl, toast } from './utils.js';
import { fmtDate, fmtMoney } from './dates.js';
import { fileBadges, staffFileBadges } from './queue.js';
import { threadState } from './thread.js';

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

// Ответ клиента на вопрос бухгалтера. Файлы уходят тем же списком, что и в
// заявке: RPC положит их во вложения платежа, а не только в переписку — счёт
// нужен бухгалтеру там, где он платит.
export async function replyByToken(token, id, text, files) {
  const res = await sb.rpc("reply_by_token", {
    p_token: token,
    p_id:    id,
    p_text:  text || "",
    p_files: files || [],
  });
  if (res.error) throw res.error;
  return res.data;
}

// ---------- Рендер клиентского списка ----------

function activeOpen(it) { return it.status === "new" || it.status === "in_progress"; }

function clStatusInfo(it) {
  // Вопрос бухгалтера важнее стадии: пока на него не ответили, заявка стоит
  // именно из-за этого, и человек должен видеть причину, а не «ждёт оплаты».
  if (activeOpen(it) && threadState(it) === "waiting")
    return {cls:"s-ask", icon:"❓", text:"Бухгалтер ждёт вашего ответа"};
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

// Переписка на карточке заявки.
//
// Само поле ответа живёт НЕ здесь, а в окне за пределами #list: список
// перерисовывается поллингом раз в 15 секунд, и текст, который человек набирает,
// вместе с кареткой просто исчез бы на середине слова.
function clThreadHtml(it) {
  const list = it.thread || [];
  if (!list.length) return "";

  const waiting = threadState(it) === "waiting" && it.status !== "sent";
  const msgs = list.map(m => {
    const files = (m.files || [])
      .filter(f => f && f.url)
      .map(f => `<a class="th-file" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">📎 ${esc(f.name || "файл")}</a>`)
      .join("");
    return `<div class="th-msg ${m.who === "client" ? "cl" : "st"}">` +
      `<div class="th-who">${m.who === "client" ? "Вы" : "Бухгалтер"}</div>` +
      `<div class="th-text">${esc(m.text || "")}</div>` +
      (files ? `<div class="th-files">${files}</div>` : "") +
    `</div>`;
  }).join("");

  return `<div class="cl-thread${waiting ? " ask" : ""}">` +
    (waiting ? '<div class="cl-thread-h">❓ Бухгалтеру не хватает данных</div>' : "") +
    msgs +
    (waiting
      ? `<button class="cl-answer" data-clreply="${esc(it.id)}">✍️ Ответить бухгалтеру</button>`
      : "") +
  `</div>`;
}

function rowHtmlClient(it) {
  const done = it.status === "paid" || it.status === "sent";
  const s = clStatusInfo(it);
  const fileBadge = fileBadges(it);
  const recBadge = it.recurrence !== "once" ? `<span class="badge b-rec">🔁 ${recLbl[it.recurrence]}</span>` : "";
  // Пока заявка не взята в работу (status 'new') — клиент может её отредактировать.
  // Кроме заведённых бухгалтером: их сервер править не даст (M2.3), и кнопка
  // только обещала бы то, чего нет.
  const editBtn = it.status === "new" && !it.createdByStaff
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
      clThreadHtml(it) +
    `</div>` +
  `</div>`;
}

// ---------- Окно ответа клиента ----------

// Окно, а не поле прямо в карточке: #list переписывается поллингом каждые 15
// секунд, и набранный текст исчезал бы вместе с кареткой.
let replyFor = null;

export function openClientReply(it) {
  replyFor = it;
  const list = it.thread || [];
  const last = list[list.length - 1] || {};

  document.getElementById("clrPayee").textContent = it.payee || "";
  document.getElementById("clrQuestion").textContent = last.text || "";
  document.getElementById("clrText").value = "";
  const f = document.getElementById("clrFile");
  if (f) f.value = "";
  document.getElementById("clrBox").classList.remove("hidden");
  setTimeout(() => document.getElementById("clrText").focus(), 30);
}

export function closeClientReply() {
  document.getElementById("clrBox").classList.add("hidden");
  replyFor = null;
}

async function sendClientReply() {
  const it = replyFor;
  if (!it) return;
  const btn = document.getElementById("clrSend");
  const text = document.getElementById("clrText").value.trim();
  const input = document.getElementById("clrFile");
  const picked = input && input.files ? input.files : [];

  if (!text && !picked.length) { toast("Напишите ответ или приложите файл"); return; }

  btn.disabled = true;
  try {
    // файл грузим до RPC: она принимает уже готовые ссылки
    const files = picked.length ? await uploadFiles(picked) : [];
    if (picked.length && !files.length && !text) {
      toast("Файл не загрузился — попробуйте ещё раз");
      return;
    }
    await replyByToken(state.TOKEN, it.id, text, files);
    closeClientReply();
    await loadPaymentsByToken(state.TOKEN);
    renderClient();
    toast("Ответ отправлен бухгалтеру");
  } catch (e) {
    console.error(e);
    toast(e && e.message ? `Не отправилось: ${e.message}` : "Не отправилось — попробуйте ещё раз");
  } finally {
    btn.disabled = false;
  }
}

export function initClientReply() {
  const box = document.getElementById("clrBox");
  if (!box) return;
  box.addEventListener("click", e => {
    if (e.target === box) { closeClientReply(); return; }
    const b = e.target.closest && e.target.closest("button[data-clr]");
    if (!b) return;
    if (b.getAttribute("data-clr") === "close") closeClientReply();
    else sendClientReply();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) closeClientReply();
  });
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
