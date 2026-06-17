export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}

export function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}

let _toastTimer;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = ""; }, 2600);
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
