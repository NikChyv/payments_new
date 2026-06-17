import { sb, useRemote } from './supabase.js';
import { state } from './state.js';
import { esc, toast } from './utils.js';

export function baseLink(token) {
  return location.origin + location.pathname + "?t=" + encodeURIComponent(token);
}

export function genToken() {
  const a = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.prototype.map.call(a, b => ("0" + b.toString(16)).slice(-2)).join("");
}

export async function loadClients() {
  if (!useRemote) { state.clientsList = []; return; }
  const res = await sb.from("clients").select("*").order("name", {ascending: true});
  state.clientsList = res.error ? [] : (res.data || []);
}

export async function loadStaffList() {
  if (!useRemote) { state.staffList = []; return; }
  const res = await sb.from("staff").select("id,name,is_admin").order("name", {ascending: true});
  state.staffList = res.error ? [] : (res.data || []);
}

export function staffNameById(sid) {
  const s = state.staffList.find(s => s.id === sid);
  return s ? s.name : "—";
}

export function renderClients() {
  const sel = document.getElementById("ncStaff");
  sel.innerHTML = '<option value="">— бухгалтер —</option>' + state.staffList.map(s =>
    `<option value="${s.id}">${esc(s.name)}${s.is_admin ? " (админ)" : ""}</option>`
  ).join("");

  const box = document.getElementById("clientsList");
  if (!state.clientsList.length) {
    box.innerHTML = '<div class="empty">Пока нет клиентов. Добавьте первого выше.</div>';
    return;
  }
  box.innerHTML = state.clientsList.map(c => {
    const link = baseLink(c.token);
    return `<div class="cl-card">` +
      `<div class="nm">${esc(c.name)}</div>` +
      `<div class="who">Бухгалтер: ${esc(staffNameById(c.staff_id))}</div>` +
      `<div class="cl-link"><code>${esc(link)}</code>` +
      `<button data-copy="${esc(link)}">Скопировать ссылку</button></div>` +
      `</div>`;
  }).join("");
}

export async function addClient() {
  const name = (document.getElementById("ncName").value || "").trim();
  const sid  = document.getElementById("ncStaff").value;
  const err  = document.getElementById("ncErr");
  err.textContent = "";
  if (!name) { err.textContent = "Укажите название компании"; return; }
  if (!sid)  { err.textContent = "Выберите бухгалтера"; return; }
  const res = await sb.from("clients").insert({name, token: genToken(), staff_id: sid});
  if (res.error) { err.textContent = "Ошибка: " + res.error.message; return; }
  document.getElementById("ncName").value = "";
  await loadClients();
  renderClients();
  toast("Клиент добавлен");
}

export function refreshClients() {
  const names = {};
  state.items.forEach(it => { if (it.client) names[it.client] = 1; });
  const arr = Object.keys(names).sort();

  const dl = document.getElementById("clientsDl");
  if (dl) dl.innerHTML = arr.map(n => `<option value="${esc(n)}">`).join("");

  const sel = document.getElementById("fClient");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Все клиенты</option>' +
      arr.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = cur;
  }
}
