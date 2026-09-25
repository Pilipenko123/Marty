#!/usr/bin/env bash
#
# Поселить «SEGA-CHAT» в Yandex Cloud одной командой.
#
# Проще всего запускать из Yandex Cloud Shell (кнопка в консоли облака):
# там уже установлены yc, zip и git, ничего ставить на свой компьютер не нужно.
#
#   git clone <адрес репозитория> && cd Marty/sega-chat
#   ./cloud/deploy.sh
#
# Повторный запуск обновляет мессенджер, не трогая переписку.
#
set -euo pipefail

NAME="${NAME:-sega-chat}"
DB_NAME="${DB_NAME:-$NAME-db}"
SA_NAME="${SA_NAME:-$NAME-sa}"
FUNC_NAME="${FUNC_NAME:-$NAME}"
GW_NAME="${GW_NAME:-$NAME}"
TABLE="${YDB_TABLE:-sega_chat}"
RUNTIME="${RUNTIME:-nodejs18}"
MEMORY="${MEMORY:-256m}"
TIMEOUT="${TIMEOUT:-30s}"
STORAGE_LIMIT="${STORAGE_LIMIT:-262144000}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- проверки
command -v yc  >/dev/null 2>&1 || die "не найден yc. Запустите скрипт в Yandex Cloud Shell или установите Yandex Cloud CLI."
command -v zip >/dev/null 2>&1 || die "не найден zip. Установите его: sudo apt install zip"

# читалка JSON без лишних требований
jget() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then jq -r ".$field // empty"
  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$field','') or '')"
  else grep -o "\"$field\"[^,}]*" | head -1 | sed 's/.*: *"\{0,1\}//; s/"$//'
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
[ -f cloud/index.js ] && [ -d public ] || die "скрипт нужно запускать из папки sega-chat"

FOLDER_ID="$(yc config get folder-id 2>/dev/null || true)"
[ -n "$FOLDER_ID" ] || die "не выбран каталог. Выполните: yc init"
say "Каталог облака: $FOLDER_ID"

# ---------------------------------------------------------------- база данных
say "Шаг 1 из 5. База данных «$DB_NAME»"
if yc ydb database get "$DB_NAME" >/dev/null 2>&1; then
  info "уже существует — оставляем как есть (переписка не пострадает)"
else
  info "создаю бессерверную базу (тариф: платите только за запросы)…"
  yc ydb database create "$DB_NAME" --serverless >/dev/null
fi
# База создаётся не мгновенно, а в Yandex Cloud Shell адрес Document API
# нередко появляется на несколько секунд позже статуса RUNNING. Поэтому в
# одном цикле ждём и готовности базы, и появления адреса. Ошибки отдельных
# вызовов yc глушим, чтобы `set -euo pipefail` не прерывал ожидание.
ENDPOINT=""
for _ in $(seq 1 60); do
  DB_JSON="$(yc ydb database get "$DB_NAME" --format json 2>/dev/null || true)"
  STATUS="$(printf '%s' "$DB_JSON" | jget status || true)"
  ENDPOINT="$(printf '%s' "$DB_JSON" | jget document_api_endpoint || true)"
  [ "$STATUS" = "RUNNING" ] && [ -n "$ENDPOINT" ] && break
  if [ "$STATUS" = "RUNNING" ]; then
    info "база готова, жду появления адреса Document API…"
  else
    info "жду готовности базы (сейчас: ${STATUS:-неизвестно})…"
  fi
  sleep 5
done

[ -n "$ENDPOINT" ] || die "не удалось узнать адрес Document API. Проверьте, что база создана в бессерверном режиме, и повторите запуск скрипта."
info "адрес Document API: $ENDPOINT"

# ---------------------------------------------------------------- сервисный аккаунт
say "Шаг 2 из 5. Служебная учётная запись «$SA_NAME»"
if yc iam service-account get "$SA_NAME" >/dev/null 2>&1; then
  info "уже существует"
else
  yc iam service-account create --name "$SA_NAME" >/dev/null
  info "создана"
fi
SA_ID="$(yc iam service-account get "$SA_NAME" --format json | jget id)"
[ -n "$SA_ID" ] || die "не удалось получить идентификатор учётной записи"
for role in ydb.editor serverless.functions.invoker; do
  yc resource-manager folder add-access-binding "$FOLDER_ID" \
    --role "$role" --subject "serviceAccount:$SA_ID" >/dev/null 2>&1 || true
done
info "права на базу и вызов функций выданы ($SA_ID)"

# ---------------------------------------------------------------- сборка
say "Шаг 3 из 5. Собираю архив с мессенджером"
ZIP="$(mktemp -d)/sega-chat.zip"
zip -qr "$ZIP" index.js package.json cloud lib public \
  -x '*/node_modules/*' '*/data/*' '*.zip'
info "$(du -h "$ZIP" | cut -f1) — лимит загрузки через CLI: 3,5 МБ"

# ---------------------------------------------------------------- функция
say "Шаг 4 из 5. Функция «$FUNC_NAME»"
if yc serverless function get "$FUNC_NAME" >/dev/null 2>&1; then
  info "уже существует — выкладываю новую версию"
else
  yc serverless function create --name "$FUNC_NAME" \
    --description "Приватный мессенджер SEGA-CHAT" >/dev/null
  info "создана"
fi

yc serverless function version create \
  --function-name "$FUNC_NAME" \
  --runtime "$RUNTIME" \
  --entrypoint index.handler \
  --memory "$MEMORY" \
  --execution-timeout "$TIMEOUT" \
  --source-path "$ZIP" \
  --service-account-id "$SA_ID" \
  --environment "YDB_ENDPOINT=$ENDPOINT,YDB_TABLE=$TABLE,STORAGE_LIMIT=$STORAGE_LIMIT" \
  >/dev/null
info "версия выложена (среда: $RUNTIME, память: $MEMORY)"

# ---------------------------------------------------------------- API Gateway
say "Шаг 5 из 5. API-шлюз «$GW_NAME» и доступ из браузера"
yc serverless function allow-unauthenticated-invoke "$FUNC_NAME" >/dev/null
FUNC_ID="$(yc serverless function get "$FUNC_NAME" --format json | jget id)"
FUNC_URL="https://functions.yandexcloud.net/$FUNC_ID"

GW_SPEC_DIR="$(mktemp -d)"
GW_SPEC="$GW_SPEC_DIR/api-gateway.yaml"
sed -e "s/ВАШ_ID_ФУНКЦИИ/$FUNC_ID/g" \
    -e "s/ВАШ_ID_УЧЁТНОЙ_ЗАПИСИ/$SA_ID/g" \
    -e "s/\${FUNCTION_ID}/$FUNC_ID/g" \
    -e "s/\${SERVICE_ACCOUNT_ID}/$SA_ID/g" \
    cloud/api-gateway.yaml > "$GW_SPEC"

if yc serverless api-gateway get "$GW_NAME" >/dev/null 2>&1; then
  info "API Gateway «$GW_NAME» уже существует — обновляю спецификацию…"
  yc serverless api-gateway update "$GW_NAME" --spec "$GW_SPEC" >/dev/null
elif yc serverless api-gateway get "${GW_NAME}-gw" >/dev/null 2>&1; then
  GW_NAME="${GW_NAME}-gw"
  info "API Gateway «$GW_NAME» уже существует — обновляю спецификацию…"
  yc serverless api-gateway update "$GW_NAME" --spec "$GW_SPEC" >/dev/null
else
  info "создаю API Gateway «$GW_NAME»…"
  yc serverless api-gateway create --name "$GW_NAME" --spec "$GW_SPEC" >/dev/null
fi

GW_JSON="$(yc serverless api-gateway get "$GW_NAME" --format json 2>/dev/null || true)"
GW_DOMAIN="$(printf '%s' "$GW_JSON" | jget domain || true)"
if [ -z "$GW_DOMAIN" ]; then
  GW_ID="$(printf '%s' "$GW_JSON" | jget id || true)"
  [ -n "$GW_ID" ] && GW_DOMAIN="${GW_ID}.apigw.yandexcloud.net"
fi
GW_URL="https://${GW_DOMAIN:-$FUNC_ID.apigw.yandexcloud.net}"

rm -rf "$GW_SPEC_DIR"
rm -f "$ZIP"

cat <<EOF

  ╔════════════════════════════════╗
  ║        S E G A - C H A T       ║
  ╚════════════════════════════════╝

  Мессенджер живёт в облаке. Основной адрес для входа и друзей:

      $GW_URL

  (Технический адрес функции: $FUNC_URL — используйте основной адрес
   API Gateway выше, чтобы стили, скрипты и логотип загружались корректно)

  Что дальше:
    1. Откройте адрес $GW_URL в браузере — увидите экран «Создать мессенджер».
    2. Придумайте своё имя, пароль и кодовую фразу — вы станете администратором.
    3. Разошлите друзьям адрес и кодовую фразу, каждый заведёт себе имя и пароль.

  Полезное:
    • обновить мессенджер после правок     ./cloud/deploy.sh
    • посмотреть записи в журнале          yc serverless function logs $FUNC_NAME
    • расход бесплатного лимита            консоль облака -> Биллинг -> Детализация
    • удалить всё вместе с перепиской      yc serverless api-gateway delete $GW_NAME
                                           yc serverless function delete $FUNC_NAME
                                           yc ydb database delete $DB_NAME

EOF
