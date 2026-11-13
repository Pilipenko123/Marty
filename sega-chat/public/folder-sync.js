/* SEGA-CHAT · pkg3-154: окно «Папка с ПК». Загружается после app.js. */
'use strict';
(function () {
  const st = { devices: [], folders: [], shares: { incoming: [], outgoing: [] }, keys: new Map(), loaded: false };
  const h = s => escapeHtml(s);
  async function syncPairKey(pub) {
    const key = await subtle.importKey('raw', fromB64(pub), EC, false, []);
    return subtle.deriveKey({ name: 'ECDH', public: key }, S.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function wrapFor(pub, raw) { return aesEncryptBytes(await syncPairKey(pub), raw); }
  async function unwrapFrom(pub, blob) { return new Uint8Array(await aesDecryptBytes(await syncPairKey(pub), blob)); }
  async function folderKey(f) {
    if (st.keys.has(f.id + ':' + f.keyRev)) return st.keys.get(f.id + ':' + f.keyRev);
    const me = userById(S.me.id) || S.me;
    const raw = await unwrapFrom(me.pub, f.userWrap);
    const key = await importAes(raw);
    st.keys.set(f.id + ':' + f.keyRev, { raw, key });
    return { raw, key };
  }
  async function load() {
    const [d, f, sh] = await Promise.all([api('/api/sync/devices'), api('/api/sync/folders'), api('/api/sync/shares')]);
    st.devices = d.devices || []; st.folders = f.folders || []; st.shares = sh; st.loaded = true;
  }
  function deviceOptions(filter) {
    return st.devices.filter(d => !d.revoked && (!filter || filter(d))).map(d => `<option value="${h(d.id)}">${h(d.name)}</option>`).join('');
  }
  function userOptions() {
    const ids = new Set();
    for (const c of S.chats || []) for (const u of c.members || []) if (u !== S.me.id) ids.add(u);
    return [...ids].map(id => userById(id)).filter(u => u && u.pub).map(u => `<option value="${h(u.id)}">${h(u.name)}</option>`).join('');
  }
  function statusHtml(f, dev, key) {
    if (!dev.state) return '<span class="tiny muted">ещё не выходил на связь</span>';
    return `<span class="tiny muted" data-sync-state="${h(f.id)}:${h(dev.id)}">состояние зашифровано</span>`;
  }
  async function decryptStates() {
    for (const f of st.folders) {
      let k; try { k = await folderKey(f); } catch (e) { continue; }
      for (const dev of f.devices || []) {
        const el = document.querySelector(`[data-sync-state="${f.id}:${dev.id}"]`);
        if (!el || !dev.state) continue;
        try {
          const s = JSON.parse(dec.decode(await aesDecryptBytes(k.key, dev.state)));
          const pend = (s.pending || []).map(p => `<div class="sync-pending">${h(p.path)} <button class="mini" data-sync-approve="${h(f.id)}" data-dev="${h(dev.id)}" data-pending="${h(p.id)}">Подтвердить удаление</button></div>`).join('');
          el.innerHTML = (s.paused ? 'на паузе · ' : '') + (s.error ? '⚠ ' + h(s.error) : 'работает') + pend;
        } catch (e) { el.textContent = 'состояние не открылось'; }
      }
    }
  }
  function render() {
    const folders = st.folders.map(f => `<div class="sync-card"><b>${h(f.name)}</b>
      <div class="tiny muted">${f.owner === S.me.id ? 'владелец' : 'доступ: ' + (f.perm === 'write' ? 'изменение' : 'чтение')} · ключ ${f.keyRev}${f.needsRotation ? ' · <b>нужно обновить ключ</b>' : ''}</div>
      ${(f.devices || []).map(d => `<div class="sync-dev">${h(d.name)} ${statusHtml(f, d)}</div>`).join('')}
      <div class="sync-actions">
        ${f.owner === S.me.id && !f.needsRotation ? `<select id="sync-add-dev-${h(f.id)}">${deviceOptions(d => !(f.devices || []).some(x => x.id === d.id))}</select><button class="mini" data-sync-add="${h(f.id)}">Добавить ПК</button>` : ''}
        ${f.owner === S.me.id && f.needsRotation ? `<button class="mini" data-sync-rotate="${h(f.id)}">Обновить ключ</button>` : ''}
        ${f.owner === S.me.id && !f.needsRotation ? `<button class="mini" data-sync-share="${h(f.id)}">Поделиться с другом</button>` : ''}
        ${f.owner === S.me.id ? `<button class="mini" data-sync-cloud="${h(f.id)}">Подключить папку диска</button>` : ''}
        ${(f.mounts || []).map(m => `<span class="chip">${m.kind === 'google' ? 'Google' : 'Яндекс'} · ${h(m.path)} <button class="mini" data-sync-unmount="${h(f.id)}" data-mount="${h(m.id)}">×</button></span>`).join('')}
        ${f.owner === S.me.id ? `<button class="mini danger" data-sync-delete="${h(f.id)}">Убрать из синхронизации</button>` : ''}
      </div>
      ${(f.members || []).filter(m => m.id !== f.owner).map(m => `<div class="tiny">${h(m.name)} <button class="mini" data-sync-unshare="${h(f.id)}" data-uid="${h(m.id)}">Отозвать</button></div>`).join('')}
    </div>`).join('');
    const devices = st.devices.map(d => `<div class="sync-dev">${h(d.name)} · ${d.revoked ? 'отозван' : d.lastSeen ? 'на связи ' + fmtAgo(d.lastSeen) : 'ещё не запускался'} ${!d.revoked ? `<button class="mini" data-sync-resync="${h(d.id)}">Сверить заново</button> <button class="mini danger" data-sync-revoke="${h(d.id)}">Отозвать</button>` : ''}</div>`).join('');
    const incoming = (st.shares.incoming || []).map(s => `<div class="sync-card"><b>${h(s.folderName)}</b> · ${s.perm === 'write' ? 'изменение' : 'чтение'}
      <select id="sync-accept-dev-${h(s.id)}">${deviceOptions(d => !st.folders.some(f => (f.devices || []).some(x => x.id === d.id)))}</select>
      <button class="mini" data-sync-accept="${h(s.id)}">Принять на этот ПК</button> <button class="mini" data-sync-decline="${h(s.id)}">Отклонить</button></div>`).join('');
    modal('Папка с ПК', `
      <p class="hint">Переписка, игры и файлы на облачных дисках не меняются. Синхронизируется только выбранная папка. Удаления и спорные замены требуют подтверждения.</p>
      <div class="sync-actions"><a class="btn" href="${h(BASE)}/api/sync/download" download>Скачать помощник Windows</a> <button class="mini" id="sync-pair-code">Код для этого ПК</button></div>
      <div id="sync-code-box"></div>
      <details><summary>Как установить</summary><ol>
        <li>Нажмите «Код для этого ПК» и скопируйте код.</li>
        <li>Скачайте архив, распакуйте его и запустите <b>install.cmd</b>.</li>
        <li>Выберите папку, вставьте код, задайте имя компьютера.</li>
        <li>Вернитесь сюда и создайте папку синхронизации. На двух других ПК повторите установку и добавьте их кнопкой «Добавить ПК».</li>
      </ol><p class="tiny muted">Помощник работает при закрытом чате и заблокированном экране, пока компьютер включён и есть сеть. После сна он догоняет изменения сам.</p></details>
      <h4>Мои компьютеры</h4>${devices || '<div class="hint">Пока нет подключённых компьютеров.</div>'}
      <h4>Папки</h4>${folders || '<div class="hint">Папок пока нет.</div>'}
      <div class="sync-actions"><input id="sync-folder-name" placeholder="Название папки" maxlength="80"> <select id="sync-folder-dev">${deviceOptions(d => !st.folders.some(f => (f.devices || []).some(x => x.id === d.id)))}</select> <button class="mini" id="sync-create">Создать папку</button></div>
      ${incoming ? '<h4>Приглашения друга</h4>' + incoming : ''}
    `, { cls: 'sync-modal' });
    decryptStates();
  }
  async function openFolderSync() {
    if (!S.priv) return toast('Нет ключа шифрования: выйдите и войдите снова', true);
    try { await load(); render(); } catch (e) { toast(e.message, true); }
  }
  async function refresh() { await load(); render(); }
  document.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('[data-foldsync]')) { closeRail(); return openFolderSync(); }
    try {
      if (t.id === 'sync-pair-code') {
        const r = await api('/api/sync/pair/init', { method: 'POST', body: {} });
        document.getElementById('sync-code-box').innerHTML = `<div class="sync-code"><span id="sync-code-value">${h(r.code)}</span> <button class="mini" id="sync-copy-code">Скопировать</button></div><div class="tiny muted">Код действует 10 минут и только один раз.</div>`;
      }
      if (t.id === 'sync-copy-code') { await navigator.clipboard.writeText(document.getElementById('sync-code-value').textContent.trim()); toast('Код скопирован'); }
      if (t.id === 'sync-create') {
        const name = document.getElementById('sync-folder-name').value.trim();
        const did = document.getElementById('sync-folder-dev').value;
        const dev = st.devices.find(d => d.id === did);
        if (!name || !dev) return toast('Введите название и выберите компьютер', true);
        const raw = rnd(32), me = userById(S.me.id) || S.me;
        const wrap = { by: S.me.id, blob: await wrapFor(dev.pub, raw) };
        const userWrap = await wrapFor(me.pub, raw);
        await api('/api/sync/folders', { method: 'POST', body: { name, deviceId: did, wrap, userWrap } });
        await refresh();
      }
      const add = t.closest('[data-sync-add]');
      if (add) {
        const f = st.folders.find(x => x.id === add.dataset.syncAdd);
        const did = document.getElementById('sync-add-dev-' + f.id).value;
        const dev = st.devices.find(d => d.id === did); if (!dev) return;
        const k = await folderKey(f);
        await api('/api/sync/folders/' + f.id + '/wrap', { method: 'POST', body: { deviceId: did, wrap: { by: S.me.id, blob: await wrapFor(dev.pub, k.raw) } } });
        await refresh();
      }
      const rot = t.closest('[data-sync-rotate]');
      if (rot) {
        const f = st.folders.find(x => x.id === rot.dataset.syncRotate);
        const raw = rnd(32), wraps = {}, userWraps = {};
        for (const d of f.devices || []) wraps[d.id] = { by: d.uid, blob: await wrapFor(d.pub, raw) };
        for (const m of f.members || []) userWraps[m.id] = await wrapFor(m.pub, raw);
        await api('/api/sync/folders/' + f.id + '/rotate', { method: 'POST', body: { wraps, userWraps } });
        st.keys.clear(); await refresh();
      }
      const sh = t.closest('[data-sync-share]');
      if (sh) {
        const f = st.folders.find(x => x.id === sh.dataset.syncShare);
        const k = await folderKey(f);
        modal('Поделиться папкой', `<select id="sync-share-uid">${userOptions()}</select> <select id="sync-share-perm"><option value="read">Только чтение</option><option value="write">Изменение</option></select> <button class="mini" id="sync-share-send" data-f="${h(f.id)}">Отправить приглашение</button>`);
        document.getElementById('sync-share-send').addEventListener('click', async () => {
          const uid = document.getElementById('sync-share-uid').value;
          const u = userById(uid); if (!u) return;
          const perm = document.getElementById('sync-share-perm').value;
          await api('/api/sync/folders/' + f.id + '/share', { method: 'POST', body: { uid, perm, userWrap: await wrapFor(u.pub, k.raw) } });
          await refresh();
        });
      }
      const acc = t.closest('[data-sync-accept]');
      if (acc) {
        const s = st.shares.incoming.find(x => x.id === acc.dataset.syncAccept);
        const did = document.getElementById('sync-accept-dev-' + s.id).value;
        const dev = st.devices.find(d => d.id === did); if (!dev) return toast('Выберите компьютер', true);
        const raw = await unwrapFrom(s.ownerPub, s.userWrap);
        await api('/api/sync/shares/accept', { method: 'POST', body: { shareId: s.id, deviceId: did, wrap: { by: S.me.id, blob: await wrapFor(dev.pub, raw) } } });
        await refresh();
      }
      const dec2 = t.closest('[data-sync-decline]');
      if (dec2) { await api('/api/sync/shares/decline', { method: 'POST', body: { shareId: dec2.dataset.syncDecline } }); await refresh(); }
      const un = t.closest('[data-sync-unshare]');
      if (un && confirm('Отозвать доступ участника? Ключ папки будет обновлён.')) { await api('/api/sync/folders/' + un.dataset.syncUnshare + '/unshare', { method: 'POST', body: { uid: un.dataset.uid } }); await refresh(); }
      const rev = t.closest('[data-sync-revoke]');
      if (rev && confirm('Отозвать компьютер? Он потеряет доступ к папкам.')) { await api('/api/sync/devices/revoke', { method: 'POST', body: { id: rev.dataset.syncRevoke } }); await refresh(); }
      const del = t.closest('[data-sync-delete]');
      if (del && confirm('Убрать папку из синхронизации? Файлы на компьютерах останутся.')) { await api('/api/sync/folders/' + del.dataset.syncDelete + '/delete', { method: 'POST', body: {} }); await refresh(); }
      const rs = t.closest('[data-sync-resync]');
      if (rs) {
        const f = st.folders.find(x => (x.devices || []).some(d => d.id === rs.dataset.syncResync));
        if (!f) return toast('Сначала создайте папку для этого компьютера', true);
        await api('/api/sync/devices/command', { method: 'POST', body: { id: rs.dataset.syncResync, command: { t: 'resync', folderId: f.id } } });
        toast('Команда отправлена');
      }
      const ap = t.closest('[data-sync-approve]');
      if (ap && confirm('Подтверждаете удаление этого файла? Служебная копия сохранится на компьютере.')) {
        await api('/api/sync/devices/command', { method: 'POST', body: { id: ap.dataset.dev, command: { t: 'approve', folderId: ap.dataset.syncApprove, pendingId: ap.dataset.pending } } });
        toast('Подтверждение отправлено');
      }
      const um = t.closest('[data-sync-unmount]');
      if (um) { await api('/api/sync/folders/' + um.dataset.syncUnmount + '/unmount', { method: 'POST', body: { mountId: um.dataset.mount } }); await refresh(); }
      const cl = t.closest('[data-sync-cloud]');
      if (cl) return cloudPicker(cl.dataset.syncCloud);
    } catch (err) { toast(err.message || String(err), true); }
  });
  async function cloudPicker(fid, drive, p) {
    const ds = drivesState();
    if (!ds.loaded) await drivesLoad();
    const list = (drivesState().list || []).filter(d => d.connected);
    if (!list.length) return toast('Сначала подключите диск в «Моих дисках»', true);
    drive = drive || list[0].id;
    const root = dkRoot(drive);
    p = p || root;
    let r;
    try { r = await api('/api/yadisk/list?path=' + encodeURIComponent(p) + '&limit=200'); } catch (e) { return toast(e.message, true); }
    const dirs = (r.items || []).filter(x => x.dir);
    modal('Подключить папку диска', `
      <select id="sync-cloud-drive">${list.map(d => `<option value="${h(d.id)}" ${d.id === drive ? 'selected' : ''}>${h(d.title)}</option>`).join('')}</select>
      <div class="hint">${h(p)}</div>
      <div class="sync-cloud-list">${p !== root ? `<button class="mini" data-sync-cloud-up="${h(fid)}" data-drive="${h(drive)}" data-p="${h(dkParent(p))}">↑ Назад</button>` : ''}
      ${dirs.map(d => `<button class="mini" data-sync-cloud-dir="${h(fid)}" data-drive="${h(drive)}" data-p="${h(d.path)}">📁 ${h(d.name)}</button>`).join(' ')}</div>
      <button class="mini" id="sync-cloud-mount" data-f="${h(fid)}" data-drive="${h(drive)}" data-p="${h(p)}" ${p === root ? 'disabled' : ''}>Синхронизировать эту папку</button>`);
    document.getElementById('sync-cloud-drive').addEventListener('change', ev => cloudPicker(fid, ev.target.value));
    document.getElementById('sync-cloud-mount').addEventListener('click', async ev => {
      const b = ev.currentTarget;
      try {
        await api('/api/sync/folders/' + fid + '/mounts', { method: 'POST', body: { kind: drvKindOf(b.dataset.drive), slot: drvSlotOf(b.dataset.drive), path: b.dataset.p, perm: 'write' } });
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
  }
  document.addEventListener('click', e => {
    const d = e.target.closest('[data-sync-cloud-dir]');
    if (d) cloudPicker(d.dataset.syncCloudDir, d.dataset.drive, d.dataset.p);
    const u = e.target.closest('[data-sync-cloud-up]');
    if (u) cloudPicker(u.dataset.syncCloudUp, u.dataset.drive, u.dataset.p);
  });
  window.openFolderSync = openFolderSync;
})();
