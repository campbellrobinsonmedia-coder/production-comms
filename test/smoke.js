// Starts the server on a spare port, connects two clients, checks cues, acks, chat, channels and audio relay.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const DATA = path.join(os.tmpdir(), `pc-test-${Date.now()}.json`);
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, HTTPS_PORT: PORT + 1, DATA_FILE: DATA } });

function client(name, dept) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (d, bin) => {
      const m = bin ? { type: 'audio', data: d } : JSON.parse(d.toString());
      ws.inbox.push(m);
      ws.waiters = ws.waiters.filter((w) => !(w.f(m) && (w.r(m), true)));
    });
    ws.wait = (f, ms = 2000) => new Promise((r, j) => {
      const hit = ws.inbox.find(f); if (hit) { ws.inbox.splice(ws.inbox.indexOf(hit), 1); return r(hit); }
      const t = setTimeout(() => j(new Error('timeout waiting in ' + name)), ms);
      ws.waiters.push({ f, r: (m) => { clearTimeout(t); ws.inbox.splice(ws.inbox.indexOf(m), 1); r(m); } });
    });
    ws.j = (o) => ws.send(JSON.stringify(o));
    ws.on('open', () => { ws.j({ type: 'hello', clientId: name + '-id', name, dept }); resolve(ws); });
  });
}

(async () => {
  await new Promise((r) => srv.stdout.once('data', r));
  const sm = await client('SM', 'sm');
  const lx = await client('LX Op', 'lx');
  const smW = await sm.wait((m) => m.type === 'welcome');
  const lxW = await lx.wait((m) => m.type === 'welcome');
  assert.ok(lxW.users.find((u) => u.id === lxW.you).channels.includes('lx'), 'auto-joined dept channel');

  // SM joins lighting channel, sends a cue requiring ack
  sm.j({ type: 'join', channel: 'lx' });
  await sm.wait((m) => m.type === 'users' && m.users.find((u) => u.id === smW.you).channels.includes('lx'));
  sm.j({ type: 'send', channel: 'lx', text: 'Standby — LX 42', kind: 'cue', requireAck: true });
  const cue = await lx.wait((m) => m.type === 'message' && m.msg.kind === 'cue');
  assert.deepStrictEqual(cue.msg.expected, [lxW.you], 'LX op expected to ack');
  lx.j({ type: 'ack', msgId: cue.msg.id });
  const ack = await sm.wait((m) => m.type === 'ack');
  assert.strictEqual(ack.userId, lxW.you);
  console.log('ok  cue + acknowledge');

  // direct message
  lx.j({ type: 'send', to: smW.you, text: 'LX ready', kind: 'text' });
  const dm = await sm.wait((m) => m.type === 'message' && m.msg.channel.startsWith('dm:'));
  assert.strictEqual(dm.msg.text, 'LX ready');
  console.log('ok  direct message');

  // channel privacy: sound channel message should not reach LX
  sm.j({ type: 'join', channel: 'snd' });
  await sm.wait((m) => m.type === 'history' && m.channel === 'snd');
  sm.j({ type: 'send', channel: 'snd', text: 'secret', kind: 'text' });
  await sm.wait((m) => m.type === 'message' && m.msg.text === 'secret');
  await assert.rejects(lx.wait((m) => m.type === 'message' && m.msg.text === 'secret', 400));
  console.log('ok  channel isolation');

  // push to talk relay
  sm.j({ type: 'ptt-start', channel: 'lx' });
  await lx.wait((m) => m.type === 'talk' && m.active);
  sm.send(Buffer.from(new Int16Array([1, 2, 3, 4]).buffer));
  const audio = await lx.wait((m) => m.type === 'audio');
  const idLen = audio.data[0];
  assert.strictEqual(audio.data.slice(1, 1 + idLen).toString(), smW.you);
  assert.strictEqual(audio.data.length, 1 + idLen + 8);
  sm.j({ type: 'ptt-stop' });
  await lx.wait((m) => m.type === 'talk' && !m.active);
  console.log('ok  push-to-talk audio relay');

  // presets editable
  sm.j({ type: 'preset-add', label: 'Fly out', color: 'amber' });
  const pr = await lx.wait((m) => m.type === 'presets');
  assert.ok(pr.presets.some((p) => p.label === 'Fly out'));
  console.log('ok  shared preset buttons');

  console.log('\nAll tests passed.');
  srv.kill(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); srv.kill(); process.exit(1); });
