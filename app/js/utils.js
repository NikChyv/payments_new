export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}

// Ссылка на вложение подставляется в href. esc() тут не помощник: он
// экранирует кавычки и скобки, но `javascript:…` внутри href остаётся рабочим
// и выполняется в сессии того, кто кликнул, — то есть бухгалтера (M2.1).
// Поэтому проверяем схему: только http(s), и без символов, которыми можно
// выйти из атрибута. База те же ссылки не пускает в новые заявки
// (is_safe_file_url), эта проверка прикрывает уже сохранённое.
export function safeUrl(u) {
  const s = String(u == null ? "" : u);
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "#";
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
