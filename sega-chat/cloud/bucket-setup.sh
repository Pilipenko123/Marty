#!/usr/bin/env bash
#
# ОДНОРАЗОВАЯ НАСТРОЙКА: завести в Yandex Cloud «контейнер для программы».
#
#   бакет Object Storage  — здесь лежит сама программа (sega-chat.zip)
#                           и резервные копии переписки
#   база YDB              — здесь лежит переписка и участники (уже создана)
#
# Скрипт создаёт приватный бакет и выдаёт служебной учётной записи мессенджера
# права читать его и писать туда копии. Больше ничего не трогает: переписка,
# функция и API-шлюз остаются как есть.
#
# Запуск из Yandex Cloud Shell:
#   ./cloud/bucket-setup.sh
# или с другим именем бакета (имена бакетов общие на весь Yandex Cloud):
#   BUCKET=sega-chat-code-ivan ./cloud/bucket-setup.sh
#
set -uo pipefail

export BUCKET="${BUCKET:-sega-chat-code}"
export SA_NAME="${SA_NAME:-sega-chat-sa}"
export FUNC_NAME="${FUNC_NAME:-sega-chat}"

command -v yc >/dev/null 2>&1 || { echo "не найден yc — запускайте в Yandex Cloud Shell"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "не найден python3"; exit 1; }

python3 - <<'PY'
import json, os, re, subprocess, sys

BUCKET    = os.environ.get("BUCKET", "sega-chat-code")
SA_NAME   = os.environ.get("SA_NAME", "sega-chat-sa")
FUNC_NAME = os.environ.get("FUNC_NAME", "sega-chat")
CODE_OBJ  = "sega-chat.zip"
DEPLOY_SH = "sega-deploy.sh"

def run(args, timeout=120):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return None, "не найдена программа " + args[0]
    except Exception as e:
        return None, "сбой: %s" % e
    if p.returncode != 0:
        t = (p.stderr or p.stdout or "").strip().splitlines()
        return None, (t[0] if t else "ошибка")
    return p.stdout, None

def yc(args, timeout=120):
    out, err = run(["yc"] + args + ["--format", "json"], timeout)
    if err:
        return None, err
    try:
        return json.loads(out or "null"), None
    except Exception:
        return None, "не разобрать ответ"

def line(s=""): print(s)
def head(s): line(); line("─" * 74); line(s); line("─" * 74)

problems, notes, done = [], [], []

head("КОНТЕЙНЕР ДЛЯ ПРОГРАММЫ  (бакет «%s»)" % BUCKET)

# ── куда смотрит Cloud Shell
cfg, _ = run(["yc", "config", "list"])
folder_id = ""
for l in (cfg or "").splitlines():
    l = l.strip()
    if l.startswith("folder-id"): folder_id = l.split(":", 1)[1].strip()
    if l.startswith(("cloud-id", "folder-id", "profile")): line("   " + l)
if not folder_id:
    problems.append("Cloud Shell не знает каталог. Выполните: yc init")
else:
    f, _ = yc(["resource-manager", "folder", "get", folder_id])
    if f:
        c, _ = yc(["resource-manager", "cloud", "get", f.get("cloud_id", "")])
        line("   облако:  %s" % ((c or {}).get("name") or f.get("cloud_id", "?")))
        line("   каталог: %s [%s]" % (f.get("name", "?"), folder_id))

# ── что уже есть в каталоге (чтобы права выдать правильной учётке)
sas, _ = yc(["iam", "service-account", "list"])
sas = sas or []
funcs, _ = yc(["serverless", "function", "list"])
funcs = funcs or []
sa = next((x for x in sas if x.get("name") == SA_NAME), None)
if not sa and sas:
    sa = next((x for x in sas if str(x.get("name", "")).startswith("sega")), sas[0])
if sa:
    line("   учётка мессенджера: %s [%s]" % (sa.get("name"), sa.get("id")))
    SA_NAME = sa.get("name") or SA_NAME
else:
    notes.append("Служебная учётная запись пока не найдена — права выдаст sega-deploy.sh при первом деплое.")

# ── бакет
line()
line("БАКЕТ")
b, err = yc(["storage", "bucket", "get", "--name", BUCKET])
if b:
    own = (b.get("folder_id") or "") == folder_id
    line("   уже существует" + (" — он ваш, оставляем как есть" if own else ""))
    if not own:
        problems.append("Бакет «%s» лежит в чужом каталоге. Придумайте другое имя: "
                        "BUCKET=sega-chat-code-<ваше-слово> ./cloud/bucket-setup.sh" % BUCKET)
    else:
        done.append("бакет «%s» на месте" % BUCKET)
else:
    line("   создаю приватный бакет «%s»…" % BUCKET)
    out, cerr = run(["yc", "storage", "bucket", "create", "--name", BUCKET])
    if cerr:
        low = (cerr or "").lower()
        if "already" in low or "занят" in low or "owned" in low:
            problems.append("Имя «%s» уже занято (имена бакетов общие на весь Yandex Cloud). "
                            "Придумайте другое: BUCKET=sega-chat-code-<ваше-слово> ./cloud/bucket-setup.sh" % BUCKET)
        else:
            problems.append("Бакет не создался: %s" % cerr)
    else:
        done.append("бакет «%s» создан (приватный, доступ только из вашего облака)" % BUCKET)

# ── права учётке мессенджера: читать программу и писать копии
if sa and not problems:
    line()
    line("ПРАВА СЛУЖЕБНОЙ УЧЁТНОЙ ЗАПИСИ")
    have, _ = run(["yc", "resource-manager", "folder", "list-access-bindings",
                   folder_id, "--format", "json"])
    try:
        binds = json.loads(have or "[]")
    except Exception:
        binds = []
    granted = {(x.get("role_id"), x.get("subject", {}).get("service_account_id"))
               for x in binds if isinstance(x, dict)}
    for role in ("storage.editor",):
        if (role, sa.get("id")) in granted:
            line("   %-18s уже выдана" % role)
            continue
        _, e = run(["yc", "resource-manager", "folder", "add-access-binding",
                    folder_id, "--role", role,
                    "--service-account-id", sa.get("id")])
        if e:
            notes.append("Не удалось выдать %s: %s (это сделает sega-deploy.sh)" % (role, e))
        else:
            line("   %-18s выдана" % role)
            done.append("учётке «%s» выдана роль %s" % (sa.get("name"), role))

# ── что лежит в бакете
line()
line("ЧТО ЛЕЖИТ В БАКЕТЕ")
lst, lerr = run(["yc", "storage", "s3api", "list-objects", "--bucket", BUCKET])
items = []
if lst:
    try:
        j = json.loads(lst)
        items = (j.get("Contents") or j.get("contents") or [])
    except Exception:
        items = [x for x in re.findall(r"<Key>([^<]+)</Key>", lst)]
        items = [{"Key": k} for k in items]
if items:
    for it in items[:40]:
        if isinstance(it, dict):
            line("   %-42s %s" % (it.get("Key") or it.get("key"), it.get("Size") or it.get("size") or ""))
        else:
            line("   %s" % it)
else:
    line("   (пусто — сейчас положим программу)")
    if lerr: notes.append("Список не прочитать: %s" % lerr)

keys = [ (it.get("Key") or it.get("key") or it) if isinstance(it, dict) else it for it in items ]
has_code   = CODE_OBJ in keys
has_deploy = any(str(k).endswith(DEPLOY_SH) for k in keys)

head("ЧТО СДЕЛАТЬ ДАЛЬШЕ")
if problems:
    line("   ❌ НЕ ПОЛУЧИЛОСЬ:")
    for p in problems: line("      • " + p)
    line()
    line("   Пришлите мне этот вывод целиком.")
    sys.exit(0)

for d in done: line("   ✓ " + d)
for n in notes: line("   ⚠ " + n)
line()
line("   Осталось положить в бакет ДВА файла. Это делается мышкой, в браузере:")
line()
line("   1. Откройте консоль облака:  https://console.yandex.cloud/storage")
line("      (слева в списке сервисов — «Object Storage», он же «Облачное хранилище»)")
line("   2. Нажмите на бакет «%s»." % BUCKET)
line("   3. Перетащите в окно браузера файлы из архива, который я вам дал:")
line("        • sega-chat.zip     — сама программа")
line("        • sega-deploy.sh    — команда обновления (лежит в папке cloud/)")
line("      Кнопка «Загрузить» сверху тоже работает.")
line()
if has_code:
    line("   ✓ sega-chat.zip уже в бакете.")
if has_deploy:
    line("   ✓ sega-deploy.sh уже в бакете.")
line()
line("   4. После этого в Cloud Shell вставьте ОДНУ строку — она обновит мессенджер:")
line()
line("      cd /tmp && rm -f sega-deploy.sh && yc storage s3 cp s3://%s/%s . && bash sega-deploy.sh"
     % (BUCKET, DEPLOY_SH))
line()
line("   Первый раз лучше так (покажет, что видно в бакете, и ничего не сломает):")
line()
line("      cd /tmp && rm -f sega-deploy.sh && yc storage s3 cp s3://%s/%s . && LIST=1 bash sega-deploy.sh"
     % (BUCKET, DEPLOY_SH))
line()
line("   Важно: бакет приватный — из интернета его не видно и не прочитать.")
line("   Переписка лежит в отдельной базе YDB и остаётся нетронутой.")
PY
