#!/usr/bin/env bash
# pkg3-51: перенос истории на этот сервер из резервной копии бакета —
# обходной путь, когда функция в Yandex Cloud не запускается.
#
# Запуск от root (в консоли сервера):
#   bash /opt/sega-chat/code/cloud-vps/import-backup.sh /root/копия.sbgz СЕКРЕТ_64_СИМВОЛА
#
# Секрет можно не писать в команде, а задать переменной (тогда он не попадёт
# в историю команд):
#   SEGA_BACKUP_SECRET=СЕКРЕТ bash /opt/sega-chat/code/cloud-vps/import-backup.sh /root/копия.sbgz
#
# Что делает: останавливает службу → переносит базу из копии → поднимает
# службу → показывает, что получилось. Флаг --force третьим аргументом нужен,
# только если на этом сервере уже есть своя переписка и её надо заменить.
#
# Сначала посмотреть, что в копии, ничего не меняя:
#   SEGA_BACKUP_SECRET=СЕКРЕТ bash import-backup.sh /root/копия.sbgz --inspect
set -uo pipefail

APP="/opt/sega-chat"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /tmp)"

# аргументы в любом порядке: файл, секрет, --force, --inspect
FILE=""; SECRET=""; FORCE=""; INSPECT=""
for a in "$@"; do
  case "$a" in
    --force)   FORCE="--force" ;;
    --inspect) INSPECT="--inspect" ;;
    --*)       : ;;
    *) if [ -z "$FILE" ]; then FILE="$a"; elif [ -z "$SECRET" ]; then SECRET="$a"; fi ;;
  esac
done
FILE="${FILE:-${SEGA_BACKUP_FILE:-}}"
SECRET="${SECRET:-${SEGA_BACKUP_SECRET:-}}"

[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }
[ -n "$FILE" ] || { echo "Не указан файл копии."; echo "Пример: bash import-backup.sh /root/sega-chat-2026-10-13-053415.sbgz СЕКРЕТ"; exit 1; }
[ -f "$FILE" ] || { echo "Беда: файла $FILE нет на этом сервере (скопировали его сюда?)."; exit 1; }
if [ -z "$INSPECT" ] && [ -z "$SECRET" ]; then
  echo "Не указан секрет мессенджера (64 символа из serverSecret)."
  echo "Достаётся в Yandex Cloud → Yandex Database → SQL-консоль:"
  echo "  SELECT d FROM sega_chat WHERE pk = 'meta' AND sk = 'root';"
  exit 1
fi

# где взять сам переносчик
SCRIPT=""
for c in "$APP/code/cloud-vps/import-from-backup.js" "$HERE/import-from-backup.js" "/tmp/import-from-backup.js"; do
  [ -f "$c" ] && { SCRIPT="$c"; break; }
done
if [ -z "$SCRIPT" ]; then
  echo "=== Беру переносчик с GitHub ==="
  curl -fsSL https://raw.githubusercontent.com/Pilipenko123/Marty/main/sega-chat/cloud-vps/import-from-backup.js \
    -o /tmp/import-from-backup.js || { echo "Беда: GitHub не открылся, а файла рядом нет."; exit 1; }
  SCRIPT="/tmp/import-from-backup.js"
fi

if [ -n "$INSPECT" ]; then
  echo "=== Осмотр копии (ничего не меняем) ==="
  SEGA_BACKUP_SECRET="$SECRET" node "$SCRIPT" --file "$FILE" --data-dir "$APP/data" --inspect
  exit $?
fi

echo "=== Останавливаю службу ==="
command -v systemctl >/dev/null && { systemctl stop sega-chat 2>/dev/null || true; }

echo "=== Переношу историю из копии ==="
SEGA_BACKUP_SECRET="$SECRET" node "$SCRIPT" --file "$FILE" --data-dir "$APP/data" $FORCE
RC=$?

echo "=== Поднимаю службу ==="
command -v systemctl >/dev/null && systemctl start sega-chat
sleep 2
if [ "$RC" != "0" ]; then
  echo "Перенос не состоялся — служба поднята обратно с прежней базой."
  exit "$RC"
fi
if command -v systemctl >/dev/null; then systemctl is-active sega-chat >/dev/null && echo "  служба работает" || echo "  Беда: служба не поднялась — journalctl -u sega-chat -n 30"; fi

echo "=== Что отвечает сервер ==="
command -v curl >/dev/null && curl -s http://127.0.0.1:3000/api/state | head -c 300
echo
echo
echo "ГОТОВО. Откройте https://segachat.pilpro.ru и войдите как обычно:"
echo "  • имя и пароль прежние — участники и ключи переехали вместе с базой;"
echo "  • в настройках, в подвале, должно быть «Сервер: pkg3-51 · VPS (основной)»;"
echo "  • файл копии $FILE не удалён — оставьте его у себя как запасной."
