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

export function fmtMoney(v) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}
