// Production Comms server: static files + WebSocket messaging + push-to-talk audio relay.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const PASSCODE = process.env.SHOW_PASSCODE || '';
const SHOW_NAME = process.env.SHOW_NAME || 'Production Comms';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const CERT_DIR = path.join(__dirname, 'certs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MSGS_PER_CHANNEL = 300;

const DEPARTMENTS = [
  { id: 'sm', name: 'Stage Management' },
  { id: 'dir', name: 'Director / AD' },
  { id: 'prod', name: 'Production' },
  { id: 'lx', name: 'Lighting' },
  { id: 'snd', name: 'Sound / Audio' },
  { id: 'vid', name: 'Video / Graphics' },
  { id: 'cam', name: 'Camera' },
  { id: 'talent', name: 'Talent / Cast' },
  { id: 'crew', name: 'Stage Crew / Rigging' },
  { id: 'ward', name: 'Wardrobe / Hair / MU' },
  { id: 'foh', name: 'Front of House' },
  { id: 'other', name: 'Other' },
];

const DEFAULT_CHANNELS = [
  { id: 'all', name: 'All Call', locked: true },
  ...DEPARTMENTS.filter((d) => d.id !== 'other').map((d) => ({ id: d.id, name: d.name })),
];

const DEFAULT_PRESETS = [
  { label: 'Standby', color: 'amber' },
  { label: 'GO', color: 'green' },
  { label: 'Hold', color: 'red', urgent: true },
  { label: 'Places', color: 'blue' },
  { label: 'Clear', color: 'green' },
  { label: 'Copy', color: 'gray', noAck: true },
  { label: 'Say again?', color: 'gray', noAck: true },
  { label: 'Rolling', color: 'red' },
  { label: 'Cut', color: 'red' },
  { label: 'Reset', color: 'amber' },
  { label: 'Mic check', color: 'blue' },
  { label: 'On break', color: 'gray', noAck: true },
  { label: 'Back', color: 'gray', noAck: true },
  { label: 'Need help', color: 'red', urgent: true },
  { label: 'EMERGENCY STOP', color: 'red', urgent: true, wide: true },
].map((p) => ({ id: rid(), ...p }));

function rid(n = 8) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

// ---------- state ----------
let db = { users: {}, clientMap: {}, channels: DEFAULT_CHANNELS, presets: DEFAULT_PRESETS, messages: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (e) {
  console.error('Could not read data file, starting fresh:', e.message);
}
for (const u of Object.values(db.users)) { u.online = false; u.talking = null; }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 1500);
}

const sockets = new Map(); // userId -> Set<ws>

const dmKey = (a, b) => 'dm:' + [a, b].sort().join(':');
const isDm = (ch) => ch.startsWith('dm:');

function canSee(user, ch) {
  if (!user) return false;
  if (ch === 'all') return true;
  if (isDm(ch)) return ch.split(':').includes(user.id);
  return user.channels.includes(ch);
}

function publicUser(u) {
  return { id: u.id, name: u.name, dept: u.dept, status: u.status, online: u.online, talking: u.talking, channels: u.channels };
}

function sendTo(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendUser(userId, obj) {
  for (const ws of sockets.get(userId) || []) sendTo(ws, obj);
}
function broadcast(obj, filter = () => true) {
  const data = JSON.stringify(obj);
  for (const [uid, set] of sockets) {
    if (!filter(db.users[uid])) continue;
    for (const ws of set) if (ws.readyState === 1) ws.send(data);
  }
}
const broadcastUsers = () => broadcast({ type: 'users', users: Object.values(db.users).map(publicUser) });

function visibleMessages(user) {
  const out = [];
  for (const [ch, list] of Object.entries(db.messages)) if (canSee(user, ch)) out.push(...list.slice(-100));
  return out;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function handler(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const servers = [http.createServer(handler).listen(PORT, '0.0.0.0')];
const keyFile = path.join(CERT_DIR, 'key.pem');
const certFile = path.join(CERT_DIR, 'cert.pem');
const hasCert = fs.existsSync(keyFile) && fs.existsSync(certFile);
if (hasCert) {
  servers.push(https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handler).listen(HTTPS_PORT, '0.0.0.0'));
}

// ---------- WebSocket ----------
for (const server of servers) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('connection', onConnection);
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
}

function onConnection(ws) {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  sendTo(ws, { type: 'config', showName: SHOW_NAME, departments: DEPARTMENTS, needsPasscode: !!PASSCODE });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return relayAudio(ws, data);
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    try { handle(ws, m); } catch (e) { console.error(e); sendTo(ws, { type: 'error', message: 'Server error' }); }
  });

  ws.on('close', () => {
    const u = db.users[ws.userId];
    if (!u) return;
    const set = sockets.get(u.id);
    set?.delete(ws);
    if (ws.talk) stopTalk(ws);
    if (!set || set.size === 0) {
      sockets.delete(u.id);
      u.online = false;
      u.lastSeen = Date.now();
      broadcastUsers();
      save();
    }
  });
}

function handle(ws, m) {
  if (m.type === 'hello') return hello(ws, m);
  const user = db.users[ws.userId];
  if (!user) return sendTo(ws, { type: 'error', message: 'Not signed in' });

  switch (m.type) {
    case 'status': {
      user.status = String(m.status || 'Ready').slice(0, 24);
      broadcastUsers(); save();
      break;
    }
    case 'profile': {
      if (m.name) user.name = String(m.name).trim().slice(0, 40);
      if (m.dept && DEPARTMENTS.some((d) => d.id === m.dept)) user.dept = m.dept;
      broadcastUsers(); save();
      break;
    }
    case 'join':
    case 'leave': {
      const ch = db.channels.find((c) => c.id === m.channel);
      if (!ch || ch.id === 'all') return;
      if (m.type === 'join' && !user.channels.includes(ch.id)) {
        user.channels.push(ch.id);
        sendUser(user.id, { type: 'history', channel: ch.id, messages: (db.messages[ch.id] || []).slice(-100) });
      }
      if (m.type === 'leave') user.channels = user.channels.filter((c) => c !== ch.id);
      broadcastUsers(); save();
      break;
    }
    case 'channel-create': {
      const name = String(m.name || '').trim().slice(0, 32);
      if (!name) return;
      const id = 'c-' + rid(6);
      db.channels.push({ id, name, createdBy: user.id });
      user.channels.push(id);
      broadcast({ type: 'channels', channels: db.channels });
      broadcastUsers(); save();
      break;
    }
    case 'channel-delete': {
      const ch = db.channels.find((c) => c.id === m.channel);
      if (!ch || ch.locked || DEFAULT_CHANNELS.some((d) => d.id === ch.id)) return;
      db.channels = db.channels.filter((c) => c.id !== ch.id);
      delete db.messages[ch.id];
      for (const u of Object.values(db.users)) u.channels = u.channels.filter((c) => c !== ch.id);
      broadcast({ type: 'channels', channels: db.channels });
      broadcastUsers(); save();
      break;
    }
    case 'send': return sendMessage(user, m);
    case 'ack': return ackMessage(user, m.msgId);
    case 'preset-add': {
      const label = String(m.label || '').trim().slice(0, 24);
      if (!label) return;
      const color = ['red', 'amber', 'green', 'blue', 'gray'].includes(m.color) ? m.color : 'blue';
      db.presets.push({ id: rid(), label, color, urgent: !!m.urgent, noAck: !!m.noAck });
      broadcast({ type: 'presets', presets: db.presets }); save();
      break;
    }
    case 'preset-remove': {
      db.presets = db.presets.filter((p) => p.id !== m.id);
      broadcast({ type: 'presets', presets: db.presets }); save();
      break;
    }
    case 'ptt-start': {
      let ch = String(m.channel || 'all');
      if (ch.startsWith('user:')) ch = dmKey(user.id, ch.slice(5));
      if (!canSee(user, ch)) return;
      if (ws.talk) stopTalk(ws);
      ws.talk = ch;
      user.talking = ch;
      broadcast({ type: 'talk', userId: user.id, channel: ch, active: true }, (u) => canSee(u, ch));
      broadcastUsers();
      break;
    }
    case 'ptt-stop': if (ws.talk) stopTalk(ws); break;
    case 'clear-channel': {
      if (!canSee(user, m.channel)) return;
      db.messages[m.channel] = [];
      broadcast({ type: 'history', channel: m.channel, messages: [], replace: true }, (u) => canSee(u, m.channel));
      save();
      break;
    }
  }
}

function hello(ws, m) {
  if (PASSCODE && m.passcode !== PASSCODE) return sendTo(ws, { type: 'auth-failed', message: 'Wrong show passcode' });
  const clientId = String(m.clientId || '').slice(0, 64);
  const name = String(m.name || '').trim().slice(0, 40);
  if (!clientId || !name) return sendTo(ws, { type: 'error', message: 'Name required' });
  const dept = DEPARTMENTS.some((d) => d.id === m.dept) ? m.dept : 'other';

  let user = db.users[db.clientMap[clientId]];
  if (!user) {
    const id = rid(8);
    user = { id, name, dept, status: 'Ready', channels: [] };
    if (dept !== 'other' && db.channels.some((c) => c.id === dept)) user.channels.push(dept);
    db.users[id] = user;
    db.clientMap[clientId] = id;
  }
  user.name = name;
  user.dept = dept;
  user.online = true;
  ws.userId = user.id;
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);

  sendTo(ws, {
    type: 'welcome',
    you: user.id,
    users: Object.values(db.users).map(publicUser),
    channels: db.channels,
    presets: db.presets,
    messages: visibleMessages(user),
  });
  broadcastUsers();
  save();
}

function sendMessage(user, m) {
  const text = String(m.text || '').trim().slice(0, 1000);
  if (!text) return;
  let ch = String(m.channel || '');
  if (m.to) {
    if (!db.users[m.to] || m.to === user.id) return;
    ch = dmKey(user.id, m.to);
  }
  if (!canSee(user, ch)) return sendTo1(user, { type: 'error', message: 'You are not in that channel' });

  const kind = m.kind === 'cue' ? 'cue' : 'text';
  const requireAck = !!m.requireAck;
  const expected = requireAck
    ? Object.values(db.users).filter((u) => u.id !== user.id && canSee(u, ch)).map((u) => u.id)
    : [];
  const msg = {
    id: rid(10), channel: ch, from: user.id, fromName: user.name, fromDept: user.dept,
    text, kind, color: m.color || null, urgent: !!m.urgent, requireAck, expected, acks: {}, ts: Date.now(),
  };
  (db.messages[ch] ||= []).push(msg);
  if (db.messages[ch].length > MAX_MSGS_PER_CHANNEL) db.messages[ch].splice(0, db.messages[ch].length - MAX_MSGS_PER_CHANNEL);
  broadcast({ type: 'message', msg }, (u) => canSee(u, ch));
  save();
}
const sendTo1 = (user, obj) => sendUser(user.id, obj);

function ackMessage(user, msgId) {
  for (const [ch, list] of Object.entries(db.messages)) {
    const msg = list.find((x) => x.id === msgId);
    if (!msg) continue;
    if (!canSee(user, ch) || msg.acks[user.id]) return;
    msg.acks[user.id] = Date.now();
    if (!msg.expected.includes(user.id)) msg.expected.push(user.id);
    broadcast({ type: 'ack', msgId, channel: ch, userId: user.id, ts: msg.acks[user.id] }, (u) => canSee(u, ch));
    save();
    return;
  }
}

function stopTalk(ws) {
  const user = db.users[ws.userId];
  const ch = ws.talk;
  ws.talk = null;
  if (!user) return;
  user.talking = null;
  broadcast({ type: 'talk', userId: user.id, channel: ch, active: false }, (u) => canSee(u, ch));
  broadcastUsers();
}

function relayAudio(ws, data) {
  const user = db.users[ws.userId];
  if (!user || !ws.talk) return;
  const id = Buffer.from(user.id, 'ascii');
  const frame = Buffer.concat([Buffer.from([id.length]), id, data]);
  for (const [uid, set] of sockets) {
    if (uid === user.id || !canSee(db.users[uid], ws.talk)) continue;
    for (const s of set) if (s.readyState === 1 && s.bufferedAmount < 512 * 1024) s.send(frame, { binary: true });
  }
}

// ---------- startup banner ----------
const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
console.log(`\n${SHOW_NAME} is running.`);
console.log(`  This computer:  http://localhost:${PORT}`);
for (const ip of ips) {
  console.log(`  On the network: http://${ip}:${PORT}${hasCert ? `   (with mic: https://${ip}:${HTTPS_PORT})` : ''}`);
}
if (!hasCert) console.log('\n  Push-to-talk on phones/tablets needs HTTPS. Run "npm run cert" then restart.');
if (PASSCODE) console.log('  Show passcode is ON.');
console.log('');

process.on('SIGINT', () => { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); process.exit(0); });
