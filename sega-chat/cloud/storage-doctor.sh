#!/usr/bin/env bash
#
# ДОКТОР ХРАНИЛИЩА. Лечение надписи «Хранилище недоступно: Access Denied»
# в разделе «Резервная копия».
#
# Скрипт ТОЛЬКО СМОТРИТ и печатает диагноз: где бакет, от чьего имени работает
# функция и каких прав не хватает. Ничего не удаляет и не перезаписывает.
# С FIX=1 — выдает недостающую роль (одна команда add-access-binding).
#
#   bash storage-doctor.sh          # только диагноз
#   FIX=1 bash storage-doctor.sh    # диагноз + лечение
#
# Если бакет называется не sega-chat-code:  BUCKET=моё-имя bash storage-doctor.sh
set -uo pipefail

export BUCKET="${BUCKET:-sega-chat-code}"
export FUNC_NAME="${FUNC_NAME:-sega-chat}"
export FIX="${FIX:-}"
export BAD_FOLDER="${BAD_FOLDER:-b1gbner1dp6vnbo1ha45}"   # пустой дубль в чужом аккаунте

command -v yc >/dev/null 2>&1 || { echo "не найден yc — запускайте в Yandex Cloud Shell"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "не найден python3"; exit 1; }

python3 - <<'PY'
import json, os, subprocess, sys

BUCKET    = os.environ.get("BUCKET", "sega-chat-code")
FUNC_NAME = os.environ.get("FUNC_NAME", "sega-chat")
FIX       = os.environ.get("FIX", "") == "1"
BAD_FOLDER= os.environ.get("BAD_FOLDER", "")

def run(args, timeout=120):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        return None, str(e)
    if p.returncode != 0:
        t = (p.stderr or p.stdout or "").strip().splitlines()
        return None, (t[0] if t else "ошибка")
    return p.stdout, None

def yc(args, timeout=120):
    out, err = run(["yc"] + args + ["--format", "json"], timeout)
    if err: return None, err
    try: return json.loads(out or "null"), None
    except Exception: return None, "не разобрать ответ"

def head(s):
    print(); print("─" * 74); print(s); print("─" * 74)

head("ДОКТОР ХРАНИЛИЩА  (бакет «%s»)" % BUCKET)

# ── 1. куда смотрит Cloud Shell
cfg, _ = run(["yc", "config", "list"])
shell_folder = ""
for l in (cfg or "").splitlines():
    l = l.strip()
    if l.startswith("folder-id"): shell_folder = l.split(":", 1)[1].strip()
    if l.startswith(("cloud-id", "folder-id", "profile")): print("   " + l)
if not shell_folder:
    print("❌ Cloud Shell не знает каталог. Выполните: yc init"); sys.exit(0)
if shell_folder == BAD_FOLDER:
    print("❌ Это каталог ПУСТОГО ДУБЛЯ (не тот аккаунт). Переключите Cloud Shell")
    print("   на аккаунт, где живёт настоящий мессенджер, и повторите.")
    sys.exit(0)

# ── 2. функция мессенджера и её служебная учётка
funcs, _ = yc(["serverless", "function", "list"])
funcs = funcs or []
func = next((f for f in funcs if f.get("name") == FUNC_NAME), None)
if not func: func = next((f for f in funcs if "sega" in str(f.get("name", "")).lower()), None)
if not func and len(funcs) == 1: func = funcs[0]
if not func:
    print("❌ В этом каталоге нет функции мессенджера (функций вообще: %d)." % len(funcs))
    print("   Значит, Cloud Shell сейчас смотрит не в тот аккаунт/каталог,")
    print("   где живёт чат. Переключитесь (значок каталога сверху справа)")
    print("   и запустите доктора снова.")
    sys.exit(0)
print("   функция: %s [%s]" % (func.get("name"), func.get("id")))

sa_id = func.get("service_account_id") or ""
env_bucket = ""
vers, _ = yc(["serverless", "function", "version", "list", "--function-id", func.get("id")])
if vers:
    env_bucket = ((vers[0].get("env") or {}).get("CODE_BUCKET")) or ""
    sa_id = sa_id or (vers[0].get("service_account_id") or "")
if not sa_id:
    print("❌ У функции нет служебной учётной записи — без неё она не может")
    print("   стучаться в хранилище. Пришлите мне этот вывод.")
    sys.exit(0)
bucket = env_bucket or BUCKET
print("   служебная учётка функции: %s" % sa_id)
print("   бакет из переменных функции: %s" % (env_bucket or "(не задана, беру %s)" % BUCKET))

# ── 3. где лежит бакет
b, err = yc(["storage", "bucket", "get", "--name", bucket])
if not b:
    print(); print("❌ Бакет «%s» в этом облаке не найден: %s" % (bucket, err))
    print("   Либо он создан в другом аккаунте, либо шаг создания не прошёл.")
    if FIX:
        print("   FIX: создаю бакет здесь…")
        _, e2 = run(["yc", "storage", "bucket", "create", "--name", bucket])
        print("   " + ("создан ✓ (теперь загрузите в него sega-chat.zip и sega-deploy.sh и обновите функцию)" % () if not e2 else "не создался: " + e2))
    else:
        print("   Лечение: FIX=1 bash storage-doctor.sh  (создаст бакет здесь)")
    sys.exit(0)
b_folder = b.get("folder_id") or ""
print("   бакет: %s, каталог бакета: %s" % (bucket, b_folder))
if b_folder and shell_folder and b_folder != shell_folder:
    print("   ⚠ бакет лежит в ДРУГОМ каталоге, не в том, куда смотрит Cloud Shell.")

# ── 4. права служебной учётки в каталоге бакета
binds, _ = run(["yc", "resource-manager", "folder", "list-access-bindings",
                (b_folder or shell_folder), "--format", "json"])
roles = set()
try:
    for x in json.loads(binds or "[]"):
        if isinstance(x, dict) and (x.get("subject") or {}).get("service_account_id") == sa_id:
            roles.add(x.get("role_id"))
except Exception:
    pass
print("   роли учётки в каталоге бакета: %s" % (", ".join(sorted(r for r in roles if r)) or "(нет)"))
STORAGE_ROLES = {"storage.viewer", "storage.uploader", "storage.editor", "storage.admin"}
ok_read  = bool(roles & {"storage.viewer", "storage.editor", "storage.admin"})
ok_write = bool(roles & {"storage.editor", "storage.admin"})
ok_del   = ok_write

head("ДИАГНОЗ")
if ok_read and ok_write:
    print("   ✓ Права на месте. Надпись «Access Denied» должна уйти:")
    print("     в чате нажмите Ctrl+F5, шестерёнка → «Управление» → «Резервная копия».")
    print("     Если осталась — пришлите мне этот вывод целиком.")
    sys.exit(0)

missing = []
if not ok_read:  missing.append("читать список копий (поэтому и краснеет раздел)")
if not ok_write: missing.append(" класть и удалять копии")
print("   ❌ У служебной учётки функции нет прав на бакет:")
for m in missing: print("      • " + m)
print()
print("   Это и есть причина «Access Denied»: функция стучится в свой же бакет,")
print("   а облако отвечает «доступ запрещён», потому что роль не выдана")
print("   (или выдана не в том каталоге — бакет лежит в «%s»)." % (b_folder or shell_folder))

cmd = ["yc", "resource-manager", "folder", "add-access-binding",
       (b_folder or shell_folder),
       "--role", "storage.editor", "--subject", "serviceAccount:" + sa_id]
if not FIX:
    print()
    print("   Лечение (одна команда, вставьте в Cloud Shell):")
    print("   " + " ".join(cmd))
    print()
    print("   Или просто:  FIX=1 bash storage-doctor.sh")
    sys.exit(0)

print("   FIX: выдаю storage.editor…")
_, e = run(cmd)
if e:
    print("   ❌ не выдалось: %s" % e)
    print("   Значит, у вашей учётки в консоли не хватает прав выдавать роли")
    print("   (нужна роль admin или owner каталога). Пришлите мне этот вывод.")
    sys.exit(0)
print("   ✓ роль storage.editor выдана")
if b_folder and b_folder != shell_folder:
    print("   ⚠ роль выдана в каталоге бакета («%s») — это правильно." % b_folder)
print()
print("   Готово. В чате: Ctrl+F5 → шестерёнка → «Управление» → «Резервная копия».")
print("   Надпись должна смениться на «Копии хранятся в облаке…». Проверьте кнопкой")
print("   «Сохранить копию в облако».")
PY
