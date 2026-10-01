#!/usr/bin/env node
/*
 * Напечатать НОВУЮ пару ключей Web Push (VAPID) в виде готовых строк export.
 * Запуск из папки sega-chat (нужны установленные зависимости):
 *   npm install --omit=dev --no-audit --no-fund
 *   node cloud/gen-vapid.js
 * Три полученные строки копируют в Cloud Shell целиком и затем деплоят заново.
 */
'use strict';
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('# ── скопируйте три строки ниже в Cloud Shell целиком ──');
console.log("export VAPID_PUBLIC_KEY='" + keys.publicKey + "'");
console.log("export VAPID_PRIVATE_KEY='" + keys.privateKey + "'");
console.log("export VAPID_SUBJECT='mailto:artsystems66@gmail.com'");
console.log('# ── после вставки выполните:  ./cloud/deploy.sh  ──');
