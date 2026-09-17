import { SUPABASE_URL, SUPABASE_KEY, TABLE, BUCKET } from './config.js';
import { todayStr, addDays } from './dates.js';
import { state } from './state.js';
import { toast, genId } from './utils.js';

export const useRemote = !!(SUPABASE_URL && SUPABASE_KEY && window.supabase);
export const sb = useRemote ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const KEY = "pay_requests_v1";

// Файлы живут в массиве `files`. Колонки file_url/file_name остаются зеркалом
// первого файла — их читают утренняя рассылка, уведомление о новой заявке и бот.
export function toRow(it) {
  const files = Array.isArray(it.files) ? it.files : [];
  return {
    id: it.id, client: it.client, payee: it.payee, amount: it.amount,
    requisites: it.requisites || null, due: it.due, recurrence: it.recurrence,
    purpose: it.purpose || null, status: it.status, need_receipt: !!it.needReceipt,
    files,
    file_url:  files.length ? (files[0].url  || null) : null,
    file_name: files.length ? (files[0].name || null) : null,
    created_at: it.created || todayStr(),
    client_id: it.client_id || null,
    auto_created: !!it.autoCreated,
    created_by_staff: it.createdByStaff || null,
    // копия повторяющегося платежа помнит исходную заявку: по этой ссылке
    // «Отменить оплату» находит именно её, а не похожую (M1.4)
    parent_id: it.parentId || null,
    // документы бухгалтера живут отдельно от files: те — счёт от клиента,
    // и их первый элемент зеркалится в file_url, который читают рассылки
    staff_files: Array.isArray(it.staffFiles) ? it.staffFiles : [],
    // thread здесь НАМЕРЕННО нет. Переписка меняется только дописыванием на
    // сервере (post_staff_message / reply_by_token), потому что пишет в неё и
    // клиент — из кабинета и из бота. У новой заявки её и быть не может, а
    // отправлять пустой массив поверх — значит однажды снова затереть ответ,
    // пришедший между опросами.
  };
}

export function fromRow(r) {
  // заявки, созданные до перехода на массив, приходят только со старыми колонками
  let files = Array.isArray(r.files) ? r.files : [];
  if (!files.length && (r.file_url || r.file_name)) {
    files = [{url: r.file_url || null, name: r.file_name || "файл"}];
  }
  return {
    id: r.id, client: r.client, payee: r.payee, amount: Number(r.amount),
    requisites: r.requisites || "", due: r.due, recurrence: r.recurrence,
    purpose: r.purpose || "", status: r.status, needReceipt: !!r.need_receipt,
    files,
    // Набор файлов ровно как в базе — без подставленного выше зеркала старых
    // колонок. По нему правка формой проверяет, что файлы не меняли, пока
    // форма была открыта (M7.1): сравнение идёт с базой, а не с нашим видом.
    filesRaw: Array.isArray(r.files) ? r.files : [],
    created: r.created_at, client_id: r.client_id || null,
    autoCreated: !!r.auto_created,
    createdByStaff: r.created_by_staff || null,
    parentId: r.parent_id || null,
    lastEditAt: r.last_edit_at || null,
    staffFiles: Array.isArray(r.staff_files) ? r.staff_files : [],
    thread: Array.isArray(r.thread) ? r.thread : [],
    // Оплата по частям. Только читаем: в toRow этих полей нет и быть не
    // должно — сторож в базе отвергнет любой update, где они меняются мимо
    // pay_part / undo_part, и вместе с ними пропала бы вся запись.
    parts: Array.isArray(r.parts) ? r.parts : [],
    paidAmount: Number(r.paid_amount) || 0,
  };
}

// Сообщение бухгалтера клиенту. Отдельной RPC, а не общим сохранением: имя
// автора функция берёт из JWT (подписаться чужим именем нельзя), а запись идёт
// дописыванием — иначе параллельный ответ клиента был бы затёрт.
export async function postStaffMessage(it, text, kind) {
  if (!useRemote) {
    // локальный режим без Supabase — только чтобы демо не разваливалось
    it.thread = (it.thread || []).concat([{
      id: genId(), who: "staff", kind: kind || "question", text,
      author: "Бухгалтер", files: [], at: new Date().toISOString(),
    }]);
    _saveLocal();
    return;
  }
  const res = await sb.rpc("post_staff_message", {
    p_id: it.id, p_text: text, p_kind: kind || "question",
  });
  if (res.error) throw res.error;
  it.thread = (it.thread || []).concat([res.data]);
}

export async function load() {
  if (useRemote) {
    try {
      const res = await sb.from(TABLE).select("*");
      if (res.error) throw res.error;
      state.items = (res.data || []).map(fromRow);
      // Сервер отдаёт не больше max_rows строк (config.toml, на проде тоже 1000)
      // и режет молча (M1.6). На 16.09 заявок меньше 200 — хватит надолго, но
      // когда упрёмся, узнать об этом надо сразу, а не по пропавшим заявкам.
      if (res.data && res.data.length >= 1000)
        toast("Загружено 1000 заявок — это предел, часть очереди может не показываться. Сообщите администратору");
      if (state.currentStaff && !state.currentStaff.is_admin) {
        const ids = {};
        state.clientsList.forEach(c => { ids[c.id] = 1; });
        // свои клиенты + собственные личные задачи (у них нет client_id)
        state.items = state.items.filter(it =>
          (it.client_id && ids[it.client_id]) ||
          (it.createdByStaff && it.createdByStaff === state.currentStaffId)
        );
      }
    } catch(e) {
      console.error(e);
      toast("Ошибка чтения из базы — проверьте URL/ключ и таблицу");
      state.items = [];
    }
    return;
  }
  try { state.items = JSON.parse(localStorage.getItem(KEY)) || null; } catch(e) { state.items = null; }
  if (!state.items) { state.items = seed(); _saveLocal(); }
}

// ---------------------------------------------------------------------------
// Запись в базу — только точечная
//
// Здесь был общий save(): он делал upsert ВСЕХ заявок из состояния вкладки.
// То есть любое нажатие «Взять в работу» переписывало всю очередь тем, что
// вкладка успела загрузить в прошлый раз, и выигрывал тот, кто нажал последним.
// Отсюда росло сразу пять находок ревью: откат чужих статусов (M1.1) с риском
// оплатить дважды, статус из момента открытия формы (M1.2), затирание файла из
// ответа клиента (M7.1), ложное «бухгалтер изменил вашу заявку» (M4.8) и запись
// затирания в журнал как честной правки (M10.2).
//
// Правило теперь одно: пишем ровно те поля, которые человек менял, ровно в ту
// строку, которую он видел, и только если она с тех пор не изменилась.
// ---------------------------------------------------------------------------

// Поля содержания заявки. Статуса здесь намеренно нет: форма правки его не
// показывает и менять не должна (M1.2).
function contentRow(it) {
  const files = Array.isArray(it.files) ? it.files : [];
  return {
    payee: it.payee, amount: it.amount, requisites: it.requisites || null,
    due: it.due, recurrence: it.recurrence, purpose: it.purpose || null,
    need_receipt: !!it.needReceipt,
    files,
    file_url:  files.length ? (files[0].url  || null) : null,
    file_name: files.length ? (files[0].name || null) : null,
  };
}

// Перечитать одну заявку. Нужна, когда наша запись не прошла: человеку надо
// показать то, что в базе на самом деле, а не то, что он видел минуту назад.
async function refetch(id) {
  const res = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (res.error) throw res.error;
  return res.data ? fromRow(res.data) : null;
}

// Заменить заявку в состоянии на свежую версию (или убрать, если её удалили).
function replaceLocal(it, fresh) {
  if (fresh) { Object.assign(it, fresh); return; }
  state.items = state.items.filter(x => x !== it);
}

// Смена статуса.
//
// `.eq("status", from)` — то самое условие, ради которого всё затевалось: если
// заявку уже перевёл кто-то другой, update не найдёт строку и вернёт пусто.
// Тогда мы не пишем поверх, а перечитываем и говорим человеку.
//
// Возвращает {ok:true} либо {ok:false, current} — current это то, что в базе
// сейчас, или null, если заявку удалили.
//
// `seenPaid` — сколько было оплачено на экране. Передаётся там, где от этого
// зависит смысл перехода: «Оплачено», «Закрыть с недоплатой», отмена оплаты.
// Без него отставшая вкладка закрыла бы заявку, по которой только что прошла
// часть, как целую — или целую как недоплаченную.
export async function changeStatusRemote(it, from, to, seenPaid) {
  if (!useRemote) { it.status = to; _saveLocal(); return {ok: true}; }

  let q = sb.from(TABLE).update({status: to}).eq("id", it.id).eq("status", from);
  if (seenPaid !== undefined) q = q.eq("paid_amount", seenPaid);
  const res = await q.select();
  if (res.error) throw res.error;

  if (!res.data || !res.data.length) {
    const fresh = await refetch(it.id);
    replaceLocal(it, fresh);
    return {ok: false, current: fresh};
  }
  Object.assign(it, fromRow(res.data[0]));
  return {ok: true};
}

// Правка содержания сотрудником. Статус не трогаем вовсе — значит параллельное
// «Отметить оплаченным» из соседней вкладки переживёт эту правку.
//
// Набор файлов форма пишет целиком, поэтому запись идёт с условием «файлы в
// базе те же, что были, когда форму открыли» (M7.1). Клиент мог за это время
// приложить счёт ответом на вопрос — без условия правка молча его стёрла бы.
// Не совпало — ничего не пишем и отдаём свежую заявку: форма добавит новые
// файлы к себе, и человек сохранит ещё раз уже с ними.
export async function updateContentRemote(it, seenFiles) {
  if (!useRemote) { _saveLocal(); return {ok: true}; }
  const res = await sb.from(TABLE).update(contentRow(it))
    .eq("id", it.id).eq("files", JSON.stringify(seenFiles || []))
    .select();
  if (res.error) throw res.error;
  if (!res.data || !res.data.length) return {ok: false, current: await refetch(it.id)};
  Object.assign(it, fromRow(res.data[0]));
  return {ok: true};
}

// Документ бухгалтера: пишем вложения и статус одной строкой, с проверкой
// прежнего статуса — заявку могли успеть вернуть в работу.
export async function attachDocRemote(it, from) {
  if (!useRemote) { _saveLocal(); return {ok: true}; }

  const res = await sb.from(TABLE)
    .update({staff_files: it.staffFiles || [], status: it.status})
    .eq("id", it.id).eq("status", from).select();
  if (res.error) throw res.error;

  if (!res.data || !res.data.length) {
    const fresh = await refetch(it.id);
    replaceLocal(it, fresh);
    return {ok: false, current: fresh};
  }
  Object.assign(it, fromRow(res.data[0]));
  return {ok: true};
}

// Документ на часть оплаты. Статус не меняется — заявка ещё в работе или уже
// оплачена, а закрывает её отдельное действие. Условие — всё, что человек
// видел: статус, оплаченное и сам набор документов. Иначе параллельная
// вкладка, приложившая свой файл, потеряла бы его под нашей записью.
export async function attachPartDocRemote(it, seen, files) {
  if (!useRemote) { it.staffFiles = files; _saveLocal(); return {ok: true}; }

  const res = await sb.from(TABLE).update({staff_files: files})
    .eq("id", it.id).eq("status", seen.status).eq("paid_amount", seen.paid)
    .eq("staff_files", JSON.stringify(seen.staffFiles))
    .select();
  if (res.error) throw res.error;

  if (!res.data || !res.data.length) {
    const fresh = await refetch(it.id);
    replaceLocal(it, fresh);
    return {ok: false, current: fresh};
  }
  Object.assign(it, fromRow(res.data[0]));
  return {ok: true};
}

// Часть оплаты и её отмена — только через RPC: части и оплаченную сумму
// база больше никому не даёт менять (сторож guard_payment_parts). Проверка
// «заявку тем временем изменили» — внутри функций, по p_seen_paid и id
// последней части. Отказ приходит исключением с человеческим текстом —
// его и показываем. После любого исхода заявку перечитываем: RPC вернула
// только числа, а на экране нужна вся строка.
async function partRpc(it, name, args) {
  const res = await sb.rpc(name, args);
  // не перечиталось (сеть) — оставляем как было, поллинг догонит; перечиталось
  // пустым — заявку удалили, убираем с экрана
  let fresh = null, fetched = false;
  try { fresh = await refetch(it.id); fetched = true; } catch (e) { console.error(e); }
  if (fetched) replaceLocal(it, fresh);
  if (res.error) return {ok: false, message: res.error.message, current: fresh};
  // Записалось, но перечитать не вышло: берём итог из ответа самой функции.
  // Иначе заявка осталась бы «в работе» на экране, а вызывающий по её статусу
  // решает, создавать ли копию повторяющегося, — и копия молча не появилась бы.
  if (!fetched && res.data) {
    const d = res.data;
    if (d.status) it.status = d.status;
    if (d.paid_amount != null) it.paidAmount = Number(d.paid_amount);
    if (d.due) it.due = d.due;
    if (d.part) it.parts = (it.parts || []).concat([d.part]);
  }
  return {ok: true, result: res.data};
}

export function payPartRemote(it, amount, newDue, seenPaid) {
  return partRpc(it, "pay_part",
    {p_id: it.id, p_amount: amount, p_new_due: newDue || null, p_seen_paid: seenPaid});
}

export function undoPartRemote(it, partId) {
  return partRpc(it, "undo_part", {p_id: it.id, p_part_id: partId});
}

// Новая заявка — insert одной строки вместо upsert всей очереди.
export async function insertPaymentRemote(rec) {
  if (!useRemote) { _saveLocal(); return; }
  const res = await sb.from(TABLE).insert(toRow(rec)).select();
  if (res.error) throw res.error;
  if (res.data && res.data.length) Object.assign(rec, fromRow(res.data[0]));
}

function _saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state.items)); } catch(e) {}
}

// Бакет принимает только эти типы и только до 10 МБ (миграция
// 20260826000003_storage_limits.sql). Проверяем до отправки: браузер иначе
// выгрузит все 30 МБ по мобильному интернету и лишь потом получит отказ.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Тип отдаём бакету сами, по расширению (M3.2): для heic на Windows и части
// Android браузер присылает пустой type, бакет отвечал «mime type not supported»,
// и человек видел «сбой» вместо причины. Таблица та же, что MIME_BY_EXT в боте.
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  heic: "image/heic", heif: "image/heif", webp: "image/webp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  doc: "application/msword",
};
const fileExt = file => (file.name.split(".").pop() || "").toLowerCase();

// Тип проверяем по расширению, а не по file.type: браузеры для heic и части
// офисных форматов отдают пустую строку, и проверка по типу зарубила бы годный
// файл. Настоящий фильтр всё равно на стороне бакета — здесь только понятное
// сообщение вместо отказа сервера.
function fileProblem(file) {
  if (!MIME_BY_EXT[fileExt(file)]) return "тип";
  if (file.size > MAX_FILE_BYTES) return "размер";
  return null;
}

// Возвращает {name, url} при успехе и {name, url: null, reason} при отказе.
// Сообщение человеку показывает uploadFiles — иначе на один файл выскакивало бы
// по два уведомления: причина и общее «не загрузился».
export async function uploadFile(file) {
  if (!file) return null;
  if (useRemote) {
    const problem = fileProblem(file);
    if (problem) return {name: file.name, url: null, reason: problem};
    try {
      const rand = crypto.getRandomValues(new Uint8Array(16));
      const hex = Array.from(rand, b => b.toString(16).padStart(2, "0")).join("");
      const path = hex + "/" + file.name.replace(/[^\w.\-]+/g, "_");
      const up = await sb.storage.from(BUCKET).upload(path, file, {contentType: MIME_BY_EXT[fileExt(file)]});
      if (up.error) throw up.error;
      const pub = sb.storage.from(BUCKET).getPublicUrl(path);
      return {name: file.name, url: pub.data.publicUrl};
    } catch(e) {
      console.error(e);
      return {name: file.name, url: null, reason: "сбой"};
    }
  }
  return {name: file.name, url: null};
}

// Загружает несколько файлов подряд. Один неудачный не отменяет остальные:
// заявка важнее вложения, поэтому просто предупреждаем — но с причиной, иначе
// человек шлёт тот же самый файл по кругу.
export async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  const out = [];
  for (const f of files) {
    const up = await uploadFile(f);
    if (up && up.url) { out.push({url: up.url, name: up.name}); continue; }
    if (!up) continue;
    const why = {
      "тип":    "такой файл не принимается: нужно фото, PDF, Word или Excel",
      "размер": "больше 10 МБ — приложите файл поменьше",
      "сбой":   "не загрузился",
    }[up.reason] || "не загрузился";
    toast(`Файл «${up.name}» ${why} — заявка сохранится без него`);
  }
  return out;
}

// Удаление ждём и проверяем: раньше ошибка уходила молча в консоль, а строка
// пропадала с экрана — человек считал заявку удалённой, хотя она осталась.
export async function removeRemote(idv) {
  if (!useRemote) { _saveLocal(); return; }
  const res = await sb.from(TABLE).delete().eq("id", idv);
  if (res.error) throw res.error;
}

// Удаление автокопии при отмене оплаты — только нетронутой. Условие проверяет
// база, а не вкладка: пока бухгалтер смотрел на экран, клиент мог приложить
// счёт к копии или поправить её. Возвращает false, если копию уже тронули.
// paid_amount = 0 — отдельно: часть, закрывшая заявку целиком, дату не
// меняет и last_edit_at не ставит, так что копия с оплатой выглядела бы
// нетронутой.
export async function removeUntouchedCopyRemote(idv) {
  if (!useRemote) { _saveLocal(); return true; }
  const res = await sb.from(TABLE).delete()
    .eq("id", idv).eq("status", "new").is("last_edit_at", null)
    .eq("files", "[]").eq("thread", "[]").eq("paid_amount", 0)
    .select("id");
  if (res.error) throw res.error;
  return !!(res.data && res.data.length);
}

function seed() {
  const t = todayStr();
  return [
    {id:genId(), client:"ООО «Ромашка»", payee:"Яндекс Директ", amount:45000, requisites:"УНП 191234567",
      due:addDays(t,-2), recurrence:"weekly", purpose:"Пополнение рекламного кабинета", status:"new",
      needReceipt:true, files:[], created:t},
    {id:genId(), client:"ИП Смирнов А.В.", payee:"Аренда офиса (ООО «Парус»)", amount:80000, requisites:"р/с 40702810…",
      due:t, recurrence:"monthly", purpose:"Аренда за июнь", status:"new", needReceipt:true, files:[], created:t},
    {id:genId(), client:"ООО «Ромашка»", payee:"Поставщик «Техно»", amount:127500, requisites:"счёт №А-1188",
      due:addDays(t,2), recurrence:"once", purpose:"Оплата по счёту А-1188", status:"in_progress",
      needReceipt:true, files:[{name:"schet_A-1188.pdf", url:null}], created:t},
    {id:genId(), client:"ООО «Вектор»", payee:"СБИС (отчётность)", amount:6900, requisites:"",
      due:addDays(t,5), recurrence:"monthly", purpose:"Абонентская плата", status:"new", needReceipt:false, files:[], created:t},
    {id:genId(), client:"ИП Смирнов А.В.", payee:"Налог УСН", amount:31200, requisites:"налог в бюджет",
      due:addDays(t,-1), recurrence:"once", purpose:"Авансовый платёж", status:"paid",
      needReceipt:true, files:[], created:t},
  ];
}
