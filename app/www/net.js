/* ============================================================
   Klaverjassen transport abstraction (mobile app).

   Exposes KJNet.createSolo / createHost / createClient. Each returns an object
   with the SAME tiny API the UI already used on the Socket.IO client:
       net.on(event, cb)      // 'state' | 'joined' | 'error' | 'ready'
       net.emit(event, data)  // 'play' | 'chooseTrump' | 'start' | ...
       net.close()

   - solo   : local GameRoom, bots fill the table, no network at all (offline).
   - host   : local GameRoom (authoritative) + PeerJS, remote friends connect in.
   - client : joins a host over a WebRTC data channel via the free PeerJS broker.

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
  });
  room.addHuman(me, opts.name || 'You');
  net.emit = (event, data) => {
    if (event === 'hello') return;
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    room.handle(me, event, data || {});
  };
  net.close = () => { room.clearTimers(); };
  net.isHost = true; net.solo = true; net.room = room;
  // start after the UI has attached its listeners
  setTimeout(() => { net._fire('joined', { code: 'SOLO' }); room.startGame(); }, 0);
  return net;
}

/* ---------- HOST (authoritative + accepts remote joiners) ---------- */
function createHost(opts) {
  const GameRoom = requireGameRoom();
  const Peer = requirePeer();
  const net = makeEmitter();
  const me = opts.playerId;
  let code = makeCode();
  const remotes = new Map();   // playerId -> DataConnection
  let peer = null;

  const room = new GameRoom(code, {
    botLevel: opts.botLevel || 'normal',
    handRoem: !!opts.handRoem,
    send(pid, event, payload) {
      if (pid === me) { net._fire(event, payload); return; }
      const c = remotes.get(pid);
      if (c && c.open) { try { c.send({ event, data: payload }); } catch (e) {} }
    },
  });
  room.addHuman(me, opts.name || 'Host');

  net.emit = (event, data) => {
    if (event === 'hello') return;                 // host is already seated
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    room.handle(me, event, data || {});
  };
  net.close = () => {
    room.clearTimers();
    remotes.forEach(c => { try { c.close(); } catch (e) {} });
    try { peer && peer.destroy(); } catch (e) {}
  };
  net.isHost = true; net.room = room;

  function wireIncoming(conn) {
    let pid = null;
    conn.on('data', (msg) => {
      if (!msg || !msg.event) return;
      if (msg.event === 'hello') {
        const inPid = (msg.data && msg.data.playerId) || conn.peer;
        const token = msg.data && msg.data.token;
        const nm = ((msg.data && msg.data.name) || 'Player').toString().slice(0, 16);
        // Reconnecting onto an existing seat requires the token that seat was issued.
        if (room.seatOf(inPid) >= 0 && !room.verifyToken(inPid, token)) {
          try { conn.send({ event: 'error', data: { msg: 'Could not verify your seat — rejoin with the code.' } }); } catch (e) {}
          try { conn.close(); } catch (e) {}
          return;
        }
        pid = inPid;
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
    conn.on('close', () => {
      if (!pid) return;
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
    });
    conn.on('error', () => {});
  }

  function startPeer(tries) {
    peer = new Peer(peerIdFor(code), PEER_OPTS);
    peer.on('open', () => { net._fire('joined', { code }); room.broadcast(); });
    peer.on('connection', wireIncoming);
    peer.on('error', (err) => {
      if (err && err.type === 'unavailable-id' && tries < 6) {   // rare collision on shared broker
        try { peer.destroy(); } catch (e) {}
        code = makeCode(); room.code = code; startPeer(tries + 1); return;
      }
      net._fire('error', { msg: peerErrMsg(err) });
    });
  }
  startPeer(0);
  return net;
}

/* ---------- CLIENT (joins a host) ---------- */
function createClient(opts) {
  const Peer = requirePeer();
  const net = makeEmitter();
  const code = (opts.code || '').toUpperCase();
  let peer = null, conn = null, closed = false, opened = false;

  net.emit = (event, data) => {
    if (event === 'leave') { net.close(); net._fire('ready'); return; }
    if (event === 'hello') return;                 // hello is sent automatically on connect
    if (conn && conn.open) { try { conn.send({ event, data: data || {} }); } catch (e) {} }
  };
  net.close = () => { closed = true; try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} };
  net.isHost = false;

  peer = new Peer(PEER_OPTS);
  peer.on('open', () => {
    conn = peer.connect(peerIdFor(code), { reliable: true });
    conn.on('open', () => { opened = true; conn.send({ event: 'hello', data: { playerId: opts.playerId, name: opts.name, token: opts.token } }); });
    conn.on('data', (msg) => { if (msg && msg.event) net._fire(msg.event, msg.data); });
    conn.on('close', () => { if (!closed) net._fire('error', { msg: 'Lost connection to the host — the game may have ended.' }); });
    conn.on('error', () => {});
  });
  peer.on('error', (err) => { if (!closed) net._fire('error', { msg: peerErrMsg(err) }); });

  // If we never connect within a reasonable window, surface a clear failure.
  setTimeout(() => { if (!opened && !closed) net._fire('error', { msg: 'Could not reach the host. Check the code and that the host is online.' }); }, 12000);
  return net;
}

root.KJNet = { createSolo, createHost, createClient, makeCode };

})(typeof self !== 'undefined' ? self : this);
