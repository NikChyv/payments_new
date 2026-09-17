import { state } from './state.js';
import { daysBetween, addDays, addMonths, fmtDate, fmtDateShort, fmtNum, fmtMoney, todayStr, isoLocal } from './dates.js';
import { removeRemote, uploadFiles, changeStatusRemote, attachDocRemote, attachPartDocRemote,
         insertPaymentRemote, postStaffMessage, removeUntouchedCopyRemote,
         payPartRemote, undoPartRemote } from './supabase.js';
import { esc, safeUrl, toast, genId } from './utils.js';
import { threadState, threadHtml, openThread } from './thread.js';

// Очередь бухгалтера — направление B «Выписка» (редизайн, шаг 5): таблица,
// одна кнопка главного действия в строке, остальное за «…» и в раскрытии.
// Решения по виду — docs/REDESIGN.md §1, §5, §5а.

// экспортируются: те же подписи идут в выгрузку Excel (export.js)
export const recLbl = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};
export const stLbl  = {new:"Новая", in_progress:"В работе", paid:"Оплачено", sent:"Документ отправлен"};

export function activeOpen(it) {
  return it.status === "new" || it.status === "in_progress";
}

// ---------- оплата по частям: числа ----------
// Частичная оплата — не статус, а число: пока остаток больше нуля, заявка
// «в работе». Недоплата — тоже не статус: заявка закрыта, а оплачено меньше
// суммы. Считаем в копейках, иначе 340 − 140.1 даёт 199.89999999999998.

const cents = v => Math.round(Number(v) * 100) / 100;
const paidOf = it => Number(it.paidAmount) || 0;

export function restOf(it) {
  const r = cents(Number(it.amount) - paidOf(it));
  return r > 0 ? r : 0;
}
const hasParts  = it => (it.parts || []).length > 0;
const partly    = it => paidOf(it) > 0 && restOf(it) > 0;
const underpaid = it => !activeOpen(it) && paidOf(it) > 0 && restOf(it) > 0;
const lastPart  = it => hasParts(it) ? it.parts[it.parts.length - 1] : null;

// ---------- срочность: один сигнал — красная дата и мягкая заливка ----------
function urgency(it) {
  if (!activeOpen(it)) return {k:"", lbl:"—"};
  const d = daysBetween(it.due);
  if (d < 0)  return {k:"crit", lbl:"просрочено " + Math.abs(d) + " дн."};
  if (d === 0)return {k:"warn", lbl:"сегодня до 17:00"};
  if (d === 1)return {k:"",     lbl:"завтра"};
  return {k:"", lbl:"через " + d + " дн."};
}

// ---------- фильтры ----------

function passStatus(it, fs) {
  if (fs === "active")    return activeOpen(it);
  if (fs === "await_doc") return it.status === "paid" && it.needReceipt;
  if (fs === "all")       return true;
  return it.status === fs;
}

function passQuick(it, qf) {
  if (!qf) return true;
  const d = daysBetween(it.due);
  // "due" — всё, что уже пора делать: просроченные + сегодняшние
  if (qf === "due")       return activeOpen(it) && d <= 0;
  if (qf === "overdue")   return activeOpen(it) && d < 0;
  if (qf === "today")     return activeOpen(it) && d === 0;
  if (qf === "prog")      return it.status === "in_progress";
  if (qf === "waiting")   return activeOpen(it) && threadState(it) === "waiting";
  if (qf === "await_doc") return it.status === "paid" && it.needReceipt;
  return true;
}

const isPersonal = it => !it.client_id && !!it.createdByStaff;

function passSearch(it, q) {
  if (!q) return true;
  const hay = ((isPersonal(it) ? "личная задача " : "") + (it.client || "") + " " + it.payee + " " +
               (it.purpose || "") + " " + (it.requisites || "")).toLowerCase();
  return hay.indexOf(q) >= 0;
}

// Все числа — по выбранному клиенту. Иначе «к оплате сегодня» показывает сумму
// по всей очереди, когда в списке остался один клиент, а «Просрочено 3» во
// вкладке ведёт в пустой список. Деньги — по остатку: в день доплаты в банк
// несут остаток, а не сумму заявки.
export function computeCounts() {
  const fc = document.getElementById("fClient").value;
  const fs = document.getElementById("fStatus").value;
  const c = {overdue:0, today:0, due:0, week:0, prog:0, wait:0, doc:0, all:0, total:0, dueSum:0, openSum:0};
  state.items.forEach(it => {
    if (fc && it.client !== fc) return;
    c.total++;
    if (passStatus(it, fs)) c.all++;
    if (it.status === "paid" && it.needReceipt) c.doc++;
    if (!activeOpen(it)) return;
    // «Ждут ответа» — только открытые: по закрытой ждать нечего
    if (threadState(it) === "waiting") c.wait++;
    const d = daysBetween(it.due), r = restOf(it);
    c.openSum += r;
    if (d < 0)       { c.overdue++; c.due++; c.dueSum += r; }
    else if (d === 0){ c.today++;   c.due++; c.dueSum += r; }
    else if (d <= 7) c.week++;
    if (it.status === "in_progress") c.prog++;
  });
  return c;
}

// «Ближайшие 7 дней» вкладкой нет — в них ничего не делают; это справочный
// счётчик в шапке. Просроченное и сегодняшнее — и вместе (стартовая), и
// порознь: разная срочность и разное настроение работы.
const TABS = [
  {k:"due",       t:"Нужно сегодня",      cls:"crit", n:c => c.due},
  {k:"overdue",   t:"Просрочено",         cls:"crit", n:c => c.overdue},
  {k:"today",     t:"Сегодня",            cls:"warn", n:c => c.today},
  {k:"prog",      t:"В работе",           cls:"",     n:c => c.prog},
  {k:"waiting",   t:"Ждут ответа",        cls:"hold", n:c => c.wait},
  {k:"await_doc", t:"Отправить документ", cls:"",     n:c => c.doc},
  {k:"",          t:"Все",                cls:"",     n:c => c.all},
];

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function renderTop(c, fc) {
  document.getElementById("qBig").innerHTML = fmtNum(c.dueSum) + "<small>Br</small>";
  const base = c.due === 0
    ? "Просроченного и сегодняшнего нет — можно заняться ближайшими"
    : "Просроченные и сегодняшние заявки, по остатку к оплате";
  document.getElementById("qBigSub").innerHTML = fc
    ? `<b>Только ${esc(fc)}</b> · ${base.charAt(0).toLowerCase() + base.slice(1)}`
    : base;
  document.getElementById("qKv").innerHTML =
    `<div><b class="crit num">${c.overdue}</b><span>просрочено</span></div>` +
    `<div><b class="warn num">${c.today}</b><span>на сегодня</span></div>` +
    `<div><b class="hold num">${c.wait}</b><span>ждут ответа</span></div>` +
    `<div><b class="num">${c.week}</b><span>ближайшие 7 дней</span></div>` +
    `<div><b class="num">${c.prog}</b><span>в работе</span></div>` +
    `<div><b class="num">${fmtNum(c.openSum)}</b><span>всего в очереди, Br</span></div>`;
  document.getElementById("qFilters").innerHTML = TABS.map(f =>
    `<button class="q-f ${state.quickFilter === f.k ? "on " : ""}${f.cls}" data-f="${f.k}"` +
    ` aria-pressed="${state.quickFilter === f.k}"><i></i>${f.t}<span class="n num">${f.n(c)}</span></button>`
  ).join("");
}

function emptyHtml() {
  const qf = document.getElementById("search").value.trim() || document.getElementById("fClient").value
    ? "filtered" : state.quickFilter;
  const [head, sub] = {
    due:     ["На сегодня всё закрыто, просроченных нет", "Будущие платежи — во вкладке «Все»."],
    overdue: ["Просроченного нет", "Дальше — вкладка «Сегодня»."],
    today:   ["На сегодня всё закрыто", "Будущие платежи — во вкладке «Все»."],
    waiting: ["Вопросов без ответа нет", "Спросить клиента можно из меню «…» у заявки."],
  }[qf] || ["По этому фильтру ничего нет", "Попробуйте снять фильтр или очистить поиск."];
  return `<div class="q-empty"><b>${head}</b>${sub}</div>`;
}

export function render() {
  const fc = document.getElementById("fClient").value;
  const fs = document.getElementById("fStatus").value;
  const q  = (document.getElementById("search").value || "").toLowerCase().trim();
  const c  = computeCounts();
  renderTop(c, fc);

  // Фильтруем только на рендере, state.items не трогаем: от него живут
  // «Повторить» и «Редактировать».
  const rows = state.items.filter(it =>
    (!fc || it.client === fc) && passStatus(it, fs) && passQuick(it, state.quickFilter) && passSearch(it, q));
  rows.sort((a, b) => {
    const ao = activeOpen(a) ? 0 : 1, bo = activeOpen(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  });

  document.getElementById("list").innerHTML = rows.length ? rows.map(rowHtml).join("") : emptyHtml();
  document.getElementById("qFoot").textContent =
    `${rows.length} ${plural(rows.length, "заявка", "заявки", "заявок")} в списке · ` +
    `${fc ? "у этого клиента всего" : "всего в очереди"} ${c.total}`;
}

// ---------- значки и вложения ----------

const CLIP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.18 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.6l8.49-8.48"/></svg>';
const DOC  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
const DOTS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
const REC  = t => `<svg class="rec" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" role="img" aria-label="${t}"><title>${t}</title><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`;

// Используются кабинетом клиента (client_view.js) — до его переноса (шаг 6)
// в старом виде.
export function fileBadges(it) {
  return (it.files || []).map(f => f.url
    ? `<a class="badge b-file" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" title="Открыть файл">📎 ${esc(f.name || "файл")}</a>`
    : `<span class="badge b-file" title="${esc(f.name || "файл")}">📎 ${esc(f.name || "файл")}</span>`
  ).join("");
}

export function staffFileBadges(it) {
  return (it.staffFiles || []).map(f => f.url
    ? `<a class="badge b-doc" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" title="Платёжный документ">📄 ${esc(f.name || "документ")}</a>`
    : `<span class="badge b-doc">📄 ${esc(f.name || "документ")}</span>`
  ).join("");
}

// Счёт ОТ клиента и платёжка ДЛЯ него лежат рядом — разные иконки и цвет,
// путать их нельзя.
function fileLinks(list, doc) {
  return list.map(f => f.url
    ? `<a class="q-file${doc ? " doc" : ""}" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${doc ? DOC : CLIP}${esc(f.name || (doc ? "документ" : "файл"))}</a>`
    : `<span class="q-file${doc ? " doc" : ""}">${doc ? DOC : CLIP}${esc(f.name || "файл")}</span>`
  ).join("");
}

const tag = (cls, t) => `<span class="q-tag${cls ? " " + cls : ""}">${t}</span>`;

// ---------- действия строки ----------

// Что человек видел в момент отрисовки. Уходит в условие записи: не совпало —
// заявку тронули, пока он смотрел, и писать поверх нельзя. Для меню «…» это
// особенно важно: оно открыто дольше, чем живёт строка между опросами.
function seenAttrs(it) {
  const lp = lastPart(it);
  return ` data-id="${esc(it.id)}" data-st="${esc(it.status)}" data-paid="${paidOf(it)}"` +
    (lp ? ` data-part="${esc(lp.id)}"` : "") +
    (lp && restOf(it) === 0 ? ` data-full="1"` : "");
}

// Главное действие — одно на строку. Пока ждём ответа клиента, это «Напомнить»
// (кроме закрытых — там ответить уже нельзя, M7.2).
function primaryOf(it, ts) {
  if (it.status === "sent") return null;
  if (ts === "waiting")            return {a:"remind", t:"🔔 Напомнить", c:"hold"};
  if (it.status === "new")         return {a:"take",   t:"В работу",    c:""};
  // с частичной оплатой подпись честнее: платят остаток, а не всю сумму
  if (it.status === "in_progress") return {a:"pay",    t:partly(it) ? "Остаток оплачен" : "Оплачено", c:"done"};
  if (it.status === "paid")        return it.needReceipt
    // коротко: колонка действия мерена по «Остаток оплачен» (208 px, зазор
    // 38 px до суммы на 961), «Приложить документ» вылезал на сумму на 19 px.
    // Полная подпись — в подсказке, в меню и в раскрытии.
    ? {a:"attach", t:"📄 Документ", c:"", title:"Приложить платёжный документ — клиент получит его в Telegram"}
    : {a:"send",   t:"Закрыть",            c:""};
  return null;
}

// Все переходы по статусу и частям, которые есть у заявки сейчас. Главное
// действие из этого списка в меню не дублируется.
function statusActions(it, ts) {
  const a = [], st = it.status, p = partly(it);
  if (ts === "waiting" && st !== "sent") a.push(["remind", "🔔 Напомнить"]);
  if (st === "new") a.push(["take", "Взять в работу"]);
  if (activeOpen(it)) {
    a.push(["pay", p ? "Остаток оплачен" : "Отметить оплаченной"]);
    // платят кусками заметно реже, чем целиком, — поэтому здесь, а не в строке
    a.push(["part", p ? "Оплатить ещё часть…" : "Оплатить часть…"]);
    if (hasParts(it)) a.push(["unpart", "Отменить последнюю часть"]);
    if (p)            a.push(["close_under", "Закрыть с недоплатой"]);
  }
  // «Вернуть в новые» с оплаченными частями — бессмыслица: деньги уже ушли
  if (st === "in_progress" && !hasParts(it)) a.push(["back", "Вернуть в «новые»"]);
  if (st === "paid") {
    if (it.needReceipt) a.push(["attach", "📄 Приложить документ"]);
    a.push(["send", it.needReceipt ? "Закрыть без файла" : "Закрыть"]);
    a.push(["unpay", "Отменить оплату", "bad"]);
  }
  if (st === "sent") a.push(["unsend", "Вернуть в «Оплачено»"]);
  return a;
}

function threadAction(it, ts) {
  const n = (it.thread || []).length;
  if (it.status === "sent") return n ? ["thread", `💬 Переписка (${n})`] : null;
  return ["thread", ts === "none" ? "❓ Спросить клиента…" : `💬 Переписка (${n})`];
}

function rowHtml(it) {
  const u = urgency(it);
  const open = state.openId === it.id;
  const ts = it.status === "sent" ? "none" : threadState(it);
  const p = primaryOf(it, ts);
  const seen = seenAttrs(it);

  const cli = isPersonal(it) ? '<span class="q-self">личная задача</span>' : esc(it.client || "—");

  // Статуса колонкой нет: в девяти строках из десяти там было бы «принята».
  // Метка у получателя — только когда статус не «принята».
  let tags = "";
  if (ts === "waiting")       tags += tag("hold", "⏸ ждём ответ");
  else if (ts === "answered") tags += tag("reply", "💬 клиент ответил");
  if (it.status === "in_progress" || (it.status === "new" && paidOf(it) > 0))
    tags += partly(it) ? tag("part", "частично") : tag("", "в работе");
  else if (it.status === "paid")
    tags += tag("ok", "оплачено") + (underpaid(it) ? tag("under", "с недоплатой") : "") +
            (it.needReceipt ? tag("warn", "нужен документ") : "");
  else if (it.status === "sent")
    tags += tag("ok", "закрыта") + (underpaid(it) ? tag("under", "с недоплатой") : "");

  const nf = (it.files || []).length, nd = (it.staffFiles || []).length;
  const clips =
    (nf ? `<button class="q-clip" data-files="${esc(it.id)}" title="Вложения клиента" aria-label="Вложения клиента: ${nf}">${CLIP}${nf}</button>` : "") +
    (nd ? `<button class="q-clip doc" data-files="${esc(it.id)}" title="Платёжные документы" aria-label="Платёжные документы: ${nd}">${DOC}${nd}</button>` : "");

  const rec = it.recurrence !== "once" ? REC(recLbl[it.recurrence]) : "";

  // Крупно — то, что понесут в банк: у открытой заявки остаток. Полная сумма
  // и оплаченное — строкой мельче, это справка, а не действие.
  const amt = activeOpen(it) ? restOf(it) : it.amount;
  const amtSub = paidOf(it) > 0
    ? `<span class="q-rest">оплачено ${fmtNum(paidOf(it))} из ${fmtNum(it.amount)}</span>` : "";

  let h = `<div class="qr${u.k ? " u-" + u.k : ""}${open ? " open" : ""}" data-id="${esc(it.id)}" tabindex="0" aria-expanded="${open}">` +
    `<div class="q-c-cli"><div class="q-cli">${cli}</div></div>` +
    `<div class="q-c-payee"><div class="q-payee">${esc(it.payee)}${tags}${clips}</div>` +
      (it.requisites ? `<div class="q-req">${esc(it.requisites)}</div>` : "") + `</div>` +
    `<div class="q-c-purp"><div class="q-purp${it.purpose ? "" : " mut"}">${esc(it.purpose) || "не указано"}</div></div>` +
    `<div class="q-c-due q-due ${u.k}"><b class="num">${fmtDateShort(it.due)}${rec}</b><span>${u.lbl}</span></div>` +
    `<div class="q-c-amt r q-amt${activeOpen(it) ? "" : " done"} num">${fmtNum(amt)}${amtSub}</div>` +
    `<div class="q-acts">` +
      (p ? `<button class="q-go ${p.c}" data-act="${p.a}"${seen}${p.title ? ` title="${p.title}"` : ""}>${p.t}</button>` : "") +
      `<button class="q-more" data-menu="${esc(it.id)}" aria-label="Ещё действия" aria-haspopup="menu">${DOTS}</button>` +
    `</div>`;

  if (open) h += detHtml(it, ts, seen);
  return h + `</div>`;
}

function partsHtml(it, seen) {
  if (!hasParts(it)) return "";
  const paid = paidOf(it), rest = restOf(it), over = cents(paid - Number(it.amount));
  const canDoc = it.status !== "sent";
  const lines = it.parts.map(pt => {
    const docs = (it.staffFiles || []).filter(f => f.part_id === pt.id);
    return `<div class="q-part"><b class="num">${fmtNum(pt.amount)}</b>` +
      `<span>${pt.at ? fmtDateShort(isoLocal(new Date(pt.at))) : ""} · ${esc(pt.by_name || "сотрудник")}</span>` +
      (docs.length ? `<span class="q-files">${fileLinks(docs, true)}</span>` : "") +
      (canDoc ? `<button class="q-link" data-act="partdoc" data-part-doc="${esc(pt.id)}"${seen}>📄 документ на часть</button>` : "") +
    `</div>`;
  }).join("");
  const tail = rest > 0
    ? `<div class="q-part left"><b class="num">${fmtNum(rest)}</b><span>` +
      (activeOpen(it) ? `остаток, планируем ${fmtDate(it.due)}` : "не доплачено, заявка закрыта") + `</span></div>`
    : `<div class="q-part"><span>оплачено полностью${over > 0 ? `, переплата ${fmtMoney(over)}` : ""}</span></div>`;
  const pct = Math.min(100, Math.round(paid / Number(it.amount) * 100)) || 0;
  // История частей: клиент первым делом спросит «а когда те 200 ушли».
  return `<div class="full"><div class="q-dk">Оплата по частям</div>` +
    `<div class="q-parts">${lines}${tail}</div>` +
    `<div class="q-bar"><i style="width:${pct}%"></i></div></div>`;
}

function detHtml(it, ts, seen) {
  const who = isPersonal(it) ? "личная задача — видна только вам"
    : it.createdByStaff ? "сотрудник (клиент её не редактирует)" : "клиент";
  const clientFiles = it.files || [];
  const plainDocs = (it.staffFiles || []).filter(f => !f.part_id);

  const btns = statusActions(it, ts).map(([a, t, cls]) =>
    `<button class="q-mini${cls ? " " + cls : ""}" data-act="${a}"${seen}>${t}</button>`);
  const th = threadAction(it, ts);
  if (th) btns.push(`<button class="q-mini" data-act="${th[0]}"${seen}>${th[1]}</button>`);
  btns.push(`<button class="q-mini" data-edit="${esc(it.id)}">Редактировать</button>`,
            `<button class="q-mini" data-dup="${esc(it.id)}">Дублировать</button>`,
            `<button class="q-mini bad" data-act="del"${seen}>Удалить</button>`);

  return `<div class="q-det"><div class="q-in">` +
    `<div><div class="q-dk">Назначение</div><div class="q-dv${it.purpose ? "" : " mut"}">${esc(it.purpose) || "не указано"}</div></div>` +
    `<div><div class="q-dk">Реквизиты</div><div class="q-dv${it.requisites ? "" : " mut"}">${esc(it.requisites) || "не указаны"}</div></div>` +
    `<div><div class="q-dk">Срок и периодичность</div><div class="q-dv">${fmtDate(it.due)} · ${recLbl[it.recurrence] || "—"}</div></div>` +
    `<div><div class="q-dk">Документ после оплаты</div><div class="q-dv${it.needReceipt ? "" : " mut"}">${it.needReceipt ? "нужен клиенту" : "не нужен"}</div></div>` +
    `<div><div class="q-dk">Сумма заявки</div><div class="q-dv num">${fmtMoney(it.amount)}</div></div>` +
    `<div><div class="q-dk">Кто завёл</div><div class="q-dv">${who}</div></div>` +
    `<div class="full"><div class="q-dk">Вложения</div>` +
      (clientFiles.length || plainDocs.length
        ? `<div class="q-files">${fileLinks(clientFiles, false)}${fileLinks(plainDocs, true)}</div>`
        : `<div class="q-dv mut">нет</div>`) + `</div>` +
    partsHtml(it, seen) +
    ((it.thread || []).length
      ? `<div class="full"><div class="q-dk">Переписка по заявке</div><div class="q-thread">${threadHtml(it)}</div></div>` : "") +
    `<div class="full q-btns">${btns.join("")}</div>` +
  `</div></div>`;
}

// ---------- меню «…» и вложения ----------

let downX = 0, downY = 0;

function menuEl() { return document.getElementById("qMenu"); }

export function hideMenu() {
  const m = menuEl();
  if (m) { m.classList.add("hidden"); m.innerHTML = ""; }
}

function placeMenu(anchor) {
  const m = menuEl();
  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 10) top = r.top - h - 6;
  m.style.left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10)) + "px";
  m.style.top  = Math.max(10, top) + "px";
}

function showMenu(anchor) {
  const it = state.items.find(x => x.id === anchor.getAttribute("data-menu"));
  if (!it) return;
  const ts = it.status === "sent" ? "none" : threadState(it);
  const p = primaryOf(it, ts), seen = seenAttrs(it);
  const item = ([a, t, cls]) =>
    `<button role="menuitem" class="${cls || ""}" data-act="${a}"${seen}>${t}</button>`;

  const st = statusActions(it, ts).filter(([a]) => !p || a !== p.a).map(item).join("");
  const th = threadAction(it, ts);
  menuEl().innerHTML =
    (st ? st + "<hr>" : "") +
    (th ? item(th) : "") +
    `<button role="menuitem" data-edit="${esc(it.id)}">Редактировать заявку</button>` +
    `<button role="menuitem" data-dup="${esc(it.id)}">Дублировать</button>` +
    `<hr>` + item(["del", "Удалить", "bad"]);
  placeMenu(anchor);
}

function showFiles(anchor) {
  const it = state.items.find(x => x.id === anchor.getAttribute("data-files"));
  if (!it) return;
  const files = it.files || [], docs = it.staffFiles || [];
  menuEl().innerHTML =
    (files.length ? `<div class="q-mhead">Вложения клиента — ${files.length}</div>${fileLinks(files, false)}` : "") +
    (docs.length  ? `<div class="q-mhead">Платёжные документы — ${docs.length}</div>${fileLinks(docs, true)}` : "");
  placeMenu(anchor);
}

// ---------- клики ----------

// Заявку тронул кто-то другой. Молча перезаписывать нельзя — из этого и росла
// двойная оплата: бухгалтер видел «в работе» у уже оплаченного платежа.
function reportConflict(current, seen) {
  if (!current) { toast("Заявку тем временем удалили — экран обновлён"); return; }
  if (seen && current.status === seen.status && paidOf(current) !== seen.paid) {
    toast(`Заявку тем временем изменили — оплачено уже ${fmtMoney(paidOf(current))}. Экран обновлён`);
    return;
  }
  toast(`Заявку тем временем изменили — сейчас «${stLbl[current.status] || current.status}». Экран обновлён`);
}

// Отказ pay_part / undo_part. Текст — из базы, но «обновите экран» там писан
// для любого вызывающего; мы строку уже перечитали (partRpc).
function rpcFailText(res) {
  return (res.message || "Не записалось").replace(/ — обновите экран$/, "") + " — экран обновлён";
}

// Клики по #list и по меню «…». Правку и дубликат разбирает main.js до нас.
export async function onListClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  const fb = t.closest("button[data-files]");
  if (fb) { showFiles(fb); return; }
  const mb = t.closest("button[data-menu]");
  if (mb) {
    const m = menuEl();
    const same = !m.classList.contains("hidden") && m.getAttribute("data-for") === mb.getAttribute("data-menu");
    if (same) { hideMenu(); return; }
    showMenu(mb);
    m.setAttribute("data-for", mb.getAttribute("data-menu"));
    return;
  }
  const b = t.closest("button[data-act]");
  if (b) { hideMenu(); await runAction(b); return; }

  toggleRow(e);
}

// Реквизиты и суммы копируют в банк-клиент, поэтому выделение текста важнее
// раскрытия строки: мышь проехала больше 4 px, что-то выделено или это
// двойной клик по слову — строку не трогаем. Клики внутри раскрытия её тоже
// не сворачивают: там читают и копируют.
function toggleRow(e) {
  const t = e.target;
  const row = t.closest(".qr");
  if (!row || t.closest("a,button,input,select,textarea,.q-det")) return;
  if (e.detail > 1) return;
  if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
  const sel = window.getSelection ? String(window.getSelection()) : "";
  if (sel.length) return;
  toggleOpen(row.getAttribute("data-id"), false);
}

function toggleOpen(id, keepFocus) {
  state.openId = state.openId === id ? null : id;
  render();
  if (keepFocus) {
    const row = document.querySelector(`.qr[data-id="${CSS.escape(id)}"]`);
    if (row) row.focus();
  }
}

function seenOf(b, it) {
  const paid = b.getAttribute("data-paid");
  return {
    status: b.getAttribute("data-st") || it.status,
    paid: paid === null ? paidOf(it) : Number(paid),
    part: b.getAttribute("data-part"),
    full: b.hasAttribute("data-full"),
  };
}

// Куда ведёт каждая простая кнопка. Ожидаемый статус в условие update берём не
// отсюда, а из того, что человек видел в момент клика.
const MOVES = {
  take:   {to: "in_progress", msg: "Взято в работу"},
  back:   {to: "new",         msg: "Возвращено в «новые»"},
  send:   {to: "sent",        msg: "Платёж закрыт"},
  unsend: {to: "paid",        msg: "Возвращено в «Оплачено»"},
};

async function runAction(b) {
  const act = b.getAttribute("data-act");
  const it = state.items.find(x => x.id === b.getAttribute("data-id"));
  if (!it) return;
  const seen = seenOf(b, it);

  // Переписка дописывается на сервере отдельной RPC: параллельный ответ клиента
  // так не теряется.
  if (act === "thread")  { openThread(it, render); return; }
  if (act === "remind")  { remindClient(it); return; }
  if (act === "attach")  { attachDocument(it, seen); return; }
  if (act === "partdoc") { attachPartDocument(it, seen, b.getAttribute("data-part-doc")); return; }
  if (act === "part")    { openPartDialog(it, seen); return; }

  if (act === "del") {
    if (!confirm(`Удалить заявку «${it.payee}»?`)) return;
    try { await removeRemote(it.id); }
    catch (err) { console.error(err); toast("Не удалось удалить — попробуйте ещё раз"); return; }
    state.items = state.items.filter(x => x !== it);
    if (state.openId === it.id) state.openId = null;
    render();
    return;
  }

  try {
    if (act === "pay")         await payFull(it, seen);
    else if (act === "close_under") await closeUnderpaid(it, seen);
    else if (act === "unpay")  await undoPaid(it, seen);
    else if (act === "unpart") await undoLastPart(it, seen);
    else if (MOVES[act]) {
      const res = await changeStatusRemote(it, seen.status, MOVES[act].to);
      if (!res.ok) reportConflict(res.current, seen);
      else toast(MOVES[act].msg);
    }
  } catch (err) {
    console.error(err);
    toast("Ошибка записи в базу");
  }
  render();
}

// «Оплачено» / «Остаток оплачен». Если части уже были, остаток записывается
// такой же частью: в истории сходятся суммы, а «Отменить оплату» потом снимет
// именно её. Без частей — обычная смена статуса, но с проверкой, что частей
// за это время не появилось: иначе заявку с недоплатой закрыли бы как целую.
async function payFull(it, seen) {
  if (seen.paid > 0) {
    const rest = cents(Number(it.amount) - seen.paid);
    const res = await payPartRemote(it, rest, null, seen.paid);
    if (!res.ok) { toast(rpcFailText(res)); return; }
    if (it.status === "paid") await afterPaid(it, `«${it.payee}» оплачена полностью`);
    return;
  }
  const res = await changeStatusRemote(it, seen.status, "paid", seen.paid);
  if (!res.ok) { reportConflict(res.current, seen); return; }
  await afterPaid(it, "Отмечено как оплачено");
}

// Сумму заявки не ужимаем: клиент просил столько, сколько просил, — ужать
// задним числом значит сделать историю неправдой. Недоплата видна из чисел.
async function closeUnderpaid(it, seen) {
  const rest = cents(Number(it.amount) - seen.paid);
  if (!confirm(`Закрыть «${it.payee}» с недоплатой?\n\nОплачено ${fmtMoney(seen.paid)} из ${fmtMoney(it.amount)}, ` +
               `остаток ${fmtMoney(rest)} платить не будем. Клиенту уйдёт «оплачено ${fmtNum(seen.paid)} из ${fmtNum(it.amount)}».`)) return;
  const res = await changeStatusRemote(it, seen.status, "paid", seen.paid);
  if (!res.ok) { reportConflict(res.current, seen); return; }
  await afterPaid(it, `Закрыто с недоплатой: оплачено ${fmtNum(seen.paid)} из ${fmtMoney(it.amount)}`);
}

// «Отменить оплату». Закрыла заявку последняя часть — отменяем её (остаток и
// дата — как до неё). Закрыли с недоплатой или без частей — просто возвращаем
// в работу: части, прошедшие до закрытия, остаются.
async function undoPaid(it, seen) {
  if (seen.full && seen.part) {
    const res = await undoPartRemote(it, seen.part);
    if (!res.ok) { toast(rpcFailText(res)); return; }
  } else {
    const res = await changeStatusRemote(it, seen.status, "in_progress", seen.paid);
    if (!res.ok) { reportConflict(res.current, seen); return; }
  }
  await afterUndoPaid(it);
}

async function undoLastPart(it, seen) {
  const part = (it.parts || []).find(p => p.id === seen.part);
  if (!confirm(`Отменить последнюю часть${part ? " " + fmtMoney(part.amount) : ""}?\n\n` +
               "Остаток и дата остатка вернутся к тому, что было до неё. Клиенту об этом не сообщается.")) return;
  const res = await undoPartRemote(it, seen.part);
  if (!res.ok) { toast(rpcFailText(res)); return; }
  toast(`Часть отменена — остаток снова ${fmtMoney(restOf(it))}, срок ${fmtDate(it.due)}`);
}

// Следующий повторяющийся — от исходной даты (аренда 15-го → 15-го), а не от
// даты остатка: при частях она лежит в due_before первой части.
function nextDueOf(it) {
  const base = hasParts(it) && it.parts[0].due_before ? it.parts[0].due_before : it.due;
  return it.recurrence === "weekly" ? addDays(base, 7) : addMonths(base, 1);
}

// Напоминание в один клик из строки очереди.
//
// Два напоминания подряд не отправляем: клиент получит их в Telegram
// одинаковыми сообщениями и решит, что бот сломался. Хочется дожать — есть
// переписка, там можно написать словами.
async function remindClient(it) {
  const list = it.thread || [];
  const last = list[list.length - 1];
  if (last && last.kind === "reminder") {
    toast("Напоминание уже отправлено — подождите ответа");
    return;
  }
  try {
    await postStaffMessage(it, "Напоминаю: жду вашего ответа по этой заявке.", "reminder");
    toast("Напомнили клиенту");
    render();
  } catch (e) {
    console.error(e);
    toast(e && e.message ? `Не отправилось: ${e.message}` : "Не отправилось — попробуйте ещё раз");
  }
}

// Выбор файлов. Отменённый выбор событий не даёт, поэтому убрать поле «после
// диалога» нельзя — держим в документе не больше одного: перед новым
// открытием сносим прошлое. Поле обязано быть в документе: по неприкреплённому
// элементу часть браузеров программный click игнорирует.
function pickFiles(onPicked) {
  const old = document.getElementById("docPicker");
  if (old) old.remove();

  const input = document.createElement("input");
  input.id = "docPicker";
  input.type = "file";
  input.multiple = true;
  // те же типы, что принимает бакет: список живёт в supabase.js и в миграции
  input.accept = ".jpg,.jpeg,.png,.heic,.heif,.webp,.pdf,.xlsx,.docx,.xls,.doc";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = () => {
    const chosen = input.files;
    input.remove();
    if (chosen && chosen.length) onPicked(chosen);
  };
  input.click();
}

// Бухгалтер прикладывает платёжный документ и закрывает заявку.
//
// Меняется ровно одна строка — значит notify-client получит ровно одно событие
// и отправит файл клиенту.
function attachDocument(it, seen) {
  pickFiles(async chosen => {
    toast("Загружаю документ…");
    const uploaded = await uploadFiles(chosen);
    // ни один файл не дошёл — причину uploadFiles уже показала, статус не трогаем:
    // «документ отправлен» без документа это ровно то, от чего мы уходим
    if (!uploaded.length) return;

    const prev = Array.isArray(it.staffFiles) ? it.staffFiles : [];
    it.staffFiles = prev.concat(uploaded);
    it.status = "sent";

    let res;
    try {
      res = await attachDocRemote(it, seen.status);
    } catch (e) {
      console.error(e);
      it.staffFiles = prev;          // откатываем локально, иначе экран соврёт
      it.status = seen.status;
      toast("Не удалось сохранить документ — попробуйте ещё раз");
      render();
      return;
    }
    // Заявку успели тронуть из другой вкладки. Состояние уже перечитано внутри
    // attachDocRemote — документ просто не прикрепился, и человек об этом узнает.
    if (!res.ok) { reportConflict(res.current, seen); render(); return; }

    toast(uploaded.length === 1
      ? "Документ отправлен клиенту в Telegram"
      : `Отправлено документов: ${uploaded.length}`);
    render();
  });
}

// Документ на часть оплаты: у каждой части своя платёжка. Статус не меняется,
// клиенту документ уходит тем же конвейером, что и обычный (client_docs_notified).
function attachPartDocument(it, seen, partId) {
  pickFiles(async chosen => {
    toast("Загружаю документ…");
    const uploaded = await uploadFiles(chosen);
    if (!uploaded.length) return;

    const prev = Array.isArray(it.staffFiles) ? it.staffFiles : [];
    const files = prev.concat(uploaded.map(f => ({...f, part_id: partId})));
    let res;
    try {
      res = await attachPartDocRemote(it, {status: seen.status, paid: seen.paid, staffFiles: prev}, files);
    } catch (e) {
      console.error(e);
      toast("Не удалось сохранить документ — попробуйте ещё раз");
      return;
    }
    if (!res.ok) {
      toast(res.current ? "Заявку тем временем изменили — документ не приложен, экран обновлён"
                        : "Заявку тем временем удалили — экран обновлён");
      render();
      return;
    }
    toast("Документ на часть отправлен клиенту в Telegram");
    render();
  });
}

// Платёж оплачен — статус в базе уже переведён. Осталось завести следующий,
// если платёж повторяющийся.
//
// Копию собираем по полю, а не клонированием заявки целиком. Клонирование
// тащило за собой платёжный документ бухгалтера и всю переписку по прошлому
// платежу (M1.3). Частей у копии тоже нет — сторож их и не пропустит.
async function afterPaid(it, lead) {
  const tail = it.needReceipt ? ". Клиенту нужен документ" : "";
  if (it.recurrence === "once") { toast(lead + tail); return; }

  const nextDue = nextDueOf(it);
  const copy = {
    id: genId(),
    client: it.client,
    client_id: it.client_id || null,
    createdByStaff: it.createdByStaff || null,
    payee: it.payee,
    amount: it.amount,
    requisites: it.requisites,
    due: nextDue,
    recurrence: it.recurrence,
    purpose: it.purpose,
    status: "new",
    needReceipt: it.needReceipt,
    files: [],       // счёт у следующего платежа будет свой
    staffFiles: [],  // и платёжный документ тоже
    thread: [],      // переписка была про прошлый платёж
    created: todayStr(),
    autoCreated: true, // заявку не подавал клиент — уведомление не шлём
    parentId: it.id,   // по ней «Отменить оплату» найдёт именно эту копию (M1.4)
  };

  try {
    await insertPaymentRemote(copy);
  } catch (e) {
    console.error(e);
    // Статус уже переведён, и это правда: платёж оплачен. Врать про
    // созданный следующий не будем — скажем как есть.
    toast(lead + ", но следующий платёж не создался — заведите вручную");
    return;
  }

  state.items.push(copy);
  toast(lead + ". Создан следующий платёж на " + fmtDate(nextDue) + tail);
}

// Отмена оплаты — заявка уже снова «в работе». Убираем следующий платёж,
// если он был создан автоматически и его ещё никто не тронул.
async function afterUndoPaid(it) {
  const lead = partly(it)
    ? `Оплата отменена — снова в работе, остаток ${fmtMoney(restOf(it))}`
    : "Оплата отменена";
  if (it.recurrence === "once") { toast(lead); return; }

  // Копию ищем по ссылке на исходную заявку (M1.4). Копии, созданные до 16.09,
  // ссылки не имеют: для них прежний поиск, но только среди созданных
  // автоматически.
  const nd = nextDueOf(it);
  let idx = state.items.findIndex(c => c.parentId === it.id);
  if (idx < 0) idx = state.items.findIndex(c =>
    c !== it && !c.parentId && c.autoCreated && c.status === "new" &&
    c.recurrence === it.recurrence && c.client === it.client && c.payee === it.payee &&
    Number(c.amount) === Number(it.amount) && c.due === nd
  );
  if (idx < 0) { toast(lead); return; }

  // Копию уже тронули — удалять молча нельзя: пропадёт чужая работа. Проверяет
  // база в момент удаления; вкладка могла отстать от неё на опрос.
  const copy = state.items[idx];
  let removed;
  try {
    removed = await removeUntouchedCopyRemote(copy.id);
  } catch (e) {
    console.error(e);
    toast(lead + ", но следующий платёж удалить не вышло — удалите вручную");
    return;
  }
  if (!removed) {
    toast(lead + ". Следующий платёж на " + fmtDate(copy.due) + " уже изменён — проверьте его вручную");
    return;
  }
  state.items.splice(state.items.indexOf(copy), 1);
  toast(lead + ", следующий платёж удалён");
}

// ---------- окно «Оплатить часть» ----------
// Лежит вне #list (поллинг). Что человек видел — оплаченное на момент
// открытия — запоминаем здесь и отдаём в pay_part: успел кто-то записать
// свою часть — база откажет, а не задвоит оплату.

let pp = null;   // {id, seenPaid, rest}
const $ = id => document.getElementById(id);

// Сумма денег — строго: цифры и не больше двух знаков после запятой. Молча
// выбрасывать лишнее нельзя: «1.250,00» превратилось бы в 1,25.
function parseAmount(s) {
  const v = String(s || "").replace(/[\s ]/g, "").replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(v) ? Number(v) : NaN;
}

function nextWorkingDay() {
  let d = addDays(todayStr(), 1);
  while ([0, 6].includes(new Date(d + "T00:00:00").getDay())) d = addDays(d, 1);
  return d;
}

function ppWarn(text) {
  const w = $("ppWarn");
  w.textContent = text || "";
  w.classList.toggle("hidden", !text);
}

function openPartDialog(it, seen) {
  const rest = cents(Number(it.amount) - seen.paid);
  pp = {id: it.id, seenPaid: seen.paid, rest};
  $("ppTitle").textContent = seen.paid > 0 ? "Оплатить ещё часть" : "Оплатить часть";
  $("ppSub").textContent = `${it.payee} · ${isPersonal(it) ? "личная задача" : (it.client || "—")}`;
  $("ppRest").textContent = fmtMoney(rest) + (seen.paid > 0 ? ` из ${fmtMoney(it.amount)}` : "");
  $("ppAmt").value = "";
  const due = $("ppDue");
  due.min = todayStr();
  due.value = daysBetween(it.due) > 0 ? it.due : nextWorkingDay();
  $("ppChips").innerHTML =
    `<button type="button" class="th-chip" data-fill="${cents(rest / 2)}">половина остатка</button>` +
    `<button type="button" class="th-chip" data-fill="${rest}">весь остаток</button>`;
  $("ppDueBox").classList.remove("hidden");
  ppWarn("");
  $("ppSave").disabled = false;
  $("partBox").classList.remove("hidden");
  setTimeout(() => $("ppAmt").focus(), 30);
}

function closePartDialog() {
  $("partBox").classList.add("hidden");
  pp = null;
}

// Сумма закрывает остаток — дата остатка не нужна, прячем поле.
function checkPart() {
  if (!pp) return;
  const raw = $("ppAmt").value.trim();
  const v = parseAmount(raw);
  $("ppDueBox").classList.toggle("hidden", v >= pp.rest);
  if (raw && isNaN(v))  ppWarn("Сумма — число, не больше двух знаков после запятой.");
  else if (v > pp.rest) ppWarn(`Это больше остатка на ${fmtMoney(cents(v - pp.rest))} — заявка закроется как переплаченная.`);
  else ppWarn("");
}

async function savePart() {
  if (!pp) return;
  const it = state.items.find(x => x.id === pp.id);
  if (!it) { closePartDialog(); toast("Заявку тем временем удалили — экран обновлён"); render(); return; }

  const v = parseAmount($("ppAmt").value);
  if (isNaN(v) || v <= 0) { ppWarn("Введите сумму, которую заплатили."); $("ppAmt").focus(); return; }
  const closes = v >= pp.rest;
  const due = $("ppDue").value;
  if (!closes && !due) { ppWarn("Поставьте дату, к которой планируем остаток."); return; }
  if (!closes && due < todayStr()) { ppWarn("Дата остатка уже прошла — выберите сегодня или позже."); return; }

  const seenPaid = pp.seenPaid;
  $("ppSave").disabled = true;
  let res;
  try {
    res = await payPartRemote(it, v, closes ? null : due, seenPaid);
  } catch (e) {
    console.error(e);
    res = {ok: false, message: "Не записалось — проверьте связь и попробуйте ещё раз"};
  }
  $("ppSave").disabled = false;

  if (!res.ok) {
    // заявку тронули или удалили — окно со старыми цифрами держать нельзя
    const gone = !state.items.includes(it);
    if (gone || paidOf(it) !== seenPaid || !activeOpen(it)) {
      closePartDialog();
      toast(gone ? "Заявку тем временем удалили — экран обновлён"
                 : rpcFailText(res));
      render();
      return;
    }
    ppWarn(res.message || "Не записалось — попробуйте ещё раз");
    return;
  }

  closePartDialog();
  if (it.status === "paid") {
    const over = cents(paidOf(it) - Number(it.amount));
    await afterPaid(it, `«${it.payee}» оплачена полностью` + (over > 0 ? ` (переплата ${fmtMoney(over)})` : ""));
  } else {
    toast(`Записано ${fmtMoney(v)}. Остаток ${fmtMoney(restOf(it))} — к ${fmtDate(it.due)}` +
          (it.due !== due ? " (рабочий день закончился, дата сдвинута)" : ""));
  }
  render();
}

// ---------- слушатели, один раз ----------

export function initQueue() {
  document.addEventListener("mousedown", e => { downX = e.clientX; downY = e.clientY; });

  // меню закрывается любым кликом мимо кнопок, которые его открывают;
  // пункт меню к этому моменту уже отработал (слушатель на самом меню раньше)
  document.addEventListener("click", e => {
    if (e.target.closest && e.target.closest("button[data-menu],button[data-files]")) return;
    hideMenu();
  });
  window.addEventListener("resize", hideMenu);
  window.addEventListener("scroll", hideMenu, true);

  $("qFilters").addEventListener("click", e => {
    const f = e.target.closest && e.target.closest("button[data-f]");
    if (!f) return;
    state.quickFilter = f.getAttribute("data-f");
    // «Отправить документ» — оплаченные, в активных их нет
    $("fStatus").value = state.quickFilter === "await_doc" ? "all" : "active";
    state.openId = null;
    render();
  });

  // На фазе перехвата: окно переписки закрывается по Escape своим слушателем,
  // и к нашему оно было бы уже скрыто — строка свернулась бы заодно.
  document.addEventListener("keydown", e => {
    const t = e.target;
    if ((e.key === "Enter" || e.key === " ") && t.classList && t.classList.contains("qr")) {
      e.preventDefault();
      toggleOpen(t.getAttribute("data-id"), true);
      return;
    }
    if (e.key !== "Escape") return;
    if (pp) { closePartDialog(); return; }
    const m = menuEl();
    if (m && !m.classList.contains("hidden")) { hideMenu(); return; }
    const th = $("thBox");
    if (state.openId && !state.TOKEN && (!th || th.classList.contains("hidden"))) toggleOpen(state.openId, false);
  }, true);

  const box = $("partBox");
  box.addEventListener("mousedown", e => { if (e.target === box) closePartDialog(); });
  box.addEventListener("click", e => {
    const fill = e.target.closest && e.target.closest("button[data-fill]");
    if (fill) {
      $("ppAmt").value = String(fill.getAttribute("data-fill")).replace(".", ",");
      checkPart();
      $("ppAmt").focus();
      return;
    }
    const b = e.target.closest && e.target.closest("button[data-pp]");
    if (!b) return;
    if (b.getAttribute("data-pp") === "close") closePartDialog();
    else savePart();
  });
  $("ppAmt").addEventListener("input", checkPart);
  $("ppAmt").addEventListener("keydown", e => { if (e.key === "Enter") savePart(); });
}
