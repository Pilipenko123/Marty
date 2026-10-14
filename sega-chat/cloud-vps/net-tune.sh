#!/usr/bin/env bash
# pkg3-55.1: сетевая настройка сервера под мобильные сети и VPN.
#
#   bash /opt/sega-chat/code/cloud-vps/net-tune.sh            ← базовая настройка
#   bash /opt/sega-chat/code/cloud-vps/net-tune.sh --ecdsa    ← + лёгкий сертификат
#
# Зачем: на телефонах через VPN (и в мобильных сетях с урезанным MTU) рукопожатие
# HTTPS и тяжёлые файлы (стили, скрипт) упирались в размер пакета: полноразмерные
# пакеты молча терялись в туннеле — страница приезжала «голой» или висела белым
# экраном, хотя с компьютера всё работало. Лечится тремя вещами: уменьшение
# размера пакетов, которые сервер шлёт в ответ на рекламу MSS клиента; HTTP/2
# (пакеты мельче и плотнее); сжатие стилей и скриптов (меньше байтов в пути).
#
# pkg3-55.1: MSS по умолчанию снижен с 1250 до 1100 — поверх мобильной сети
# инкапсуляция VPN (AdGuard и подобные) съедает больше, чем помещалось в 1250.
# Скрипт теперь снимает СВОИ прежние правила с ЛЮБЫМ старым значением MSS, иначе
# старое правило оставалось вторым и перетирало новое.
#
# Скрипт идемпотентен: прежние свои правила убирает, дублей не копит.
# Всё обратимо: правила снимаются командой
#   iptables -t mangle -D INPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1100
# а конфиг nginx восстанавливается из /etc/nginx/sites-available/sega-chat.bak-net-tune
set -uo pipefail

DOMAIN="${DOMAIN:-segachat.pilpro.ru}"
MSS="${SEGA_MSS:-1100}"
say() { printf '\n=== %s ===\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "Нужен запуск от root."; exit 1; }

say "1/4. Размер пакетов под туннели (VPN, мобильные сети)"
if command -v iptables >/dev/null 2>&1; then
  # убираем прежние СВОИ правила ограничения MSS с ЛЮБЫМ старым значением,
  # чтобы новое значение не перетиралось оставшимся вторым правилом
  while iptables -t mangle -S INPUT 2>/dev/null | grep -q -- '-j TCPMSS --set-mss'; do
    spec="$(iptables -t mangle -S INPUT 2>/dev/null | grep -- '-j TCPMSS --set-mss' | head -1)"
    [ -n "$spec" ] || break
    iptables -t mangle -D INPUT ${spec#-A INPUT } 2>/dev/null || break
  done
  while iptables -t mangle -D OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; do :; done
  # Клиент рекламирует свой MSS в SYN-пакете. Уменьшаем эту рекламу: тогда сервер
  # шлёт более мелкие сегменты (рукопожатие, цепочку сертификатов, стили, скрипт),
  # и они пролезают в урезанный MTU туннеля, даже когда ICMP «нужна фрагментация»
  # в пути теряется.
  iptables -t mangle -I INPUT 1 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$MSS"
  iptables -t mangle -A OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  echo "  входящая реклама MSS ограничена $MSS, исходящая прижата к MTU маршрута"
  # переживание перезагрузки: сохраняем правила и ставим страховочную единицу
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 && echo "  правила сохранены (netfilter-persistent)"
  elif command -v iptables-save >/dev/null 2>&1; then
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null && echo "  правила сохранены в /etc/iptables/rules.v4"
  fi
  cat > /etc/systemd/system/sega-net-tune.service <<UNIT
[Unit]
Description=SEGA-CHAT: размер пакетов под мобильные сети и VPN
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/iptables -t mangle -I INPUT 1 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss $MSS
ExecStart=/usr/sbin/iptables -t mangle -A OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload >/dev/null 2>&1
  systemctl enable sega-net-tune >/dev/null 2>&1 || true
  echo "  страховочная единица sega-net-tune включена (поднимет правила после перезагрузки)"
else
  echo "  iptables не найден — пропускаю шаг"
fi

say "2/4. HTTP/2 в nginx (пакеты мельче и плотнее — туннелям легче)"
NGX=/etc/nginx/sites-available/sega-chat
if [ -f "$NGX" ]; then
  if grep -q 'listen 443 ssl;' "$NGX" && ! grep -q 'listen 443 ssl http2;' "$NGX"; then
    cp "$NGX" "$NGX.bak-net-tune"
    sed -i 's/listen 443 ssl;/listen 443 ssl http2;/' "$NGX"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && echo "  HTTP/2 включён (прежний конфиг: $NGX.bak-net-tune)"
    else
      echo "  nginx не принял правку — откатываю конфиг"
      mv "$NGX.bak-net-tune" "$NGX"
      systemctl reload nginx 2>/dev/null || true
    fi
  else
    echo "  HTTP/2 уже включён или строка listen не найдена — не трогаю"
  fi
else
  echo "  конфиг nginx не найден — пропускаю шаг"
fi

say "3/4. Сжатие стилей и скриптов в nginx (меньше байтов — легче узкому пути)"
if [ -f "$NGX" ] && grep -q "server_name $DOMAIN;" "$NGX"; then
  if grep -q 'gzip on;' "$NGX"; then
    echo "  сжатие уже включено — не трогаю"
  else
    cp "$NGX" "$NGX.bak-net-tune"
    sed -i "/server_name $DOMAIN;/a\\    gzip on;\\n    gzip_min_length 1024;\\n    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml;\\n    gzip_vary on;" "$NGX"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && echo "  сжатие включено (прежний конфиг: $NGX.bak-net-tune)"
    else
      echo "  nginx не принял правку — откатываю конфиг"
      mv "$NGX.bak-net-tune" "$NGX"
      systemctl reload nginx 2>/dev/null || true
    fi
  fi
else
  echo "  конфиг nginx или строка server_name не найдены — пропускаю шаг"
fi

say "4/4. Лёгкий сертификат ECDSA (только с флагом --ecdsa)"
if [ "${1:-}" = "--ecdsa" ]; then
  # рукопожатие с ECDSA-сертификатом заметно меньше по байтам — ещё один шанс
  # пролезть в урезанный MTU; при неудаче прежний сертификат остаётся рабочим
  if certbot --nginx -d "$DOMAIN" --key-type ecdsa --force-renewal --non-interactive \
      --agree-tos --register-unsafely-without-email --redirect; then
    systemctl reload nginx
    echo "  сертификат перевыпущен на ECDSA"
  else
    echo "  перевыпуск не удался — остаётся прежний сертификат, это НЕ поломка"
  fi
else
  echo "  пропущено. Захотите лёгкий сертификат: bash cloud-vps/net-tune.sh --ecdsa"
fi

echo
echo "ГОТОВО: сетевая настройка применена. Проверка с телефона: выключите Wi-Fi,"
echo "включите VPN и откройте чат; если не помогло — попробуйте флаг --ecdsa."
