#!/usr/bin/env bash
#
# pkg3-51: установка SEGA-CHAT на основной сервер (VPS) ОДНОЙ командой.
# Запускать от root (в консоли Sprintbox сразу после входа):
#
#   curl -fsSL https://raw.githubusercontent.com/Pilipenko123/Marty/main/sega-chat/cloud-vps/setup.sh -o /tmp/sega-setup.sh && bash /tmp/sega-setup.sh
#
# Если GitHub с сервера не открывается:
#   curl -fsSL https://cdn.jsdelivr.net/gh/Pilipenko123/Marty@main/sega-chat/cloud-vps/setup.sh -o /tmp/sega-setup.sh && bash /tmp/sega-setup.sh
#
# Что делает: Node.js, nginx, сертификат HTTPS, служба systemd, папки данных,
# ключ канала «основной → запасной» и отправка слепков каждые 5 минут.
# Повторный запуск безопасен: настройки и ключ сохраняются.
#
set -euo pipefail

DOMAIN="${DOMAIN:-segachat.pilpro.ru}"
APP="/opt/sega-chat"
REPO_ZIP="https://github.com/Pilipenko123/Marty/archive/refs/heads/main.zip"

say()  { printf '\n=== %s ===\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }
command -v curl >/dev/null || { echo "Нужен curl."; exit 1; }

say "1/8. Базовые пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates unzip nginx certbot python3-certbot-nginx >/dev/null
echo "  готово: nginx, certbot, unzip"

say "2/8. Node.js"
need_node=1
if command -v node >/dev/null; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "${major:-0}" -ge 18 ] && need_node=0 && echo "  уже стоит: $(node -v)"
fi
if [ "$need_node" = "1" ]; then
  if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; then
    apt-get install -y nodejs >/dev/null || true
  fi
  if ! command -v node >/dev/null; then apt-get install -y nodejs npm >/dev/null; fi
  echo "  поставил: $(node -v 2>/dev/null || echo 'НЕ УДАЛОСЬ')"
fi
command -v node >/dev/null || { echo "Беда: Node.js не поставился."; exit 1; }

say "3/8. Подкачка (памяти на тарифе мало — добавим 1 ГБ на диске)"
if [ "$(free -m | awk '/^Swap:/{print $2}')" -lt 512 ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  подкачка 1 ГБ включена"
else
  echo "  уже есть — пропускаю"
fi

say "4/8. Код мессенджера с GitHub"
rm -rf /tmp/marty.zip /tmp/marty-src
curl -fsSL "$REPO_ZIP" -o /tmp/marty.zip
unzip -q -o /tmp/marty.zip -d /tmp/marty-src
SRC="$(find /tmp/marty-src -maxdepth 3 -type d -name sega-chat -print -quit)"
[ -n "$SRC" ] || { echo "Беда: в архиве нет папки sega-chat."; exit 1; }
mkdir -p "$APP"
rm -rf "$APP/code.new" "$APP/code.old"
mv "$SRC" "$APP/code.new"
if [ -d "$APP/code" ]; then mv "$APP/code" "$APP/code.old"; fi
mv "$APP/code.new" "$APP/code"
mkdir -p "$APP/data"
chmod 700 "$APP/data"
cd "$APP/code"
npm install --omit=dev --no-audit --no-fund >/dev/null
echo "  код лежит в $APP/code, зависимости поставлены"

say "5/8. Настройки (.env) и ключ канала к запасному серверу"
# pkg3-52: прежний .env БОЛЬШЕ НЕ ПЕРЕПИСЫВАЕТСЯ. В нём живут ключи уведомлений
# (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT) и другие настройки,
# которые владелец добавил руками; старый вариант файла их стирал при каждом
# повторном запуске установщика. Теперь дописываем только недостающее.
ensure_key() {   # ensure_key ИМЯ ЗНАЧЕНИЕ
  grep -q "^$1=" "$APP/.env" 2>/dev/null || printf '%s=%s\n' "$1" "$2" >> "$APP/.env"
}
if [ -f "$APP/.env" ]; then
  cp "$APP/.env" "$APP/.env.bak"
  echo "  .env уже есть — оставляю как был (страховочная копия: $APP/.env.bak)"
else
  : > "$APP/.env"
  echo "  .env создан"
fi
ensure_key PORT 3000
ensure_key HOST 127.0.0.1
ensure_key DATA_DIR "$APP/data"
ensure_key STORE file
ensure_key HTTPS ""
ensure_key SEGA_ROLE primary
ensure_key SEGA_LABEL '"VPS (основной)"'   # значение с пробелом — в кавычках, как и было
ensure_key SEGA_STANDBY_URL ""
ensure_key SEGA_STANDBY_TOKEN "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
chmod 600 "$APP/.env"
OLD_TOKEN="$(sed -n 's/^SEGA_STANDBY_TOKEN=//p' "$APP/.env" | head -1)"
if grep -q '^VAPID_PUBLIC_KEY=' "$APP/.env"; then
  echo "  ключи уведомлений (VAPID) на месте — пуши продолжат работать"
else
  echo "  ВНИМАНИЕ: ключей уведомлений (VAPID_*) в .env нет — пуши работать не будут."
  echo "  Как добавить: см. ИНСТРУКЦИЯ (три строки VAPID_* в $APP/.env и перезапуск службы)."
fi
echo "  .env готов (права 600), строк: $(wc -l < "$APP/.env")"

say "6/8. Служба systemd"
cat > /etc/systemd/system/sega-chat.service <<UNIT
[Unit]
Description=SEGA-CHAT (основной сервер)
After=network.target

[Service]
WorkingDirectory=$APP/code
EnvironmentFile=$APP/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable sega-chat >/dev/null 2>&1 || true
systemctl restart sega-chat
sleep 2
if systemctl is-active sega-chat >/dev/null; then
  echo "  служба работает"
else
  # pkg3-52: сервер теперь живой, на нём настоящие участники — при неудаче
  # сами откатываемся на прежний код и поднимаем службу обратно.
  echo "  Беда: служба на новом коде не поднялась — откатываюсь на прежний код"
  if [ -d "$APP/code.old" ]; then
    rm -rf "$APP/code.failed"
    mv "$APP/code" "$APP/code.failed"
    mv "$APP/code.old" "$APP/code"
    systemctl restart sega-chat
    sleep 2
    systemctl is-active sega-chat >/dev/null \
      && echo "  прежний код снова в работе (неудачный лежит в $APP/code.failed)" \
      || echo "  Беда: и прежний код не поднялся — journalctl -u sega-chat -n 30"
  else
    echo "  Прежнего кода нет — journalctl -u sega-chat -n 30"
  fi
  exit 1
fi

say "7/8. nginx на порту 80 для $DOMAIN"
cat > /etc/nginx/sites-available/sega-chat <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGX
ln -sf /etc/nginx/sites-available/sega-chat /etc/nginx/sites-enabled/sega-chat
nginx -t >/dev/null && systemctl reload nginx
echo "  nginx настроен"

say "8/8. Сертификат HTTPS (нужна DNS-запись на этот сервер)"
VPS_IP="$(ip -4 addr show scope global 2>/dev/null | grep -oE 'inet [0-9.]+' | awk '{print $2}' | head -1)"
RES="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
echo "  адрес сервера: ${VPS_IP:-?}, домен сейчас указывает на: ${RES:-никуда}"
if [ -n "$RES" ] && [ "$RES" = "$VPS_IP" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    && echo "  сертификат получен, HTTPS работает" \
    || echo "  сертификат НЕ получен — позже: bash $APP/code/cloud-vps/cert.sh"
else
  echo "  DNS ещё не смотрит сюда — сертификат получим позже: bash $APP/code/cloud-vps/cert.sh"
fi

cat > /etc/cron.d/sega-standby <<CRON
*/5 * * * * root cd $APP/code && /usr/bin/node cloud-vps/push-snapshot.js >> /var/log/sega-standby.log 2>&1
CRON
echo "  слепки на запасной сервер: каждые 5 минут (пока получателю некуда — это нормально)"

# pkg3-55: сразу применяем сетевую настройку под мобильные сети и VPN
if [ -f "$APP/code/cloud-vps/net-tune.sh" ]; then
  say "Дополнительно: сеть под мобильные сети и VPN"
  bash "$APP/code/cloud-vps/net-tune.sh" || echo "  сетевая настройка не применилась — не страшно, запустите позже: bash $APP/code/cloud-vps/net-tune.sh"
fi

say "ГОТОВО"
cat <<EOF
  Адрес чата (когда DNS дойдёт):   https://$DOMAIN
  Ключ канала к запасному серверу: $OLD_TOKEN
  Он же лежит в $APP/.env (строка SEGA_STANDBY_TOKEN).

  Дальше по инструкции ИНСТРУКЦИЯ-VPS-pkg3-51.md:
   1) DNS-запись A: segachat -> $VPS_IP ( Рег.ру );
   2) когда запись дойдёт: bash $APP/code/cloud-vps/cert.sh
   3) вечером переезда — команда переноса базы с Яндекса (см. инструкцию).
EOF
