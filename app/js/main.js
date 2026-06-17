import { useRemote, sb, load, save, uploadFile } from './supabase.js';
import { state } from './state.js';
import { todayStr, fmtDate } from './dates.js';
import { esc, toast, genId } from './utils.js';
import { onLoggedIn, doLogin, doLogout } from './auth.js';
import { addClient, refreshClients } from './clients.js';
import { render, onListClick } from './queue.js';
import { renderClient } from './client_view.js';

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
  if (v === "queue") { state.CLIENT ? renderClient() : render(); }
}

// ---------- поллинг ----------

function startPoll() {
  if (state._pollStarted || !useRemote) return;
  state._pollStarted = true;
  setInterval(() => {
    if (!document.getElementById("view-queue").classList.contains("hidden")) {
      load().then(() => state.CLIENT ? renderClient() : render());
    }
  }, 15000);
}

// ---------- отправка формы ----------

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const fileInput = document.getElementById("fileInput");
  const submitBtn = f.querySelector(".submit");
  const oldTxt = submitBtn.textContent;
  submitBtn.disabled = true; submitBtn.textContent = "Отправляем…";

  const fileObj = await uploadFile(fileInput.files[0]);
  const rec = {
    id: genId(), client: f.client.value.trim(), payee: f.payee.value.trim(),
    amount: parseFloat(f.amount.value) || 0, requisites: f.requisites.value.trim(),
    due: f.due.value, recurrence: f.recurrence.value, purpose: f.purpose.value.trim(),
    status: "new", needReceipt: f.needReceipt.checked, file: fileObj, created: todayStr(),
  };
  state.items.push(rec);
  save();

  submitBtn.disabled = false; submitBtn.textContent = oldTxt;

  const lockedClient = state.CLIENT;
  f.reset();
  const dueEl = document.querySelector('input[name=due]');
  if (dueEl) dueEl.value = todayStr();
  if (lockedClient) f.client.value = lockedClient;

  const ok = document.getElementById("okMsg");
  ok.textContent = "✓ Поручение отправлено бухгалтеру. Платёж «" + rec.payee + "» на " + fmtDate(rec.due) + " уже в очереди.";
  ok.className = "ok-msg show";
  setTimeout(() => { ok.className = "ok-msg"; }, 6000);

  refreshClients();

  if (state.CLIENT) {
    switchView("queue");
    if (useRemote) { await load(); }
    renderClient();
    toast("Заявка отправлена — статус виден ниже");
  } else {
    toast("Заявка добавлена в очередь");
  }
}

// ---------- init ----------

async function init() {
  state.CLIENT = new URLSearchParams(location.search).get("client") || null;

  const dueEl = document.querySelector('input[name=due]');
  if (dueEl) dueEl.value = todayStr();

  // ----- слушатели -----
  document.getElementById("tabQueue").addEventListener("click", () => {
    switchView("queue");
    if (!state.CLIENT && useRemote) load().then(render);
  });
  document.getElementById("tabForm").addEventListener("click", () => switchView("form"));
  document.getElementById("tabClients").addEventListener("click", () => switchView("clients"));

  const crf = document.getElementById("clientRefresh");
  if (crf) crf.addEventListener("click", () => {
    if (useRemote) { load().then(() => { state.CLIENT ? renderClient() : render(); toast("Обновлено"); }); }
    else { state.CLIENT ? renderClient() : render(); }
  });

  document.getElementById("list").addEventListener("click", e => {
    if (!state.CLIENT) onListClick(e);
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
    const b = e.target.closest && e.target.closest("button[data-copy]");
    if (!b) return;
    const link = b.getAttribute("data-copy");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => toast("Ссылка скопирована"));
    } else {
      toast("Скопируйте ссылку вручную");
    }
  });

  // ----- режим клиента (?client=…) -----
  if (state.CLIENT) {
    document.body.classList.add("client-mode");
    document.getElementById("tabQueue").textContent = "Мои платежи";
    document.getElementById("tabForm").textContent  = "Новая заявка";
    document.getElementById("tabs").classList.remove("hidden");
    const sub = document.querySelector(".brand p");
    if (sub) sub.textContent = "Оставьте заявку — и следите за статусом каждого платежа";

    const ci = document.querySelector('input[name=client]');
    if (ci) { ci.value = state.CLIENT; ci.readOnly = true; }

    const cn = document.getElementById("clientName");
    if (cn) cn.textContent = state.CLIENT;

    await load(); refreshClients(); renderClient();
    switchView(state.items.filter(it => it.client === state.CLIENT).length ? "queue" : "form");
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
