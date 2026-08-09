// Куда фронт ходит за данными.
//
// Определяем по адресу страницы: с localhost — в локальный стек Supabase,
// отовсюду ещё (GitHub Pages) — в прод. Так локальная проверка не требует
// править этот файл, и невозможно случайно закоммитить конфиг, смотрящий
// не туда: прод-адрес из файла не исчезает.
const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Ключи ниже — публичные anon-ключи, им положено быть во фронте.
// Локальный ключ у Supabase CLI одинаков у всех и секретом не является.
export const SUPABASE_URL = LOCAL
  ? "http://127.0.0.1:18321"
  : "https://gmvhphuabiyggfurfhmc.supabase.co";

export const SUPABASE_KEY = LOCAL
  ? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtdmhwaHVhYml5Z2dmdXJmaG1jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1Njg1NDEsImV4cCI6MjA5NjE0NDU0MX0.sTX7bZFXKRfkb9pPA8Pr_gHzHpYsaU4t5PYNRPeazWU";

export const TABLE  = "payments";
export const BUCKET = "files";
