import { sb, useRemote, fromRow, uploadFiles } from './supabase.js';
import { state } from './state.js';
import { esc, safeUrl, toast } from './utils.js';
import { fmtDate, fmtMoney, todayStr, isoLocal } from './dates.js';
import { activeOpen } from './queue.js';
import { threadState } from './thread.js';

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

// ---------- Рендер клиентского списка: направление C «Фирменный» ----------
//
// Карточка на заявку. Классы с префиксом c-: #list общий с очередью, а у той
// свои q-*, — так правка одного экрана не задевает другой.

const recWord = {weekly:"еженедельно", monthly:"ежемесячно"};
const cents   = v => Math.round(Number(v) * 100) / 100;
const paidOf  = it => Number(it.paidAmount) || 0;

const SVG_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const SVG_CLIP  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.05-9.15 9.15a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.18 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.59l8.49-8.48"/></svg>';
const SVG_DOC   = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';

// Вопрос бухгалтера ждёт ответа. По закрытой (sent) заявке ответить уже
// нельзя — сервер не примет, значит и звать к ответу нечего.
const askOpen = it => threadState(it) === "waiting" && it.status !== "sent";

// Счёт ОТ клиента — голубой со скрепкой, документ ОТ бухгалтера — зелёный:
// в одной строке их путать нельзя.
function fileChips(list, doc) {
  return list.map(f => {
    const cls = `c-file${doc ? " doc" : ""}`;
    const body = (doc ? SVG_DOC : SVG_CLIP) + esc(f.name || (doc ? "документ" : "файл"));
    return f.url
      ? `<a class="${cls}" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener"${doc ? ' title="Платёжный документ"' : ""}>${body}</a>`
      : `<span class="${cls}">${body}</span>`;
  }).join("");
}

// Метка статуса. Класс — через мапу, а не именем статуса: в пробнике C стиль
// назывался .prog, а рендер ставил in_progress, и «в работе» выходила без цвета.
function pillOf(it) {
  if (activeOpen(it) && askOpen(it)) return ["ask", "Нужен ваш ответ"];
  if (it.status === "in_progress")    return ["prog", paidOf(it) > 0 ? "Оплачено частично" : "В работе"];
  if (it.status === "paid")           return ["ok", "Оплачено"];
  if (it.status === "sent")           return ["ok", it.needReceipt ? "Документ отправлен" : "Оплачено"];
  return ["new", "Принята"];
}

// Шаги. Без платёжного документа их три, и заявка готова уже на «Оплачено».
// Подписи шагов на телефоне прячутся — там вместо них строка словами.
function stepsHtml(it) {
  const labels = it.needReceipt ? ["Принята", "В работе", "Оплачено", "Документ"] : ["Принята", "В работе", "Оплачено"];
  const stage = ({new:1, in_progress:2, paid:3, sent:4})[it.status] || 1;
  const fullyDone = it.needReceipt ? it.status === "sent" : (it.status === "paid" || it.status === "sent");
  const html = labels.map((lab, i) => {
    const done = fullyDone || i + 1 < stage;
    const now  = !done && i + 1 === stage;
    return (i ? `<span class="c-bar${fullyDone || i < stage ? " done" : ""}"></span>` : "") +
      `<span class="c-st"><span class="c-dot${done ? " done" : now ? " now" : ""}">${done ? SVG_CHECK : i + 1}</span>` +
      `<span class="c-slab${done || now ? " on" : ""}">${lab}</span></span>`;
  }).join("");

  let words;
  if (fullyDone) words = it.status === "sent" && it.needReceipt ? "Готово · документ отправлен" : "Готово · оплачено";
  else {
    const what = askOpen(it) && activeOpen(it) ? "бухгалтер ждёт вашего ответа"
      : it.status === "new" ? "заявка принята, ждёт оплаты"
      : it.status === "in_progress" ? (paidOf(it) > 0 ? "оплачена часть" : "бухгалтер взял платёж в работу")
      : "платёж проведён, готовим документ";
    words = `Шаг ${Math.min(stage, labels.length)} из ${labels.length} · ${what}`;
  }
  return `<div class="c-track">${html}</div>` +
    `<div class="c-stepnow${fullyDone ? " ok" : ""}">${words}</div>`;
}

// Оплата по частям глазами клиента: сколько ушло, сколько осталось и до
// какого числа, и документ на каждую часть. Слова — те же, что в Telegram
// (notify-client), чтобы кабинет и сообщение не спорили. Кто из сотрудников
// проводил часть, клиенту не нужно.
function partsHtml(it) {
  const parts = it.parts || [];
  const paid = paidOf(it);
  if (!parts.length && paid <= 0) return "";
  const amount = Number(it.amount);
  const rest = Math.max(cents(amount - paid), 0);
  const over = cents(paid - amount);
  const pct = amount > 0 ? Math.min(100, Math.round(paid / amount * 100)) : 100;

  const right = activeOpen(it) && rest > 0
    ? `Остаток <b class="num">${fmtMoney(rest)}</b> — оплатим до ${fmtDate(it.due)}`
    : rest > 0 ? "Заявка закрыта"
    : over > 0 ? `Переплата ${fmtMoney(over)}` : "Оплачено полностью";

  const lines = parts.map(pt => {
    const docs = (it.staffFiles || []).filter(f => f.part_id === pt.id);
    return `<div class="c-part"><b class="num">${fmtMoney(pt.amount)}</b>` +
      `<span>${pt.at ? fmtDate(isoLocal(new Date(pt.at))) : ""}</span>` +
      (docs.length ? `<span class="c-files">${fileChips(docs, true)}</span>` : "") +
    `</div>`;
  }).join("");

  return `<div class="c-parts${activeOpen(it) ? "" : " closed"}">` +
    `<div class="c-parts-h"><span>Оплачено <b class="num">${fmtMoney(paid)}</b> из ${fmtMoney(amount)}</span><span>${right}</span></div>` +
    `<div class="c-pbar"><i style="width:${pct}%"></i></div>` +
    lines +
  `</div>`;
}

// Переписка на карточке. Поле ответа живёт НЕ здесь, а в окне #clrBox вне
// #list: список перерисовывается поллингом раз в 15 секунд, и набранный текст
// вместе с кареткой исчез бы на середине слова.
function threadHtml(it) {
  const list = it.thread || [];
  if (!list.length) return "";
  const asking = askOpen(it);
  const msgs = list.map((m, i) => {
    const last = asking && i === list.length - 1;
    const files = (m.files || []).filter(f => f && f.url);
    return `<div class="c-msg ${m.who === "client" ? "me" : "st"}${last ? " q" : ""}">` +
      `<span class="c-who">${m.who === "client" ? "Вы" : "Бухгалтер"}</span>` +
      `<div class="c-text">${esc(m.text || "")}</div>` +
      (files.length ? `<div class="c-files">${fileChips(files, false)}</div>` : "") +
    `</div>`;
  }).join("");

  return `<div class="c-thread${asking ? " ask" : ""}">` +
    `<div class="c-thread-h">${asking ? "❓ Бухгалтер спрашивает" : "Переписка с бухгалтером"}</div>` +
    msgs +
    (asking ? `<button class="c-b pri" data-clreply="${esc(it.id)}">Ответить бухгалтеру</button>` : "") +
  `</div>`;
}

function rowHtmlClient(it) {
  const done = it.status === "paid" || it.status === "sent";
  const partial = activeOpen(it) && paidOf(it) > 0;
  // Просрочку подсвечиваем только у непринятой в работу: взятая бухгалтером
  // заявка уже в руках, и красная рамка клиента бы только пугала.
  const late = it.status === "new" && it.due < todayStr();
  const cls = done ? " done" : activeOpen(it) && askOpen(it) ? " ask" : late ? " late" : "";
  const [pc, pt] = pillOf(it);

  const when = partial
    ? `Остаток до <b>${fmtDate(it.due)}</b>`
    : `Дата платежа <b>${fmtDate(it.due)}</b>` + (late ? ' · <span class="late">просрочен</span>' : "");

  const clientFiles = it.files || [];
  const plainDocs = (it.staffFiles || []).filter(f => !f.part_id);
  const files = clientFiles.length || plainDocs.length
    ? `<div class="c-files">${fileChips(clientFiles, false)}${fileChips(plainDocs, true)}</div>` : "";

  // «Исправить» — пока заявка не взята в работу, и не у заведённых
  // бухгалтером: их сервер править не даст (M2.3), кнопка обещала бы то, чего
  // нет. «Повторить» — с любой, в том числе давно оплаченной: именно этого и
  // просили — не вбивать одно и то же заново.
  const acts = [];
  if (it.status === "new" && !it.createdByStaff)
    acts.push(`<button class="c-b pri" data-edit="${esc(it.id)}">Исправить</button>`);
  acts.push(`<button class="c-b" data-dup="${esc(it.id)}">Повторить платёж</button>`);

  return `<article class="c-card${cls}">` +
    `<div class="c-r1">` +
      `<div class="c-who-col"><div class="c-nm">${esc(it.payee)}</div>` +
        `<div class="c-meta"><span>${when}</span>` +
          (recWord[it.recurrence] ? `<span>↻ ${recWord[it.recurrence]}</span>` : "") +
          (it.requisites ? `<span>${esc(it.requisites)}</span>` : "") +
        `</div></div>` +
      `<div class="c-right"><span class="c-pill ${pc}">${pt}</span>` +
        `<span class="c-amt num">${fmtMoney(it.amount)}</span></div>` +
    `</div>` +
    (it.purpose ? `<div class="c-purp">${esc(it.purpose)}</div>` : "") +
    files +
    partsHtml(it) +
    stepsHtml(it) +
    threadHtml(it) +
    `<div class="c-acts">${acts.join("")}</div>` +
  `</article>`;
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

  const sort = document.getElementById("clSort");
  if (sort) {
    sort.textContent = state.clSort === "asc" ? "↑ Сначала старые" : "↓ Сначала новые";
    sort.title = "Порядок по дате платежа — нажмите, чтобы поменять";
  }

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

  // Порядок по дате платежа выбирает сам клиент, по умолчанию сначала новые:
  // раньше оплаченные шли от старых к новым, и свежий платёж приходилось
  // листать в самый низ. Запланированные при этом всегда выше оплаченных —
  // иначе просроченный неоплаченный платёж со старой датой утонул бы среди
  // давно закрытых.
  const dir = state.clSort === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const ao = activeOpen(a) ? 0 : 1, bo = activeOpen(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.due < b.due ? -dir : a.due > b.due ? dir : 0;
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
      ? '<div class="c-empty"><b>По этому запросу платежей нет</b>' +
        '<p>Платежи есть, просто не попали под поиск или фильтр.</p>' +
        '<button class="c-b" id="clReset">Сбросить поиск и фильтр</button></div>'
      : '<div class="c-empty"><b>Заявок пока нет</b>' +
        '<p>Оставьте первое поручение — бухгалтер увидит его сразу.</p>' +
        '<button class="c-b pri" id="clNew">Новая заявка</button></div>';
    return;
  }
  list.innerHTML = rows.map(rowHtmlClient).join("");
}
