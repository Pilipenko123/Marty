#!/usr/bin/env bash
# pkg3-51: получить/продлить сертификат HTTPS для домена чата.
# Запускать от root, когда DNS-запись уже смотрит на этот сервер:
#   bash /opt/sega-chat/code/cloud-vps/cert.sh
set -euo pipefail
DOMAIN="${DOMAIN:-segachat.pilpro.ru}"
[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
systemctl reload nginx
echo "Готово: https://$DOMAIN"
