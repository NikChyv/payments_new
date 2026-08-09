// Минимальный генератор .xlsx — без внешних библиотек.
//
// Почему свой, а не готовая библиотека: из Excel нам нужны ровно четыре вещи —
// жирная шапка, ширина колонок, суммы числами и даты датами. Ради этого тащить
// 400 КБ чужого минифицированного кода в репозиторий смысла нет.
//
// Формат .xlsx — это обычный zip с XML внутри. Zip пишем без сжатия (метод
// «store»): Excel такое читает штатно, а нам не нужен deflate в браузере.

// ---------- CRC32 (обязателен для каждого файла в zip) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const utf8 = new TextEncoder();

// ---------- сборка zip ----------
function zipStore(files) {
  const parts = [], central = [];
  let offset = 0;

  // время внутри архива: Excel его не проверяет, но формат требует поле
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  files.forEach(f => {
    const name = utf8.encode(f.name);
    const data = utf8.encode(f.xml);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // сигнатура локального заголовка
    lv.setUint16(4, 20, true);           // нужная версия распаковщика
    lv.setUint16(6, 0x0800, true);       // имена в UTF-8
    lv.setUint16(8, 0, true);            // без сжатия
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // сжатый размер = исходному
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // запись центрального каталога
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);      // где лежит локальный заголовок
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  });

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // конец центрального каталога
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd],
    {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

// ---------- вспомогательное ----------
function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}[c]));
}

function colLetter(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}

// Excel хранит дату числом дней от 30.12.1899. Считаем через UTC, чтобы
// перевод часов и пояс РБ не сдвинули дату на сутки.
function dateSerial(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

// ---------- стили ----------
// Индексы cellXfs, на которые ссылаются ячейки: 0 обычная, 1 шапка,
// 2 дата, 3 деньги, 4 итог-подпись, 5 итог-сумма, 6 заголовок листа.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="DD.MM.YYYY"/>
<numFmt numFmtId="165" formatCode="#,##0.00"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB8BEC9"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FFB8BEC9"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/**
 * Собирает книгу из одного листа и отдаёт Blob.
 * columns: [{title, width, type: "text"|"date"|"money"}]
 * rows:    массив массивов «сырых» значений (ISO-строка для даты, число для денег)
 * title:   необязательная строка-заголовок над таблицей (файл уходит клиенту,
 *          поэтому внутри должно быть видно, чей это график и за какой период)
 * total:   true — дописать строку «Итого» с формулой СУММ по денежным колонкам
 */
export function buildXlsx({sheet = "Лист1", columns, rows, title = "", total = false}) {
  const lastCol = colLetter(columns.length - 1);
  const dataRows = rows.length;
  const headRow = title ? 2 : 1;                  // строка с названиями колонок
  const firstData = headRow + 1;
  const lastData = headRow + dataRows;
  // пустая строка между данными и итогом: иначе Excel при открытии растягивает
  // автофильтр на строку «Итого» и та начинает вести себя как обычная запись
  const totalRowNum = lastData + 2;
  const lastRow = total && dataRows > 0 ? totalRowNum : lastData;

  const cols = "<cols>" + columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("") + "</cols>";

  // заголовок занимает всю ширину таблицы (объединённая ячейка ниже, в mergeCells)
  const titleRow = title
    ? `<row r="1" ht="24" customHeight="1"><c r="A1" s="6" t="inlineStr"><is><t>${xmlEsc(title)}</t></is></c></row>`
    : "";

  const head = `<row r="${headRow}" ht="20" customHeight="1">` + columns.map((c, i) =>
    `<c r="${colLetter(i)}${headRow}" s="1" t="inlineStr"><is><t>${xmlEsc(c.title)}</t></is></c>`).join("") + "</row>";

  const body = rows.map((row, ri) => {
    const r = ri + firstData;
    const cells = row.map((v, ci) => {
      const ref = colLetter(ci) + r;
      const type = columns[ci].type || "text";
      if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${type === "date" ? 2 : type === "money" ? 3 : 0}"/>`;
      if (type === "date")  return `<c r="${ref}" s="2"><v>${dateSerial(v)}</v></c>`;
      if (type === "money") return `<c r="${ref}" s="3"><v>${Number(v)}</v></c>`;
      return `<c r="${ref}" s="0" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");

  let totalRow = "";
  if (total && dataRows > 0) {
    totalRow = `<row r="${totalRowNum}">` + columns.map((c, i) => {
      const ref = colLetter(i) + totalRowNum;
      if (i === 0) return `<c r="${ref}" s="4" t="inlineStr"><is><t>Итого</t></is></c>`;
      if (c.type === "money") {
        const col = colLetter(i);
        const sum = rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
        // и формула (пересчитается при правках), и готовое значение —
        // чтобы сумма была видна даже до первого пересчёта
        return `<c r="${ref}" s="5"><f>SUM(${col}${firstData}:${col}${lastData})</f><v>${sum}</v></c>`;
      }
      return `<c r="${ref}" s="4"/>`;
    }).join("") + "</row>";
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0" tabSelected="1">
<pane ySplit="${headRow}" topLeftCell="A${firstData}" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${titleRow}${head}${body}${totalRow}</sheetData>
${dataRows > 0 ? `<autoFilter ref="A${headRow}:${lastCol}${lastData}"/>` : ""}
${title ? `<mergeCells count="1"><mergeCell ref="A1:${lastCol}1"/></mergeCells>` : ""}
<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;

  return zipStore([
    {name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`},

    {name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`},

    {name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc(sheet).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`},

    {name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`},

    {name: "xl/styles.xml", xml: STYLES_XML},
    {name: "xl/worksheets/sheet1.xml", xml: sheetXml},
  ]);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
