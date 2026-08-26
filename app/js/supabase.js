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
    created: r.created_at, client_id: r.client_id || null,
    autoCreated: !!r.auto_created,
    createdByStaff: r.created_by_staff || null,
  };
}

export async function load() {
  if (useRemote) {
    try {
      const res = await sb.from(TABLE).select("*");
      if (res.error) throw res.error;
      state.items = (res.data || []).map(fromRow);
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

export function save() {
  if (useRemote) {
    sb.from(TABLE).upsert(state.items.map(toRow)).then(res => {
      if (res.error) { console.error(res.error); toast("Ошибка записи в базу"); }
    });
    return;
  }
  _saveLocal();
}

function _saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state.items)); } catch(e) {}
}

// Бакет принимает только эти типы и только до 10 МБ (миграция
// 20260826000003_storage_limits.sql). Проверяем до отправки: браузер иначе
// выгрузит все 30 МБ по мобильному интернету и лишь потом получит отказ.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = ["jpg","jpeg","png","heic","heif","webp","pdf","xlsx","docx","xls","doc"];

// Тип проверяем по расширению, а не по file.type: браузеры для heic и части
// офисных форматов отдают пустую строку, и проверка по типу зарубила бы годный
// файл. Настоящий фильтр всё равно на стороне бакета — здесь только понятное
// сообщение вместо отказа сервера.
function fileProblem(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return "тип";
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
      const up = await sb.storage.from(BUCKET).upload(path, file);
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

// Точечная правка заявки сотрудником. Именно update, а не общий upsert всех
// строк: тогда БД видит изменение ровно одной заявки и правильно помечает,
// кто её правил (last_edit_role) — от этого зависит уведомление клиенту.
export async function updatePaymentRemote(it) {
  if (!useRemote) { _saveLocal(); return; }
  const row = toRow(it);
  delete row.id;
  delete row.created_at;
  const res = await sb.from(TABLE).update(row).eq("id", it.id);
  if (res.error) throw res.error;
}

export function removeRemote(idv) {
  if (useRemote) sb.from(TABLE).delete().eq("id", idv).then(res => { if (res.error) console.error(res.error); });
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
