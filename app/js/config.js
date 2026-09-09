// Куда фронт ходит за данными.
//
// Определяем по адресу страницы: с localhost — в локальный стек Supabase,
// отовсюду ещё (GitHub Pages) — в прод. Так локальная проверка не требует
// править этот файл, и невозможно случайно закоммитить конфиг, смотрящий
// не туда: прод-адрес из файла не исчезает.
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Ключи ниже публичные, им положено быть во фронте: сами по себе они ничего не
// открывают, доступ решают RLS и проверки внутри RPC.
//
// Прод переведён на publishable-ключ новой схемы (sb_publishable_…) вместо
// legacy anon-JWT. Причина не в удобстве: legacy-ключи выключаются целиком,
// одной кнопкой в панели, — и это единственный способ убить утёкший
// service_role, который три месяца пролежал в baseline-миграции публичного
// репозитория (SECURITY.md, п. 5.2.1). Пока фронт ходит legacy-ключом,
// выключить их нельзя.
//
// Локальный стек остаётся на своём anon-ключе: он одинаков у всех, работает
// только против 127.0.0.1 и секретом не является.
export const SUPABASE_URL = LOCAL
  ? "http://127.0.0.1:18321"
  : "https://gmvhphuabiyggfurfhmc.supabase.co";

export const SUPABASE_KEY = LOCAL
  ? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  : "sb_publishable_Vce6cWOwY9G4w-bt9cGsRw_h4YoFR-s";

export const TABLE  = "payments";
export const BUCKET = "files";
