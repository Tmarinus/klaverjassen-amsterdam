/* ============================================================
   Klaverjassen Online — authoritative game server
   Node + Express + Socket.IO. Amsterdam rules. Bots fill empties.

   The game logic lives in game-room.js (shared with the mobile app, where a
   phone acts as host over WebRTC). This file is just the Socket.IO transport:
   it maps sockets <-> players and feeds actions into GameRoom.
   ============================================================ */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom } = require('./game-room');

const PORT = process.env.PORT || 8787;
const MATCH_DEALS = 16;
const N = (k, d) => (process.env[k] ? +process.env[k] : d);
const D = {
  botThink:    N('KJ_BOT_MS', 850),
  trumpThink:  N('KJ_TRUMP_MS', 1000),
  trickLinger: N('KJ_TRICK_MS', 2400),
  dealAuto:    N('KJ_DEAL_MS', 10000),
};
const ROOM_GRACE = N('KJ_GRACE_MS', 60000);   // keep an all-disconnected room alive this long (reconnection)
const MAX_ROOMS = N('KJ_MAX_ROOMS', 300);     // global cap so create-spam can't grow memory without bound
const MAX_CREATES_PER_CONN = N('KJ_MAX_CREATES', 40);   // per-socket create budget

const PUBLIC_URL = (process.env.KJ_PUBLIC_URL || '').replace(/\/+$/, '');  // public tunnel URL for invite links

const app = express();
app.get('/config', (_req, res) => res.json({ publicUrl: PUBLIC_URL }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 25000, pingInterval: 10000 });

/* ---------- registries ---------- */
const rooms = new Map();               // code -> GameRoom

function makeCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => alpha[Math.floor(Math.random() * alpha.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

// A room whose outbound messages route to the right socket for each playerId.
function makeRoom(code) {
  return new GameRoom(code, {
    timings: D,
    matchDeals: MATCH_DEALS,
    send(playerId, event, payload) {
      const sid = playerSock.get(playerId);
      const sock = sid && io.sockets.sockets.get(sid);
      if (sock) sock.emit(event, payload);
    },
  });
}

/* ============================================================
                    SOCKET WIRING
   ============================================================ */
const playerSock = new Map();     // playerId -> socket.id
const sockPlayer = new Map();     // socket.id -> playerId
const playerRoom = new Map();     // playerId -> room code

function roomOf(pid) { const c = playerRoom.get(pid); return c ? rooms.get(c) : null; }

io.on('connection', (socket) => {
  socket.on('hello', ({ playerId, name, token }) => {
    if (!playerId) return;
    const room = roomOf(playerId);
    // Verify BEFORE binding any maps, so an unverified claim on a seated playerId
    // can't even redirect that player's message routing to the impostor.
    if (room && room.seatOf(playerId) >= 0 && !room.verifyToken(playerId, token)) {
      socket.emit('error', { msg: 'Could not verify your seat — rejoin with the table code.' });
      socket.emit('ready');
      return;
    }
    playerSock.set(playerId, socket.id);
    sockPlayer.set(socket.id, playerId);
    socket.data.name = (name || 'Player').toString().slice(0, 16);
    if (room) {
      const seat = room.seatOf(playerId);
      if (seat >= 0) room.setConnected(playerId, true);
      scheduleEmptyCheck(room);            // a human is back -> cancel any pending close
      socket.emit('joined', { code: room.code });
      room.broadcast();
    } else {
      socket.emit('ready');
    }
  });

  socket.on('create', () => {
    const pid = sockPlayer.get(socket.id); if (!pid) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('error', { msg: 'Server is at capacity — try again shortly.' });
    socket.data.creates = (socket.data.creates || 0) + 1;
    if (socket.data.creates > MAX_CREATES_PER_CONN) return socket.emit('error', { msg: 'Too many tables created on this connection.' });
    leaveCurrent(pid);
    const code = makeCode();
    const room = makeRoom(code);
    rooms.set(code, room);
    room.addHuman(pid, socket.data.name);
    playerRoom.set(pid, code);
    socket.emit('joined', { code });
    room.broadcast();
  });

  socket.on('join', ({ code }) => {
    const pid = sockPlayer.get(socket.id); if (!pid) return;
    code = (code || '').toString().toUpperCase().trim().slice(0, 8);
    if (!code) return socket.emit('error', { msg: 'Enter a table code' });
    const room = rooms.get(code);
    if (!room) return socket.emit('error', { msg: 'No table with code ' + code });
    leaveCurrent(pid);
    if (room.phase === 'lobby' && room.openSeat() >= 0) {
      room.addHuman(pid, socket.data.name);
    } else {
      room.addSpectator(pid, socket.data.name);   // game running or full -> spectator
    }
    playerRoom.set(pid, code);
    socket.emit('joined', { code });
    room.broadcast();
  });

  // In-room actions all funnel through GameRoom.handle so the rules live in one place.
  const forward = (event) => (data) => {
    const pid = sockPlayer.get(socket.id); const r = roomOf(pid);
    if (r) r.handle(pid, event, data || {});
  };
  socket.on('claimSeat', forward('claimSeat'));
  socket.on('setDifficulty', forward('setDifficulty'));
  socket.on('setHandRoem', forward('setHandRoem'));
  socket.on('callRoem', forward('callRoem'));
  socket.on('setTrumpMode', forward('setTrumpMode'));
  socket.on('bid', forward('bid'));
  socket.on('start', forward('start'));
  socket.on('chooseTrump', forward('chooseTrump'));
  socket.on('play', forward('play'));
  socket.on('next', forward('next'));
  socket.on('newMatch', forward('newMatch'));
  socket.on('leave', () => { const pid = sockPlayer.get(socket.id); leaveCurrent(pid); socket.emit('ready'); });

  socket.on('disconnect', () => {
    const pid = sockPlayer.get(socket.id);
    sockPlayer.delete(socket.id);
    if (!pid) return;
    if (playerSock.get(pid) === socket.id) playerSock.delete(pid);
    const room = roomOf(pid);
    if (room) {
      const seat = room.seatOf(pid);
      if (seat >= 0 && room.phase !== 'lobby') {
        room.setConnected(pid, false);         // bot takes over turns
        room.broadcast();
        // if it is (or becomes) their turn, keep the game moving
        room.wake(seat);
      } else if (seat >= 0) {
        room.removePlayer(pid);
        if (rooms.has(room.code)) room.broadcast();
      } else {
        room.removeSpectator(pid);
      }
      scheduleEmptyCheck(room);              // no connected humans left -> close after grace
    }
  });
});

function leaveCurrent(pid) {
  const room = roomOf(pid);
  if (!room) return;
  room.removePlayer(pid);
  playerRoom.delete(pid);
  scheduleEmptyCheck(room);
  if (rooms.has(room.code)) room.broadcast();
}
function hasLiveHuman(room) {
  return room.seats.some(s => s && !s.isBot && s.connected) || room.spectators.size > 0;
}
function closeRoom(room) {
  room.clearTimers();
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  rooms.delete(room.code);
  for (const [pid, c] of playerRoom) if (c === room.code) playerRoom.delete(pid);
}
// close a room only after ROOM_GRACE with no connected humans, so refresh/reconnect survives
function scheduleEmptyCheck(room) {
  if (!rooms.has(room.code)) return;
  if (hasLiveHuman(room)) { if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; } return; }
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (rooms.has(room.code) && !hasLiveHuman(room)) closeRoom(room);
  }, ROOM_GRACE);
}

server.listen(PORT, () => {
  console.log(`\n  Klaverjassen Online running on http://localhost:${PORT}`);
  console.log(`  Share the public tunnel URL with friends to play.\n`);
});
