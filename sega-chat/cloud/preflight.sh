#!/usr/bin/env bash
# ПРОВЕРКА ПЕРЕД ДЕПЛОЕМ SEGA-CHAT — только чтение, ничего не создаёт и не меняет.
# Вставлять в Yandex Cloud Shell целиком.
set -uo pipefail
python3 - <<'PY'
import json, re, subprocess, sys

NEW_GW_ID = "d5deshv7pt6ff4gchn00"          # новый ПУСТОЙ адрес из прошлой ошибки
BAD_FOLDER_ID = "b1gbner1dp6vnbo1ha45"       # каталог «default» чужой учётки
NEW_SALT = "09197e8fae3953946002245c3b7e90be"  # «отпечаток» пустой базы
OLD_URL = ""                                 # <-- сюда вставьте вашу СТАРУЮ ссылку (где переписка)

def run(args, timeout=90):
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

def yc(args, timeout=90):
    out, err = run(["yc"] + args + ["--format", "json"], timeout)
    if err: return None, err
    try: return json.loads(out or "null"), None
    except Exception: return None, "не разобрать ответ"

def curl(url):
    out, err = run(["curl", "-s", "-m", "12", url])
    if err: return None, err
    try: return json.loads(out), None
    except Exception: return None, "ответ не похож на JSON"

def rid(u):
    u = (u or "").strip()
    m = re.search(r"//([a-z0-9]+)\.[a-z0-9.]*apigw\.yandexcloud\.net", u)
    if m: return m.group(1)
    m = re.search(r"functions\.yandexcloud\.net/([a-z0-9]+)", u)
    if m: return m.group(1)
    return ""

def line(s=""): print(s)
def head(s): line(); line("─" * 74); line(s); line("─" * 74)

problems, notes = [], []

head("ПРОВЕРКА ПЕРЕД ДЕПЛОЕМ  (скрипт только читает, ничего не меняет)")

# ── 1. куда смотрит Cloud Shell
line("1) КУДА СМОТРИТ CLOUD SHELL СЕЙЧАС")
cfg, _ = run(["yc", "config", "list"])
cfg = cfg or ""
folder_id = ""
for l in cfg.splitlines():
    l = l.strip()
    if l.startswith("folder-id"): folder_id = l.split(":", 1)[1].strip()
    if l.startswith(("cloud-id", "folder-id", "profile")): line("   " + l)
prof, _ = run(["yc", "config", "profile", "list"])
for l in (prof or "").strip().splitlines(): line("   " + l.strip())

if not folder_id:
    problems.append("Cloud Shell не знает каталог. Выполните: yc init")
cloud, cerr = yc(["resource-manager", "cloud", "list"])
clouds = {c["id"]: c.get("name", "") for c in (cloud or [])}
if folder_id:
    f, e = yc(["resource-manager", "folder", "get", folder_id])
    if f:
        line("   облако:  %s [%s]" % (clouds.get(f.get("cloud_id", ""), "?"), f.get("cloud_id", "?")))
        line("   каталог: %s [%s]" % (f.get("name", "?"), folder_id))
        if folder_id == BAD_FOLDER_ID:
            problems.append("Это каталог «default» из ЧУЖОЙ учётки (cloud-aurora-909) — там только пустой дубль.")
    else:
        line("   каталог не прочитать: %s" % e)
if len(clouds) > 1:
    notes.append("У аккаунта несколько облаков: %s — убедитесь, что выбрано нужное." % ", ".join(clouds.values()))

# ── 2. что лежит в каталоге
line(); line("2) ЧТО ЛЕЖИТ В ЭТОМ КАТАЛОГЕ")
if not folder_id:
    dbs = funcs = gws = sas = []
else:
    dbs,  _ = yc(["ydb", "database", "list"])
    funcs, _ = yc(["serverless", "function", "list"])
    gws,  _ = yc(["serverless", "api-gateway", "list"])
    sas,  _ = yc(["iam", "service-account", "list"])
    dbs, funcs, gws, sas = dbs or [], funcs or [], gws or [], sas or []
    for it in dbs:  line("   база YDB : %-18s [%s]" % (it.get("name"), it.get("id")))
    for it in funcs:line("   функция  : %-18s [%s]" % (it.get("name"), it.get("id")))
    for it in gws:
        tag = "   <== ПУСТОЙ ДУБЛЬ" if it.get("id") == NEW_GW_ID else ""
        line("   API-шлюз : %-18s [%s]  https://%s%s" % (it.get("name"), it.get("id"), it.get("domain", ""), tag))
    for it in sas:  line("   учётка   : %-18s [%s]" % (it.get("name"), it.get("id")))
    if not dbs:  problems.append("В каталоге нет базы YDB — это не тот каталог.")
    if not gws:  problems.append("В каталоге нет API-шлюза — это не тот каталог.")
    if len(gws) > 1: notes.append("Шлюзов несколько: %s" % ", ".join(g.get("name", "?") for g in gws))
    if len(funcs) > 1: notes.append("Функций несколько: %s" % ", ".join(f.get("name", "?") for f in funcs))

# ── 3. живой опрос адреса
line(); line("3) ЖИВОЙ ОПРОС АДРЕСА ШЛУЗА (curl /api/state)")
gw = None
if gws:
    want = rid(OLD_URL)
    if want:
        gw = next((g for g in gws if g.get("id") == want), None)
        if not gw:
            problems.append("Шлюза с id %s (ваша старая ссылка) в этом каталоге НЕТ." % want)
    else:
        gw = next((g for g in gws if g.get("id") != NEW_GW_ID), gws[0])
        notes.append("Старая ссылка в скрипт не вписана — беру шлюз «%s». Сверьте адрес глазами!" % gw.get("name"))
    if gw and gw.get("id") == NEW_GW_ID:
        problems.append("Это новый ПУСТОЙ адрес (дубль). Деплоить сюда нельзя.")
if gw:
    dom = gw.get("domain") or (gw.get("id", "") + ".apigw.yandexcloud.net")
    line("   адрес: https://%s" % dom)
    st, e = curl("https://%s/api/state" % dom)
    if not st:
        problems.append("Сервер по этому адресу не отвечает (%s)." % e)
    else:
        line("   build          : %s" % st.get("build"))
        line("   setupRequired  : %s  -> %s" % (st.get("setupRequired"),
             "в базе ЕСТЬ люди (переписка на месте)" if st.get("setupRequired") is False else "база ПУСТАЯ"))
        line("   codeProofSalt  : %s" % st.get("codeProofSalt"))
        if st.get("setupRequired") is not False:
            problems.append("База пустая (setupRequired=true) — здесь нет вашей переписки.")
        if st.get("codeProofSalt") == NEW_SALT:
            problems.append("«Отпечаток» базы совпадает с пустым дублем — это не ваша переписка.")
        if str(st.get("build", "")).startswith("pkg3-13"):
            notes.append("Тут уже pkg3-13 — возможно, деплой уже прошёл.")

# ── 4. настройки текущей функции (что обязательно сохранить)
line(); line("4) НАСТРОЙКИ ТЕКУЩЕЙ ФУНКЦИИ (их надо сохранить при деплое)")
fn = None
if funcs:
    fn = funcs[0]
env, sa_id_used, ydb_table, endpoint_fn = {}, "", "", ""
if fn:
    v, e = yc(["serverless", "function", "version", "list", "--function-name", fn.get("name")])
    if v:
        v = sorted(v, key=lambda x: x.get("created_at", ""), reverse=True)
        cur = v[0]
        env = cur.get("environment") or {}
        sa_id_used = cur.get("service_account_id", "")
        ydb_table = env.get("YDB_TABLE", "")
        endpoint_fn = env.get("YDB_ENDPOINT", "")
        line("   функция        : %s [%s]" % (fn.get("name"), fn.get("id")))
        line("   версий         : %d (последняя: %s)" % (len(v), cur.get("tag") or cur.get("id", "")[:12]))
        line("   YDB_TABLE      : %s" % (ydb_table or "(не задана — по умолчанию sega_chat)"))
        line("   VAPID-ключи    : %s" % ("есть, сохраним" if env.get("VAPID_PRIVATE_KEY") else "НЕТ — push не работал и не заработает"))
        if not env.get("VAPID_PRIVATE_KEY"):
            notes.append("В функции нет VAPID-ключей: при деплое возьму ключи из вашего комплекта (push продолжит работать).")
    else:
        line("   версии не прочитать: %s" % e)

db_name = ""
if dbs and endpoint_fn:
    for d in dbs:
        dd, _ = yc(["ydb", "database", "get", d.get("name")])
        if dd and dd.get("document_api_endpoint") == endpoint_fn:
            db_name = d.get("name"); break
    if db_name:
        line("   YDB_ENDPOINT   : совпадает с базой «%s» ✓" % db_name)
    else:
        problems.append("Адрес базы в функции не совпадает ни с одной базой каталога — пришлите вывод мне.")
elif dbs:
    db_name = dbs[0].get("name")
    notes.append("Адрес функции не прочитан; беру базу «%s»." % db_name)

sa_name = ""
if sa_id_used:
    s, _ = yc(["iam", "service-account", "get", sa_id_used])
    if s: sa_name = s.get("name", "")
    if sa_name: line("   учётка функции : %s" % sa_name)
elif sas:
    sa_name = next((x.get("name") for x in sas if x.get("name", "").startswith("sega")), sas[0].get("name", ""))

# ── вердикт
head("ВЕРДИКТ")
for n in notes: line("   ⚠ " + n)
if problems:
    line()
    line("   ❌ ДЕПЛОЙ ЗАПУСКАТЬ НЕЛЬЗЯ:")
    for p in problems: line("      • " + p)
    line()
    line("   Пришлите мне весь этот вывод — разберёмся. Ничего не удаляйте.")
    sys.exit(0)

line("   ✅ Похоже, это ВАШ настоящий мессенджер: адрес живой, в базе есть люди,")
line("      база и функция в каталоге совпадают. Можно обновлять до pkg3-13.")
line()
line("   Ещё раз сверьте глазами: адрес из пункта 3 == ваша СТАРАЯ ссылка,")
line("   где видны все чаты и друзья. Если да — копируйте блок ниже ЦЕЛИКОМ.")

ov = []
if db_name and db_name != "sega-chat-db": ov.append("DB_NAME=%s" % db_name)
if fn and fn.get("name") != "sega-chat":  ov.append("FUNC_NAME=%s" % fn.get("name"))
if gw and gw.get("name") != "sega-chat":  ov.append("GW_NAME=%s" % gw.get("name"))
if sa_name and sa_name != "sega-chat-sa": ov.append("SA_NAME=%s" % sa_name)
if ydb_table and ydb_table != "sega_chat": ov.append("YDB_TABLE=%s" % ydb_table)
dep = (" ".join(ov) + " " if ov else "") + "./cloud/deploy.sh"

head("БЛОК ДЕПЛОЯ (копировать целиком)")
line("cd /tmp && rm -rf Marty && git clone https://github.com/Pilipenko123/Marty.git && cd Marty/sega-chat")
line("grep -c pkg3-13 lib/api.js public/app.js        # должно напечатать 1 и 1")
line("# ключи push — берём из работающей функции, чтобы уведомления не сломались")
if env.get("VAPID_PRIVATE_KEY"):
    line("VJSON=$(yc serverless function version list --function-name %s --format json)" % (fn.get("name") if fn else "sega-chat"))
    line("export VAPID_PUBLIC_KEY=$(printf '%s' \"$VJSON\" | python3 -c \"import sys,json;v=sorted(json.load(sys.stdin),key=lambda x:x.get('created_at',''),reverse=True);print(v[0].get('environment',{}).get('VAPID_PUBLIC_KEY',''))\")")
    line("export VAPID_PRIVATE_KEY=$(printf '%s' \"$VJSON\" | python3 -c \"import sys,json;v=sorted(json.load(sys.stdin),key=lambda x:x.get('created_at',''),reverse=True);print(v[0].get('environment',{}).get('VAPID_PRIVATE_KEY',''))\")")
    line("export VAPID_SUBJECT=$(printf '%s' \"$VJSON\" | python3 -c \"import sys,json;v=sorted(json.load(sys.stdin),key=lambda x:x.get('created_at',''),reverse=True);print(v[0].get('environment',{}).get('VAPID_SUBJECT','mailto:artsystems66@gmail.com'))\")")
else:
    line("export VAPID_PUBLIC_KEY='BCovX9YJGfCOF3j9JrLKKogAAPLDvcL9SvrTo2bt_-CeVzrd_2H1CNhoafgm-LxYo8yjuJOSIrm_il2LR6BAT1A'")
    line("export VAPID_PRIVATE_KEY='UOWCUZAxHXB6U8CvKtGOTSGbROyVXzEXoIASaXCzQZ4'")
    line("export VAPID_SUBJECT='mailto:artsystems66@gmail.com'")
line("[ -n \"$VAPID_PRIVATE_KEY\" ] && echo 'ключи push на месте ✓' || echo 'СТОП: ключей push нет'")
line("# и сам деплой")
line(dep)
line()
line("   После деплоя: откройте СТАРУЮ ссылку и нажмите Ctrl+F5 (на телефоне —")
line("   закройте все вкладки и откройте заново). В настройках должно быть")
line("   «Интерфейс: pkg3-13 · Сервер: pkg3-13», все чаты и друзья на месте.")
line("   Пустой дубль пока НЕ удаляем — уберём после вашей проверки.")
PY
