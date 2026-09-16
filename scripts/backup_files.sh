#!/usr/bin/env bash
# Бэкап файлов Storage (бакет files): счета клиентов и платёжные документы.
#
# Зачем (M3.1): ежедневный pg_dump сохраняет заявки, но сами файлы живут только
# в Storage. Потеря проекта Supabase = потеря всех первичных документов, и
# восстановленные из дампа заявки ссылались бы в пустоту.
#
# Как устроено. Бакет публичный, поэтому секретный ключ не нужен:
#   • список объектов берётся из storage.objects — тем же SUPABASE_DB_URL,
#     которым уже снимается дамп (запрос делает workflow, сюда приходит файл);
#   • каждый файл скачивается по публичной ссылке;
#   • всё складывается в tar.gz и шифруется тем же BACKUP_PASSPHRASE, что дамп:
#     артефакты публичного репозитория может скачать кто угодно.
#
# Структура архива повторяет пути в бакете (files/<папка>/<имя>) — по ним
# файл возвращается на место, и ссылки в заявках снова работают. Порядок
# восстановления — docs/RUNBOOK.md, раздел про Storage.
#
# Использование:
#   STORAGE_URL=https://<ref>.supabase.co BACKUP_PASSPHRASE=... \
#     bash scripts/backup_files.sh objects.txt out.tar.gz.gpg
# objects.txt — по имени объекта на строку (select name from storage.objects
# where bucket_id = 'files').
#
# Код выхода не 0, если хоть один файл не скачался: архив всё равно
# создаётся (частичная копия лучше никакой), но прогон краснеет и GitHub
# присылает письмо.

set -euo pipefail

LIST="$1"
OUT="$2"
: "${STORAGE_URL:?нужен STORAGE_URL}"
: "${BACKUP_PASSPHRASE:?нужен BACKUP_PASSPHRASE}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/files"

total=0
failed=0
while IFS= read -r name || [ -n "$name" ]; do
  [ -z "$name" ] && continue
  total=$((total + 1))

  # Путь внутри архива не должен выйти за пределы папки: имя объекта пишет
  # загрузивший, и «../» в нём — не наша забота, но и не повод писать мимо.
  case "$name" in
    /*|*../*|..*) echo "::warning::пропущено подозрительное имя: $name"; failed=$((failed + 1)); continue ;;
  esac

  # каждый сегмент пути кодируем отдельно: кириллица и пробелы в именах бывают,
  # а слеши между папками кодировать нельзя
  enc="$(jq -rn --arg s "$name" '$s | split("/") | map(@uri) | join("/")')"
  mkdir -p "$WORK/files/$(dirname "$name")"
  if ! curl -fsS --retry 3 --retry-delay 2 --max-time 120 \
         -o "$WORK/files/$name" "$STORAGE_URL/storage/v1/object/public/files/$enc"; then
    echo "::warning::не скачан: $name"
    rm -f "$WORK/files/$name"   # пустышка в архиве выглядела бы как настоящий файл
    failed=$((failed + 1))
  fi
done < "$LIST"

size="$(du -sh "$WORK/files" | cut -f1)"
echo "Объектов в бакете: $total, скачано: $((total - failed)), не скачано: $failed, объём: $size"

tar -C "$WORK" -czf - files \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_PASSPHRASE" -o "$OUT"
ls -lh "$OUT"

[ "$failed" -eq 0 ]
