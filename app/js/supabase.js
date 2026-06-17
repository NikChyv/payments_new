import { SUPABASE_URL, SUPABASE_KEY, TABLE, BUCKET } from './config.js';
import { todayStr, addDays } from './dates.js';
import { state } from './state.js';
import { toast, genId } from './utils.js';

export const useRemote = !!(SUPABASE_URL && SUPABASE_KEY && window.supabase);
export const sb = useRemote ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const KEY = "pay_requests_v1";

export function toRow(it) {
  return {
    id: it.id, client: it.client, payee: it.payee, amount: it.amount,
    requisites: it.requisites || null, due: it.due, recurrence: it.recurrence,
    purpose: it.purpose || null, status: it.status, need_receipt: !!it.needReceipt,
    file_url: it.file ? (it.file.url || null) : null,
    file_name: it.file ? it.file.name : null,
    created_at: it.created || todayStr(),
    client_id: it.client_id || null,
  };
}

export function fromRow(r) {
  return {
    id: r.id, client: r.client, payee: r.payee, amount: Number(r.amount),
    requisites: r.requisites || "", due: r.due, recurrence: r.recurrence,
    purpose: r.purpose || "", status: r.status, needReceipt: !!r.need_receipt,
    file: (r.file_url || r.file_name) ? {name: r.file_name || "файл", url: r.file_url || null} : null,
    created: r.created_at, client_id: r.client_id || null,
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
        state.items = state.items.filter(it => it.client_id && ids[it.client_id]);
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

export async function uploadFile(file) {
  if (!file) return null;
  if (useRemote) {
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
      toast("Файл не загрузился — заявка сохранена без файла");
      return {name: file.name, url: null};
    }
  }
  return {name: file.name, url: null};
}

export function removeRemote(idv) {
  if (useRemote) sb.from(TABLE).delete().eq("id", idv).then(res => { if (res.error) console.error(res.error); });
}

function seed() {
  const t = todayStr();
  return [
    {id:genId(), client:"ООО «Ромашка»", payee:"Яндекс Директ", amount:45000, requisites:"УНП 191234567",
      due:addDays(t,-2), recurrence:"weekly", purpose:"Пополнение рекламного кабинета", status:"new",
      needReceipt:true, file:null, created:t},
    {id:genId(), client:"ИП Смирнов А.В.", payee:"Аренда офиса (ООО «Парус»)", amount:80000, requisites:"р/с 40702810…",
      due:t, recurrence:"monthly", purpose:"Аренда за июнь", status:"new", needReceipt:true, file:null, created:t},
    {id:genId(), client:"ООО «Ромашка»", payee:"Поставщик «Техно»", amount:127500, requisites:"счёт №А-1188",
      due:addDays(t,2), recurrence:"once", purpose:"Оплата по счёту А-1188", status:"in_progress",
      needReceipt:true, file:{name:"schet_A-1188.pdf", url:null}, created:t},
    {id:genId(), client:"ООО «Вектор»", payee:"СБИС (отчётность)", amount:6900, requisites:"",
      due:addDays(t,5), recurrence:"monthly", purpose:"Абонентская плата", status:"new", needReceipt:false, file:null, created:t},
    {id:genId(), client:"ИП Смирнов А.В.", payee:"Налог УСН", amount:31200, requisites:"налог в бюджет",
      due:addDays(t,-1), recurrence:"once", purpose:"Авансовый платёж", status:"paid",
      needReceipt:true, file:null, created:t},
  ];
}
