import { sb } from './supabase.js';
import { state } from './state.js';
import { toast } from './utils.js';
import { loadClients, loadStaffList, renderClients } from './clients.js';

export async function onLoggedIn() {
  const ures = await sb.auth.getUser();
  const u = ures.data ? ures.data.user : null;
  if (!u) return false; // сигнал main.js → показать login

  const st = await sb.from("staff").select("name,is_admin").eq("id", u.id).single();
  if (st.error || !st.data) {
    toast("Этот аккаунт не подключён как сотрудник");
    await sb.auth.signOut();
    return false;
  }

  state.currentStaff = st.data;
  document.getElementById("staffName").textContent = state.currentStaff.name;
  document.getElementById("staffRole").textContent = state.currentStaff.is_admin ? "владелец" : "бухгалтер";
  document.getElementById("staffBox").classList.remove("hidden");
  document.getElementById("tabForm").style.display = "none";

  await loadClients();
  if (state.currentStaff.is_admin) {
    await loadStaffList();
    renderClients();
    document.getElementById("tabClients").style.display = "";
    document.getElementById("tabs").classList.remove("hidden");
  } else {
    document.getElementById("tabClients").style.display = "none";
    document.getElementById("tabs").classList.add("hidden");
  }
  return true;
}

export async function doLogin() {
  const email  = (document.getElementById("loginEmail").value || "").trim();
  const pass   = document.getElementById("loginPass").value || "";
  const errEl  = document.getElementById("loginErr");
  errEl.textContent = "";
  const btn = document.getElementById("loginBtn");
  const t = btn.textContent;
  btn.disabled = true; btn.textContent = "Входим…";
  const res = await sb.auth.signInWithPassword({email, password: pass});
  btn.disabled = false; btn.textContent = t;
  if (res.error) { errEl.textContent = "Не удалось войти — проверьте email и пароль"; return false; }
  document.getElementById("loginPass").value = "";
  return true;
}

export async function doLogout() {
  await sb.auth.signOut();
  state.currentStaff = null;
  state.items = [];
  state.clientsList = [];
  state.staffList = [];
  document.getElementById("staffBox").classList.add("hidden");
  document.getElementById("tabs").classList.add("hidden");
}
