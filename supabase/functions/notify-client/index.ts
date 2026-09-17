import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
// Номера бухгалтеров здесь больше не живут: адресатов по каждой заявке считает
// база (notify_staff_chats), см. staffChats ниже. Раньше это был секрет
// TELEGRAM_CHAT_ID, и всё уходило всем подряд, чей бы клиент ни был.

// service_role подставляется Supabase автоматически
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  // SB_SECRET_KEY — новый ключ (sb_secret_…); SUPABASE_SERVICE_ROLE_KEY —
  // legacy, который платформа подставляет сама. Читаем новый с откатом на
  // старый, чтобы функция работала и до отключения legacy-ключей, и после.
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Кто имеет право дёргать эту функцию.
//
// Verify JWT у вебхуков включён, но он принимает ЛЮБОЙ валидный ключ проекта —
// в том числе публичный, который лежит во фронте. То есть кто угодно мог бы
// прислать сюда произвольный record: подделать сообщение клиента в чат
// бухгалтеров, проставить флаги уведомлений чужой заявке или заставить функцию
// скачать любой URL и переслать его в Telegram. Поэтому проверяем собственный
// секрет, как это уже сделано у бота (TG_WEBHOOK_SECRET).
//
// Пока WEBHOOK_SECRET не задан в окружении, проверка выключена: это позволяет
// выкатить функцию раньше, чем секрет появится в триггерах, и не уронить
// уведомления на время перехода.
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
function fromWebhook(req: Request) {
  if (!WEBHOOK_SECRET) return true;
  return req.headers.get("x-webhook-secret") === WEBHOOK_SECRET;
}

const months = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];

// Одно сообщение переписки по заявке (payments.thread). Форму задаёт БД —
// post_staff_message и reply_by_token, миграция 20260909000001.
type ThreadMsg = {
  who?: string;                 // 'staff' | 'client'
  kind?: string;                // 'question' | 'reminder' | 'reply'
  text?: string;
  author?: string;
  files?: Array<{ url?: string; name?: string }>;
  at?: string;
};

function fmtMoney(v: number) {
  return Number(v).toLocaleString("ru-RU", {minimumFractionDigits: 2, maximumFractionDigits: 2}) + " Br";
}
function fmtDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-");
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}
const recLbl: Record<string, string> = {once:"Разовый", weekly:"Еженедельно", monthly:"Ежемесячно"};

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!));
}

// Неудачная отправка — в журнал, а не только в консоль.
//
// У Database Webhooks нет ретраев, а console.error никто не читает: ровно так
// получился инцидент «клиент месяц не получал уведомлений». Теперь каждая
// осечка оставляет след, а health.yml сторожит счётчик (находка M4.4).
//
// Сам журнал падать не имеет права: если запись не удалась, уведомления это
// касаться не должно.
async function logFailure(branch: string, paymentId: unknown, chatId: unknown, detail: string) {
  try {
    await sb.from("notify_failures").insert({
      fn: "notify-client", branch,
      payment_id: paymentId == null ? null : String(paymentId),
      chat_id: chatId == null ? null : String(chatId),
      detail: detail.slice(0, 2000),
    });
  } catch (e) {
    console.error("не записался notify_failures:", e);
  }
}

// Кому из сотрудников слать уведомление по заявке: бухгалтер её клиента плюс
// админы. Само правило живёт в базе (notify_staff_chats) — одно на обе функции
// уведомлений и на утреннее письмо, и покрыто тестами. Здесь только вызов.
//
// Если у ответственного бухгалтера не указан Telegram, база всё равно вернёт
// админов, а мы пишем это в журнал: иначе бухгалтер молча ничего не получает,
// и узнаём мы об этом от недовольного клиента.
//
// Та же функция есть в notify-payment — правило в базе, а обёртка простая,
// поэтому держим две копии, а не заводим общий модуль ради десяти строк.
async function staffChats(branch: string, rec: Record<string, unknown>): Promise<string[]> {
  const { data, error } = await sb.rpc("notify_staff_chats", { p_client_id: rec.client_id ?? null });
  if (error) {
    console.error("notify_staff_chats:", error);
    await logFailure(branch, rec.id, null, `не удалось получить адресатов: ${error.message}`);
    return [];
  }
  if (data?.unreachable) {
    await logFailure(branch, rec.id, null,
      `у бухгалтера «${data.unreachable}» не указан telegram_id — уведомление ушло только админу`);
  }
  return Array.isArray(data?.chats) ? data.chats : [];
}

async function tg(chatId: string | number, text: string, keyboard?: unknown, branch = "?", paymentId?: unknown) {
  const body: Record<string, unknown> = {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  // fetch БРОСАЕТ при сетевой ошибке, а не возвращает !ok. Раньше такое
  // исключение вылетало из ветки наружу и рубило весь вызов: остальные
  // уведомления по заявке не уходили вовсе. Отправка не имеет права бросать.
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const detail = `Telegram недоступен: ${e instanceof Error ? e.message : String(e)}`;
    console.error(detail);
    await logFailure(branch, paymentId, chatId, detail);
    return false;
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error(`Telegram error for ${chatId}:`, detail);
    await logFailure(branch, paymentId, chatId, `${res.status} ${detail}`);
  }
  return res.ok;
}

// Отправка документа клиенту.
//
// Шлём именно sendDocument и именно БАЙТАМИ, а не ссылкой. Две причины:
//
// 1. Пересылка. Клиент перешлёт сообщение поставщику как подтверждение оплаты —
//    Telegram передаст сам файл, и наша вечная публичная ссылка никуда не уйдёт.
// 2. Имя файла. Если отдать Telegram URL, он возьмёт имя из адреса, а в пути
//    кириллица заменена подчёркиваниями при загрузке — клиент получил бы
//    «________.pdf» и переслал бы это поставщику. Подставляя байты, имя задаём
//    сами и человеческое.
//
// sendPhoto не годится даже для фотографии платёжки: Telegram её пережмёт.
async function tgDocument(chatId: string | number, url: string, name: string, caption: string | undefined, paymentId: unknown) {
  // Битая ссылка на документ — самая коварная осечка: раньше она делала заявку
  // навсегда глухой и никак себя не проявляла. Причём ссылка может не просто
  // отдать 404, а вовсе не отозваться — тогда fetch БРОСАЕТ, и это исключение
  // рубило весь вызов, а не одну ветку.
  let file: Response;
  try {
    file = await fetch(url);
  } catch (e) {
    const detail = `файл не забрать: ${e instanceof Error ? e.message : String(e)} (${url})`;
    console.error(detail);
    await logFailure("документ", paymentId, chatId, detail);
    return false;
  }
  if (!file.ok) {
    console.error(`Не скачался файл ${url}: ${file.status}`);
    await logFailure("документ", paymentId, chatId, `файл не скачался: ${file.status} ${url}`);
    return false;
  }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([await file.arrayBuffer()]), name || "document");
  if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: "POST", body: form });
  } catch (e) {
    const detail = `Telegram недоступен: ${e instanceof Error ? e.message : String(e)}`;
    console.error(detail);
    await logFailure("документ", paymentId, chatId, detail);
    return false;
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error(`Telegram sendDocument error for ${chatId}:`, detail);
    await logFailure("документ", paymentId, chatId, `${res.status} ${detail}`);
  }
  return res.ok;
}

// Один Telegram-аккаунт может быть привязан к нескольким фирмам сразу (человек
// ведёт две компании). Тогда «Ваш платёж «Белтелеком» оплачен» бесполезен — он
// не понимает, чей это платёж. Подписываем фирму, но только таким людям:
// остальным это лишняя строка в каждом сообщении.
async function firmSuffix(telegramId: number, firm: unknown) {
  const name = String(firm ?? "").trim();
  if (!name) return "";
  const { count } = await sb.from("clients")
    .select("id", { count: "exact", head: true }).eq("telegram_id", telegramId);
  return (count ?? 1) > 1 ? `\n\n🏢 ${esc(name)}` : "";
}

// Что именно изменилось — списком «было → стало». Только те поля, которые видит
// человек: служебные флаги уведомлений сюда попадать не должны, иначе функция
//сама себе устроит рассылку, проставив флаг после отправки.
function diffLines(oldRec: Record<string, unknown>, rec: Record<string, unknown>,
                   skipFiles = false, skipDue = false): string[] {
  const out: string[] = [];
  const pair = (label: string, a: string, b: string) => out.push(`• ${label}: ${esc(a)} → <b>${esc(b)}</b>`);

  if (oldRec.payee !== rec.payee) pair("Получатель", String(oldRec.payee ?? "—"), String(rec.payee ?? "—"));
  if (Number(oldRec.amount) !== Number(rec.amount))
    pair("Сумма", fmtMoney(Number(oldRec.amount ?? 0)), fmtMoney(Number(rec.amount ?? 0)));
  if (oldRec.due !== rec.due && !skipDue) pair("Дата", fmtDate(String(oldRec.due ?? "")), fmtDate(String(rec.due ?? "")));
  if (oldRec.requisites !== rec.requisites)
    pair("Реквизиты", String(oldRec.requisites || "—"), String(rec.requisites || "—"));
  if (oldRec.purpose !== rec.purpose)
    pair("Назначение", String(oldRec.purpose || "—"), String(rec.purpose || "—"));
  if (oldRec.recurrence !== rec.recurrence)
    pair("Периодичность",
         recLbl[String(oldRec.recurrence)] ?? String(oldRec.recurrence),
         recLbl[String(rec.recurrence)] ?? String(rec.recurrence));
  if (oldRec.need_receipt !== rec.need_receipt)
    pair("Платёжный документ", oldRec.need_receipt ? "нужен" : "не нужен", rec.need_receipt ? "нужен" : "не нужен");

  const oldN = Array.isArray(oldRec.files) ? oldRec.files.length : 0;
  const newN = Array.isArray(rec.files) ? rec.files.length : 0;
  if (oldN !== newN && !skipFiles) pair("Файлов", String(oldN), String(newN));

  return out;
}

serve(async (req) => {
  if (!fromWebhook(req)) return new Response("forbidden", { status: 403 });

  // Живут снаружи try, потому что нужны и обработчику исключения: что успели
  // доставить, то обязаны записать в любом случае.
  const patch: Record<string, unknown> = {};
  const done: string[] = [];
  let paymentId: unknown = null;

  // Записать накопленное. Зовётся и по-хорошему, и из catch, поэтому сама
  // падать не имеет права.
  const flush = async () => {
    if (!paymentId || !Object.keys(patch).length) return;
    try {
      await sb.from("payments").update(patch).eq("id", paymentId);
    } catch (e) {
      console.error("не записались флаги уведомлений:", e);
      await logFailure("запись флагов", paymentId, null,
        `исключение: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    const body = await req.json();
    const rec = body.record;
    const old = body.old_record;

    if (body.type !== "UPDATE" || !rec || !old) return new Response("skip");
    paymentId = rec.id;

    // -----------------------------------------------------------------------
    // Ветки ниже НЕ выходят из функции досрочно (находка M4.1)
    //
    // Раньше каждая заканчивалась `return`, и первая же сработавшая запирала
    // все остальные. У клиента без Telegram ветка «документ» на КАЖДОМ UPDATE
    // входила и выходила, а «оплачено» до него не доходило никогда. Битая
    // ссылка на документ (файл удалили, Storage отдал 4xx) делала заявку глухой
    // навсегда: сообщения по ней не уходили больше вообще никакие.
    //
    // Теперь каждая ветка делает своё дело и складывает результат в `patch`,
    // а строка обновляется ОДИН раз в конце. Заодно это один повторный вызов
    // вебхука вместо нескольких.
    // -----------------------------------------------------------------------

    // Телеграм клиента нужен трём веткам — читаем его один раз, а не трижды.
    let clientTg: number | null = null;
    if (rec.client_id) {
      const { data: client } = await sb
        .from("clients").select("telegram_id").eq("id", rec.client_id).maybeSingle();
      clientTg = client?.telegram_id ?? null;
    }

    // Адресаты среди сотрудников нужны двум веткам — «клиент ответил» и «клиент
    // изменил». Спрашиваем базу лениво и один раз: чаще всего вызов про статус
    // или документ, и сотрудникам там слать нечего. Заодно запись «у бухгалтера
    // нет Telegram» не задвоится, если в одном вызове сработают обе ветки.
    let staffChatsMemo: string[] | null = null;
    const getStaffChats = async (branch: string) =>
      staffChatsMemo ??= await staffChats(branch, rec);

    // ---------- 0. платёжный документ от бухгалтера ----------
    // Стоит первой намеренно: прикрепление документа приходит сюда как обычный
    // UPDATE от сотрудника, а diffLines про staff_files не знает.
    const docs: Array<{ url?: string; name?: string; part_id?: string }> = Array.isArray(rec.staff_files) ? rec.staff_files : [];
    const alreadySent = Number(rec.client_docs_notified ?? 0);
    const fresh = docs.slice(alreadySent).filter((d) => d && d.url);

    if (fresh.length && clientTg) {
      // Подпись только у первого файла — иначе один и тот же текст повторится
      // под каждым вложением. Пишем её так, чтобы пересылка поставщику была
      // самодостаточной: из сообщения понятно, что за платёж и что он прошёл.
      // Документ на часть оплаты (part_id) — про сумму части, а не всей заявки:
      // «платёж на 500 оплачен» под платёжкой на 200 поставщик прочтёт как
      // полную оплату.
      const parts: Array<{ id?: string; amount?: number }> = Array.isArray(rec.parts) ? rec.parts : [];
      const part = fresh[0].part_id ? parts.find((p) => p?.id === fresh[0].part_id) : undefined;
      const caption = (part
          ? `✅ По платежу «${esc(rec.payee)}» оплачена часть: ${fmtMoney(Number(part.amount ?? 0))}.`
          : `✅ Платёж «${esc(rec.payee)}» на ${fmtMoney(Number(rec.amount))} оплачен.`)
        + `\n📄 Во вложении — платёжный документ.`
        + await firmSuffix(clientTg, rec.client);

      let sent = 0;
      for (const d of fresh) {
        const ok = await tgDocument(clientTg, d.url!, d.name || "документ",
                                    sent === 0 ? caption : undefined, rec.id);
        if (!ok) break;   // не дошёл — счётчик не двигаем, при следующем касании допошлём
        sent++;
      }

      if (sent > 0) {
        patch.client_docs_notified = alreadySent + sent;
        // Документ ушёл — текстовое «документ отправлен» теперь только
        // дублировало бы. Но не документ на часть: заявка ещё открыта, и если
        // потом её закроют без файла, клиент так и не узнал бы о закрытии.
        if (fresh.slice(0, sent).some((d) => !d.part_id)) patch.client_sent_notified = true;
        done.push("документ");
      }
    }

    // ---------- 0.5. переписка по заявке ----------
    // Стоит перед разбором статуса и правок по той же причине, что и документ:
    // сообщение приходит сюда обычным UPDATE, а diffLines про thread не знает и
    // вернула бы «skip» — ни клиент, ни бухгалтер ничего бы не получили.
    //
    // Счётчики client_thread_notified / staff_thread_notified — это ИНДЕКСЫ в
    // переписке, а не количество отправленного: в ней вперемешку лежат реплики
    // обеих сторон, и считать «сколько своих отправил» пришлось бы дважды.
    // Не дошло — оставляем индекс на неудачном сообщении и допошлём при
    // следующем касании заявки.
    const thread: ThreadMsg[] = Array.isArray(rec.thread) ? rec.thread : [];

    if (thread.length) {
      const fromClient = Number(rec.client_thread_notified ?? 0);
      const fromStaff  = Number(rec.staff_thread_notified ?? 0);
      const hasForClient = thread.slice(fromClient).some((m) => m && m.who === "staff");
      const hasForStaff  = thread.slice(fromStaff).some((m) => m && m.who === "client");

      if (hasForClient || hasForStaff) {
        // сообщение бухгалтера → клиенту, с кнопкой «Ответить» под ним
        if (hasForClient) {
          // Не привязан к боту — индекс НЕ двигаем: привяжется, и вопрос дойдёт.
          // Пока же он виден ему в кабинете, туда сообщение попало сразу.
          if (clientTg) {
            const suffix = await firmSuffix(clientTg, rec.client);
            const card = `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}`;
            let i = fromClient;
            for (; i < thread.length; i++) {
              const m = thread[i];
              if (!m || m.who !== "staff") continue;
              const head = m.kind === "reminder"
                ? "🔔 <b>Напоминание от бухгалтера</b>"
                : "❗ <b>Бухгалтер спрашивает по вашей заявке</b>";
              const ok = await tg(clientTg,
                `${head}\n\n${card}\n\n${esc(m.text)}${suffix}`,
                [[{ text: "✍️ Ответить", callback_data: `reply:${rec.id}` }]],
                "переписка → клиенту", rec.id);
              if (!ok) break;
            }
            if (i > fromClient) { patch.client_thread_notified = i; done.push("вопрос клиенту"); }
          }
        }

        // ответ клиента → бухгалтеру этого клиента и админам
        const replyChats = hasForStaff ? await getStaffChats("переписка → бухгалтерам") : [];
        if (hasForStaff && replyChats.length) {
          const card = `👤 ${esc(rec.client)}\n`
                     + `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}`;
          let i = fromStaff;
          for (; i < thread.length; i++) {
            const m = thread[i];
            if (!m || m.who !== "client") continue;
            // Файл клиент прислал в ответ, и он уже лежит во вложениях заявки —
            // ссылкой, чтобы открыть его можно было прямо из чата.
            const files = (m.files ?? [])
              .filter((f) => f && f.url)
              .map((f) => `📎 <a href="${esc(f.url)}">${esc(f.name || "файл")}</a>`)
              .join("\n");
            const text = `💬 <b>Клиент ответил по заявке</b>\n\n${card}\n\n`
                       + (m.text ? `«${esc(m.text)}»` : "<i>без текста</i>")
                       + (files ? `\n\n${files}` : "");
            const results = await Promise.all(
              replyChats.map((chat) => tg(chat, text, undefined, "переписка → бухгалтерам", rec.id)));
            if (!results.some(Boolean)) break;   // не дошло вообще никому — повторим позже
          }
          if (i > fromStaff) { patch.staff_thread_notified = i; done.push("ответ бухгалтерам"); }
        } else if (hasForStaff) {
          // Индекс не двигаем: как только кому-то проставят Telegram, ответ
          // дойдёт при следующем касании заявки. Но и молчать нельзя.
          await logFailure("переписка → бухгалтерам", rec.id, null,
            "некому отправить: ни у бухгалтера клиента, ни у админов не указан telegram_id");
        }
      }
    }

    // ---------- 1. смена статуса: уведомляем клиента ----------
    let text: string | null = null;
    let flagField: "client_paid_notified" | "client_sent_notified" | null = null;

    if (rec.status === "paid" && old.status !== "paid" && !rec.client_paid_notified) {
      // «Закрыть с недоплатой» — тот же переход в paid, но оплачено меньше суммы:
      // «оплачен на 1 000» было бы неправдой, клиент ждал бы, что ушло всё.
      const paid = Number(rec.paid_amount ?? 0), amount = Number(rec.amount);
      text = (paid > 0 && paid < amount
               ? `✅ По заявке «${esc(rec.payee)}» оплачено ${fmtMoney(paid)} из ${fmtMoney(amount)}. Заявка закрыта.`
               : `✅ Ваш платёж «${esc(rec.payee)}» на ${fmtMoney(amount)} оплачен.`)
           + (rec.need_receipt ? "\n📄 Готовим платёжный документ." : "");
      flagField = "client_paid_notified";
    } else if (rec.status === "sent" && old.status !== "sent" && !rec.client_sent_notified
               && !patch.client_sent_notified && rec.need_receipt) {
      // M1.5: «документ отправлен» уместно, только если документ вообще просили.
      // У заявки с need_receipt = false кнопка «Закрыть» — внутреннее действие
      // бухгалтера, а клиент получал «📄 Платёжный документ отправлен» и шёл
      // искать документ, которого нет и не было.
      //
      // Проверка patch.client_sent_notified — про случай, когда документ ушёл
      // вложением прямо в этом же вызове: текст был бы дубликатом.
      text = `📄 Платёжный документ по «${esc(rec.payee)}» отправлен.`;
      flagField = "client_sent_notified";
    }

    if (text && flagField && clientTg) {
      text += await firmSuffix(clientTg, rec.client);

      // флаг ставим только после успешной отправки — иначе уведомление потеряется
      // навсегда: повторно оно уже не уйдёт
      if (await tg(clientTg, text, undefined, "статус", rec.id)) {
        patch[flagField] = true;
        done.push("статус");
      }
    }

    // ---------- 1а. оплата частью ----------
    // Клиента уведомляем о каждой части (решение 27.08). Счётчик — как у
    // документов: не дошло сейчас (нет Telegram, сеть), допошлём при следующем
    // касании заявки. Несколько неотправленных частей — одним сообщением.
    //
    // Финальную часть сюда не берём: она переводит заявку в paid, и про неё
    // скажет ветка «оплачено» выше — одно действие, одно сообщение. Отмена части
    // клиенту не сообщается (как и отмена оплаты), счётчик просто опускается,
    // чтобы следующая часть снова дошла.
    const parts: Array<{ amount?: number }> = Array.isArray(rec.parts) ? rec.parts : [];
    const partsTold = Number(rec.client_parts_notified ?? 0);
    if (parts.length < partsTold ||
        (parts.length > partsTold && (rec.status === "paid" || rec.status === "sent"))) {
      patch.client_parts_notified = parts.length;
    } else if (parts.length > partsTold && clientTg) {
      const fresh = parts.slice(partsTold).reduce((s, p) => s + Number(p?.amount ?? 0), 0);
      const left = Math.max(Number(rec.amount) - Number(rec.paid_amount ?? 0), 0);
      const partText = `💸 По заявке «${esc(rec.payee)}» оплачено ${fmtMoney(fresh)}.\n`
                     + `Остаток ${fmtMoney(left)} — оплатим до ${fmtDate(String(rec.due))}.`
                     + await firmSuffix(clientTg, rec.client);
      if (await tg(clientTg, partText, undefined, "часть", rec.id)) {
        patch.client_parts_notified = parts.length;
        done.push("часть");
      }
    }

    // ---------- 2. правка заявки ----------
    // Направление определяет БД: last_edit_role проставляет триггер по JWT,
    // подделать его из браузера нельзя.
    //
    // Ответ клиента с файлом из кабинета приходит одним UPDATE: reply_by_token
    // дописывает переписку и кладёт файл во вложения, а триггер ставит
    // last_edit_role = anon. Без этой оговорки бухгалтер получал два сообщения
    // подряд — «Клиент ответил» (уже со ссылкой на файл) и «Клиент изменил
    // заявку: Файлов 0 → 1». Если в этом же UPDATE в переписке появились
    // сообщения клиента, прирост файлов объяснён ответом и правкой не считается.
    // Остальные поля reply_by_token не трогает, так что настоящая правка
    // по-прежнему дойдёт — она приходит отдельным UPDATE.
    const oldThread = Array.isArray(old.thread) ? old.thread as ThreadMsg[] : [];
    const clientReplied = thread.length > oldThread.length &&
      thread.slice(oldThread.length).some((m) => m && m.who === "client");
    // Та же история с оплатой частью: pay_part переносит срок на дату остатка
    // и undo_part возвращает прежний — дата уже есть в сообщении о части, а
    // «Бухгалтер изменил вашу заявку: Дата» вторым сообщением было бы дублем.
    const partsMoved = Number(old.paid_amount ?? 0) !== Number(rec.paid_amount ?? 0);
    const changes = diffLines(old, rec, clientReplied, partsMoved);
    if (changes.length) {
      // правил сотрудник → сообщаем клиенту, но только про ЕГО собственную заявку:
      // заявки, заведённые бухгалтером, клиент и так не редактирует
      if (rec.last_edit_role === "authenticated" && !rec.created_by_staff && clientTg) {
        await tg(clientTg,
          `✏️ Бухгалтер изменил вашу заявку «${esc(rec.payee)}»:\n\n` + changes.join("\n") +
          await firmSuffix(clientTg, rec.client), undefined, "правка → клиенту", rec.id);
        done.push("правка");

      // правил клиент → сообщаем бухгалтеру этого клиента и админам
      } else if (rec.last_edit_role === "anon") {
        const editChats = await getStaffChats("правка → бухгалтерам");
        if (editChats.length) {
          const head = `✏️ <b>Клиент изменил заявку</b>\n\n`
                     + `👤 ${esc(rec.client)}\n`
                     + `💳 ${esc(rec.payee)} · ${fmtMoney(Number(rec.amount))} · ${fmtDate(String(rec.due))}\n\n`;
          await Promise.all(editChats.map((chat) =>
            tg(chat, head + changes.join("\n"), undefined, "правка → бухгалтерам", rec.id)));
          done.push("правка");
        } else {
          await logFailure("правка → бухгалтерам", rec.id, null,
            "некому отправить: ни у бухгалтера клиента, ни у админов не указан telegram_id");
        }
      }
    }

    // Одно обновление на весь вызов — значит и повторный вебхук будет один.
    // На повторе все ветки промолчат: в patch лежат только счётчики и флаги
    // уведомлений, а diffLines про них не знает.
    await flush();

    return new Response(done.length ? `ok: ${done.join(", ")}` : "skip");
  } catch (e) {
    console.error(e);
    await logFailure("вызов целиком", paymentId, null,
      `исключение: ${e instanceof Error ? e.message : String(e)}`);
    // Что успели доставить — обязаны записать даже на исключении. Иначе
    // счётчики останутся на месте, и при следующем касании заявки клиент
    // получит те же сообщения второй раз.
    await flush();
    return new Response("ok");
  }
});
