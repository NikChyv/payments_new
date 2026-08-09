// Выгрузка платежей клиента в Excel — для бухгалтера и админа.
//
// Данные берём из уже загруженной очереди (state.items), а не отдельным запросом:
// она уже отфильтрована правами (RLS + фильтр в load()), поэтому бухгалтер
// физически не может выгрузить чужого клиента — чужих строк у него нет в памяти.
// Файл собирается прямо в браузере, никуда не отправляется.

import { state } from './state.js';
import { isoLocal, fmtDate } from './dates.js';
import { toast } from './utils.js';
import { buildXlsx, downloadBlob } from './xlsx.js';
import { recLbl, stLbl } from './queue.js';

const COLUMNS = [
  {title: "Дата",          width: 12,   type: "date"},
  {title: "Получатель",    width: 30,   type: "text"},
  {title: "Сумма, Br",     width: 14,   type: "money"},
  {title: "Назначение",    width: 34,   type: "text"},
  {title: "Реквизиты",     width: 24,   type: "text"},
  {title: "Периодичность", width: 15,   type: "text"},
  {title: "Статус",        width: 18,   type: "text"},
];

// Период по умолчанию — текущий месяц.
export function monthRange() {
  const d = new Date();
  return {
    from: isoLocal(new Date(d.getFullYear(), d.getMonth(), 1)),
    to:   isoLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

// Имя файла попадёт в письмо клиенту — убираем всё, что ломает файловые системы.
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function exportClientPayments(clientId, from, to) {
  const client = state.clientsList.find(c => c.id === clientId);
  if (!client) { toast("Клиент не найден"); return; }
  if (!from || !to) { toast("Укажите период"); return; }
  if (from > to)   { toast("Начало периода позже конца"); return; }

  const rows = state.items
    .filter(it => it.client_id === clientId && it.due >= from && it.due <= to)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
    .map(it => [
      it.due,
      it.payee || "",
      Number(it.amount) || 0,
      it.purpose || "",
      it.requisites || "",
      recLbl[it.recurrence] || "",
      stLbl[it.status] || "",
    ]);

  if (!rows.length) { toast("За выбранный период платежей нет"); return; }

  const blob = buildXlsx({
    sheet: "График платежей",
    title: client.name + " · график платежей " + fmtDate(from) + " — " + fmtDate(to),
    columns: COLUMNS,
    rows,
    total: true,
  });

  downloadBlob(blob, `Платежи_${safeName(client.name)}_${from}_${to}.xlsx`);
  toast("Выгружено: " + rows.length + " " +
        plural(rows.length, "платёж", "платежа", "платежей"));
}
