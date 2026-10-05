#!/usr/bin/env bash
#
# ОБНОВИТЬ МЕССЕНДЖЕР, ВЗЯВ ПРОГРАММУ ИЗ ОБЛАЧНОГО ХРАНИЛИЩА.
#
# GitHub для этого не нужен: программа лежит в приватном бакете Object Storage,
# а Yandex Cloud сам забирает оттуда архив и делает новую версию функции.
# Переписка (база YDB) не трогается.
#
# Обычный запуск — после того как вы положили новый sega-chat.zip в бакет:
#
#   cd /tmp && rm -f sega-deploy.sh && yc storage s3 cp s3://sega-chat-code/sega-deploy.sh . && bash sega-deploy.sh
#
# Только посмотреть, что лежит в хранилище (ничего не меняет):
#
#   LIST=1 bash sega-deploy.sh
#
# Откатиться на прежнюю версию программы:
#
#   OBJ=releases/sega-chat-20261003-120000-pkg3-14.zip bash sega-deploy.sh
#
# Настраивается переменными: BUCKET, OBJ, FUNC_NAME, SA_NAME, DB_NAME, GW_NAME,
# YDB_TABLE, RUNTIME, MEMORY, TIMEOUT, STORAGE_LIMIT, BACKUP_KEEP,
# KEEP_RELEASES, EXPECT (ожидаемая отметка выпуска).
#
set -uo pipefail

export BUCKET="${BUCKET:-sega-chat-code}"
export OBJ="${OBJ:-sega-chat.zip}"
export FUNC_NAME="${FUNC_NAME:-sega-chat}"
export SA_NAME="${SA_NAME:-sega-chat-sa}"
export DB_NAME="${DB_NAME:-sega-chat-db}"
export GW_NAME="${GW_NAME:-sega-chat}"
export TABLE="${YDB_TABLE:-sega_chat}"
export RUNTIME="${RUNTIME:-}"
export MEMORY="${MEMORY:-}"
export TIMEOUT="${TIMEOUT:-}"
export STORAGE_LIMIT="${STORAGE_LIMIT:-262144000}"
export BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
export BACKUP_KEEP="${BACKUP_KEEP:-10}"
export KEEP_RELEASES="${KEEP_RELEASES:-8}"
export LIST="${LIST:-}"
export EXPECT="${EXPECT:-}"

command -v yc >/dev/null 2>&1 || { echo "не найден yc — запускайте в Yandex Cloud Shell"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "не найден python3"; exit 1; }

python3 - <<'PY'
import json, os, re, subprocess, sys, time, zipfile

E = os.environ.get
BUCKET   = E("BUCKET", "sega-chat-code")
OBJ      = E("OBJ", "sega-chat.zip").lstrip("/")
FUNC     = E("FUNC_NAME", "sega-chat")
SA_NAME  = E("SA_NAME", "sega-chat-sa")
DB_NAME  = E("DB_NAME", "sega-chat-db")
GW_NAME  = E("GW_NAME", "sega-chat")
TABLE    = E("TABLE", "sega_chat")
STORAGE_LIMIT = E("STORAGE_LIMIT", "262144000")
BACKUP_PREFIX = E("BACKUP_PREFIX", "backups/")
BACKUP_KEEP   = E("BACKUP_KEEP", "10")
KEEP_RELEASES = int(E("KEEP_RELEASES", "8") or 8)
LIST_MODE = E("LIST", "") in ("1", "yes", "true", "on")
EXPECT    = E("EXPECT", "")
DUBL_GW   = "d5deshv7pt6ff4gchn00"      # пустой дубль из прошлой ошибки — его не трогаем
S3 = "s3://%s" % BUCKET

def run(args, timeout=300):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return None, "не найдена программа " + args[0]
    except Exception as ex:
        return None, "сбой: %s" % ex
    if p.returncode != 0:
        t = (p.stderr or p.stdout or "").strip().splitlines()
        return None, (t[0] if t else "ошибка")
    return p.stdout, None

def yc(args, timeout=300):
    out, err = run(["yc"] + args + ["--format", "json"], timeout)
    if err: return None, err
    try: return json.loads(out or "null"), None
    except Exception: return None, "не разобрать ответ"

def keys_from(payload):
    """Ключи объектов: ответ бывает JSON, YAML-подобный или сырой XML."""
    if not payload: return []
    try:
        j = json.loads(payload)
    except Exception:
        return re.findall(r"<Key>([^<]+)</Key>", payload) or \
               re.findall(r"^[ \t]*key:\s*['\"]?([^'\"\n]+)", payload, re.M)
    if isinstance(j, str):
        return re.findall(r"<Key>([^<]+)</Key>", j)
    out = []
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k.lower() == "key" and isinstance(v, str): out.append(v)
                else: walk(v)
        elif isinstance(x, list):
            for v in x: walk(v)
    walk(j)
    return out

def list_bucket(prefix=""):
    """Список объектов. Пробуем два способа — команды storage ещё помечены PREVIEW."""
    for extra in (["--format", "json"], []):
        args = ["yc", "storage", "s3api", "list-objects", "--bucket", BUCKET]
        if prefix: args += ["--prefix", prefix]
        out, err = run(args + extra)
        if not err:
            return keys_from(out), None
        last = err
    # запасной путь: обычная команда списка бакетов тут не поможет, поэтому
    # просто сообщаем об ошибке — дальше проверим файл скачиванием
    return None, last

def bucket_alive():
    _, err = run(["yc", "storage", "bucket", "get", "--name", BUCKET])
    return err is None, err

def download(key, dest, timeout=180):
    return run(["yc", "storage", "s3", "cp", "%s/%s" % (S3, key), dest], timeout)

def line(s=""): print(s, flush=True)
def head(s): line(); line("─" * 74); line(s); line("─" * 74)
def die(msg, hint=""):
    line(); line("   ❌ " + msg)
    if hint:
        for h in str(hint).splitlines(): line("      " + h)
    line(); sys.exit(1)

warnings = []

# ─────────────────────────────────────────────────── 1. где мы
head("ШАГ 1. ГДЕ МЫ НАХОДИМСЯ  (сверьте с нужной учёткой!)")
cfg, _ = run(["yc", "config", "list"])
folder_id = ""
for l in (cfg or "").splitlines():
    l = l.strip()
    if l.startswith("folder-id"): folder_id = l.split(":", 1)[1].strip()
    if l.startswith(("cloud-id", "folder-id", "profile")): line("   " + l)
if not folder_id:
    die("Cloud Shell не знает каталог.", "Выполните: yc init")
f, _ = yc(["resource-manager", "folder", "get", folder_id])
if f:
    c, _ = yc(["resource-manager", "cloud", "get", f.get("cloud_id", "")])
    line("   облако:  %s" % ((c or {}).get("name") or f.get("cloud_id", "?")))
    line("   каталог: %s [%s]" % (f.get("name", "?"), folder_id))

# ─────────────────────────────────────────────────── 2. что в хранилище
head("ШАГ 2. ОБЛАЧНОЕ ХРАНИЛИЩЕ  (контейнер с программой)")
alive, aerr = bucket_alive()
if not alive:
    die("Бакет «%s» в этом каталоге не найден: %s" % (BUCKET, aerr),
        "Создайте его:  ./cloud/bucket-setup.sh\n"
        "Или укажите своё имя:  BUCKET=имя bash sega-deploy.sh")

code_keys, lerr = list_bucket()
if code_keys is None:
    warnings.append("Список объектов прочитать не удалось (%s) — проверяю файл скачиванием." % lerr)
    line("   ⚠ список не читается: %s" % lerr)
else:
    line("   в бакете «%s»:" % BUCKET)
    for k in code_keys[:30]:
        line("     %-52s%s" % (k, "   <== программа" if k == OBJ else ""))
    if len(code_keys) > 30: line("     …и ещё %d" % (len(code_keys) - 30))
    if not code_keys:
        die("Бакет «%s» пуст." % BUCKET,
            "Положите в него sega-chat.zip через консоль:\n"
            "https://console.yandex.cloud/storage")
    if LIST_MODE:
        line()
        line("   Режим просмотра: ничего не меняем.")
        line("   Программа «%s»%s" % (OBJ, " на месте." if OBJ in code_keys else " НЕ найдена."))
        sys.exit(0)
    if OBJ not in code_keys:
        die("Файла «%s» в бакете нет." % OBJ,
            "Положите его через консоль или укажите другой:\n"
            "OBJ=имя.zip bash sega-deploy.sh")

# ── скачиваем архив, чтобы подсмотреть отметку выпуска (и заодно проверить файл)
peek, have_mods = "", False
tmp_zip = "/tmp/sega-peek-%d.zip" % os.getpid()
try: os.remove(tmp_zip)
except Exception: pass
out, cerr = download(OBJ, tmp_zip)
if cerr or not os.path.exists(tmp_zip):
    die("Файл «%s» не скачивается из бакета: %s" % (OBJ, cerr or "пусто"),
        "Положите sega-chat.zip в бакет через консоль: https://console.yandex.cloud/storage")
try:
    with zipfile.ZipFile(tmp_zip) as z:
        names = z.namelist()
        have_mods = ("lib/s3.js" in names) or ("lib/backup.js" in names)
        if "lib/api.js" in names:
            m = re.search(r"const BUILD = '([^']+)'", z.read("lib/api.js").decode("utf-8", "ignore"))
            if m: peek = m.group(1)
except Exception as ex:
    warnings.append("Архив подсмотреть не удалось: %s" % ex)
try: os.remove(tmp_zip)
except Exception: pass
line("   архив «%s» на месте%s" % (OBJ, (", выпуск " + peek) if peek else ""))
if peek and not have_mods:
    warnings.append("В архиве нет модуля облачного хранилища — кнопка копии переписки работать не будет.")
if EXPECT and peek and not peek.startswith(EXPECT):
    die("В бакете лежит выпуск «%s», а вы ждали «%s»." % (peek, EXPECT),
        "Положите в бакет нужный sega-chat.zip и повторите.")

# ─────────────────────────────────────────────────── 3. база и функция
head("ШАГ 3. БАЗА И ФУНКЦИЯ В ЭТОМ КАТАЛОГЕ")
dbs, _ = yc(["ydb", "database", "list"]); dbs = dbs or []
for d in dbs: line("   база YDB : %-20s [%s]" % (d.get("name"), d.get("id")))
funcs, _ = yc(["serverless", "function", "list"]); funcs = funcs or []
for x in funcs: line("   функция  : %-20s [%s]" % (x.get("name"), x.get("id")))
gws, _ = yc(["serverless", "api-gateway", "list"]); gws = gws or []
for g in gws:
    line("   API-шлюз : %-20s [%s]  https://%s%s"
         % (g.get("name"), g.get("id"), g.get("domain", ""),
            "   <== ПУСТОЙ ДУБЛЬ" if g.get("id") == DUBL_GW else ""))
if not dbs:
    die("В каталоге нет базы YDB — это не тот каталог.",
        "Проверьте, в ту ли учётку вы вошли в консоли.")

fn = next((x for x in funcs if x.get("name") == FUNC), None) or (funcs[0] if funcs else None)
if not fn:
    die("В каталоге нет функции — обновлять нечего.",
        "Первая установка (без GitHub) делается так:\n"
        "  cd /tmp && rm -rf sega && mkdir sega && cd sega\n"
        "  yc storage s3 cp %s/%s . && python3 -m zipfile -e %s .\n"
        "  ./cloud/deploy.sh" % (S3, OBJ, OBJ))
FUNC = fn.get("name")

# текущая версия: из неё берём среду, память, таймаут и учётку,
# чтобы обновление не сбросило настройки (в первую очередь ключи push)
versions, verr = yc(["serverless", "function", "version", "list", "--function-name", FUNC])
if not versions:
    die("Не удалось прочитать версии функции: %s" % verr)
versions = sorted(versions, key=lambda x: x.get("created_at", ""), reverse=True)
cur = versions[0]
old_env = cur.get("environment") or {}
line("   сейчас версий: %d, последняя %s" % (len(versions), (cur.get("id") or "")[:12]))
line("   VAPID-ключи push: %s" % ("есть, сохраним" if old_env.get("VAPID_PRIVATE_KEY") else "НЕТ"))

endpoint = old_env.get("YDB_ENDPOINT", "")
db = next((d for d in dbs if d.get("name") == DB_NAME), None) or (dbs[0] if len(dbs) == 1 else None)
if db:
    dd, _ = yc(["ydb", "database", "get", db.get("name")])
    ep2 = (dd or {}).get("document_api_endpoint") or ""
    if ep2:
        if endpoint and endpoint != ep2:
            warnings.append("Адрес базы в функции не совпадает с базой «%s» — оставляю адрес функции."
                            % db.get("name"))
            line("   ⚠ адрес базы в функции отличается от базы «%s» — беру адрес функции" % db.get("name"))
        else:
            endpoint = ep2
            line("   адрес базы: %s (база «%s»)" % (endpoint, db.get("name")))
if not endpoint:
    die("Не удалось узнать адрес Document API базы.")

# ─────────────────────────────────────────────────── 4. права учётки
head("ШАГ 4. ПРАВА СЛУЖЕБНОЙ УЧЁТНОЙ ЗАПИСИ")
sa_id = cur.get("service_account_id") or ""
sas, _ = yc(["iam", "service-account", "list"]); sas = sas or []
if not sa_id:
    sa = next((x for x in sas if x.get("name") == SA_NAME), None)
    if not sa:
        if not sas: run(["yc", "iam", "service-account", "create", "--name", SA_NAME])
        sa, _ = yc(["iam", "service-account", "get", SA_NAME])
    if not sa and sas:
        sa = next((x for x in sas if str(x.get("name", "")).startswith("sega")), sas[0])
    if sa:
        sa_id = sa.get("id"); SA_NAME = sa.get("name") or SA_NAME
if not sa_id:
    die("Не удалось определить служебную учётную запись функции.")
line("   учётка функции: %s [%s]" % (SA_NAME, sa_id))

binds, _ = run(["yc", "resource-manager", "folder", "list-access-bindings",
                folder_id, "--format", "json"])
have = set()
try:
    for x in json.loads(binds or "[]"):
        if isinstance(x, dict):
            have.add((x.get("role_id"), (x.get("subject") or {}).get("service_account_id")))
except Exception:
    pass
for role in ("ydb.editor", "serverless.functions.invoker", "storage.editor"):
    if (role, sa_id) in have:
        line("   %-30s уже выдана" % role); continue
    _, e = run(["yc", "resource-manager", "folder", "add-access-binding",
                folder_id, "--role", role, "--service-account-id", sa_id])
    ok_bind = (not e) or ("already" in str(e).lower())
    line("   %-30s %s" % (role, "выдана" if ok_bind else "НЕ выдана: " + e))

# ─────────────────────────────────────────────────── 5. новая версия
head("ШАГ 5. НОВАЯ ВЕРСИЯ ФУНКЦИИ ИЗ ХРАНИЛИЩА")
env = dict(old_env)                                    # сохраняем всё, что было
env.update({                                            # и освежаем обязательное
    "YDB_ENDPOINT": endpoint,
    "YDB_TABLE": old_env.get("YDB_TABLE") or TABLE,
    "STORAGE_LIMIT": old_env.get("STORAGE_LIMIT") or STORAGE_LIMIT,
    "CODE_BUCKET": BUCKET,
    "BACKUP_PREFIX": BACKUP_PREFIX,
    "BACKUP_KEEP": old_env.get("BACKUP_KEEP") or BACKUP_KEEP,
})
for k in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"):
    if E(k, ""): env[k] = E(k)                          # явный экспорт важнее старого
if not env.get("VAPID_PRIVATE_KEY"):
    warnings.append("Ключей push нет: уведомления приходить не будут (на сам чат это не влияет).")
    line("   ⚠ ключей push нет — уведомления работать не будут")
env_str = ",".join("%s=%s" % (k, v) for k, v in sorted(env.items()) if v not in (None, ""))
line("   переменных среды: %d (в том числе CODE_BUCKET=%s)" % (len(env), BUCKET))

runtime = E("RUNTIME", "") or cur.get("runtime") or "nodejs20"
mem_raw = str(E("MEMORY", "") or cur.get("memory") or "")
if mem_raw.isdigit():
    mb = int(mem_raw) // (1024 * 1024)
    memory = ("%dMB" % mb) if mb >= 128 else "256MB"
else:
    memory = mem_raw or "256MB"
timeout = E("TIMEOUT", "") or cur.get("execution_timeout") or "30s"
line("   среда %s, память %s, таймаут %s" % (runtime, memory, timeout))

desc = "из бакета %s/%s" % (BUCKET, OBJ) + ((" · " + peek) if peek else "")
out, cerr = run(["yc", "serverless", "function", "version", "create",
                 "--function-name", FUNC,
                 "--runtime", runtime,
                 "--entrypoint", "index.handler",
                 "--memory", memory,
                 "--execution-timeout", timeout,
                 "--service-account-id", sa_id,
                 "--package-bucket-name", BUCKET,
                 "--package-object-name", OBJ,
                 "--environment", env_str,
                 "--description", desc], timeout=600)
if cerr:
    die("Новая версия не создалась: %s" % cerr,
        "Частая причина — у учётки Cloud Shell нет прав на функцию в этом каталоге,\n"
        "или архив в бакете повреждён.")
new_id = ""
try: new_id = (json.loads(out or "{}") or {}).get("id", "")
except Exception: pass
line("   ✓ версия выложена%s" % ((" [%s]" % new_id[:12]) if new_id else ""))

run(["yc", "serverless", "function", "allow-unauthenticated-invoke", FUNC])

# ─────────────────────────────────────────────────── 6. адрес
head("ШАГ 6. АДРЕС МЕССЕНДЖЕРА")
gw, _ = yc(["serverless", "api-gateway", "get", GW_NAME])
if not gw: gw, _ = yc(["serverless", "api-gateway", "get", GW_NAME + "-gw"])
if not gw:
    cands = [g for g in gws if g.get("id") != DUBL_GW]
    gw = cands[0] if cands else None
fid_raw, _ = run(["yc", "serverless", "function", "get", FUNC, "--format", "json"])
try: fid = (json.loads(fid_raw or "{}") or {}).get("id", "")
except Exception: fid = ""
if gw:
    dom = gw.get("domain") or ((gw.get("id") or "") + ".apigw.yandexcloud.net")
    url = "https://%s" % dom
    line("   основной адрес: %s" % url)
else:
    url = "https://functions.yandexcloud.net/%s" % fid
    warnings.append("API-шлюз не найден — показываю технический адрес функции.")
    line("   ⚠ API-шлюз не найден, технический адрес: %s" % url)

# ── живой контроль: что реально отвечает сервер
st = None
have_curl = subprocess.run(["bash", "-c", "command -v curl"],
                           capture_output=True, text=True).returncode == 0
if have_curl:
    for _ in range(6):
        out, _ = run(["curl", "-s", "-m", "15", url.rstrip("/") + "/api/state"], timeout=40)
        try:
            st = json.loads(out or "")
            if st.get("build"): break
        except Exception:
            st = None
        time.sleep(3)
else:
    warnings.append("В Cloud Shell нет curl — не смог проверить ответ сервера, проверьте глазами.")
if st:
    line("   сервер отвечает: build=%s, setupRequired=%s" % (st.get("build"), st.get("setupRequired")))
    if st.get("setupRequired") is not False:
        warnings.append("База выглядит пустой (setupRequired=true) — сверьте, тот ли это адрес!")
        line("   ⚠ база выглядит ПУСТОЙ — сверьте, тот ли это адрес, где видны ваши чаты")
    if peek and str(st.get("build", "")) != peek:
        line("   ⚠ в архиве «%s», а отвечает «%s» — новая версия ещё прогревается, подождите полминуты"
             % (peek, st.get("build")))
elif have_curl:
    warnings.append("Сервер пока не ответил на /api/state — возможно, функция ещё прогревается.")
    line("   ⚠ сервер пока не ответил (функция прогревается), проверьте страницу через минуту")

# ─────────────────────────────────────────────────── 7. история версий
head("ШАГ 7. ИСТОРИЯ ВЕРСИЙ ПРОГРАММЫ В ХРАНИЛИЩЕ")
stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
rel = "releases/sega-chat-%s%s.zip" % (stamp, ("-" + peek) if peek else "")
_, cerr = run(["yc", "storage", "s3", "cp", "%s/%s" % (S3, OBJ), "%s/%s" % (S3, rel)], timeout=180)
if cerr:
    warnings.append("Копию в историю положить не удалось: %s" % cerr)
    line("   ⚠ копию в историю положить не удалось: %s" % cerr)
else:
    line("   ✓ %s" % rel)
    rkeys, _ = list_bucket("releases/")
    if rkeys:
        rkeys = sorted([k for k in rkeys if k.endswith(".zip")])
        old = rkeys[:-KEEP_RELEASES] if KEEP_RELEASES > 0 else []
        for o in old:
            run(["yc", "storage", "s3", "rm", "%s/%s" % (S3, o)])
            line("   − убрали старую %s" % o)

head("ГОТОВО")
line("   Программа берётся из облачного хранилища Yandex Cloud. GitHub не нужен.")
line()
line("   Адрес мессенджера:  %s" % url)
if peek: line("   Выпуск:              %s" % peek)
if new_id: line("   Версия функции:      %s" % new_id)
line()
line("   Что сделать вам:")
line("     1. Откройте %s и нажмите Ctrl+F5" % url)
line("        (на телефоне — закройте все вкладки и откройте заново)")
line("     2. В настройках внизу должно быть «Интерфейс: %s · Сервер: %s»"
     % (peek or "новый", peek or "новый"))
line("     3. Все чаты, друзья и переписка должны остаться на месте.")
line()
line("   Как обновлять в следующий раз:")
line("     • положите новый sega-chat.zip в бакет «%s»" % BUCKET)
line("       (консоль → Object Storage → бакет → перетащить файл)")
line("     • в Cloud Shell вставьте одну строку:")
line("         cd /tmp && rm -f sega-deploy.sh && \\")
line("         yc storage s3 cp %s/sega-deploy.sh . && bash sega-deploy.sh" % S3)
line()
line("   Откат, если новая версия не понравится:")
line("         OBJ=%s bash sega-deploy.sh" % rel)
line("   Посмотреть, что лежит в хранилище:")
line("         LIST=1 bash sega-deploy.sh")
if warnings:
    line()
    line("   На что обратить внимание:")
    for w in warnings: line("     ⚠ " + w)
line()
PY
