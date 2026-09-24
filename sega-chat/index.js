// Точка входа для Yandex Cloud Functions: в настройках функции указывается
// «index.handler». Вся работа — в cloud/index.js.
module.exports.handler = require('./cloud/index').handler;
