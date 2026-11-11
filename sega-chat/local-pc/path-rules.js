/* Общие предварительные правила относительных имён для лабораторного Node и
 * браузерного кода. НЕ защищают от подмены путей и не повторяют все правила
 * Windows; настоящая файловая граница и проверка безопасности ещё нужны. */
(function (g) {
  'use strict';
  const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
  function partsOf(relative) {
    if (typeof relative !== 'string' || relative.length > 4096) throw new Error('Неверный путь');
    if (relative === '') return [];
    if (relative.startsWith('/') || relative.endsWith('/') || /[\\\x00-\x1f\x7f:]/.test(relative)) throw new Error('Неверный путь');
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.length > 255 || /[<>"|?*]/.test(p) || /[. ]$/.test(p) || WINDOWS_DEVICE.test(p))) throw new Error('Неверный путь');
    return parts;
  }
  const exported=Object.freeze({partsOf});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalPathRules=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
