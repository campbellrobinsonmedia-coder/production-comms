/* Production Comms client */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const STATUSES = ['Ready', 'Standby', 'Busy', 'Break', 'Away', 'Emergency'];
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem('pc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => localStorage.setItem('pc.' + k, JSON.stringify(v)),
  };
  if (!LS.get('clientId')) LS.set('clientId', (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)));

  const S = {
    config: null, me: null, users: {}, channels: [], presets: [], msgs: new Map(), byId: new Map(),
    tab: 'cues', chatCh: 'all', cueTarget: { channel: 'all' }, pttTarget: LS.get('pttTarget', 'all'),
    ackOnChat: false, editPresets: false, unread: {}, alerts: [], talkers: {},
    listen: LS.get('listen', true), volume: LS.get('volume', 1), latch: LS.get('latch', false),
  };

  // ---------------- connection ----------------
  let ws, retry = 0, joined = false;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { retry = 0; setConn(true); if (LS.get('name')) hello(); };
    ws.onclose = () => { setConn(false); if (talking) stopTalk(true); setTimeout(connect, Math.min(5000, 500 * 2 ** retry++)); };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onAudio(e.data));
  }
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  const setConn = (on) => { $('#connDot').className = 'dot ' + (on ? 'on' : 'off'); };
  function hello() {
    send({ type: 'hello', clientId: LS.get('clientId'), name: LS.get('name'), dept: LS.get('dept', 'other'), passcode: LS.get('passcode', '') });
  }

  function onJson(m) {
    switch (m.type) {
      case 'config': {
        S.config = m;
        $('#showTitle').textContent = $('#appTitle').textContent = document.title = m.showName;
        $('#loginDept').innerHTML = m.departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
        $('#loginDept').value = LS.get('dept', 'other');
        $('#loginName').value = LS.get('name', '');
        $('#passWrap').hidden = !m.needsPasscode;
        if (!LS.get('name')) showLogin();
        break;
      }
      case 'auth-failed': LS.set('passcode', ''); showLogin(m.message); break;
      case 'welcome': {
        S.me = m.you; joined = true;
        setUsers(m.users); S.channels = m.channels; S.presets = m.presets;
        S.msgs.clear(); S.byId.clear();
        m.messages.sort((a, b) => a.ts - b.ts).forEach((x) => store(x));
        $('#login').hidden = true; $('#app').hidden = false;
        if (!validTarget(S.pttTarget)) S.pttTarget = 'all';
        renderAll();
        break;
      }
      case 'users': setUsers(m.users); renderAll(); break;
      case 'channels': S.channels = m.channels; renderAll(); break;
      case 'presets': S.presets = m.presets; renderCues(); break;
      case 'history':
        if (m.replace) { (S.msgs.get(m.channel) || []).forEach((x) => S.byId.delete(x.id)); S.msgs.set(m.channel, []); }
        m.messages.forEach((x) => store(x));
        renderAll();
        break;
      case 'message': onMessage(m.msg); break;
      case 'ack': {
        const msg = S.byId.get(m.msgId);
        if (msg) { msg.acks[m.userId] = m.ts; if (!msg.expected.includes(m.userId)) msg.expected.push(m.userId); }
        if (m.userId === S.me) { S.alerts = S.alerts.filter((a) => a.id !== m.msgId); showAlert(); }
        renderAll();
        break;
      }
      case 'talk': {
        if (m.active) S.talkers[m.userId] = m.channel; else delete S.talkers[m.userId];
        if (!m.active && players[m.userId]) players[m.userId].next = 0;
        renderTalkBanner();
        break;
      }
      case 'error': toast(m.message); break;
    }
  }

  function setUsers(list) { S.users = {}; list.forEach((u) => (S.users[u.id] = u)); }
  const me = () => S.users[S.me] || { channels: [], name: '', status: 'Ready' };
  const dmKey = (a, b) => 'dm:' + [a, b].sort().join(':');
  const dmOther = (ch) => ch.split(':').slice(1).find((id) => id !== S.me);
  function chName(ch) {
    if (ch.startsWith('dm:')) return '@ ' + (S.users[dmOther(ch)]?.name || 'Unknown');
    if (ch.startsWith('user:')) return '@ ' + (S.users[ch.slice(5)]?.name || 'Unknown');
    return S.channels.find((c) => c.id === ch)?.name || ch;
  }
  const myChannels = () => ['all', ...me().channels.filter((c) => S.channels.some((x) => x.id === c))];
  const deptName = (id) => S.config?.departments.find((d) => d.id === id)?.name || 'Other';
  const validTarget = (t) => t === 'all' || (t.startsWith('user:') ? !!S.users[t.slice(5)] : myChannels().includes(t));

  function store(msg) {
    if (S.byId.has(msg.id)) return;
    if (!S.msgs.has(msg.channel)) S.msgs.set(msg.channel, []);
    S.msgs.get(msg.channel).push(msg);
    S.byId.set(msg.id, msg);
  }

  function onMessage(msg) {
    store(msg);
    if (msg.from !== S.me) {
      if (msg.kind === 'cue') {
        S.alerts.push(msg);
        showAlert();
      } else if (!(S.tab === 'chat' && S.chatCh === msg.channel && !document.hidden)) {
        S.unread[msg.channel] = (S.unread[msg.channel] || 0) + 1;
        beep(msg.urgent ? 'urgent' : 'soft');
      }
    }
    renderAll();
  }

  // ---------------- login / profile ----------------
  function showLogin(err = '') {
    $('#app').hidden = true; $('#login').hidden = false; $('#loginErr').textContent = err;
  }
  $('#loginForm').onsubmit = (e) => {
    e.preventDefault();
    unlockAudio();
    LS.set('name', $('#loginName').value.trim());
    LS.set('dept', $('#loginDept').value);
    if (S.config?.needsPasscode) LS.set('passcode', $('#loginPass').value);
    hello();
  };

  $('#meBtn').onclick = () => {
    const opts = S.config.departments.map((d) => `<option value="${d.id}" ${d.id === me().dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    openSheet('Me & audio', `
      <label>Name<input id="pfName" value="${esc(me().name)}" maxlength="40"></label>
      <label style="margin-top:10px">Department<select id="pfDept">${opts}</select></label>
      <button class="btn primary" id="pfSave" style="margin:12px 0 18px;width:100%">Save profile</button>
      <button class="opt" id="optListen"><span class="grow">Hear talkback audio</span><b>${S.listen ? 'ON' : 'OFF'}</b></button>
      <label>Talkback volume<input id="optVol" type="range" min="0" max="2" step="0.1" value="${S.volume}"></label>
      <button class="opt" id="optLatch" style="margin-top:10px"><span class="grow">Latch mode (tap to start/stop talking)</span><b>${S.latch ? 'ON' : 'OFF'}</b></button>
      <button class="opt" id="optTestBeep"><span class="grow">Test alert sound</span></button>
      <button class="opt" id="optSignOut" style="color:var(--red)"><span class="grow">Sign out of this device</span></button>
      <p class="empty">Push-to-talk: hold the round button, or hold the space bar on a keyboard.</p>`);
    $('#pfSave').onclick = () => {
      const name = $('#pfName').value.trim();
      if (!name) return;
      LS.set('name', name); LS.set('dept', $('#pfDept').value);
      send({ type: 'profile', name, dept: $('#pfDept').value });
      closeSheet(); toast('Saved');
    };
    $('#optListen').onclick = () => { S.listen = !S.listen; LS.set('listen', S.listen); $('#meBtn').click(); renderTalkBanner(); };
    $('#optVol').oninput = (e) => { S.volume = Number(e.target.value); LS.set('volume', S.volume); if (outGain) outGain.gain.value = S.volume; };
    $('#optLatch').onclick = () => { S.latch = !S.latch; LS.set('latch', S.latch); $('#meBtn').click(); };
    $('#optTestBeep').onclick = () => { unlockAudio(); beep('urgent'); vibrate(true); };
    $('#optSignOut').onclick = () => { localStorage.removeItem('pc.name'); location.reload(); };
  };

  $('#statusBtn').onclick = () => {
    openSheet('My status', STATUSES.map((s) => `<button class="opt ${me().status === s ? 'sel' : ''}" data-s="${s}"><span class="status ${s}">${s}</span></button>`).join(''));
    document.querySelectorAll('#sheetContent [data-s]').forEach((b) => (b.onclick = () => { send({ type: 'status', status: b.dataset.s }); closeSheet(); }));
  };

  // ---------------- tabs ----------------
  document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  function setTab(t) {
    S.tab = t;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    ['cues', 'chat', 'board'].forEach((x) => ($('#tab-' + x).hidden = x !== t));
    document.body.classList.toggle('on-chat', t === 'chat');
    if (t === 'chat') { delete S.unread[S.chatCh]; }
    renderAll();
    if (t === 'chat') scrollChat(true);
  }

  // ---------------- render ----------------
  function renderAll() {
    if (!joined) return;
    const u = me();
    $('#statusBtn').textContent = u.status || 'Ready';
    $('#statusBtn').className = 'pill status ' + (u.status || 'Ready');
    $('#meBtn').textContent = u.name || 'Me';
    renderCues(); renderChat(); renderBoard(); renderPtt(); renderBadges(); renderTalkBanner();
  }

  function targetChips(container, isSel, onPick, includePeople) {
    const items = myChannels().map((c) => ({ key: c, label: chName(c), pick: { channel: c } }));
    if (includePeople) {
      Object.values(S.users).filter((u) => u.id !== S.me && u.online)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((u) => items.push({ key: 'user:' + u.id, label: '@ ' + u.name, pick: { to: u.id } }));
    }
    container.innerHTML = items.map((it, i) => `<button class="chip ${isSel(it.pick) ? 'sel' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('');
    container.querySelectorAll('.chip').forEach((b) => (b.onclick = () => onPick(items[b.dataset.i].pick)));
  }

  function renderCues() {
    if (!joined) return;
    const t = S.cueTarget;
    if (t.to && !S.users[t.to]) S.cueTarget = { channel: 'all' };
    if (t.channel && !myChannels().includes(t.channel)) S.cueTarget = { channel: 'all' };
    targetChips($('#cueTargets'),
      (p) => (p.to ? p.to === S.cueTarget.to : p.channel === S.cueTarget.channel),
      (p) => { S.cueTarget = p; renderCues(); }, true);

    $('#presetGrid').innerHTML = S.presets.map((p) => `
      <button class="preset c-${p.color || 'blue'} ${p.wide ? 'wide' : ''}" data-id="${p.id}">
        ${esc(p.label)}${p.urgent ? '<small>URGENT</small>' : ''}${p.noAck ? '<small>no ack</small>' : ''}
        ${S.editPresets ? '<span class="x">✕</span>' : ''}
      </button>`).join('');
    $('#presetGrid').querySelectorAll('.preset').forEach((b) => (b.onclick = () => {
      const p = S.presets.find((x) => x.id === b.dataset.id);
      if (!p) return;
      if (S.editPresets) { if (confirm(`Remove "${p.label}" button for everyone?`)) send({ type: 'preset-remove', id: p.id }); return; }
      fireCue(p);
    }));
    $('#presetForm').hidden = !S.editPresets;
    $('#editPresetsBtn').textContent = S.editPresets ? 'Done' : 'Edit';

    const cues = [...S.byId.values()].filter((m) => m.kind === 'cue').sort((a, b) => b.ts - a.ts).slice(0, 15);
    $('#cueLog').innerHTML = cues.length ? cues.map((m) => `
      <div class="row">
        <span class="status" style="background:var(--${m.color || 'blue'})">${esc(m.text)}</span>
        <span class="grow" style="flex:1;font-size:13px;color:var(--muted)">${esc(m.fromName)} → ${esc(chName(m.channel))} · ${time(m.ts)}</span>
        ${ackSummary(m)}
      </div>`).join('') : '<div class="empty">No cues yet.</div>';
  }

  function fireCue(p) {
    const num = $('#cueNum').value.trim();
    const text = num ? `${p.label} — ${num}` : p.label;
    send({ type: 'send', ...S.cueTarget, text, kind: 'cue', color: p.color, urgent: !!p.urgent, requireAck: !p.noAck });
    vibrate(false);
    toast(`Sent "${text}" → ${S.cueTarget.to ? '@ ' + S.users[S.cueTarget.to]?.name : chName(S.cueTarget.channel)}`);
  }

  $('#editPresetsBtn').onclick = () => { S.editPresets = !S.editPresets; renderCues(); };
  $('#presetForm').onsubmit = (e) => {
    e.preventDefault();
    send({ type: 'preset-add', label: $('#presetLabel').value, color: $('#presetColor').value, urgent: $('#presetUrgent').checked, noAck: $('#presetNoAck').checked });
    $('#presetLabel').value = '';
  };

  function ackSummary(m) {
    if (!m.requireAck || !m.expected.length) return '';
    const got = m.expected.filter((id) => m.acks[id]).length;
    const total = m.expected.length;
    const mineToAck = m.expected.includes(S.me) && !m.acks[S.me] && m.from !== S.me;
    return `<span class="${got === total ? 'ok' : 'wait'}">✓ ${got}/${total}</span>` +
      (mineToAck ? ` <button class="ack-btn" data-ack="${m.id}">ACK</button>` : '');
  }

  function chatList() {
    const list = myChannels();
    for (const ch of S.msgs.keys()) if (ch.startsWith('dm:') && !list.includes(ch)) list.push(ch);
    if (!list.includes(S.chatCh)) list.push(S.chatCh);
    return list;
  }

  function renderChat() {
    if (!joined) return;
    if (!S.chatCh.startsWith('dm:') && !myChannels().includes(S.chatCh)) S.chatCh = 'all';
    const list = chatList();
    $('#chatChannels').innerHTML = list.map((c) => `<button class="chip ${c === S.chatCh ? 'sel' : ''}" data-c="${esc(c)}">${esc(chName(c))}${S.unread[c] ? `<span class="unread">${S.unread[c]}</span>` : ''}</button>`).join('');
    $('#chatChannels').querySelectorAll('.chip').forEach((b) => (b.onclick = () => openChat(b.dataset.c)));

    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const msgs = S.msgs.get(S.chatCh) || [];
    box.innerHTML = msgs.length ? msgs.map((m) => `
      <div class="msg ${m.from === S.me ? 'mine' : ''} ${m.kind === 'cue' ? 'cue' : ''} ${m.urgent ? 'urgent' : ''}" ${m.kind === 'cue' ? `style="border-color:var(--${m.color || 'blue'})"` : ''}>
        <div class="meta">${esc(m.fromName)} · ${esc(deptName(m.fromDept))} · ${time(m.ts)}</div>
        <div class="body">${esc(m.text)}</div>
        ${m.requireAck ? `<div class="acks">${ackSummary(m)} <button class="pill ghost" style="min-height:30px;padding:4px 10px" data-who="${m.id}">who?</button></div>` : ''}
      </div>`).join('') : '<div class="empty">No messages here yet.</div>';
    if (atBottom) scrollChat();
    $('#ackToggle').classList.toggle('on', S.ackOnChat);
  }
  const scrollChat = () => requestAnimationFrame(() => { const b = $('#messages'); b.scrollTop = b.scrollHeight; });

  function openChat(ch) {
    S.chatCh = ch; delete S.unread[ch];
    if (S.tab !== 'chat') setTab('chat'); else { renderAll(); scrollChat(); }
  }

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    const target = S.chatCh.startsWith('dm:') ? { to: dmOther(S.chatCh) } : { channel: S.chatCh };
    send({ type: 'send', ...target, text, kind: 'text', requireAck: S.ackOnChat });
    $('#chatInput').value = '';
    S.ackOnChat = false;
    renderChat(); scrollChat();
  };
  $('#ackToggle').onclick = () => { S.ackOnChat = !S.ackOnChat; renderChat(); };

  $('#manageChannelsBtn').onclick = function manage() {
    const mine = me().channels;
    openSheet('Channels', `
      <form class="row-form" id="newChForm"><input id="newCh" placeholder="New channel name" maxlength="32"><button class="btn primary">Create</button></form>
      ${S.channels.map((c) => `
        <button class="opt ${c.id === 'all' || mine.includes(c.id) ? 'sel' : ''}" data-ch="${c.id}">
          <span class="grow">${esc(c.name)}</span>
          <b>${c.id === 'all' ? 'Always on' : mine.includes(c.id) ? 'Listening ✓' : 'Join'}</b>
        </button>`).join('')}
      <p class="empty">You receive messages, cues and talkback for every channel you have joined.</p>`);
    $('#newChForm').onsubmit = (e) => { e.preventDefault(); const n = $('#newCh').value.trim(); if (n) { send({ type: 'channel-create', name: n }); closeSheet(); } };
    document.querySelectorAll('#sheetContent [data-ch]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.ch;
      if (id === 'all') return;
      send({ type: mine.includes(id) ? 'leave' : 'join', channel: id });
      setTimeout(manage, 150);
    }));
  };

  // ack buttons & "who acked" anywhere
  document.addEventListener('click', (e) => {
    const ack = e.target.closest('[data-ack]');
    if (ack) { send({ type: 'ack', msgId: ack.dataset.ack }); return; }
    const who = e.target.closest('[data-who]');
    if (who) {
      const m = S.byId.get(who.dataset.who);
      if (!m) return;
      openSheet('Acknowledgements', `<p><b>${esc(m.text)}</b><br><span class="empty">${esc(m.fromName)} · ${time(m.ts)}</span></p>` +
        m.expected.map((id) => `<div class="person"><span class="name">${esc(S.users[id]?.name || 'Unknown')}</span>${m.acks[id] ? `<span class="ok" style="color:var(--green);font-weight:700">✓ ${time(m.acks[id])}</span>` : '<span class="missing">waiting…</span>'}</div>`).join(''));
    }
  });

  function needsMyAck() {
    return [...S.byId.values()].filter((m) => m.requireAck && m.from !== S.me && m.expected.includes(S.me) && !m.acks[S.me] && Date.now() - m.ts < 12 * 3600e3);
  }

  function renderBoard() {
    if (!joined) return;
    const mine = needsMyAck().sort((a, b) => b.ts - a.ts);
    const sent = [...S.byId.values()].filter((m) => m.from === S.me && m.requireAck && m.expected.some((id) => !m.acks[id]) && Date.now() - m.ts < 12 * 3600e3)
      .sort((a, b) => b.ts - a.ts).slice(0, 20);
    let html = '';
    if (mine.length) html += '<div class="pending">' + mine.map((m) => `
      <div class="row"><b style="flex:1">${esc(m.text)}</b><span class="empty">from ${esc(m.fromName)} · ${time(m.ts)}</span><button class="ack-btn" data-ack="${m.id}">ACK</button></div>`).join('') + '</div>';
    if (sent.length) html += '<div class="pending">' + sent.map((m) => {
      const missing = m.expected.filter((id) => !m.acks[id]).map((id) => S.users[id]?.name || '?');
      return `<div class="row"><b style="flex:1">${esc(m.text)} → ${esc(chName(m.channel))}</b>${ackSummary(m)}
        <button class="pill ghost" data-who="${m.id}">who?</button><div class="missing" style="width:100%">Waiting on: ${esc(missing.join(', '))}</div></div>`;
    }).join('') + '</div>';
    $('#pendingAcks').innerHTML = html || '<div class="empty">Nothing waiting.</div>';

    const groups = {};
    Object.values(S.users).forEach((u) => (groups[u.dept] ||= []).push(u));
    $('#crewBoard').innerHTML = (S.config?.departments || []).filter((d) => groups[d.id]).map((d) => `
      <div class="dept"><h4>${esc(d.name)}</h4>
      ${groups[d.id].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)).map((u) => `
        <div class="person ${u.online ? '' : 'offline'}">
          <span class="dot ${u.online ? 'on' : ''}"></span>
          <span class="name">${esc(u.name)}${u.id === S.me ? ' (you)' : ''}</span>
          ${u.talking ? '<span class="mic">🎙 talking</span>' : ''}
          <span class="status ${esc(u.status)}">${esc(u.online ? u.status : 'Offline')}</span>
          ${u.id !== S.me ? `<button class="pill ghost" data-dm="${u.id}">Msg</button><button class="pill ghost" data-cue="${u.id}">Cue</button>` : ''}
        </div>`).join('')}</div>`).join('');
    $('#crewBoard').querySelectorAll('[data-dm]').forEach((b) => (b.onclick = () => openChat(dmKey(S.me, b.dataset.dm))));
    $('#crewBoard').querySelectorAll('[data-cue]').forEach((b) => (b.onclick = () => { S.cueTarget = { to: b.dataset.cue }; setTab('cues'); }));
  }

  function renderBadges() {
    const unread = Object.values(S.unread).reduce((a, b) => a + b, 0);
    const acks = needsMyAck().length;
    $('#badge-chat').hidden = !unread; $('#badge-chat').textContent = unread;
    $('#badge-board').hidden = !acks; $('#badge-board').textContent = acks;
  }

  // ---------------- incoming cue alert ----------------
  function showAlert() {
    const m = S.alerts[0];
    if (!m) { $('#alert').hidden = true; return; }
    const wasHidden = $('#alert').hidden;
    $('#alert').hidden = false;
    $('#alert').classList.toggle('urgent', !!m.urgent);
    $('#alertFrom').textContent = `${m.fromName} (${deptName(m.fromDept)}) → ${chName(m.channel)}`;
    $('#alertText').textContent = m.text;
    $('#alertText').style.color = m.color && m.color !== 'gray' ? `var(--${m.color})` : '';
    $('#alertMeta').textContent = time(m.ts) + (S.alerts.length > 1 ? ` · ${S.alerts.length - 1} more waiting` : '');
    const needAck = m.requireAck && m.expected.includes(S.me);
    $('#alertAck').textContent = needAck ? 'ACKNOWLEDGE' : 'OK';
    $('#alertDismiss').hidden = !needAck;
    if (wasHidden || m._shown !== true) { m._shown = true; beep(m.urgent ? 'urgent' : 'cue'); vibrate(!!m.urgent); }
  }
  $('#alertAck').onclick = () => {
    const m = S.alerts.shift();
    if (m && m.requireAck && m.expected.includes(S.me)) send({ type: 'ack', msgId: m.id });
    showAlert();
  };
  $('#alertDismiss').onclick = () => { S.alerts.shift(); showAlert(); renderAll(); };

  // ---------------- sheet / toast ----------------
  function openSheet(title, html) { $('#sheetTitle').textContent = title; $('#sheetContent').innerHTML = html; $('#sheet').hidden = false; }
  function closeSheet() { $('#sheet').hidden = true; }
  $('#sheetClose').onclick = closeSheet;
  $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };
  let toastT;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 2200); }

  // ---------------- audio: alerts ----------------
  let ac, outGain;
  function unlockAudio() {
    try {
      if (!ac) { ac = new (window.AudioContext || window.webkitAudioContext)(); outGain = ac.createGain(); outGain.gain.value = S.volume; outGain.connect(ac.destination); }
      if (ac.state === 'suspended') ac.resume();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);

  function beep(kind) {
    if (!ac) return;
    const pattern = kind === 'urgent' ? [880, 0, 880, 0, 880] : kind === 'cue' ? [660, 990] : [740];
    let t = ac.currentTime;
    pattern.forEach((f) => {
      if (f) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = f; o.type = kind === 'urgent' ? 'square' : 'sine';
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.15);
      }
      t += 0.16;
    });
  }
  const vibrate = (urgent) => navigator.vibrate?.(urgent ? [300, 100, 300, 100, 300] : [60]);

  // ---------------- push to talk ----------------
  const RATE = 16000;
  let talking = false, micStream, micNode;

  function renderPtt() {
    if (!validTarget(S.pttTarget)) S.pttTarget = 'all';
    $('#pttTarget').textContent = chName(S.pttTarget) + ' ▾';
    $('#pttBtn').classList.toggle('live', talking);
    $('#pttBtn').classList.toggle('latched', S.latch);
    $('#pttBtn').querySelector('span').innerHTML = talking ? 'LIVE' : S.latch ? 'TAP<br>TO TALK' : 'HOLD<br>TO TALK';
  }

  $('#pttTarget').onclick = () => {
    const opts = myChannels().map((c) => ({ key: c, label: chName(c) }))
      .concat(Object.values(S.users).filter((u) => u.online && u.id !== S.me).map((u) => ({ key: 'user:' + u.id, label: '@ ' + u.name })));
    openSheet('Talk to…', opts.map((o) => `<button class="opt ${o.key === S.pttTarget ? 'sel' : ''}" data-k="${esc(o.key)}">${esc(o.label)}</button>`).join(''));
    document.querySelectorAll('#sheetContent [data-k]').forEach((b) => (b.onclick = () => { S.pttTarget = b.dataset.k; LS.set('pttTarget', S.pttTarget); closeSheet(); renderPtt(); }));
  };

  async function startTalk() {
    if (talking) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      toast('Microphone needs HTTPS. Open the https:// address (port 8443).');
      return;
    }
    unlockAudio();
    talking = true; renderPtt();
    try {
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const src = ac.createMediaStreamSource(micStream);
        micNode = ac.createScriptProcessor(2048, 1, 1);
        const mute = ac.createGain(); mute.gain.value = 0;
        src.connect(micNode); micNode.connect(mute); mute.connect(ac.destination);
        micNode.onaudioprocess = (e) => {
          if (!talking || !ws || ws.readyState !== 1) return;
          ws.send(downsample(e.inputBuffer.getChannelData(0), ac.sampleRate).buffer);
        };
      }
      if (!talking) return; // released before mic was ready
      send({ type: 'ptt-start', channel: S.pttTarget });
      vibrate(false);
    } catch (err) {
      talking = false; renderPtt();
      toast('Microphone blocked: ' + (err.message || err.name));
    }
  }
  function stopTalk(silent) {
    if (!talking) return;
    talking = false; renderPtt();
    if (!silent) send({ type: 'ptt-stop' });
  }

  let carry = new Float32Array(0);
  function downsample(input, inRate) {
    const buf = new Float32Array(carry.length + input.length);
    buf.set(carry); buf.set(input, carry.length);
    const ratio = inRate / RATE;
    const outLen = Math.floor(buf.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = a; j < b; j++) sum += buf[j];
      const s = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    carry = buf.slice(Math.floor(outLen * ratio));
    return out;
  }

  const ptt = $('#pttBtn');
  ptt.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { ptt.setPointerCapture(e.pointerId); } catch {}
    if (S.latch) { talking ? stopTalk() : startTalk(); } else startTalk();
  });
  const release = () => { if (!S.latch) stopTalk(); };
  ptt.addEventListener('pointerup', release);
  ptt.addEventListener('pointercancel', release);
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    e.preventDefault(); startTalk();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    e.preventDefault(); stopTalk();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTalk(); });

  // playback: one jitter-buffered stream per talker
  const players = {};
  function onAudio(buf) {
    if (!S.listen || !ac || ac.state !== 'running') return;
    const idLen = new Uint8Array(buf, 0, 1)[0];
    const id = new TextDecoder().decode(new Uint8Array(buf, 1, idLen));
    const pcm = new Int16Array(buf.slice(1 + idLen));
    if (!pcm.length) return;
    const ab = ac.createBuffer(1, pcm.length, RATE);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ac.createBufferSource();
    src.buffer = ab; src.connect(outGain);
    const p = (players[id] ||= { next: 0 });
    const now = ac.currentTime;
    if (p.next < now + 0.02 || p.next > now + 0.6) p.next = now + 0.1; // (re)start with 100 ms buffer, drop runaway latency
    src.start(p.next);
    p.next += ab.duration;
  }

  function renderTalkBanner() {
    const list = Object.entries(S.talkers).filter(([id]) => id !== S.me);
    const el = $('#talkBanner');
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = '🎙 ' + list.map(([id, ch]) => `${S.users[id]?.name || '?'} → ${chName(ch)}`).join('  ·  ') + (S.listen ? '' : '  (audio off)');
  }

  setTab('cues');
  connect();
})();
