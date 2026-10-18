// Приглашение клиента: готовое сообщение с его персональными ссылками (18.10).
//
// Клиентов подключают сами бухгалтеры, и каждому нужно своё сообщение — ссылки
// персональные. Собирать его руками из шаблона значит переделывать ссылку
// сайта в ссылку бота, путать клиентов и не помнить, кому уже написал. Здесь
// текст собирается сам, а «Я отправил» ставит отметку, которую видят все.
//
// Текст живёт только здесь: сотрудники его не правят, поменять — правка этого
// файла, и у всех обновится сразу. Без разметки (**жирный**): сообщение уходит
// и в Telegram, и в WhatsApp, и на почту, а звёздочки каждый понимает по-своему.

import { sb } from './supabase.js';
import { state } from './state.js';
import { toast } from './utils.js';
import { baseLink } from './clients.js';

const BOT = "paymentITNIMAX_bot";

export function botLink(token) {
  return `https://t.me/${BOT}?start=${encodeURIComponent(token)}`;
}
function guideLink() {
  return new URL("guide/", location.origin + location.pathname).href;
}

const TEXTS = {
  full: (site, bot, guide) => `Здравствуйте!

Знакомая картина: счёт отправлен в одном чате, уточнение — в другом, «оплатили?» — в третьем, а платёжку для поставщика ищете еще среди сообщений. Что-то теряется, о чём-то приходится напоминать.
Больше так не будет.
Оплата счетов теперь занимает у Вас несколько секунд — и больше никогда не превращается в отдельную задачу.

📌 Все платежи — в одном месте
Каждый счёт, который Вы присылаете, сразу становится заявкой в нашей очереди: со сроком и статусом. Никаких задач, раскиданных по чатам и почте.

✅ Ничего не забудется
Заявка остаётся в работе, пока не оплачена. Сроки система держит сама: каждое утро бухгалтер получает список платежей на сегодня и всё, что требует внимания. Ни одна заявка не потеряется в переписке.

📎 Перешлите счёт боту — и всё
Фото, PDF, Word или Excel. Заявка создастся сама: заполнять ничего не нужно, получателя и сумму бухгалтер возьмёт из документа.

🔔 Не нужно спрашивать «оплатили?»
Бот сам напишет, когда платёж проведён, и пришлёт платёжное поручение файлом — его можно сразу переслать поставщику.

📋 Статус каждого платежа — одной кнопкой
«Мои платежи» покажет, что принято, что в работе и что уже оплачено.

💬 Вопросы бухгалтера — там же
Если нужно что-то уточнить, вопрос придёт в бот. Ответить можно одним нажатием, в том числе файлом.

🔁 Аренду и связь — один раз
Заведите ежемесячный платёж, и дальше он будет вставать в очередь сам.

Устанавливать ничего не нужно — всё работает в Вашем Telegram. С компьютера то же самое есть на сайте.

━━━━━━━━━━━━━━━
📖 ОБЯЗАТЕЛЬНО ПОСМОТРИТЕ РУКОВОДСТВО — 2 МИНУТЫ
${guide}
По шагам и на примерах: как отправить счёт, где смотреть статус и как ответить бухгалтеру.
━━━━━━━━━━━━━━━

👉 Подключение — 1 минута:
1. Откройте Вашу ссылку: ${bot}
2. Нажмите «Старт».
3. Перешлите боту первый счёт.

Сайт: ${site}

Мы работаем пн–пт до 17:00 — счёт, присланный позже, встанет на ближайший рабочий день, поэтому Вы можете планировать платежи в любое время суток.

Ссылки персональные и открывают платежи Вашей фирмы.`,

  short: (site, bot, guide) => `Здравствуйте! Теперь все Ваши платежи — в одном месте, и ни один не потеряется в переписке. Перешлите счёт нашему Telegram-боту — заявка создастся сама, а бот сообщит, когда оплачено, и пришлёт платёжку файлом.

📖 Обязательно посмотрите руководство — 2 минуты: ${guide}

Подключение — одна кнопка: ${bot} → «Старт».
С компьютера — сайт: ${site}

Ссылки персональные — пожалуйста, не пересылайте их.`,
};

export function inviteText(client, variant = "full") {
  return (TEXTS[variant] || TEXTS.full)(baseLink(client.token), botLink(client.token), guideLink());
}

// «15.10 · Валентина» — для строки клиента и для окна
export function invitedLabel(c, staffNameById) {
  if (!c.invited_at) return "";
  const d = new Date(c.invited_at);
  const dd = String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0");
  return c.invited_by ? `${dd} · ${staffNameById(c.invited_by)}` : dd;
}

// ---------- окно ----------

let current = null;
let variant = "full";
let afterMark = null;
let nameOf = (id) => id;

function fill() {
  const c = current;
  if (!c) return;
  document.getElementById("invText").value = inviteText(c, variant);
  document.querySelectorAll("#invBox button[data-inv-variant]").forEach((b) => {
    const on = b.getAttribute("data-inv-variant") === variant;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

export function openInvite(client, staffNameById, onMarked) {
  current = client;
  afterMark = onMarked || null;
  nameOf = staffNameById || nameOf;
  document.getElementById("invFirm").textContent = client.name;

  const notes = [];
  if (client.invited_at) notes.push(`Уже приглашён: ${invitedLabel(client, nameOf)}. Отправить ещё раз можно — отметка обновится.`);
  if (client.telegram_id) notes.push("Клиент уже подключил бота — приглашение ему, скорее всего, не нужно.");
  const warn = document.getElementById("invWarn");
  warn.textContent = notes.join(" ");
  warn.classList.toggle("hidden", !notes.length);

  fill();
  document.getElementById("invBox").classList.remove("hidden");
  setTimeout(() => { const b = document.getElementById("invCopy"); if (b) b.focus(); }, 30);
}

export function closeInvite() {
  document.getElementById("invBox").classList.add("hidden");
  current = null;
}

async function copy() {
  const ta = document.getElementById("invText");
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(ta.value);
    toast("Текст скопирован — вставьте его в чат с клиентом и нажмите «Я отправил»");
  } catch {
    // буфер недоступен (окно не в фокусе, запрещено правами) — выделяем
    // текст, чтобы скопировать его руками
    ta.focus(); ta.select();
    toast("Текст выделен — нажмите Ctrl+C");
  }
}

async function markSent() {
  const c = current;
  if (!c) return;
  const btn = document.getElementById("invMark");
  btn.disabled = true;
  try {
    const { data, error } = await sb.rpc("mark_client_invited", { p_id: c.id });
    if (error) throw error;
    const row = state.clientsList.find((x) => x.id === c.id);
    if (row) { row.invited_at = data.invited_at; row.invited_by = data.invited_by; }
    closeInvite();
    toast(`Отмечено: «${c.name}» приглашён`);
    if (afterMark) afterMark();
  } catch (e) {
    console.error(e);
    toast(e && e.message ? `Не отметилось: ${e.message}` : "Не отметилось — попробуйте ещё раз");
  } finally {
    btn.disabled = false;
  }
}

// Вешаем один раз: разметка окна статична, клиент внутри меняется.
export function initInviteDialog() {
  const box = document.getElementById("invBox");
  if (!box) return;
  box.addEventListener("click", (e) => {
    if (e.target === box) { closeInvite(); return; }
    const v = e.target.closest && e.target.closest("button[data-inv-variant]");
    if (v) { variant = v.getAttribute("data-inv-variant"); fill(); return; }
    const a = e.target.closest && e.target.closest("button[data-inv]");
    if (!a) return;
    const act = a.getAttribute("data-inv");
    if (act === "close") closeInvite();
    else if (act === "copy") copy();
    else if (act === "mark") markSent();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) closeInvite();
  });
}
