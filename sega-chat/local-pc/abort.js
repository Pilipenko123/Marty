'use strict';
// Общая отмена только для лабораторных операций. Прерывание ожидания не
// доказывает, что сторонний обработчик действительно остановил работу.
function abortError() { const e=new Error('Операция остановлена');e.name='AbortError';return e; }
function validateSignal(signal) {
  if (signal!==undefined && (!signal || typeof signal.aborted!=='boolean'
      || typeof signal.addEventListener!=='function' || typeof signal.removeEventListener!=='function')) throw new Error('Неверный сигнал остановки');
}
function checkAborted(signal) { if(signal && signal.aborted)throw abortError(); }
function waitFor(promise,signal) {
  if (!signal) return promise;
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(ok,value)=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);if(ok)resolve(value);else reject(value);};
    const onAbort=()=>finish(false,abortError());
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(value=>finish(true,value),err=>finish(false,err));
    if(signal.aborted)onAbort();
  });
}
module.exports={abortError,validateSignal,checkAborted,waitFor};
