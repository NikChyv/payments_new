// Иконки интерфейса — Lucide (lucide.dev, лицензия ISC), инлайновым SVG
// (редизайн, шаг 8). Не эмодзи: те рисуются шрифтом системы и выглядят по-
// разному на Windows, Android и iPhone, не красятся в цвет кнопки и
// читаются экранной читалкой («колокольчик Напомнить»). Не библиотекой и не
// спрайтом: фронт без сборки, а иконок полтора десятка — пути лежат здесь.
//
// Иконка всегда декоративна (aria-hidden): смысл несёт подпись рядом. Где
// подписи нет, её должен дать title/aria-label у кнопки.

const PATHS = {
  bell:        '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  file:        '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  message:     '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  help:        '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  clock:       '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  paperclip:   '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  upload:      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  x:           '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert:       '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  circleAlert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  check:       '<path d="M20 6 9 17l-5-5"/>',
  arrowDown:   '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowUp:     '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  // периодичность: тот же знак, что ↻ у даты в очереди
  repeat:      '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
};

// ico("bell") — иконка перед подписью, с отступом справа (.ico).
// cls "bare" — без отступа: для элементов, где зазор уже задан gap.
export function ico(name, size = 14, cls = "", stroke = 2) {
  return `<svg class="ico${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    (PATHS[name] || "") + `</svg>`;
}
