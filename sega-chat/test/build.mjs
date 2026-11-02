// test/build.mjs — pkg3-108: номер выпуска ЧИТАЕТСЯ ИЗ КОДА.
//
// Раньше каждый выпуск приходилось механически переписывать в двух десятках
// наборов («сервер помечен pkg3-105»), и забытая строка валила весь прогон.
// Теперь номер берётся из lib/api.js — единственного места, где он объявлен
// (рядом с public/app.js: там тот же номер, и это проверяет dom42).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD = /const BUILD = '([^']+)'/.exec(readFileSync(join(ROOT, 'lib/api.js'), 'utf8'))[1];
/** Прочитать файл программы по пути от корня (для меток в тестах). */
export const readSrc = p => readFileSync(join(ROOT, p), 'utf8');
