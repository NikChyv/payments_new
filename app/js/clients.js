import { sb, useRemote, load } from './supabase.js';
import { state } from './state.js';
import { esc, toast } from './utils.js';
import { monthRange } from './export.js';

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

// Список «для кого платёж» в форме сотрудника: свои клиенты + личная напоминалка.
export function fillStaffClientSelect() {
  const sel = document.getElementById("ncFormClient");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Личная задача (без клиента) —</option>' +
    state.clientsList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  sel.value = cur;
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
  const isAdmin = !!(state.currentStaff && state.currentStaff.is_admin);
  const per = monthRange();

  box.innerHTML = state.clientsList.map(c => {
    const link = baseLink(c.token);
    const cnt = state.items.filter(it => it.client_id === c.id).length;
    // админу видно, у кого заявок нет, — такого клиента можно удалить
    const delBtn = isAdmin
      ? `<button class="cl-del" data-del="${esc(c.id)}"` +
        (cnt ? ` title="У клиента ${cnt} — удалить нельзя"` : ` title="Удалить клиента"`) +
        `>🗑 Удалить</button>`
      : "";

    // Переименовать и сменить бухгалтера — только админ (M9.1, M9.2). Проверка
    // прав в update_client; кнопку бухгалтеру не показываем, чтобы не обещать.
    const editBtn = isAdmin
      ? `<button data-cledit="${esc(c.id)}" title="Название и бухгалтер">✏️ Изменить</button>`
      : "";
    const editBox = isAdmin
      ? `<div class="cl-period" id="ed-${esc(c.id)}" hidden>` +
          `<input data-edname="${esc(c.id)}" value="${esc(c.name)}" maxlength="200" placeholder="Название компании">` +
          `<select data-edstaff="${esc(c.id)}">` + state.staffList.map(s =>
            `<option value="${esc(s.id)}"${s.id === c.staff_id ? " selected" : ""}>${esc(s.name)}${s.is_admin ? " (админ)" : ""}</option>`
          ).join("") + `</select>` +
          `<button data-edsave="${esc(c.id)}">Сохранить</button>` +
        `</div>`
      : "";

    return `<div class="cl-card">` +
      `<div class="nm">${esc(c.name)}</div>` +
      `<div class="who">Бухгалтер: ${esc(staffNameById(c.staff_id))} · заявок: ${cnt}</div>` +
      `<div class="cl-link"><code>${esc(link)}</code>` +
      `<button data-copy="${esc(link)}">Скопировать ссылку</button>` +
      `<button class="ghost" data-rotate="${esc(c.id)}" title="Перевыпустить ссылку — старая перестанет работать">🔄 Перевыпустить</button></div>` +
      `<div class="cl-tools">` +
        `<button class="cl-exp" data-export="${esc(c.id)}">📊 Выгрузить в Excel</button>` +
        editBtn +
        delBtn +
      `</div>` +
      editBox +
      `<div class="cl-period" id="per-${esc(c.id)}" hidden>` +
        `<span>с</span><input type="date" data-from="${esc(c.id)}" value="${per.from}">` +
        `<span>по</span><input type="date" data-to="${esc(c.id)}" value="${per.to}">` +
        `<button data-expgo="${esc(c.id)}">Скачать</button>` +
      `</div>` +
      `</div>`;
  }).join("");
}

// Удаление клиента — только админ и только если заявок нет.
// Обе проверки живут в функции delete_client в базе: в браузере их можно обойти,
// а «удалить клиента с заявками» = осиротить платежи (FK стоит ON DELETE SET NULL).
export async function deleteClientById(id) {
  const res = await sb.rpc("delete_client", { p_id: id });
  if (res.error) { toast(res.error.message); return; }
  await loadClients();
  renderClients();
  fillStaffClientSelect();
  toast("Клиент удалён");
}

// Админ меняет название и бухгалтера клиента одной функцией в базе: там же имя
// переписывается во всех заявках клиента (payments.client — копия имени, по
// ней фильтр очереди, выгрузка, бот и уведомления).
export async function saveClientEdit(id) {
  const c = state.clientsList.find(x => x.id === id);
  const nameEl  = document.querySelector(`input[data-edname="${id}"]`);
  const staffEl = document.querySelector(`select[data-edstaff="${id}"]`);
  if (!c || !nameEl || !staffEl) return;
  const name = nameEl.value.trim();
  const sid  = staffEl.value;
  if (!name) { toast("Укажите название компании"); return; }
  if (name === c.name && sid === c.staff_id) { toast("Ничего не изменилось"); return; }

  // Смена бухгалтера уводит к нему всю историю клиента — это надо понимать до
  // нажатия, а не узнавать от коллеги.
  if (sid !== c.staff_id &&
      !confirm(`Передать «${c.name}» бухгалтеру ${staffNameById(sid)}?\n\n` +
               `Все заявки клиента, включая старые, будут видны новому бухгалтеру и пропадут ` +
               `из очереди прежнего. Уведомления о новых заявках тоже пойдут новому.`)) return;

  const res = await sb.rpc("update_client", { p_id: id, p_name: name, p_staff_id: sid });
  if (res.error) { toast("Ошибка: " + res.error.message); return; }

  await loadClients();
  await load();              // имя клиента в заявках поменялось на сервере
  renderClients();
  fillStaffClientSelect();
  refreshClients();          // фильтр очереди «по клиенту» собирается из имён в заявках
  toast("Клиент сохранён");
}

// Пункт 5: отзыв ссылки — генерируем новый токен, старый мгновенно мёртв.
export async function rotateClientToken(id) {
  const res = await sb.rpc("rotate_client_token", { p_id: id });
  if (res.error) { toast("Ошибка: " + res.error.message); return; }
  await loadClients();
  renderClients();
  toast("Ссылка перевыпущена — старая больше не работает");
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
  fillStaffClientSelect();  // новый клиент сразу доступен в форме заявки
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
