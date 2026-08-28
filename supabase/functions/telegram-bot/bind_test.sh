#!/usr/bin/env bash
# Проверка привязки Telegram к клиенту (/start).
#
# Зачем: в июле 2026 привязка сначала снималась и только потом искался клиент по
# токену. Открытая старая ссылка (например, после перевыпуска) стирала привязку и
# не создавала новую — клиент почти месяц молча не получал уведомления об оплате.
# Этот скрипт закрывает именно тот сценарий.
#
# С августа 2026 проверяется и второе: /start НЕ снимает прежние привязки вообще.
# Один человек может вести две фирмы, и обе должны слать ему уведомления; раньше
# вторая ссылка отключала первую, и он оставался без уведомлений по одной из них.
#
# Как запускать (Git Bash, из корня репозитория):
#   supabase start
#   supabase db reset
#   printf 'TELEGRAM_BOT_TOKEN=000000:FAKE\nTG_WEBHOOK_SECRET=localsecret\n' > /tmp/fn.env
#   supabase functions serve telegram-bot --env-file /tmp/fn.env --no-verify-jwt &
#   bash supabase/functions/telegram-bot/bind_test.sh
#
# Токен бота нарочно фиктивный: отправка в Telegram молча не проходит, а нас
# интересует только состояние привязки в БД.

set -uo pipefail

URL="${FN_URL:-http://127.0.0.1:18321/functions/v1/telegram-bot}"
SECRET="${TG_WEBHOOK_SECRET:-localsecret}"
DOCKER="${DOCKER_BIN:-/c/Program Files/Docker/Docker/resources/bin/docker.exe}"
CT="${DB_CONTAINER:-supabase_db_payments}"
CHAT=555001
fails=0

send() {
  curl -s -o /dev/null -X POST "$URL" \
    -H "content-type: application/json" \
    -H "x-telegram-bot-api-secret-token: $SECRET" \
    -d "{\"message\":{\"chat\":{\"id\":$CHAT},\"from\":{\"id\":$CHAT},\"text\":\"$1\"}}"
  sleep 2
}

# к каким фирмам сейчас привязан чат (пусто, если ни к каким).
# Сортировка обязательна: фирм может быть несколько, и без order by порядок
# в string_agg произвольный — тест начал бы мигать.
bound_to() {
  "$DOCKER" exec -i "$CT" psql -U postgres -d postgres -tAq \
    -c "select coalesce(string_agg(name, ',' order by name), '') from clients where telegram_id = $CHAT;" | tr -d '\r'
}

check() { # $1 = ожидаемое, $2 = описание
  local got
  got="$(bound_to)"
  if [ "$got" = "$1" ]; then
    echo "  ok   — $2"
  else
    echo "  FAIL — $2"
    echo "         ожидали: «$1»"
    echo "         получили: «$got»"
    fails=$((fails + 1))
  fi
}

echo "Привязка Telegram: проверка сценариев /start"

"$DOCKER" exec -i "$CT" psql -U postgres -d postgres -tAq \
  -c "update clients set telegram_id = null;" > /dev/null

send "/start demotoken1"
check "ООО «Ромашка»" "верный токен — привязка создана"

send "/start etogo-tokena-net"
check "ООО «Ромашка»" "неверный токен — прежняя привязка СОХРАНЕНА"

# Главная проверка ради двух фирм у одного человека: вторая ссылка ДОБАВЛЯЕТ
# фирму, а не заменяет первую. Ровно это раньше и ломало уведомления.
send "/start demotoken2"
check "ИП Смирнов,ООО «Ромашка»" "вторая ссылка — фирма ДОБАВЛЕНА, первая на месте"

# повтор той же ссылки не должен плодить строки: привязка идёт update по id
send "/start demotoken2"
count=$("$DOCKER" exec -i "$CT" psql -U postgres -d postgres -tAq \
  -c "select count(*) from clients where telegram_id = $CHAT;" | tr -d '\r')
if [ "$count" = "2" ]; then
  echo "  ok   — повторный /start по той же ссылке ничего не задвоил"
else
  echo "  FAIL — у чата $count привязок, ожидали 2"
  fails=$((fails + 1))
fi

send "/start"
check "ИП Смирнов,ООО «Ромашка»" "голый /start без токена — привязки не трогает"

send "/start etogo-tokena-net"
check "ИП Смирнов,ООО «Ромашка»" "неверный токен при двух фирмах — обе на месте"

echo
if [ "$fails" -eq 0 ]; then echo "Все проверки пройдены."; else echo "Провалено проверок: $fails"; fi
exit $fails
