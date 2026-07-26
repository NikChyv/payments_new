import { useRemote, sb, load, save, uploadFile } from './supabase.js';
import { state } from './state.js';
import { todayStr, fmtDate } from './dates.js';
import { esc, toast, genId } from './utils.js';
import { onLoggedIn, doLogin, doLogout } from './auth.js';
import { addClient, refreshClients, rotateClientToken } from './clients.js';
import { render, onListClick } from './queue.js';
import {
  loadClientByToken, loadPaymentsByToken, submitPaymentByToken, editPaymentByToken, renderClient,
} from './client_view.js';

// ---------- навигация ----------

function switchView(v) {
  document.getElementById("view-queue").classList.toggle("hidden", v !== "queue");
  document.getElementById("view-form").classList.toggle("hidden",  v !== "form");
  document.getElementById("view-login").classList.toggle("hidden", v !== "login");
  document.getElementById("view-clients").classList.toggle("hidden", v !== "clients");
  document.getElementById("tabQueue").classList.toggle("active", v === "queue");
  document.getElementById("tabForm").classList.toggle("active",  v === "form");
  const tc = document.getElementById("tabClients");
  if (tc) tc.classList.toggle("active", v === "clients");
  if (v === "queue") { state.TOKEN ? renderClient() : render(); }
}

// ---------- поллинг ----------

function startPoll() {
  if (state._pollStarted || !useRemote) return;
  state._pollStarted = true;
  setInterval(() => {
    if (document.getElementById("view-queue").classList.contains("hidden")) return;
    if (state.TOKEN) {
      loadPaymentsByToken(state.TOKEN).then(renderClient);
    } else {
      load().then(render);
    }
  }, 15000);
}

// ---------- режим редактирования заявки (клиент) ----------

function setFormMode(editing) {
  const title = document.getElementById("formTitle");
  const sub   = document.getElementById("formSub");
  const btn   = document.querySelector("#payForm .submit");
  if (editing) {
    if (title) title.textContent = "Редактирование заявки";
    if (sub)   sub.textContent   = "Измените нужные поля и сохраните. Доступно, пока бухгалтер не взял заявку в работу.";
    if (btn)   btn.textContent   = "Сохранить изменения";
  } else {
    if (title) title.textContent = "Поручение на оплату";
    if (sub)   sub.textContent   = "Заполните поля — бухгалтер сразу увидит заявку в очереди со сроком. Так платёж не потеряется.";
    if (btn)   btn.textContent   = "Отправить поручение";
  }
}

function fillFormForEdit(it) {
  const f = document.getElementById("payForm");
  f.payee.value       = it.payee || "";
  f.amount.value      = it.amount != null ? it.amount : "";
  f.requisites.value  = it.requisites || "";
  f.due.value         = it.due || todayStr();
  f.recurrence.value  = it.recurrence || "once";
  f.purpose.value     = it.purpose || "";
  f.needReceipt.checked = !!it.needReceipt;
  // файл заранее подставить нельзя; если клиент не приложит новый — сохранится прежний
  const fi = document.getElementById("fileInput");
  if (fi) fi.value = "";
  state.editingId = it.id;
  setFormMode(true);
  switchView("form");
}

function resetFormNew() {
  const f = document.getElementById("payForm");
  f.reset();
  state.editingId = null;
  const dueEl = document.querySelector('input[name=due]');
  if (dueEl) dueEl.value = todayStr();
  if (state.TOKEN && state.clientInfo) f.client.value = state.clientInfo.name;
  setFormMode(false);
}

// ---------- отправка формы ----------

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const fileInput = document.getElementById("fileInput");
  const submitBtn = f.querySelector(".submit");
  const wasEditing = !!(state.TOKEN && state.editingId);
  submitBtn.disabled = true; submitBtn.textContent = wasEditing ? "Сохраняем…" : "Отправляем…";

  const fileObj = await uploadFile(fileInput.files[0]);

  try {
    if (state.TOKEN && state.editingId) {
      // Фича 2: редактирование своей заявки (пока status='new')
      await editPaymentByToken(
        state.TOKEN, state.editingId,
        f.payee.value.trim(),
        parseFloat(f.amount.value) || 0,
        f.requisites.value.trim(),
        f.due.value,
        f.recurrence.value,
        f.purpose.value.trim(),
        f.needReceipt.checked,
        fileObj,
      );
    } else if (state.TOKEN) {
      // Шаг 7: через RPC submit_payment — заявка сама привязывается к клиенту и бухгалтеру
      await submitPaymentByToken(
        state.TOKEN,
        f.payee.value.trim(),
        parseFloat(f.amount.value) || 0,
        f.requisites.value.trim(),
        f.due.value,
        f.recurrence.value,
        f.purpose.value.trim(),
        f.needReceipt.checked,
        fileObj,
      );
    } else {
      // сотрудник заводит заявку: для своего клиента или личную напоминалку
      const sel = document.getElementById("ncFormClient");
      const pickedId = sel && sel.value ? sel.value : null;
      const picked = pickedId ? state.clientsList.find(c => c.id === pickedId) : null;
      const rec = {
        id: genId(),
        client: picked ? picked.name
                       : (state.currentStaff ? "Личное · " + state.currentStaff.name
                                             : f.client.value.trim()),
        client_id: picked ? picked.id : null,
        createdByStaff: state.currentStaffId || null,
        payee: f.payee.value.trim(),
        amount: parseFloat(f.amount.value) || 0, requisites: f.requisites.value.trim(),
        due: f.due.value, recurrence: f.recurrence.value, purpose: f.purpose.value.trim(),
        status: "new", needReceipt: f.needReceipt.checked, file: fileObj, created: todayStr(),
      };
      state.items.push(rec);
      save();
    }
  } catch(err) {
    console.error(err);
    toast("Ошибка: " + (err.message || err));
    submitBtn.disabled = false; setFormMode(wasEditing);
    return;
  }

  submitBtn.disabled = false;

  const sentPayee = f.payee.value.trim();
  const sentDue   = f.due.value;

  if (state.TOKEN) {
    resetFormNew(); // сбрасывает editingId, форму, метку кнопки, имя клиента
    const ok = document.getElementById("okMsg");
    ok.textContent = wasEditing
      ? "✓ Заявка обновлена. Платёж «" + sentPayee + "» на " + fmtDate(sentDue) + " — актуальные данные в очереди."
      : "✓ Поручение отправлено бухгалтеру. Платёж «" + sentPayee + "» на " + fmtDate(sentDue) + " уже в очереди.";
    ok.className = "ok-msg show";
    setTimeout(() => { ok.className = "ok-msg"; }, 6000);
    switchView("queue");
    await loadPaymentsByToken(state.TOKEN);
    renderClient();
    toast(wasEditing ? "Заявка обновлена" : "Заявка отправлена — статус виден ниже");
  } else {
    f.reset();
    setFormMode(false); // вернуть текст кнопки «Отправить поручение»
    const dueEl = document.querySelector('input[name=due]');
    if (dueEl) dueEl.value = todayStr();
    const ok = document.getElementById("okMsg");
    ok.textContent = "✓ Поручение отправлено бухгалтеру. Платёж «" + sentPayee + "» на " + fmtDate(sentDue) + " уже в очереди.";
    ok.className = "ok-msg show";
    setTimeout(() => { ok.className = "ok-msg"; }, 6000);
    refreshClients();
    toast("Заявка добавлена в очередь");
  }
}

// ---------- init ----------

async function init() {
  const params = new URLSearchParams(location.search);
  state.TOKEN = params.get("t") || null;

  const dueEl = document.querySelector('input[name=due]');
  if (dueEl) dueEl.value = todayStr();

  // ----- слушатели -----
  document.getElementById("tabQueue").addEventListener("click", () => {
    switchView("queue");
    if (!state.TOKEN && useRemote) load().then(render);
  });
  document.getElementById("tabForm").addEventListener("click", () => {
    if (state.TOKEN) resetFormNew(); // «Новая заявка» всегда чистая, без остатка редактирования
    switchView("form");
  });
  document.getElementById("tabClients").addEventListener("click", () => switchView("clients"));

  const crf = document.getElementById("clientRefresh");
  if (crf) crf.addEventListener("click", () => {
    if (state.TOKEN) {
      loadPaymentsByToken(state.TOKEN).then(() => { renderClient(); toast("Обновлено"); });
    } else if (useRemote) {
      load().then(() => { render(); toast("Обновлено"); });
    } else {
      render();
    }
  });

  document.getElementById("list").addEventListener("click", e => {
    if (!state.TOKEN) { onListClick(e); return; } // сотрудник управляет статусами
    const btn = e.target.closest && e.target.closest("button[data-edit]");
    if (!btn) return;
    const it = state.items.find(x => String(x.id) === btn.getAttribute("data-edit"));
    if (it) fillFormForEdit(it);
  });

  document.getElementById("payForm").addEventListener("submit", onSubmit);
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("fClient").addEventListener("change", render);
  document.getElementById("fStatus").addEventListener("change", render);

  document.getElementById("clearFilter").addEventListener("click", () => {
    state.quickFilter = "";
    document.getElementById("search").value = "";
    document.getElementById("fClient").value = "";
    document.getElementById("fStatus").value = "active";
    document.querySelectorAll(".scard").forEach(c => c.classList.remove("sel"));
    render();
  });

  document.querySelectorAll(".scard").forEach(card => {
    card.addEventListener("click", () => {
      const f = card.getAttribute("data-filter");
      const on = state.quickFilter !== f;
      document.querySelectorAll(".scard").forEach(c => c.classList.remove("sel"));
      state.quickFilter = on ? f : "";
      if (on) card.classList.add("sel");
      document.getElementById("fStatus").value = (on && f === "await_doc") ? "all" : "active";
      render();
    });
  });

  document.getElementById("loginBtn").addEventListener("click", async () => {
    const ok = await doLogin();
    if (ok) {
      const loggedIn = await onLoggedIn();
      if (loggedIn) {
        await load(); refreshClients(); render();
        switchView("queue");
        startPoll();
      } else {
        switchView("login");
      }
    }
  });

  document.getElementById("loginPass").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("loginBtn").click();
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await doLogout();
    switchView("login");
  });

  document.getElementById("ncAdd").addEventListener("click", addClient);

  document.getElementById("clientsList").addEventListener("click", e => {
    const copyBtn = e.target.closest && e.target.closest("button[data-copy]");
    if (copyBtn) {
      const link = copyBtn.getAttribute("data-copy");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(() => toast("Ссылка скопирована"));
      } else {
        toast("Скопируйте ссылку вручную");
      }
      return;
    }
    const rotBtn = e.target.closest && e.target.closest("button[data-rotate]");
    if (rotBtn) {
      if (!confirm("Перевыпустить ссылку? Старая сразу перестанет работать — клиенту нужно отправить новую.")) return;
      rotateClientToken(rotBtn.getAttribute("data-rotate"));
    }
  });

  // ----- режим клиента по токену (?t=…) -----
  if (state.TOKEN) {
    document.body.classList.add("client-mode");
    document.getElementById("tabQueue").textContent = "Мои платежи";
    document.getElementById("tabForm").textContent  = "Новая заявка";
    document.getElementById("tabs").classList.remove("hidden");
    const sub = document.querySelector(".brand p");
    if (sub) sub.textContent = "Оставьте заявку — и следите за статусом каждого платежа";

    if (!useRemote) {
      document.getElementById("list").innerHTML =
        '<div class="empty">Режим по токену требует подключения к базе данных.</div>';
      switchView("queue");
      return;
    }

    const clientName = await loadClientByToken(state.TOKEN);
    if (!clientName) {
      document.getElementById("list").innerHTML =
        '<div class="empty">Ссылка недействительна. Обратитесь к бухгалтеру.</div>';
      switchView("queue");
      return;
    }

    state.clientInfo = {name: clientName};

    const ci = document.querySelector('input[name=client]');
    if (ci) { ci.value = clientName; ci.readOnly = true; }

    const cn = document.getElementById("clientName");
    if (cn) cn.textContent = clientName;

    await loadPaymentsByToken(state.TOKEN);
    switchView(state.items.length ? "queue" : "form");
    startPoll();
    return;
  }

  // ----- режим сотрудника: требуется вход -----
  document.getElementById("tabs").classList.add("hidden");
  if (useRemote) {
    const sess = await sb.auth.getSession();
    if (sess.data && sess.data.session) {
      const loggedIn = await onLoggedIn();
      if (loggedIn) {
        await load(); refreshClients(); render();
        switchView("queue");
        startPoll();
      } else {
        switchView("login");
      }
    } else {
      switchView("login");
    }
  } else {
    await load(); refreshClients(); render();
    switchView("queue");
  }
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
