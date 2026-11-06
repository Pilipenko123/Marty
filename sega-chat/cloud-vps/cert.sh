#!/usr/bin/env bash
# pkg3-51: получить/продлить сертификат HTTPS для домена чата.
# Запускать от root, когда DNS-запись уже смотрит на этот сервер:
#   bash /opt/sega-chat/code/cloud-vps/cert.sh
#
# pkg3-138: перед certbot проверяем конфиг nginx и, если может, чиним сами.
# Раньше скрипт сразу звал `certbot --nginx`, а тот отказывался работать при
# любой ошибке `nginx -t` — в логе было «MisconfigurationError», и выпуск
# (а потом и продление) сертификата падали без понятной причины. Самая частая
# причина была наша: задвоенный `server_tokens` в sega-limits.conf.
set -euo pipefail
DOMAIN="${DOMAIN:-segachat.pilpro.ru}"
[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }

LIM="/etc/nginx/conf.d/sega-limits.conf"
TEST_LOG="/tmp/sega-nginx-test.log"

# 1. Починка своей же настройки: server_tokens в http-контексте — дубликат.
if [ -f "$LIM" ] && grep -qE '^[[:space:]]*server_tokens\b' "$LIM"; then
  echo "  в $LIM есть server_tokens — убираю (это дубликат и ломает nginx -t)"
  grep -vE '^[[:space:]]*server_tokens\b' "$LIM" > "$LIM.new" && mv "$LIM.new" "$LIM"
fi

# 2. Проверка конфига: без неё certbot падает невнятно.
if ! nginx -t >"$TEST_LOG" 2>&1; then
  echo "  конфиг nginx не проходит проверку:"
  sed -n '1,8p' "$TEST_LOG" | sed 's/^/    /'
  echo "  Пока это не исправлено, certbot работать не будет."
  echo "  Чаще всего помогает: удалить задвоенные директивы в /etc/nginx —"
  echo "    grep -rn \"server_tokens\" /etc/nginx/ 2>/dev/null"
  echo "  затем повторить: bash \$0"
  exit 1
fi

# 3. Сам сертификат.
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
systemctl reload nginx
echo "Готово: https://$DOMAIN"
