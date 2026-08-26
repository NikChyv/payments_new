import { useRemote, sb, load, save, uploadFiles, updatePaymentRemote } from './supabase.js';
import { state } from './state.js';
import { todayStr, fmtDate } from './dates.js';
import { esc, toast, genId } from './utils.js';
import { onLoggedIn, doLogin, doLogout } from './auth.js';
import { addClient, refreshClients, rotateClientToken, deleteClientById, renderClients } from './clients.js';
import { exportClientPayments } from './export.js';
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
  // счётчик заявок в карточках считается по загруженной очереди — при входе
  // на экран она уже загружена, поэтому перерисовываем здесь, а не при логине
  if (v === "clients" && !state.TOKEN && state.currentStaff) renderClients();
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
    if (sub)   sub.textContent   = state.TOKEN
      ? "Измените нужные поля и сохраните. Доступно, пока бухгалтер не взял заявку в работу."
      : "Измените нужные поля и сохраните. Если заявку оставлял клиент — он получит уведомление о правке.";
    if (btn)   btn.textContent   = "Сохранить изменения";
  } else {
    if (title) title.textContent = "Поручение на оплату";
    if (sub)   sub.textContent   = "Заполните поля — бухгалтер сразу увидит заявку в очереди со сроком. Так платёж не потеряется.";
    if (btn)   btn.textContent   = "Отправить поручение";
  }
}

// ---------- прикреплённые файлы ----------
// state.formFiles — то, что уже загружено (при правке и дубликате). Выбранное
// в поле «файл» добавится к этому списку при отправке.
function renderFormFiles() {
  const box = document.getElementById("fileList");
  if (!box) return;
  const kept = state.formFiles || [];
  const input = document.getElementById("fileInput");
  const picked = input ? Array.from(input.files || []) : [];

  if (!kept.length && !picked.length) { box.innerHTML = ""; return; }

  box.innerHTML =
    kept.map((f, i) =>
      `<span class="file-chip">📎 ${esc(f.name || "файл")}` +
      `<button type="button" class="x" data-rmfile="${i}" title="Убрать файл">✕</button></span>`
    ).join("") +
    picked.map(f => `<span class="file-chip new">⬆ ${esc(f.name)}</span>`).join("");
}

function fillFormFields(it) {
  const f = document.getElementById("payForm");
  f.payee.value       = it.payee || "";
  f.amount.value      = it.amount != null ? it.amount : "";
  f.requisites.value  = it.requisites || "";
  f.recurrence.value  = it.recurrence || "once";
  f.purpose.value     = it.purpose || "";
  f.needReceipt.checked = !!it.needReceipt;
  const fi = document.getElementById("fileInput");
  if (fi) fi.value = "";
  state.formFiles = (it.files || []).slice();
  renderFormFiles();
}

function fillFormForEdit(it) {
  fillFormFields(it);
  document.getElementById("payForm").due.value = it.due || todayStr();
  state.editingId = it.id;
  setFormMode(true);
  switchView("form");
}

// Дубликат: те же данные, но это НОВАЯ заявка. Дату ставим на сегодня — у
// повторного платежа она почти всегда другая, а старая только путала бы.
function fillFormForDuplicate(it) {
  fillFormFields(it);
  document.getElementById("payForm").due.value = todayStr();
  state.editingId = null;
  // Файлы намеренно не переносим: у нового платежа свой счёт. Приложить забытый
  // файл легко, а оплатить по позапрошлому счёту — уже не исправить.
  state.formFiles = [];
  renderFormFiles();
  // сотруднику подставляем того же клиента, иначе дубликат уедет в личные задачи
  const sel = document.getElementById("ncFormClient");
  if (sel && !state.TOKEN) sel.value = it.client_id || "";
  setFormMode(false);
  switchView("form");
  toast((it.files || []).length
    ? "Данные скопированы. Проверьте дату и сумму, файл приложите заново"
    : "Данные скопированы — проверьте дату и сумму");
}

function resetFormNew() {
  const f = document.getElementById("payForm");
  f.reset();
  state.editingId = null;
  state.formFiles = [];
  renderFormFiles();
  const dueEl = document.querySelector('input[name=due]');
  if (dueEl) dueEl.value = todayStr();
  if (state.TOKEN && state.clientInfo) f.client.value = state.clientInfo.name;
  setFormMode(false);
}

// ---------- отправка формы ----------

// Работаем пн–пт: будущий платёж на сб/вс не проводится. Сегодняшний выходной
// сервер сам перенесёт на ближайший рабочий день, поэтому его не блокируем.
function weekendDueBlocked(dueStr) {
  if (!dueStr || dueStr <= todayStr()) return false;
  const g = new Date(dueStr + "T00:00:00Z").getUTCDay();
  return g === 0 || g === 6;
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (state.TOKEN && weekendDueBlocked(f.due.value)) {
    toast("В выходной платёж не проводится — выберите рабочий день (пн–пт)");
    return;
  }
  const fileInput = document.getElementById("fileInput");
  const submitBtn = f.querySelector(".submit");
  const wasEditing = !!state.editingId;
  submitBtn.disabled = true; submitBtn.textContent = wasEditing ? "Сохраняем…" : "Отправляем…";

  // прежние вложения плюс только что выбранные
  const uploaded = await uploadFiles(fileInput.files);
  const files = (state.formFiles || []).concat(uploaded);
  if (files.length > 10) {
    toast("Больше 10 файлов не приложить — уберите лишние");
    submitBtn.disabled = false; setFormMode(wasEditing);
    return;
  }

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
        files,
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
        files,
      );
    } else if (state.editingId) {
      // сотрудник правит существующую заявку
      const it = state.items.find(x => String(x.id) === String(state.editingId));
      if (!it) throw new Error("Заявка не найдена");
      it.payee       = f.payee.value.trim();
      it.amount      = parseFloat(f.amount.value) || 0;
      it.requisites  = f.requisites.value.trim();
      it.due         = f.due.value;
      it.recurrence  = f.recurrence.value;
      it.purpose     = f.purpose.value.trim();
      it.needReceipt = f.needReceipt.checked;
      it.files       = files;
      await updatePaymentRemote(it);
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
        status: "new", needReceipt: f.needReceipt.checked, files, created: todayStr(),
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
    resetFormNew();
    const ok = document.getElementById("okMsg");
    ok.textContent = wasEditing
      ? "✓ Заявка обновлена: «" + sentPayee + "» на " + fmtDate(sentDue) + "."
      : "✓ Поручение отправлено бухгалтеру. Платёж «" + sentPayee + "» на " + fmtDate(sentDue) + " уже в очереди.";
    ok.className = "ok-msg show";
    setTimeout(() => { ok.className = "ok-msg"; }, 6000);
    refreshClients();
    // и после правки, и после новой заявки возвращаем в очередь: иначе сотрудник
    // остаётся на форме и не видит результата — особенно заметно на дубликате
    switchView("queue");
    render();
    toast(wasEditing ? "Заявка обновлена" : "Заявка добавлена в очередь");
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
    const find = attr => {
      const b = e.target.closest && e.target.closest(`button[${attr}]`);
      if (!b) return null;
      return state.items.find(x => String(x.id) === b.getAttribute(attr)) || null;
    };

    const dup = find("data-dup");
    if (dup) { fillFormForDuplicate(dup); return; }

    const edit = find("data-edit");
    if (edit) {
      // оплаченный платёж — уже факт, поэтому спрашиваем отдельно
      if (!state.TOKEN && (edit.status === "paid" || edit.status === "sent") &&
          !confirm("Платёж уже проведён. Точно менять данные?\n\nПравка попадёт в журнал изменений.")) return;
      fillFormForEdit(edit);
      return;
    }

    if (!state.TOKEN) onListClick(e); // сотрудник управляет статусами
  });

  // выбранные файлы показываем сразу, чтобы человек видел, что приложилось
  const fileInput = document.getElementById("fileInput");
  if (fileInput) fileInput.addEventListener("change", renderFormFiles);

  document.getElementById("fileList").addEventListener("click", e => {
    const x = e.target.closest && e.target.closest("button[data-rmfile]");
    if (!x) return;
    state.formFiles.splice(Number(x.getAttribute("data-rmfile")), 1);
    renderFormFiles();
  });

  document.getElementById("payForm").addEventListener("submit", onSubmit);
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("fClient").addEventListener("change", render);
  document.getElementById("fStatus").addEventListener("change", render);

  // подсветка карточек под текущий быстрый фильтр («due» = две карточки сразу)
  function syncCards() {
    document.querySelectorAll(".scard").forEach(c => {
      const f = c.getAttribute("data-filter");
      const on = state.quickFilter === "due"
        ? (f === "overdue" || f === "today")
        : state.quickFilter === f;
      c.classList.toggle("sel", on);
    });
  }
  syncCards();

  // «Показать все платежи» в подсказке
  document.getElementById("filterHint").addEventListener("click", e => {
    if (!e.target.closest("#showAllBtn")) return;
    state.quickFilter = "";
    syncCards();
    render();
  });

  document.getElementById("clearFilter").addEventListener("click", () => {
    state.quickFilter = "";
    document.getElementById("search").value = "";
    document.getElementById("fClient").value = "";
    document.getElementById("fStatus").value = "active";
    syncCards();
    render();
  });

  document.querySelectorAll(".scard").forEach(card => {
    card.addEventListener("click", () => {
      const f = card.getAttribute("data-filter");
      const on = state.quickFilter !== f;
      state.quickFilter = on ? f : "";
      syncCards();
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
      if (!confirm("Перевыпустить ссылку?\n\nСтарая сразу перестанет работать. У клиента отвалится и Telegram-бот: уведомления об оплате перестанут приходить, пока он не откроет НОВУЮ ссылку на бота и не нажмёт «Старт».\n\nНе забудьте отправить ему обе новые ссылки.")) return;
      rotateClientToken(rotBtn.getAttribute("data-rotate"));
      return;
    }

    // «Выгрузить в Excel» — раскрывает выбор периода под карточкой
    const expBtn = e.target.closest && e.target.closest("button[data-export]");
    if (expBtn) {
      const box = document.getElementById("per-" + expBtn.getAttribute("data-export"));
      if (box) box.hidden = !box.hidden;
      return;
    }

    const goBtn = e.target.closest && e.target.closest("button[data-expgo]");
    if (goBtn) {
      const id = goBtn.getAttribute("data-expgo");
      const from = document.querySelector(`input[data-from="${id}"]`);
      const to   = document.querySelector(`input[data-to="${id}"]`);
      exportClientPayments(id, from ? from.value : "", to ? to.value : "");
      return;
    }

    const delBtn = e.target.closest && e.target.closest("button[data-del]");
    if (delBtn) {
      const id = delBtn.getAttribute("data-del");
      const cl = state.clientsList.find(c => c.id === id);
      if (!confirm(`Удалить клиента «${cl ? cl.name : ""}»? Его ссылка перестанет работать.\n\nЕсли у клиента есть заявки, удаления не произойдёт.`)) return;
      deleteClientById(id);
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
