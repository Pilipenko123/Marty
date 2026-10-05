#!/usr/bin/env bash
#
# Собрать архив программы «sega-chat.zip» — тот самый файл, который кладётся
# в облачное хранилище Yandex Cloud и оттуда становится новой версией функции.
#
#   ./cloud/pack.sh                    -> dist/sega-chat.zip
#   ./cloud/pack.sh /путь/имя.zip      -> свой путь
#
# В архив попадают код и зависимости (node_modules), потому что при деплое из
# хранилища облако ничего не доустанавливает — оно просто распаковывает архив.
# Папка data (локальная переписка) и прочие *.zip в архив не попадают.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
OUT="${1:-dist/sega-chat.zip}"

command -v python3 >/dev/null 2>&1 || { echo "нужен python3"; exit 1; }

[ -f cloud/index.js ] && [ -d public ] || { echo "скрипт нужно запускать из папки sega-chat"; exit 1; }

# зависимости: web-push нужен функции для шифрования push-уведомлений
if [ ! -d node_modules/web-push ]; then
  echo "==> ставлю зависимости (нужны внутри архива)"
  export npm_config_cache="${NPM_CACHE:-/tmp/sega-npm-cache}"
  mkdir -p "$npm_config_cache"
  npm install --omit=dev --no-audit --no-fund >/dev/null
fi
[ -d node_modules/web-push ] || { echo "не удалось поставить web-push — без него не заработают уведомления"; exit 1; }

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
python3 - "$OUT_ABS" <<'PY'
import hashlib, os, sys, zipfile

out = sys.argv[1]
roots = ['index.js', 'package.json', 'cloud', 'lib', 'public', 'node_modules']
skip_dirs = {'data', 'dist', 'tmpdbg', '__pycache__'}

n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for r in roots:
        if os.path.isfile(r):
            z.write(r, r); n += 1
            continue
        for base, dirs, files in os.walk(r):
            dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith('.')]
            for f in sorted(files):
                if f.endswith('.zip'):
                    continue
                p = os.path.join(base, f)
                z.write(p, p); n += 1

size = os.path.getsize(out)
sha = hashlib.sha256(open(out, 'rb').read()).hexdigest()
build = ''
with zipfile.ZipFile(out) as z:
    import re
    m = re.search(r"const BUILD = '([^']+)'", z.read('lib/api.js').decode('utf-8', 'ignore'))
    if m: build = m.group(1)

print('  файл    : %s' % out)
print('  выпуск  : %s' % (build or '?'))
print('  строк   : %d файлов' % n)
print('  размер  : %.2f МБ (предел архива из хранилища — 128 МБ)' % (size / 1048576))
print('  sha256  : %s' % sha)
PY

echo
echo "Готово. Дальше:"
echo "  1. откройте консоль → Object Storage → бакет → перетащите $(basename "$OUT")"
echo "  2. в Cloud Shell:  cd /tmp && rm -f sega-deploy.sh && \\"
echo "     yc storage s3 cp s3://\${BUCKET:-sega-chat-code}/sega-deploy.sh . && bash sega-deploy.sh"
