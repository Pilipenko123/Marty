/**
 * Marty: server for the online room mode of "Back to the Future: Time Warp".
 * Zero-dependency Node.js server:
 *   1. Static file serving (index.html, assets/*)
 *   2. WebSocket relay at /ws — rooms of up to 4 players.
 * The first player in the room is the "host": their browser runs the game
 * engine and broadcasts state to everyone else. The server only relays
 * messages, tracks membership, keeps the last snapshot of state and
 * promotes a guest to host when the host leaves.
 *
 * Run:  node server.js   (PORT and HOST can be set via environment variables)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROOM_CODES = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
const MAX_FRAME = 1024 * 1024;

/* ============================== Static files ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ============================== WebSocket (RFC 6455) ============================== */

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/** Minimal frame parser; returns {fin, opcode, payload, rest} or an error. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (len > MAX_FRAME) return { error: 'frame-too-large' };
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, rest: buf.slice(offset + len) };
}

/* ============================== Rooms ============================== */

const rooms = new Map();   // code -> { code, hostId, players: Map<clientId, {ws, name, joinedAt}>, snapshot }
const wsClient = new Map(); // ws -> { id, roomCode, name }

function randomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODES[Math.floor(Math.random() * ROOM_CODES.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.writable && !ws.destroyed) {
    try { ws.write(encodeFrame(JSON.stringify(obj))); } catch (_) { /* closed */ }
  }
}

function roomBroadcast(code, obj, exceptWs = null) {
  const room = rooms.get(code);
  if (!room) return;
  for (const client of room.players.values()) {
    if (client.ws !== exceptWs) send(client.ws, obj);
  }
}

function handleJoin(ws, msg) {
  const { room, name, mode } = msg;
  const cleanName = String(name || 'Player').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
  if (mode === 'host') {
    let code = null;
    if (room && /^[A-Z2-9]{4}$/.test(room) && !rooms.has(room)) code = room;
    if (!code) code = randomCode();
    if (!code) { send(ws, { t: 'error', reason: 'no-code' }); return; }
    const client = { ws, id: crypto.randomUUID(), name: cleanName, joinedAt: Date.now() };
    rooms.set(code, { code, hostId: client.id, players: new Map([[client.id, client]]), snapshot: null });
    wsClient.set(ws, { id: client.id, roomCode: code, name: cleanName });
    send(ws, { t: 'ok', room: code, role: 'host', clientId: client.id });
    return;
  }
  // guest join
  const code = String(room || '').toUpperCase();
  const roomObj = rooms.get(code);
  if (!roomObj) { send(ws, { t: 'error', reason: 'not-found' }); return; }
  if (roomObj.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', reason: 'full' }); return; }
  const client = { ws, id: crypto.randomUUID(), name: cleanName, joinedAt: Date.now() };
  roomObj.players.set(client.id, client);
  wsClient.set(ws, { id: client.id, roomCode: code, name: cleanName });
  send(ws, { t: 'ok', room: code, role: 'guest', clientId: client.id, snapshot: roomObj.snapshot || undefined });
  // Tell the host and existing players who appeared (so the host can build the roster).
  roomBroadcast(code, { t: 'player-joined', clientId: client.id, name: cleanName });
}

function handleRelay(ws, msg) {
  const info = wsClient.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  if (!room) return;
  const payload = msg.payload;
  if (typeof payload !== 'object' || payload === null) return;
  const from = room.hostId === info.id ? 'host' : 'guest';
  if (from === 'host') {
    if (payload.t === 'sync') room.snapshot = payload; // remember the last clean snapshot
    const to = msg.to;
    if (to === 'all') {
      for (const client of room.players.values()) {
        if (client.ws !== ws) send(client.ws, { t: 'relay', from: 'host', fromId: info.id, payload });
      }
    } else if (typeof to === 'string' && to.startsWith('client:')) {
      const target = room.players.get(to.slice(7));
      if (target) send(target.ws, { t: 'relay', from: 'host', fromId: info.id, payload });
    }
  } else {
    // Guests can only talk to the host.
    const hostClient = room.players.get(room.hostId);
    if (hostClient && hostClient.ws !== ws) {
      send(hostClient.ws, { t: 'relay', from: 'guest', fromId: info.id, payload });
    }
  }
}

function handleClientClose(ws) {
  const info = wsClient.get(ws);
  wsClient.delete(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  if (!room) return;
  room.players.delete(info.id);
  if (info.id === room.hostId) {
    // Host left: if players remain, promote the oldest to host.
    const remaining = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    if (remaining.length > 0) {
      const promoted = remaining[0];
      room.hostId = promoted.id;
      send(promoted.ws, {
        t: 'host-promoted',
        snapshot: room.snapshot,
        roster: remaining.map(c => ({ clientId: c.id, name: c.name }))
      });
      for (const other of remaining) {
        if (other.ws !== promoted.ws) send(other.ws, { t: 'host-lost', newHostId: promoted.id });
      }
    }
    if (room.players.size === 0) rooms.delete(room.code);
    return;
  }
  // Regular player left.
  roomBroadcast(info.roomCode, { t: 'player-left', clientId: info.id });
  if (room.players.size === 0) rooms.delete(room.code);
}

/* ============================== Server ============================== */

const server = http.createServer((req, res) => {
  if (req.headers.upgrade) return; // handled in the 'upgrade' event
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  let fragments = [];

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = frame.rest;
      if (frame.error) { socket.destroy(); return; }
      if (frame.opcode === 0x8) { // close
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) { // ping -> pong
        try { socket.write(encodeFrame(frame.payload, 0xA)); } catch (_) { /* noop */ }
        continue;
      }
      if (frame.opcode === 0xA) continue; // pong
      if (frame.opcode === 0x0) { // continuation
        fragments.push(frame.payload);
        if (frame.fin) {
          const text = Buffer.concat(fragments).toString('utf-8');
          fragments = [];
          onWsMessage(socket, text);
        }
        continue;
      }
      if (frame.fin) {
        if (frame.opcode === 0x1) onWsMessage(socket, frame.payload.toString('utf-8'));
      } else {
        if (frame.opcode === 0x1) fragments = [frame.payload];
      }
    }
  });

  socket.on('close', () => handleClientClose(socket));
  socket.on('error', () => handleClientClose(socket));
});

function onWsMessage(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') handleJoin(ws, msg);
  else if (msg.t === 'relay') handleRelay(ws, msg);
}

// Keepalive: ping every 30 seconds.
setInterval(() => {
  for (const { ws } of wsClient.values()) {
    if (ws && ws.writable && !ws.destroyed) {
      try { ws.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch (_) { /* noop */ }
    }
  }
}, 30000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Marty online server: http://${HOST}:${PORT} (ws: /ws)`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  LAN:  http://${n.address}:${PORT}`);
    }
  }
});
