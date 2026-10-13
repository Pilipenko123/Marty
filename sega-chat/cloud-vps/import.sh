#!/usr/bin/env bash
# pkg3-51: вечер переезда — перенести базу с запасного сервера (Yandex Cloud)
# на этот сервер и поднять службу. Запускать от root:
#   bash /opt/sega-chat/code/cloud-vps/import.sh
# (если на этом сервере уже есть своя переписка и её нужно заменить: добавить --force)
set -euo pipefail
APP="/opt/sega-chat"
[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }
systemctl stop sega-chat
echo "Служба остановлена, переношу базу…"
node "$APP/code/cloud-vps/import-from-yandex.js" "$@" || { systemctl start sega-chat; echo "Перенос не состоялся — служба поднята обратно с прежней базой."; exit 1; }
systemctl start sega-chat
sleep 2
systemctl is-active sega-chat >/dev/null && echo "Служба поднята. Откройте чат и проверьте подвал: «Сервер: pkg3-51 · VPS (основной)»."
