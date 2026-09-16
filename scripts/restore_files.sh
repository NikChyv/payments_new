#!/usr/bin/env bash
# Восстановление файлов Storage из бэкапа scripts/backup_files.sh.
#
# Кладёт каждый файл обратно по его прежнему пути в бакете files — тогда
# ссылки, сохранённые в заявках (payments.files, staff_files, переписка),
# снова открываются, и править базу не нужно.
#
# Уже существующие файлы НЕ перезаписываются (x-upsert: false): скрипт можно
# безопасно запускать повторно и на частично живой бакет.
#
# Использование (Git Bash или Linux, нужны curl, gpg, tar):
#   STORAGE_URL=https://gmvhphuabiyggfurfhmc.supabase.co \
#   SB_SECRET_KEY=sb_secret_... \
#   BACKUP_PASSPHRASE=... \
#     bash scripts/restore_files.sh files-YYYYMMDD-HHMMSS.tar.gz.gpg
#
# SB_SECRET_KEY — Supabase → Project Settings → API Keys → secret. Нужен
# потому, что писать в бакет аноним не может, а бакет режет тип и размер — тип
# передаём по расширению, тот же белый список, что у фронта и бота.

set -euo pipefail

ARCHIVE="$1"
: "${STORAGE_URL:?нужен STORAGE_URL}"
: "${SB_SECRET_KEY:?нужен SB_SECRET_KEY}"
: "${BACKUP_PASSPHRASE:?нужен BACKUP_PASSPHRASE}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gpg --batch --quiet --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -d "$ARCHIVE" \
  | tar -xz -C "$WORK"

mime_of() {
  case "$(echo "${1##*.}" | tr 'A-Z' 'a-z')" in
    jpg|jpeg) echo image/jpeg ;;
    png)  echo image/png ;;
    heic) echo image/heic ;;
    heif) echo image/heif ;;
    webp) echo image/webp ;;
    pdf)  echo application/pdf ;;
    xlsx) echo application/vnd.openxmlformats-officedocument.spreadsheetml.sheet ;;
    docx) echo application/vnd.openxmlformats-officedocument.wordprocessingml.document ;;
    xls)  echo application/vnd.ms-excel ;;
    doc)  echo application/msword ;;
    *)    echo application/octet-stream ;;
  esac
}

# кодируем каждый сегмент пути, слеши оставляем
urlpath() {
  local out="" seg
  local IFS=/
  for seg in $1; do
    local enc="" i c
    for ((i = 0; i < ${#seg}; i++)); do
      c="${seg:i:1}"
      case "$c" in
        [A-Za-z0-9._~-]) enc+="$c" ;;
        *) enc+="$(printf '%s' "$c" | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g' | tr 'a-f' 'A-F')" ;;
      esac
    done
    out+="${out:+/}$enc"
  done
  printf '%s' "$out"
}

ok=0; skipped=0; failed=0
cd "$WORK/files"
while IFS= read -r -d '' f; do
  name="${f#./}"
  # Файл уже на месте — не отправляем его заново. Отказ «уже существует»
  # хранилище даёт, не дочитав тело, и на большом файле это подвешивало
  # следующий запрос (проверено на локальном стеке: 504 на соседнем файле).
  # Бакет публичный, так что проверка — обычный HEAD по публичной ссылке.
  if curl -sfI -o /dev/null "$STORAGE_URL/storage/v1/object/public/files/$(urlpath "$name")"; then
    skipped=$((skipped + 1))
    continue
  fi
  code=$(curl -sS -o "$WORK/resp" -w '%{http_code}' -X POST \
           -H "apikey: $SB_SECRET_KEY" -H "Authorization: Bearer $SB_SECRET_KEY" \
           -H "Content-Type: $(mime_of "$name")" -H "x-upsert: false" \
           --data-binary "@$f" "$STORAGE_URL/storage/v1/object/files/$(urlpath "$name")" || echo 000)
  if [ "$code" = "200" ]; then
    ok=$((ok + 1))
  elif grep -q -i "already exists\|Duplicate" "$WORK/resp" 2>/dev/null; then
    skipped=$((skipped + 1))
  else
    echo "не залит: $name (HTTP $code) $(head -c 200 "$WORK/resp")"
    failed=$((failed + 1))
  fi
done < <(find . -type f -print0)

echo "Залито: $ok, уже были на месте: $skipped, ошибок: $failed"
[ "$failed" -eq 0 ]
