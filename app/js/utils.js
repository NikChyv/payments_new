// Сумма неизвестна: клиент приложил документ и не стал её перепечатывать
// (с файлом получатель, сумма и дата необязательны — миграция 20261005000001).
// В базе это NULL, а не ноль: ноль попал бы в итоги как настоящая сумма.
export const hasAmount = it => it.amount != null;

// Получатель, когда его не указали, — по имени первого файла. То же правило в
// триггере validate_payment_fields: здесь оно нужно, чтобы заявка сотрудника
// называлась правильно сразу, а не после следующего опроса.
export const docPayee = files =>
  ("По документу: " + ((files[0] && files[0].name) || "файл")).slice(0, 200);
export const isDocPayee = v => /^По документу: /.test(v || "");

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
