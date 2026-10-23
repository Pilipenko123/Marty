'use strict';
/**
 * SEGA-CHAT · pkg3-80: звук игр, синтезированный кодом (Web Audio) — как на
 * консолях Sega: никаких файлов и семплов, только формулы (осцилляторы +
 * огибающие). Звук СПОКОЙНЫЙ: мягкая атака, низкая громкость, синус и
 * треугольник, никаких резких «аркадных» пил.
 *
 *  - GS.play(name)             — сигналы событий из таблицы SFX (ход, монета, попадание…)
 *  - GS.startMusic(mapIdx)     — фоновая мелодия карты: у всех шести карт своя,
 *                                рождается из зерна (одинакова на всех устройствах)
 *  - GS.stopMusic()            — остановить музыку
 *  - GS.musicPref()/setMusicPref(on)/toggleMusicPref() — кнопка «выключить музыку»
 *  - GS.setEnabled(on)         — главный тумблер (настройка «Звук в играх»)
 *  - GS.ensure()               — создать/разбудить аудиоконтекст (после касания)
 *  - GS.letterSound(p, mine)   — письмо игры (ход/выстрел/…) → имя сигнала;
 *                                чистая функция — проверяется тестами без браузера
 *  - GS.melodyFor(mapIdx)      — мелодия карты: чистая функция (ноты из зерна)
 *
 * В Node (тесты) модуль подключается как обычно: чистые функции работают,
 * а звуковая часть тихо не делает ничего — AudioContext там нет.
 */
(function (glob) {
  const hasWin = !!(glob && glob.document);
  const AC = (glob && (glob.AudioContext || glob.webkitAudioContext)) || null;

  /** fnv1a: строка → 32 бита (тот же хеш, что в движке забега). */
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  /** mulberry32: детерминированный генератор — мелодия из зерна всегда одна. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─────────────────────── таблица спокойных сигналов ───────────────────────
  /** Каждый сигнал — набор голосов: type (sine/triangle), f0→f1 (плавный съезд
   * частоты), t0 (задержка, с), dur (длительность, с), vol (громкость ≤ 0.12). */
  const SFX = {
    // золотая лихорадка
    step:       [{ type: 'triangle', f0: 520, f1: 470, t0: 0,    dur: 0.045, vol: 0.05 }],
    coin:       [{ type: 'sine',     f0: 988, f1: 988, t0: 0,    dur: 0.16,  vol: 0.10 },
                 { type: 'sine',     f0: 1319, f1: 1319, t0: 0.05, dur: 0.14, vol: 0.05 }],
    lantern:    [{ type: 'sine',     f0: 587, f1: 622, t0: 0,    dur: 0.50,  vol: 0.06 },
                 { type: 'sine',     f0: 590, f1: 620, t0: 0.02, dur: 0.50,  vol: 0.05 }],
    compass:    [{ type: 'triangle', f0: 784, f1: 784, t0: 0,    dur: 0.09,  vol: 0.08 },
                 { type: 'triangle', f0: 1047, f1: 1047, t0: 0.08, dur: 0.12, vol: 0.08 }],
    hourglass:  [{ type: 'sine',     f0: 392, f1: 523, t0: 0,    dur: 0.22,  vol: 0.09 },
                 { type: 'triangle', f0: 1319, f1: 1319, t0: 0.18, dur: 0.05, vol: 0.04 }],
    wall:       [{ type: 'sine',     f0: 98,  f1: 72,  t0: 0,    dur: 0.08,  vol: 0.10 }],
    warn:       [{ type: 'sine',     f0: 660, f1: 660, t0: 0,    dur: 0.09,  vol: 0.07 },
                 { type: 'sine',     f0: 660, f1: 660, t0: 0.16, dur: 0.09,  vol: 0.07 }],
    roundstart: [{ type: 'triangle', f0: 523, f1: 523, t0: 0,    dur: 0.14,  vol: 0.08 },
                 { type: 'triangle', f0: 659, f1: 659, t0: 0.12, dur: 0.14,  vol: 0.08 },
                 { type: 'triangle', f0: 784, f1: 784, t0: 0.24, dur: 0.24,  vol: 0.08 }],
    roundend:   [{ type: 'triangle', f0: 784, f1: 784, t0: 0,    dur: 0.14,  vol: 0.08 },
                 { type: 'triangle', f0: 659, f1: 659, t0: 0.12, dur: 0.14,  vol: 0.08 },
                 { type: 'triangle', f0: 523, f1: 523, t0: 0.24, dur: 0.28,  vol: 0.08 }],
    victory:    [{ type: 'triangle', f0: 523, f1: 523, t0: 0,    dur: 0.16,  vol: 0.09 },
                 { type: 'triangle', f0: 659, f1: 659, t0: 0.14, dur: 0.16,  vol: 0.09 },
                 { type: 'triangle', f0: 784, f1: 784, t0: 0.28, dur: 0.16,  vol: 0.09 },
                 { type: 'sine',     f0: 1047, f1: 1047, t0: 0.42, dur: 0.42, vol: 0.09 }],
    // шахматы и шашки
    move:       [{ type: 'triangle', f0: 440, f1: 392, t0: 0,    dur: 0.09,  vol: 0.09 }],
    capture:    [{ type: 'triangle', f0: 330, f1: 247, t0: 0,    dur: 0.16,  vol: 0.10 }],
    check:      [{ type: 'sine',     f0: 587, f1: 587, t0: 0,    dur: 0.10,  vol: 0.08 },
                 { type: 'sine',     f0: 740, f1: 740, t0: 0.09, dur: 0.14,  vol: 0.08 }],
    mate:       [{ type: 'triangle', f0: 659, f1: 659, t0: 0,    dur: 0.13,  vol: 0.09 },
                 { type: 'triangle', f0: 523, f1: 523, t0: 0.12, dur: 0.13,  vol: 0.09 },
                 { type: 'triangle', f0: 392, f1: 392, t0: 0.24, dur: 0.30,  vol: 0.09 }],
    win:        [{ type: 'triangle', f0: 523, f1: 523, t0: 0,    dur: 0.14,  vol: 0.09 },
                 { type: 'triangle', f0: 659, f1: 659, t0: 0.13, dur: 0.14,  vol: 0.09 },
                 { type: 'triangle', f0: 784, f1: 784, t0: 0.26, dur: 0.30,  vol: 0.09 }],
    lose:       [{ type: 'triangle', f0: 392, f1: 392, t0: 0,    dur: 0.16,  vol: 0.08 },
                 { type: 'triangle', f0: 330, f1: 330, t0: 0.15, dur: 0.16,  vol: 0.08 },
                 { type: 'triangle', f0: 262, f1: 262, t0: 0.30, dur: 0.34,  vol: 0.08 }],
    draw:       [{ type: 'sine',     f0: 440, f1: 440, t0: 0,    dur: 0.14,  vol: 0.07 },
                 { type: 'sine',     f0: 440, f1: 440, t0: 0.16, dur: 0.20,  vol: 0.07 }],
    // морской бой
    shot:       [{ type: 'sine',     f0: 220, f1: 110, t0: 0,    dur: 0.10,  vol: 0.10 }],
    incoming:   [{ type: 'sine',     f0: 185, f1: 92,  t0: 0,    dur: 0.11,  vol: 0.08 }],
    miss:       [{ type: 'sine',     f0: 147, f1: 139, t0: 0,    dur: 0.13,  vol: 0.07 }],
    hit:        [{ type: 'triangle', f0: 330, f1: 330, t0: 0,    dur: 0.09,  vol: 0.09 },
                 { type: 'triangle', f0: 440, f1: 415, t0: 0.08, dur: 0.14,  vol: 0.09 }],
    sunk:       [{ type: 'triangle', f0: 440, f1: 110, t0: 0,    dur: 0.45,  vol: 0.10 }],
    seal:       [{ type: 'triangle', f0: 523, f1: 523, t0: 0,    dur: 0.07,  vol: 0.07 },
                 { type: 'triangle', f0: 392, f1: 392, t0: 0.07, dur: 0.12,  vol: 0.07 }],
    reveal:     [{ type: 'sine',     f0: 659, f1: 659, t0: 0,    dur: 0.12,  vol: 0.07 },
                 { type: 'sine',     f0: 784, f1: 784, t0: 0.10, dur: 0.12,  vol: 0.07 },
                 { type: 'sine',     f0: 988, f1: 988, t0: 0.20, dur: 0.22,  vol: 0.07 }],
    // общие
    start:      [{ type: 'triangle', f0: 392, f1: 392, t0: 0,    dur: 0.13,  vol: 0.08 },
                 { type: 'triangle', f0: 523, f1: 523, t0: 0.12, dur: 0.13,  vol: 0.08 },
                 { type: 'triangle', f0: 659, f1: 659, t0: 0.24, dur: 0.26,  vol: 0.08 }],
    invite:     [{ type: 'sine',     f0: 659, f1: 659, t0: 0,    dur: 0.11,  vol: 0.08 },
                 { type: 'sine',     f0: 880, f1: 880, t0: 0.10, dur: 0.18,  vol: 0.08 }],
    event:      [{ type: 'sine',     f0: 523, f1: 494, t0: 0,    dur: 0.14,  vol: 0.07 }],
    end:        [{ type: 'triangle', f0: 523, f1: 523, t0: 0,    dur: 0.14,  vol: 0.08 },
                 { type: 'triangle', f0: 392, f1: 392, t0: 0.14, dur: 0.30,  vol: 0.08 }]
  };

  /** Письмо игры → имя сигнала. Чистая функция: её проверяют тесты. */
  function letterSound(p, mine) {
    if (!p || typeof p.k !== 'string') return null;
    if (p.k === 'move') {
      const san = String(p.san || '');
      if (san.indexOf('#') >= 0) return 'mate';
      if (san.indexOf('+') >= 0) return 'check';
      if (san.indexOf('x') >= 0 || san.indexOf(':') >= 0) return 'capture';
      return 'move';
    }
    if (p.k === 'sb-shot') return mine ? 'shot' : 'incoming';
    if (p.k === 'sb-reply') return p.r === 'sunk' ? 'sunk' : p.r === 'hit' ? 'hit' : 'miss';
    if (p.k === 'sb-commit') return 'seal';
    if (p.k === 'sb-reveal') return 'reveal';
    if (p.k === 'game-invite') return 'invite';
    if (p.k === 'game-event') {
      const t = String(p.text || '');
      if (/начал/i.test(t)) return 'start';
      if (/побед|мат\b|заверш/i.test(t)) return 'end';
      return 'event';
    }
    if (p.k === 'coins-result') return 'roundend';
    if (p.k === 'coins-record') return 'victory';
    if (p.k === 'coins-surrender') return 'event';
    return null;
  }

  // ─────────────────────── мелодии карт (фон забега) ───────────────────────
  /** Тринадцать корней (pkg3-85: у каждой из 13 карт своя тональность):
   * A3, G3, F3, B3, E3, G#3 + Bb3, C4, F#3, C#4, D4, Eb4, E4. */
  const ROOTS = [220.00, 196.00, 174.61, 246.94, 164.81, 207.65,
    233.08, 261.63, 185.00, 277.18, 293.66, 311.13, 329.63];
  /** Минорная пентатоника — спокойный лад: фальшивых нот не бывает в принципе. */
  const PENT = [0, 3, 5, 7, 10];
  /**
   * Мелодия карты: 32 доли (8 тактов 4/4), темп 60–78 (не чаще сердцебиения),
   * ноты и паузы — из зерна карты, поэтому на всех устройствах звучит одно и то
   * же. Возвращает чистые данные { map, root, bpm, beats, notes, bass }.
   */
  function melodyFor(mapIdx) {
    const i = ((Math.floor(Number(mapIdx) || 0) % ROOTS.length) + ROOTS.length) % ROOTS.length;
    const r = rng(fnv('sega80:music:' + i));
    const root = ROOTS[i];
    const bpm = 60 + Math.floor(r() * 4) * 6;             // 60, 66, 72 или 78
    const beats = 32;
    const notes = [];
    let b = 0;
    while (b < beats) {
      const d = [1, 1, 2, 2, 4][Math.floor(r() * 5)];
      const rest = r() < 0.15;                            // паузы — музыка дышит (pkg3-82: реже — мелодия слышнее)
      const len = Math.min(d, beats - b);
      if (!rest && len > 0) {
        const n = PENT[Math.floor(r() * PENT.length)] + (r() < 0.3 ? 12 : 0);
        notes.push({ b: b, n: n, d: len });
      }
      b += d;
    }
    const bass = [];
    for (let x = 0; x < beats; x += 4) bass.push({ b: x, n: (x % 8 === 4 ? 7 : 0), d: 3.4 });
    return { map: i, root: root, bpm: bpm, beats: beats, notes: notes, bass: bass };
  }
  /** Частота ноты: root · 2^(n/12); low — октавой ниже (бас). */
  const noteHz = (m, n, low) => m.root * Math.pow(2, (n || 0) / 12) * (low ? 0.5 : 1);

  // ─────────────────────── звуковая часть (только браузер) ───────────────────────
  let ctx = null;
  let enabled = true;
  const lastAt = {};
  let recent = [];
  const MUSIC_KEY = 'sega.coinsMusic80';

  function ensure() {
    if (!AC) return null;
    try {
      // pkg3-81 (пункт 4): телефонный браузер после сна иногда вовсе закрывает
      // аудиоконтекст — тогда заводим новый; «приснувший» или «прерванный»
      // (iOS после блокировки экрана) — будим
      if (ctx && ctx.state === 'closed') ctx = null;
      if (!ctx) {
        ctx = new AC();
        // pkg3-82 (правка 6): iOS отпирает звук только жестом и неохотно —
        // проигрываем бесшумный буфер сразу при создании контекста (ensure
        // зовётся из-под касания/клика), иначе мелодия карты может не зазвучать
        try {
          const ub = ctx.createBuffer(1, 1, 22050);
          const us = ctx.createBufferSource();
          us.buffer = ub; us.connect(ctx.destination); us.start(0);
        } catch (e) {}
      }
      if (ctx.state !== 'running') { const rp = ctx.resume(); if (rp && rp.catch) rp.catch(() => {}); }
      return ctx;
    } catch (e) { return null; }
  }
  /** Один голос сигнала: мягкая атака 30 мс, экспоненциальное затухание. */
  function voice(c, v, t0) {
    const osc = c.createOscillator();
    osc.type = v.type || 'sine';
    osc.frequency.setValueAtTime(v.f0, t0);
    if (v.f1 && v.f1 !== v.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.f1), t0 + v.dur);
    const g = c.createGain();
    const vol = Math.max(0.0001, v.vol == null ? 0.08 : v.vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.03, v.dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0 + v.dur + 0.02);
    setTimeout(() => { try { g.disconnect(); } catch (e) {} }, (v.dur + 0.15) * 1000);
  }
  /** Спокойный сигнал события. Защита от «пулемёта»: одно имя не чаще 60 мс,
   * всего не больше 12 сигналов в секунду. */
  function play(name) {
    if (!enabled || !SFX[name]) return;
    const now = Date.now();
    if (lastAt[name] && now - lastAt[name] < 60) return;
    recent = recent.filter(t => now - t < 1000);
    if (recent.length >= 12) return;
    lastAt[name] = now; recent.push(now);
    const c = ensure(); if (!c) return;
    try {
      const t0 = c.currentTime + 0.001;
      for (const v of SFX[name]) voice(c, v, t0 + (v.t0 || 0));
    } catch (e) { /* звук не должен ломать игру */ }
  }

  // ── фоновая музыка: один заранее отпланированный цикл на ~13–32 с, насос
  //    допланировывает следующий; «выключить музыку» гасит и запланированное.
  let music = null;   // { map, melody, timer, nextAt, nodes: [{osc,g,end}] }
  function tone(c, type, hz, t0, dur, vol) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, hz), t0);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + Math.min(0.09, dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
    const nd = { osc: osc, g: g, end: t0 + dur + 0.05 };
    setTimeout(() => { try { g.disconnect(); } catch (e) {} }, (dur + 0.3) * 1000);
    return nd;
  }
  function pump() {
    const m = music;
    if (!m || !ctx) return;
    // pkg3-82 (правка 6): контекст могли закрыть (сон телефона) — музыка
    // переставится на новый при следующем wake/касании (music.ctx !== ctx)
    if (ctx.state === 'closed') { ctx = null; return; }
    if (ctx.state !== 'running') {
      // pkg3-82 (правка 6): не просто ждём — пробуем разбудить контекст сами;
      // после сна телефона resume() иногда срабатывает не с первой попытки
      try { const rp = ctx.resume(); if (rp && rp.catch) rp.catch(() => {}); } catch (e) {}
      m.timer = setTimeout(pump, 500);
      return;
    }
    // pkg3-82 (правка 6): якорь «в прошлом» (контекст спал) не выстреливает
    // очередью нот — продолжаем с текущего такта
    if (!(m.nextAt > ctx.currentTime)) m.nextAt = ctx.currentTime + 0.05;
    const spb = 60 / m.melody.bpm;
    const loopDur = m.melody.beats * spb;
    while (m.nextAt < ctx.currentTime + 1.2) {
      const at = m.nextAt;
      for (const n of m.melody.notes) {
        m.nodes.push(tone(ctx, 'triangle', noteHz(m.melody, n.n, false), at + n.b * spb, n.d * spb * 0.9, 0.085));
      }
      for (const n of m.melody.bass) {
        m.nodes.push(tone(ctx, 'sine', noteHz(m.melody, n.n, true), at + n.b * spb, n.d * spb * 0.85, 0.09));
      }
      m.nextAt += loopDur;
    }
    m.nodes = m.nodes.filter(nd => nd.end > ctx.currentTime);   // отзвучавшие — из списка
    m.timer = setTimeout(pump, 400);
  }
  function startMusic(mapIdx) {
    if (!enabled || !musicPref()) { stopMusic(); return false; }
    const c = ensure(); if (!c) return false;
    const i = ((Math.floor(Number(mapIdx) || 0) % ROOTS.length) + ROOTS.length) % ROOTS.length;
    if (music && music.map === i && music.ctx === c) return true;   // уже звучит эта карта
    stopMusic();
    music = { map: i, ctx: c, melody: melodyFor(i), timer: 0, nextAt: c.currentTime + 0.08, nodes: [] };
    try { pump(); } catch (e) { stopMusic(); return false; }
    return true;
  }
  function stopMusic() {
    if (!music) return;
    const m = music; music = null;
    if (m.timer) clearTimeout(m.timer);
    if (ctx) {
      const now = ctx.currentTime;
      for (const nd of m.nodes) {
        try {
          nd.g.gain.cancelScheduledValues(now);
          nd.g.gain.setValueAtTime(Math.max(0.0001, nd.g.gain.value), now);
          nd.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
          nd.osc.stop(now + 0.1);
        } catch (e) {}
      }
    }
    m.nodes = [];
  }
  function musicPref() {
    try { return glob.localStorage.getItem(MUSIC_KEY) !== '0'; } catch (e) { return true; }
  }
  function setMusicPref(on) {
    try { glob.localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch (e) {}
  }
  function toggleMusicPref() {
    const v = !musicPref();
    setMusicPref(v);
    return v;
  }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) stopMusic();
  }
  /** pkg3-81 (пункт 4): разбудить звук после сна телефона / возврата на вкладку.
   * Контекст мог быть закрыт системой — тогда музыка перепривязывается к новому;
   * запланированное «в прошлом» не выстреливает очередью, а продолжается с такта. */
  function wake() {
    if (!AC || !enabled) return;
    try {
      const c = ensure();
      if (!c) return;
      if (music) {
        if (music.ctx !== c) { music.nodes = []; music.ctx = c; }
        if (!(music.nextAt > c.currentTime)) music.nextAt = c.currentTime + 0.05;
        if (music.timer) clearTimeout(music.timer);
        music.timer = setTimeout(pump, 60);
      }
    } catch (e) {}
  }
  // вкладка спрятана — контекст засыпает (музыка ставится на паузу), вернулись — просыпается
  if (hasWin) {
    try {
      glob.document.addEventListener('visibilitychange', () => {
        try {
          if (glob.document.hidden) {
            if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
          } else wake();
        } catch (e) {}
      });
      // pkg3-81 (пункт 4): телефон вернулся из спящего режима — будим звук всеми
      // способами: страница показана, окно в фокусе, первое же касание/клавиша
      // (iOS отпускает аудиоконтекст только человеку под жест)
      glob.addEventListener('pageshow', wake);
      glob.addEventListener('focus', wake);
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        glob.document.addEventListener(ev, wake, { capture: true, passive: true });
      }
    } catch (e) {}
  }

  const GS = {
    version: 'pkg3-85',
    SFX: SFX,
    ROOTS: ROOTS,
    PENT: PENT,
    fnv: fnv,
    rng: rng,
    melodyFor: melodyFor,
    noteHz: noteHz,
    letterSound: letterSound,
    ensure: ensure,
    wake: wake,
    play: play,
    startMusic: startMusic,
    stopMusic: stopMusic,
    musicPref: musicPref,
    setMusicPref: setMusicPref,
    toggleMusicPref: toggleMusicPref,
    setEnabled: setEnabled,
    isEnabled: () => enabled,
    isPlaying: () => !!music
  };
  if (glob) glob.GS = GS;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GS;
  }
})(typeof window !== 'undefined' ? window : globalThis);
