/* Заготовка окна установки; не подключена к интерфейсу мессенджера. Само окно
 * не создаёт код и не скачивает файл — это делают явно заданные обработчики. */
(function (g) {
  'use strict';
  const disposers=new WeakMap();
  // Оболочка обязана вызвать перед любым внешним удалением окна. Это отменяет
  // ожидающее подтверждение, но не останавливает уже запущенный обработчик.
  function disposeSetupView(root) { const dispose=disposers.get(root); if(dispose)dispose(); }
  function createSetupView(doc, {onCreateCode, onDownload, onClose, confirmDownload, onError} = {}) {
    if (!doc || typeof onCreateCode !== 'function' || typeof onDownload !== 'function'
        || typeof onClose !== 'function' || typeof confirmDownload !== 'function') throw new Error('Неполные действия окна');
    const root=doc.createElement('section'); root.className='local-pc-setup';
    let disposed=false;
    function dispose() {
      if(disposed)return;
      disposed=true;
      for(const button of root.querySelectorAll('button'))button.disabled=true;
    }
    disposers.set(root,dispose);
    const draft=doc.createElement('p'); draft.textContent='Это черновик инструкции. Подключение локального диска и программа для Windows ещё не готовы.'; root.appendChild(draft);
    const intro=doc.createElement('p'); intro.textContent='Подключите папку на своём компьютере с Windows 10. Она будет доступна, когда компьютер включён и подключён к интернету.'; root.appendChild(intro);
    const list=doc.createElement('ol');
    for (const text of [
      'На компьютере с нужной папкой откройте мессенджер и войдите в свой профиль.',
      'Нажмите «Создать код подключения». Этот код даёт доступ к папке — никому его не отправляйте.',
      'Нажмите «Скачать программу» и подтвердите скачивание. Откройте скачанный файл и следуйте его подсказкам.',
      'В программе вставьте код, выберите одну папку и подтвердите подключение.',
      'Вернитесь в мессенджер и откройте локальный диск. Синхронизацию со вторым ПК нужно включить отдельно.'
    ]) { const li=doc.createElement('li'); li.textContent=text; list.appendChild(li); }
    root.appendChild(list);
    const access=doc.createElement('p'); access.textContent='Другие люди смогут менять файлы только с вашего разрешения. Синхронизация между компьютерами будет включаться отдельно; при удалении копия на другом компьютере должна попадать в корзину, а разные версии файлов — сохраняться.'; root.appendChild(access);
    const buttons=doc.createElement('div'); buttons.className='local-pc-setup-actions';
    function button(text, action, reportAfterDispose=false) {
      const b=doc.createElement('button'); b.type='button'; b.textContent=text;
      b.addEventListener('click', async () => {
        if (disposed || b.disabled) return;
        b.disabled=true;
        try { await action(); } catch (e) { if ((!disposed || reportAfterDispose) && typeof onError === 'function') onError(e); }
        finally { if(!disposed)b.disabled=false; }
      });
      buttons.appendChild(b); return b;
    }
    button('Создать код подключения',onCreateCode);
    button('Скачать программу',async () => {
      const consent=await confirmDownload('Скачать файл на устройство?');
      if (!disposed && consent === true) await onDownload();
    });
    button('Закрыть',async () => { dispose(); await onClose(); },true);
    root.appendChild(buttons);
    return root;
  }
  const exported=Object.freeze({createSetupView,disposeSetupView});
  if (typeof module !== 'undefined' && module.exports) module.exports=exported;
  else g.SegaLocalSetupView=exported;
})(typeof globalThis !== 'undefined' ? globalThis : window);
