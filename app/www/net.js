/* ============================================================
   Klaverjassen transport abstraction (mobile app).

   Exposes KJNet.createSolo / createHost / createClient. Each returns an object
   with the SAME tiny API the UI already used on the Socket.IO client:
       net.on(event, cb)      // 'state' | 'joined' | 'error' | 'ready' | 'link'
       net.emit(event, data)  // 'play' | 'chooseTrump' | 'start' | ...
       net.close()

   - solo   : local GameRoom, bots fill the table, no network at all (offline).
   - host   : local GameRoom (authoritative) + PeerJS, remote friends connect in.
   - client : joins a host over a WebRTC data channel via the free PeerJS broker.

   Resilience: clients heartbeat the host and reconnect on their own when the
   link drops ('link' events: {state:'reconnecting'|'online', attempt}); the host
   and solo rooms autosave via opts.onSave(snapshot) and can be rebuilt with
   opts.resume = snapshot after a reload.

   The rules never leave game-room.js / engine.js — this file is pure plumbing.
   ============================================================ */
;(function (root) {
'use strict';

function requireGameRoom() {
  if (!root.KJGameRoom || !root.KJGameRoom.GameRoom) throw new Error('game-room.js not loaded');
  return root.KJGameRoom.GameRoom;
}
function requirePeer() {
  if (!root.Peer) throw new Error('PeerJS not loaded (no internet? peerjs.min.js missing?)');
  return root.Peer;
}

function makeEmitter() {
  const listeners = {};
  return {
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    _fire(ev, data) { (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
  };
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 to avoid confusion
function makeCode() { let c = ''; for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return c; }

// Namespace our peer ids on the shared public PeerJS broker so a room code maps
// deterministically to the host's peer id.
const PEER_PREFIX = 'kjrdam-';
const peerIdFor = code => PEER_PREFIX + code;

// Public broker (PeerJS cloud) is the default; we only pin STUN servers for NAT traversal.
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

const PING_MS = 4000;        // client -> host heartbeat interval
const STALE_MS = 13000;      // no traffic for this long = the link is dead

function peerErrMsg(err) {
  const t = err && err.type;
  if (t === 'peer-unavailable') return 'No table found with that code.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking service. Check your internet.';
  if (t === 'unavailable-id') return 'That table code is busy — try again.';
  if (t === 'browser-incompatible') return 'This device/browser does not support peer connections.';
  return 'Connection problem' + (t ? ' (' + t + ')' : '') + '.';
}

/* ---------- SOLO (offline vs bots) ---------- */
function createSolo(opts) {
  const GameRoom = requireGameRoom();
  const net = makeEmitter();
  const me = opts.playerId;
  const room = new GameRoom('SOLO', {
    botLevel: opts.botLevel || 'normal',
    handRoem: !!opts.handRoem,
    send(pid, event, payload) { if (pid === me) net._fire(event, payload); },
    onChange: opts.onSave ? () => opts.onSave(room.snapshot()) : null,
  });
  if (opts.resume) room.restore(opts.resume);
  else room.addHuman(me, opts.name || 'You');
  net.emit = (event, data) => {
    if (event === 'hello') return;
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    room.handle(me, event, data || {});
  };
  net.close = () => { room.clearTimers(); };
  net.isHost = true; net.solo = true; net.room = room;
  // start after the UI has attached its listeners
  setTimeout(() => { net._fire('joined', { code: 'SOLO' }); opts.resume ? room.resume() : room.startGame(); }, 0);
  return net;
}

/* ---------- HOST (authoritative + accepts remote joiners) ---------- */
function createHost(opts) {
  const GameRoom = requireGameRoom();
  const Peer = requirePeer();
  const net = makeEmitter();
  const me = opts.playerId;
  let code = opts.resume ? opts.resume.code : makeCode();
  const remotes = new Map();   // playerId -> DataConnection
  const lastSeen = new Map();  // DataConnection -> last ping; only pinging (current) clients can go stale
  let peer = null, closed = false, reconnT = null;

  const room = new GameRoom(code, {
    botLevel: opts.botLevel || 'normal',
    handRoem: !!opts.handRoem,
    send(pid, event, payload) {
      if (pid === me) { net._fire(event, payload); return; }
      const c = remotes.get(pid);
      if (c && c.open) { try { c.send({ event, data: payload }); } catch (e) {} }
    },
    onChange: opts.onSave ? () => opts.onSave(room.snapshot()) : null,
  });
  if (opts.resume) room.restore(opts.resume);
  else room.addHuman(me, opts.name || 'Host');

  net.emit = (event, data) => {
    if (event === 'hello') return;                 // host is already seated
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    room.handle(me, event, data || {});
  };
  net.close = () => {
    closed = true; clearInterval(staleT); clearTimeout(reconnT);
    room.clearTimers();
    remotes.forEach(c => { try { c.close(); } catch (e) {} });
    try { peer && peer.destroy(); } catch (e) {}
  };
  net.isHost = true; net.room = room;

  // A player's link is gone (closed, or silent too long): hand their seat to a bot
  // until they reconnect. Ignore stale connections already replaced by a newer one.
  function dropped(pid, conn) {
    lastSeen.delete(conn);
    if (!pid || remotes.get(pid) !== conn) return;
    remotes.delete(pid);
    const seat = room.seatOf(pid);
    if (seat >= 0 && room.phase !== 'lobby') {
      room.setConnected(pid, false);
      room.broadcast();
      if (room.phase === 'playing' && room.g.turn === seat) room.nextTurn();
      else if (room.phase === 'choosing' && room.g.chooser === seat) room.scheduleBotTrump(seat);
    } else if (seat >= 0) {
      room.removePlayer(pid); room.broadcast();
    } else {
      room.removeSpectator(pid); room.broadcast();
    }
  }
  const staleT = setInterval(() => {
    const now = Date.now();
    for (const [pid, c] of [...remotes]) {
      if (lastSeen.has(c) && now - lastSeen.get(c) > STALE_MS) { try { c.close(); } catch (e) {} dropped(pid, c); }
    }
  }, 3000);

  function wireIncoming(conn) {
    let pid = null;
    conn.on('data', (msg) => {
      if (!msg || !msg.event) return;
      if (lastSeen.has(conn) || msg.event === 'ping') lastSeen.set(conn, Date.now());
      if (msg.event === 'ping') { try { conn.send({ event: 'pong' }); } catch (e) {} return; }
      if (msg.event === 'hello') {
        const inPid = (msg.data && msg.data.playerId) || conn.peer;
        const token = msg.data && msg.data.token;
        const nm = ((msg.data && msg.data.name) || 'Player').toString().slice(0, 16);
        // Reconnecting onto an existing seat requires the token that seat was issued.
        if (room.seatOf(inPid) >= 0 && !room.verifyToken(inPid, token)) {
          try { conn.send({ event: 'error', data: { msg: 'Could not verify your seat — rejoin with the code.', fatal: true } }); } catch (e) {}
          try { conn.close(); } catch (e) {}
          return;
        }
        pid = inPid;
        const old = remotes.get(pid);
        if (old && old !== conn) { lastSeen.delete(old); try { old.close(); } catch (e) {} }   // superseded link
        remotes.set(pid, conn);
        if (room.seatOf(pid) >= 0) room.setConnected(pid, true);                       // reconnect
        else if (room.phase === 'lobby' && room.openSeat() >= 0) room.addHuman(pid, nm);
        else room.addSpectator(pid, nm);
        conn.send({ event: 'joined', data: { code } });
        room.broadcast();
      } else if (pid) {
        room.handle(pid, msg.event, msg.data || {});
      }
    });
    conn.on('close', () => dropped(pid, conn));
    conn.on('error', () => {});
  }

  function startPeer(tries) {
    if (closed) return;
    const p = peer = new Peer(peerIdFor(code), PEER_OPTS);
    p.on('open', () => { if (!opts.resume) net._fire('joined', { code }); net._fire('link', { state: 'online' }); room.broadcast(); });
    p.on('connection', wireIncoming);
    // Lost the matchmaker (bad internet): existing links may survive, but nobody can
    // (re)join until we're registered again — keep retrying.
    p.on('disconnected', () => {
      if (closed || p !== peer) return;
      net._fire('link', { state: 'reconnecting' });
      clearTimeout(reconnT);
      reconnT = setTimeout(() => { if (!closed && p === peer && !p.destroyed) { try { p.reconnect(); } catch (e) {} } }, 2000);
    });
    p.on('error', (err) => {
      const t = err && err.type;
      if (t === 'unavailable-id' && opts.resume && tries < 30) {     // our old id is still held by the broker
        try { p.destroy(); } catch (e) {}
        reconnT = setTimeout(() => startPeer(tries + 1), 3000); return;
      }
      if (t === 'unavailable-id' && tries < 6) {                    // rare collision on shared broker
        try { p.destroy(); } catch (e) {}
        code = makeCode(); room.code = code; startPeer(tries + 1); return;
      }
      if ((t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') && p.disconnected && !p.destroyed) {
        net._fire('link', { state: 'reconnecting' });
        clearTimeout(reconnT);
        reconnT = setTimeout(() => { if (!closed && p === peer && !p.destroyed) { try { p.reconnect(); } catch (e) {} } }, 4000);
        return;
      }
      net._fire('error', { msg: peerErrMsg(err) });
    });
  }
  startPeer(0);
  if (opts.resume) setTimeout(() => { net._fire('joined', { code }); room.resume(); }, 0);   // game runs even before peers return
  return net;
}

/* ---------- CLIENT (joins a host) ---------- */
// Once joined, a dropped link (closed channel, or no pong for STALE_MS) triggers
// automatic reconnects with backoff, using a fresh Peer each time. The host keeps
// our seat (a bot plays it meanwhile) and the seat token proves it's us.
function createClient(opts) {
  const Peer = requirePeer();
  const net = makeEmitter();
  const code = (opts.code || '').toUpperCase();
  let peer = null, conn = null, closed = false, joined = false, attempt = 0;
  let lastHeard = 0, retryT = null, pingT = null;

  net.emit = (event, data) => {
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    if (event === 'hello') return;                 // hello is sent automatically on connect
    if (conn && conn.open) { try { conn.send({ event, data: data || {} }); } catch (e) {} }
  };
  net.close = () => {
    closed = true; clearTimeout(retryT); clearInterval(pingT);
    try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {}
  };
  net.isHost = false;
  net.reconnectNow = () => { if (!closed && joined && !(conn && conn.open)) { clearTimeout(retryT); connect(); } };

  function lost() {                                // link is gone: schedule another attempt
    if (closed) return;
    clearInterval(pingT);
    try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {}
    conn = null; peer = null;
    if (!joined) return;                           // initial join failed — the UI already showed why
    attempt++;
    net._fire('link', { state: 'reconnecting', attempt });
    clearTimeout(retryT);
    retryT = setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 8000));
  }

  function connect() {
    if (closed) return;
    const p = peer = new Peer(PEER_OPTS);
    p.on('open', () => {
      if (p !== peer) return;
      const c = conn = p.connect(peerIdFor(code), { reliable: true });
      c.on('open', () => {
        if (c !== conn) return;
        lastHeard = Date.now();
        const token = opts.getToken ? opts.getToken() : opts.token;
        c.send({ event: 'hello', data: { playerId: opts.playerId, name: opts.name, token } });
        clearInterval(pingT);
        pingT = setInterval(() => {
          if (c !== conn) return;
          if (Date.now() - lastHeard > STALE_MS) { lost(); return; }
          try { c.send({ event: 'ping' }); } catch (e) {}
        }, PING_MS);
      });
      c.on('data', (msg) => {
        if (c !== conn || !msg || !msg.event) return;
        lastHeard = Date.now();
        if (msg.event === 'pong') return;
        if (msg.event === 'error' && msg.data && msg.data.fatal) { closed = true; net._fire('link', { state: 'failed' }); }   // host refused us: stop retrying
        if (msg.event === 'joined') {
          if (joined && attempt) net._fire('link', { state: 'online' });
          joined = true; attempt = 0;
        }
        net._fire(msg.event, msg.data);
      });
      c.on('close', () => { if (c === conn) lost(); });
      c.on('error', () => {});
    });
    p.on('error', (err) => {
      if (closed || p !== peer) return;
      if (joined) { lost(); return; }              // mid-game: keep trying quietly
      net._fire('error', { msg: peerErrMsg(err) });
    });
  }
  connect();

  // If we never connect within a reasonable window, surface a clear failure.
  setTimeout(() => { if (!joined && !closed) net._fire('error', { msg: 'Could not reach the host. Check the code and that the host is online.' }); }, 12000);
  return net;
}

root.KJNet = { createSolo, createHost, createClient, makeCode };

})(typeof self !== 'undefined' ? self : this);
