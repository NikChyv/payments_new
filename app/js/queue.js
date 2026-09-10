import { state } from './state.js';
import { daysBetween, addDays, addMonths, fmtDate, fmtMoney, todayStr } from './dates.js';
import { removeRemote, uploadFiles, changeStatusRemote, attachDocRemote,
         insertPaymentRemote, postStaffMessage } from './supabase.js';
import { esc, safeUrl, toast, setText, genId } from './utils.js';
import { threadState, openThread } from './thread.js';

// экспортируются: те же подписи идут в выгрузку Excel (export.js)
export const recLbl = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};
export const stLbl  = {new:"Новая", in_progress:"В работе", paid:"Оплачено", sent:"Документ отправлен"};
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
  let o = 0, today = 0, week = 0, prog = 0, doc = 0, wait = 0;
  state.items.forEach(it => {
    if (it.status === "paid" && it.needReceipt) doc++;
    // «Ждут ответа» считаем по открытым заявкам: по закрытой ждать нечего
    if (activeOpen(it) && threadState(it) === "waiting") wait++;
    if (!activeOpen(it)) return;
    const d = daysBetween(it.due);
    if (d < 0) o++;
    else if (d === 0) today++;
    else if (d <= 7) week++;
    if (it.status === "in_progress") prog++;
  });
  setText("cOverdue", o); setText("cToday", today);
  setText("cWeek", week); setText("cProg", prog); setText("cDoc", doc);
  setText("cWait", wait);

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

// Подсказка, что список сужен: иначе непонятно, куда делись остальные платежи.
function renderFilterHint() {
  const el = document.getElementById("filterHint");
  if (!el) return;
  if (state.quickFilter === "due") {
    el.className = "filter-hint show";
    el.innerHTML = '⚡ Показано только то, что <b>нужно сделать сейчас</b> — просроченные и на сегодня. ' +
                   '<button class="linkbtn" id="showAllBtn">Показать все платежи</button>';
  } else {
    el.className = "filter-hint";
    el.innerHTML = "";
  }
}

export function render() {
  computeCounts();
  renderFilterHint();
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
      // "due" — всё, что уже пора делать: просроченные + сегодняшние
      if (state.quickFilter === "due"       && !(activeOpen(it) && d <= 0))    return false;
      if (state.quickFilter === "overdue"   && !(activeOpen(it) && d < 0))    return false;
      if (state.quickFilter === "today"     && !(activeOpen(it) && d === 0))   return false;
      if (state.quickFilter === "week"      && !(activeOpen(it) && d > 0 && d <= 7)) return false;
      if (state.quickFilter === "prog"      && it.status !== "in_progress")    return false;
      if (state.quickFilter === "waiting"   && !(activeOpen(it) && threadState(it) === "waiting")) return false;
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
    list.innerHTML = state.quickFilter === "due"
      ? '<div class="empty">На сегодня всё закрыто, просроченных нет 🎉<br><span style="font-size:13px">Будущие платежи — кнопка «Показать все платежи» выше.</span></div>'
      : '<div class="empty">Нет платежей по выбранному фильтру 🎉</div>';
    return;
  }
  list.innerHTML = rows.map(rowHtml).join("");
}

// Все вложения отдельными значками — их может быть несколько.
export function fileBadges(it) {
  return (it.files || []).map(f => f.url
    ? `<a class="badge b-file" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" title="Открыть файл">📎 ${esc(f.name || "файл")}</a>`
    : `<span class="badge b-file" title="${esc(f.name || "файл")}">📎 ${esc(f.name || "файл")}</span>`
  ).join("");
}

// Документы бухгалтера — отдельным значком и другой иконкой: в одной строке
// рядом лежат счёт ОТ клиента и платёжка ДЛЯ него, и путать их нельзя.
export function staffFileBadges(it) {
  return (it.staffFiles || []).map(f => f.url
    ? `<a class="badge b-doc" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" title="Платёжный документ">📄 ${esc(f.name || "документ")}</a>`
    : `<span class="badge b-doc">📄 ${esc(f.name || "документ")}</span>`
  ).join("");
}

function rowHtml(it) {
  const u = urgency(it);
  const dueBadge  = u.cls ? `<span class="badge ${u.cls}">${u.lbl}</span>` : "";
  const fileBadge = fileBadges(it);
  const recBadge = it.recurrence !== "once" ? `<span class="badge b-rec">🔁 ${recLbl[it.recurrence]}</span>` : "";
  let receiptBadge = "";
  if (it.needReceipt && it.status !== "sent") {
    receiptBadge = it.status === "paid"
      ? '<span class="badge b-due-amber">📄 приложить документ</span>'
      : '<span class="badge b-rec">нужен документ</span>';
  }

  // Метка переписки. «Ждём ответ» намеренно спокойная: заявка и так уже
  // подсвечена сроком, а второй кричащий цвет в строке только мешает.
  const ts = threadState(it);
  const threadBadge =
    ts === "waiting"  ? '<span class="badge b-wait">⏸ ждём ответ клиента</span>' :
    ts === "answered" ? '<span class="badge b-answer">💬 клиент ответил</span>' : "";

  let acts = "";
  if (it.status === "new")
    acts = _btn("p","take","Взять в работу") + _btn("ok","pay","Отметить оплаченным");
  else if (it.status === "in_progress")
    acts = _btn("ok","pay","Отметить оплаченным") + _btn("soft","back","↩ Вернуть в «новые»");
  else if (it.status === "paid")
    // Раньше здесь была кнопка «Документ отправлен клиентом» — она означала
    // честное слово бухгалтера, а файл уходил в личный чат. Теперь главное
    // действие — приложить сам документ: клиент получит его в Telegram и
    // сможет переслать поставщику. «Закрыть без файла» остаётся для случаев,
    // когда документ отдали на бумаге или лично.
    acts = (it.needReceipt ? _btn("p","attach","📄 Приложить документ") : _btn("soft","send","Закрыть"))
         + (it.needReceipt ? _btn("soft","send","Закрыть без файла") : "")
         + _btn("soft","unpay","↩ Отменить оплату");
  else if (it.status === "sent")
    acts = '<span class="badge b-st-sent" style="text-align:center;padding:9px">✓ Готово</span>'
         + _btn("soft","unsend","↩ Вернуть в «Оплачено»");
  // Второстепенные действия — узкой строкой иконок. Пять одинаковых кнопок в
  // столбик не давали иерархии: смена статуса это работа, а правка и дубликат
  // нужны изредка, и выглядеть они должны спокойнее.
  // Пока ждём ответа — напомнить можно одним нажатием, не открывая переписку:
  // это самое частое, что бухгалтер делает с такой заявкой.
  if (ts === "waiting") acts += _btn("soft", "remind", "🔔 Напомнить");

  const n = (it.thread || []).length;
  acts += `<div class="acts-more">` +
    `<button class="btn mini${ts === "answered" ? " hot" : ""}" data-act="thread" ` +
      `title="Переписка по заявке" aria-label="Переписка">💬${n ? " " + n : ""}</button>` +
    `<button class="btn mini" data-edit="${esc(it.id)}" title="Редактировать заявку" aria-label="Редактировать">✏️</button>` +
    `<button class="btn mini" data-dup="${esc(it.id)}" title="Создать такую же заявку" aria-label="Дублировать">⧉</button>` +
    `<button class="btn mini danger" data-act="del" title="Удалить заявку" aria-label="Удалить">🗑</button>` +
  `</div>`;

  return `<div class="row b-${u.key}" data-id="${it.id}">` +
    `<div class="main">` +
      `<div class="head"><span class="payee">${esc(it.payee)}</span><span class="amount">${fmtMoney(it.amount)}</span></div>` +
      `<div class="meta">` +
        `<span><b>${esc(it.client)}</b></span>` +
        `<span>📅 ${fmtDate(it.due)}</span>` +
        (it.requisites ? `<span>${esc(it.requisites)}</span>` : "") +
        (it.purpose    ? `<span>${esc(it.purpose)}</span>` : "") +
      `</div>` +
      `<div class="badges"><span class="badge ${stCls[it.status]}">${stLbl[it.status]}</span>${dueBadge}${threadBadge}${recBadge}${receiptBadge}${fileBadge}${staffFileBadges(it)}</div>` +
    `</div>` +
    `<div class="acts">${acts}</div>` +
  `</div>`;
}

function _btn(kind, act, label) {
  return `<button class="btn ${kind}" data-act="${act}">${label}</button>`;
}

// Куда ведёт каждая кнопка. Ожидаемый статус в условие update мы берём не
// отсюда, а из строки, которую человек видел в момент клика: важно не «какой
// переход разрешён вообще», а «изменилось ли что-то с тех пор, как он смотрел».
const MOVES = {
  take:   {to: "in_progress", msg: "Взято в работу"},
  back:   {to: "new",         msg: "Возвращено в «Новые»"},
  send:   {to: "sent",        msg: "Платёж закрыт"},
  unsend: {to: "paid",        msg: "Возвращено в «Оплачено»"},
  pay:    {to: "paid",        msg: null},   // сообщение зависит от повторяемости
  unpay:  {to: "in_progress", msg: null},
};

// Заявку тронул кто-то другой. Молча перезаписывать нельзя — из этого и росла
// двойная оплата: бухгалтер видел «в работе» у уже оплаченного платежа.
function reportConflict(current) {
  toast(current
    ? `Заявку тем временем изменили — сейчас «${stLbl[current.status] || current.status}». Экран обновлён`
    : "Заявку тем временем удалили — экран обновлён");
}

export async function onListClick(e) {
  const b = e.target.closest && e.target.closest("button[data-act]");
  if (!b) return;
  const row = e.target.closest(".row");
  if (!row) return;
  const it = state.items.find(x => x.id === row.getAttribute("data-id"));
  if (!it) return;
  const act = b.getAttribute("data-act");

  // Прикрепление документа — с загрузкой файла, поэтому своим путём.
  if (act === "attach") { attachDocument(it); return; }

  // Переписка дописывается на сервере отдельной RPC: параллельный ответ клиента
  // так не теряется.
  if (act === "thread") { openThread(it, render); return; }
  if (act === "remind") { remindClient(it); return; }

  if (act === "del") {
    if (!confirm("Удалить платёж?")) return;
    try { await removeRemote(it.id); }
    catch (err) { console.error(err); toast("Не удалось удалить — попробуйте ещё раз"); return; }
    state.items = state.items.filter(x => x !== it);
    render();
    return;
  }

  const move = MOVES[act];
  if (!move) return;

  // Статус на экране в момент клика. Он же уходит в условие update — не совпал,
  // значит между отрисовкой и нажатием заявку кто-то перевёл.
  const seen = it.status;

  let res;
  try { res = await changeStatusRemote(it, seen, move.to); }
  catch (err) { console.error(err); toast("Ошибка записи в базу"); render(); return; }

  if (!res.ok) { reportConflict(res.current); render(); return; }

  if (act === "pay")        await afterPaid(it);
  else if (act === "unpay") await afterUndoPaid(it);
  else toast(move.msg);

  render();
}

function nextDueOf(it) {
  return it.recurrence === "weekly" ? addDays(it.due, 7) : addMonths(it.due, 1);
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

// Бухгалтер прикладывает платёжный документ для клиента.
//
// Меняется ровно одна строка — значит notify-client получит ровно одно событие
// и отправит файл клиенту, а не будет вылавливать его среди холостых
// срабатываний вебхука.
async function attachDocument(it) {
  // Отменённый выбор файла событий не даёт, поэтому убрать поле «после диалога»
  // нельзя — вместо этого держим в документе не больше одного: перед новым
  // открытием сносим прошлое. Иначе каждый передуманный клик оставлял бы
  // висеть ещё один элемент.
  const old = document.getElementById("docPicker");
  if (old) old.remove();

  const input = document.createElement("input");
  input.id = "docPicker";
  input.type = "file";
  input.multiple = true;
  // те же типы, что принимает бакет: список живёт в supabase.js и в миграции
  input.accept = ".jpg,.jpeg,.png,.heic,.heif,.webp,.pdf,.xlsx,.docx,.xls,.doc";
  // Поле обязано быть в документе: по неприкреплённому элементу часть браузеров
  // программный click просто игнорирует, и диалог не открывается.
  input.style.display = "none";
  document.body.appendChild(input);

  input.onchange = async () => {
    const chosen = input.files;
    input.remove();
    if (!chosen || !chosen.length) return;
    toast("Загружаю документ…");

    const uploaded = await uploadFiles(chosen);
    // ни один файл не дошёл — причину uploadFiles уже показала, статус не трогаем:
    // «документ отправлен» без документа это ровно то, от чего мы уходим
    if (!uploaded.length) return;

    const prev = Array.isArray(it.staffFiles) ? it.staffFiles : [];
    const seen = it.status;          // статус, который бухгалтер видел на экране
    it.staffFiles = prev.concat(uploaded);
    it.status = "sent";

    let res;
    try {
      res = await attachDocRemote(it, seen);
    } catch (e) {
      console.error(e);
      it.staffFiles = prev;          // откатываем локально, иначе экран соврёт
      it.status = seen;
      toast("Не удалось сохранить документ — попробуйте ещё раз");
      render();
      return;
    }
    // Заявку успели тронуть из другой вкладки. Состояние уже перечитано внутри
    // attachDocRemote, поэтому откатывать руками нечего — документ просто не
    // прикрепился, и человек об этом узнает.
    if (!res.ok) { reportConflict(res.current); render(); return; }

    toast(uploaded.length === 1
      ? "Документ отправлен клиенту в Telegram"
      : `Отправлено документов: ${uploaded.length}`);
    render();
  };

  input.click();
}

// Платёж отмечен оплаченным — статус в базе уже переведён. Осталось завести
// следующий, если платёж повторяющийся.
//
// Копию собираем по полю, а не клонированием заявки целиком. Клонирование
// тащило за собой платёжный документ бухгалтера и всю переписку по прошлому
// платежу (M1.3): клиент получал «документ отправлен» по заявке, которой ещё
// никто не занимался, и видел в ней чужой разговор.
async function afterPaid(it) {
  if (it.recurrence === "once") { toast("Отмечено как оплачено"); return; }

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
  };

  try {
    await insertPaymentRemote(copy);
  } catch (e) {
    console.error(e);
    // Статус уже переведён, и это правда: платёж оплачен. Врать про
    // созданный следующий не будем — скажем как есть.
    toast("Оплачено, но следующий платёж не создался — заведите вручную");
    return;
  }

  state.items.push(copy);
  toast("Оплачено. Создан следующий платёж на " + fmtDate(nextDue));
}

// Отмена оплаты — статус уже возвращён в «в работе». Убираем следующий платёж,
// если он был создан автоматически и его ещё никто не тронул.
async function afterUndoPaid(it) {
  if (it.recurrence === "once") { toast("Оплата отменена"); return; }

  const nd = nextDueOf(it);
  const idx = state.items.findIndex(c =>
    c !== it && c.status === "new" && c.recurrence === it.recurrence &&
    c.client === it.client && c.payee === it.payee &&
    Number(c.amount) === Number(it.amount) && c.due === nd
  );
  if (idx < 0) { toast("Оплата отменена"); return; }

  try {
    await removeRemote(state.items[idx].id);
  } catch (e) {
    console.error(e);
    toast("Оплата отменена, но следующий платёж удалить не вышло — удалите вручную");
    return;
  }
  state.items.splice(idx, 1);
  toast("Оплата отменена, следующий платёж удалён");
}
