#!/usr/bin/env bash
# pkg3-51: перенос ЖИВОЙ базы из Yandex Database на этот сервер —
# обходной путь, когда облачная функция не запускается, а база цела.
#
# Запуск от root, три значения из консоли Yandex Cloud одной строкой:
#   bash /opt/sega-chat/code/cloud-vps/import-ydb.sh \
#     "https://docapi.serverless.yandexcloud.net/ru-central1/…" \
#     "КЛЮЧ_ID" "СЕКРЕТ_КЛЮЧА"
#
# Дополнительные флаги (можно в любом порядке):
#   --inspect  только посмотреть, что в облачной базе (служба не останавливается)
#   --force    заменить переписку этого сервера, если она уже есть
#   --save-copy сохранить местную копию перенесённой базы файлом
#
# Что делает: останавливает службу → читает облачную базу → кладёт её на этот
# сервер → поднимает службу → показывает результат.
# В облаке ничего не меняется: база только читается.
set -uo pipefail

APP="/opt/sega-chat"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /tmp)"

ENDPOINT=""; KEY_ID=""; SECRET_KEY=""; FLAGS=""
for a in "$@"; do
  case "$a" in
    --force|--inspect|--save-copy) FLAGS="$FLAGS $a" ;;
    --*) : ;;
    *) if [ -z "$ENDPOINT" ]; then ENDPOINT="$a"
       elif [ -z "$KEY_ID" ]; then KEY_ID="$a"
       elif [ -z "$SECRET_KEY" ]; then SECRET_KEY="$a"; fi ;;
  esac
done
ENDPOINT="${ENDPOINT:-${YDB_ENDPOINT:-}}"
KEY_ID="${KEY_ID:-${YDB_ACCESS_KEY_ID:-}}"
SECRET_KEY="${SECRET_KEY:-${YDB_SECRET_ACCESS_KEY:-}}"

[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }
if [ -z "$ENDPOINT" ] || [ -z "$KEY_ID" ] || [ -z "$SECRET_KEY" ]; then
  echo "Нужны три значения: адрес Document API, идентификатор ключа и секрет ключа."
  echo "Пример: bash import-ydb.sh \"https://docapi.serverless.yandexcloud.net/ru-central1/…\" \"КЛЮЧ_ID\" \"СЕКРЕТ\""
  echo "Адрес — в Yandex Database → sega-chat-db → «Обзор» (Document API эндпоинт)."
  echo "Ключ — в IAM → Сервисные аккаунты → sega-chat-sa → «Создать новый ключ» → Access key."
  exit 1
fi

SCRIPT=""
for c in "$APP/code/cloud-vps/import-from-ydb.js" "$HERE/import-from-ydb.js" "/tmp/import-from-ydb.js"; do
  [ -f "$c" ] && { SCRIPT="$c"; break; }
done
if [ -z "$SCRIPT" ]; then
  echo "=== Беру переносчик с GitHub ==="
  curl -fsSL https://raw.githubusercontent.com/Pilipenko123/Marty/main/sega-chat/cloud-vps/import-from-ydb.js \
    -o /tmp/import-from-ydb.js || { echo "Беда: GitHub не открылся, а файла рядом нет."; exit 1; }
  SCRIPT="/tmp/import-from-ydb.js"
fi

RUN_ENV=(env "YDB_ENDPOINT=$ENDPOINT" "YDB_TABLE=${YDB_TABLE:-sega_chat}"
         "YDB_ACCESS_KEY_ID=$KEY_ID" "YDB_SECRET_ACCESS_KEY=$SECRET_KEY")

if printf '%s' "$FLAGS" | grep -q -- '--inspect'; then
  echo "=== Осмотр облачной базы (ничего не меняем, служба не трогается) ==="
  "${RUN_ENV[@]}" node "$SCRIPT" --data-dir "$APP/data" $FLAGS
  exit $?
fi

echo "=== Останавливаю службу ==="
command -v systemctl >/dev/null && { systemctl stop sega-chat 2>/dev/null || true; }

echo "=== Читаю облачную базу и переношу ==="
"${RUN_ENV[@]}" node "$SCRIPT" --data-dir "$APP/data" $FLAGS
RC=$?

echo "=== Поднимаю службу ==="
command -v systemctl >/dev/null && systemctl start sega-chat
sleep 2
if [ "$RC" != "0" ]; then
  echo "Перенос не состоялся — служба поднята обратно с прежней базой."
  echo "Постоянный ключ сервисного аккаунта можно удалить в консоли Яндекса."
  exit "$RC"
fi
if command -v systemctl >/dev/null; then systemctl is-active sega-chat >/dev/null && echo "  служба работает" || echo "  Беда: служба не поднялась — journalctl -u sega-chat -n 30"; fi

echo "=== Что отвечает сервер ==="
command -v curl >/dev/null && curl -s http://127.0.0.1:3000/api/state | head -c 300
echo
echo
echo "ГОТОВО. Дальше:"
echo "  1) откройте https://segachat.pilpro.ru и войдите как обычно — имя и пароль прежние;"
echo "  2) в настройках, в подвале, должно быть «Сервер: pkg3-51 · VPS (основной)»;"
echo "  3) сообщите друзьям новый адрес;"
echo "  4) ВАЖНО: удалите постоянный ключ в консоли Яндекса (IAM → sega-chat-sa → ключи),"
echo "     он больше не нужен, а след его остался в истории команд."
