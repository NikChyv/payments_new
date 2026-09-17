export function isoLocal(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

export function todayStr() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return isoLocal(d); // локальная дата, иначе в поясе РБ подставлялся вчерашний день
}

export function daysBetween(dateStr) {
  const t = new Date(todayStr() + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d - t) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

export function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return isoLocal(d);
}

export function fmtDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const m = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
  return d.getDate() + " " + m[d.getMonth()] + " " + d.getFullYear();
}

// Без года — для колонки срока в очереди: год там почти всегда текущий, а
// место в узкой колонке нужно под «просрочено N дн.»
export function fmtDateShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const m = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
  const y = d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "";
  return d.getDate() + " " + m[d.getMonth()] + y;
}

// Число без «Br» — в таблице валюта стоит в заголовке колонки.
export function fmtNum(v) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export function fmtMoney(v) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}

// ---------- рабочий график бухгалтерии: пн–пт до 17:00 по Минску ----------
// Настоящее правило живёт в базе (adjust_due_date). Здесь его зеркало — только
// чтобы сказать человеку заранее, куда уедет дата (M2.4), а не удивить потом.
// Время берём минское, а не часы браузера: клиент может быть в другом поясе.

function minskNow() {
  const p = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const isWeekendIso = iso => [0, 6].includes(new Date(iso + "T00:00:00Z").getUTCDay());

// Дата, на которую сервер поставит заявку, если выбрать `iso`. Совпадает с
// выбранной почти всегда; отличается, только когда выбрано «сегодня», а рабочий
// день уже закончился или сегодня выходной.
export function workingDueFor(iso) {
  const now = minskNow();
  if (iso !== now.date || (!isWeekendIso(iso) && now.hour < 17)) return iso;
  let d = addDays(iso, 1);
  while (isWeekendIso(d)) d = addDays(d, 1);
  return d;
}

export function fmtDateDow(dateStr) {
  const dow = ["вс","пн","вт","ср","чт","пт","сб"][new Date(dateStr + "T00:00:00Z").getUTCDay()];
  return dow + ", " + fmtDate(dateStr);
}
