/* ============================================================
   Klaverjassen game room — authoritative game flow, transport-agnostic.
   Ported from server.js's Room class so the SAME logic runs on:
     - the Node server (server.js, via Socket.IO), and
     - a player's phone acting as host (mobile app, via WebRTC data channels)
     - a phone playing solo offline (bots fill the other seats).

   The room never touches sockets/peers directly. All outbound messages go
   through an injected send(playerId, event, payload) callback; membership
   (seats + spectators) is owned here.

   Runs in Node and in the browser.
   ============================================================ */
;(function (root) {
'use strict';

const E = (typeof module !== 'undefined' && module.exports) ? require('./engine') : root.KJEngine;

const SEAT_LABEL = ['South', 'West', 'North', 'East'];
const TEAM = ['North/South', 'East/West'];
const SYM = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const sym = s => SYM[s];

const DEFAULT_TIMINGS = { botThink: 850, trumpThink: 1000, trickLinger: 2400, dealAuto: 10000 };
const DEFAULT_MATCH_DEALS = 16;

// Per-seat reconnection secret. A client proves it owns a seat by presenting the
// token the room issued to it (delivered only in that player's own private view),
// so a third party who merely learns someone's playerId can't seize their seat.
function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class GameRoom {
  constructor(code, opts = {}) {
    this.code = code;
    this.send = opts.send || function () {};      // send(playerId, event, payload)
    this.timings = Object.assign({}, DEFAULT_TIMINGS, opts.timings);
    this.matchDeals = opts.matchDeals || DEFAULT_MATCH_DEALS;

    this.seats = [null, null, null, null];        // {playerId,name,isBot,connected}
    this.hostId = null;
    this.phase = 'lobby';                          // lobby|choosing|playing|scored|matchover
    this.log = [];
    this.timers = new Set();
    this.advanced = false;
    this.botLevel = opts.botLevel || 'normal';     // easy | normal | hard | family
    this.handRoem = !!opts.handRoem;               // host option: roem in hand may be called
    this.trumpMode = opts.trumpMode === 'draw' ? 'draw' : 'choose';   // host option: how trump is set
    this.spectators = new Map();                   // playerId -> { name }
    this.tokens = new Map();                        // playerId -> seat reconnection token
    this.g = null;                                 // game state
    this.history = [];                             // debug record: one entry per deal (see export())
    this.events = [];                              // debug record: connections, resumes, warnings
    this.onChange = opts.onChange || null;         // called after every broadcast (host autosave)
  }

  /* --- debug record --- */
  note(type, info) { this.events.push(Object.assign({ t: Date.now(), type }, info)); if (this.events.length > 500) this.events.shift(); }
  curDeal() { return this.history[this.history.length - 1]; }

  /* --- seat auth --- */
  tokenFor(playerId) { return this.tokens.get(playerId) || null; }
  verifyToken(playerId, token) { const t = this.tokens.get(playerId); return !!t && t === token; }

  /* --- membership --- */
  openSeat() { return this.seats.findIndex(s => s === null); }
  seatOf(playerId) { return this.seats.findIndex(s => s && s.playerId === playerId); }
  humans() { return this.seats.filter(s => s && !s.isBot); }
  addHuman(playerId, name) {
    const seat = this.openSeat();
    if (seat < 0) return -1;
    this.seats[seat] = { playerId, name, isBot: false, connected: true };
    if (!this.tokens.has(playerId)) this.tokens.set(playerId, makeToken());
    if (!this.hostId) this.hostId = playerId;
    return seat;
  }
  claimSeat(playerId, target) {
    if (target == null || target < 0 || target > 3) return false;
    if (this.seats[target] && !(this.seats[target].isBot)) return false; // occupied by human
    const cur = this.seatOf(playerId);
    if (cur < 0 || this.phase !== 'lobby') return false;
    const me = this.seats[cur];
    this.seats[cur] = null;
    this.seats[target] = me;
    return true;
  }
  setConnected(playerId, on) {
    const seat = this.seatOf(playerId);
    if (seat < 0) return;
    if (this.seats[seat].connected !== on) this.note(on ? 'reconnect' : 'disconnect', { seat, name: this.seats[seat].name });
    this.seats[seat].connected = on;
  }
  addSpectator(playerId, name) { this.spectators.set(playerId, { name: name || 'Spectator' }); }
  removeSpectator(playerId) { this.spectators.delete(playerId); }
  removePlayer(playerId) {
    this.spectators.delete(playerId);
    const seat = this.seatOf(playerId);
    if (seat < 0) return;
    if (this.phase === 'lobby') {
      this.seats[seat] = null;
      this.tokens.delete(playerId);                // seat freed pre-game; invalidate its token
      if (this.hostId === playerId) {
        const nh = this.seats.find(s => s && !s.isBot);
        this.hostId = nh ? nh.playerId : null;
      }
    } else {
      // mid-game: keep the seat, hand control to a bot until they return
      this.seats[seat].connected = false;
    }
  }

  /* --- timers helper (so we can cancel on room death) --- */
  after(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; }
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  addLog(cls, html) { this.log.push({ cls, html }); if (this.log.length > 120) this.log.shift(); }

  /* ============================================================
                        GAME FLOW
     ============================================================ */
  startGame() {
    // fill empty seats with bots
    for (let s = 0; s < 4; s++) if (!this.seats[s]) this.seats[s] = { playerId: 'bot' + s, name: 'Bot ' + SEAT_LABEL[s], isBot: true, connected: true };
    // Random starting dealer each match, so the host (seat 0) isn't always first to choose trump.
    this.g = { deal: 0, cumulative: [0, 0], firstDealer: Math.floor(Math.random() * 4) };
    this.match = (this.match || 0) + 1;
    this.note('matchStart', { match: this.match, botLevel: this.botLevel, handRoem: this.handRoem, trumpMode: this.trumpMode, seats: this.seats.map(s => ({ name: s.name, isBot: s.isBot })) });
    this.log = [];
    this.addLog('deal', `Match start — ${this.matchDeals} deals, Amsterdam rules. North &amp; South vs East &amp; West. Bots: <b>${this.botLevel}</b>.` +
      (this.handRoem ? ' Roem in hand: <b>on</b> (call it before your first card).' : '') +
      (this.trumpMode === 'draw' ? ' Trump is <b>drawn</b>: play on it or pass.' : ''));
    this.newDeal();
  }

  newDeal() {
    const g = this.g;
    g.deal++;
    this.advanced = false;
    const dealer = (g.firstDealer + (g.deal - 1)) % 4;
    const chooser = (dealer + 1) % 4;
    const deck = E.freshDeck();
    const hands = [[], [], [], []];
    for (let i = 0; i < 32; i++) hands[i % 4].push(deck[i]);
    hands.forEach(h => h.sort(E.handComparator(null)));
    Object.assign(g, {
      dealer, chooser, declarer: chooser, bid: null, hands, trump: null,
      trick: [], leader: chooser, turn: chooser, trickNo: 0, resolving: false,
      dealCard: [0, 0], dealRoem: [0, 0], tricksWon: [0, 0], played: [],
      roemCalled: [false, false, false, false], calledRoem: [0, 0],
      lastResult: null,
    });
    this.history.push({
      match: this.match, deal: g.deal, dealer, chooser, trump: null,
      hands: hands.map(h => h.map(E.cardId)), plays: [], roemCalls: [], tricks: [], result: null,
      trumpMode: this.trumpMode, bids: [], declarer: null,
    });
    this.phase = 'choosing';
    if (this.trumpMode === 'draw') {
      this.addLog('deal', `— Deal ${g.deal} — ${this.name(dealer)} deals. ${this.name(chooser)} leads.`);
      this.drawTrump(false);
      return;
    }
    this.addLog('deal', `— Deal ${g.deal} — ${this.name(dealer)} deals. ${this.name(chooser)} chooses trump.`);
    this.broadcast();
    if (this.isAuto(chooser)) this.scheduleBotTrump(chooser);
  }

  /* --- draw-trump mode: a random suit goes round the table from the first player;
         each plays on it or passes. If all four pass, a different suit is drawn and
         the first player must play it. The first player leads trick 1 either way. --- */
  drawTrump(forced) {
    const g = this.g;
    const prev = g.bid ? g.bid.drawn : [];
    const pool = E.SUITS.filter(s => !prev.includes(s));
    const suit = pool[Math.floor(Math.random() * pool.length)];
    g.bid = { suit, turn: g.chooser, passes: 0, forced, drawn: prev.concat([suit]) };
    if (forced) {
      this.addLog('deal', `Everyone passed. ${sym(suit)} is drawn — ${this.name(g.chooser)} must play it.`);
      this.takeTrump(g.chooser);
      return;
    }
    this.addLog('deal', `Trump drawn: ${sym(suit)}. ${this.name(g.chooser)} first — play or pass.`);
    this.broadcast();
    this.scheduleBotTrump(g.chooser);
  }
  bid(seat, take) {
    const g = this.g, b = g && g.bid;
    if (this.phase !== 'choosing' || this.trumpMode !== 'draw' || !b || b.forced || seat !== b.turn) return;
    this.curDeal().bids.push({ seat, suit: b.suit, take: !!take, auto: this.isAuto(seat) });
    if (take) { this.takeTrump(seat); return; }
    this.addLog('', `${this.name(seat)} passes on ${sym(b.suit)}.`);
    if (++b.passes === 4) { this.drawTrump(true); return; }
    b.turn = (b.turn + 1) % 4;
    this.broadcast();
    this.scheduleBotTrump(b.turn);
  }
  takeTrump(seat) {
    const g = this.g;
    g.declarer = seat;
    this.setTrump(g.bid.suit, `${this.name(seat)} plays ${sym(g.bid.suit)} — ${TEAM[E.teamOf(seat)]} must win or go nat.` +
      (seat !== g.chooser ? ` ${this.name(g.chooser)} still leads.` : ''));
  }
  // Re-arm an automatic decision for `seat` if it's that seat's move (bot, or a
  // player who dropped). Safe to call any time.
  wake(seat) {
    if (this.phase === 'playing' && this.g.turn === seat) this.nextTurn();
    else if (this.phase === 'choosing') this.scheduleBotTrump(seat);
  }

  isAuto(seat) { const s = this.seats[seat]; return !s || s.isBot || !s.connected; }
  name(seat) { const s = this.seats[seat]; return s ? s.name : SEAT_LABEL[seat]; }

  // deferred bot trump choice — re-checks state when the timer fires (handles reconnection & stale timers)
  scheduleBotTrump(seat) {
    if (!this.isAuto(seat)) return;
    this.after(this.timings.trumpThink, () => {
      if (this.phase !== 'choosing' || !this.isAuto(seat)) return;
      const g = this.g;
      if (this.trumpMode === 'draw') {
        if (g.bid && !g.bid.forced && g.bid.turn === seat) this.bid(seat, E.botTakeTrump(g.hands[seat], g.bid.suit, this.botLevel));
      } else if (g.chooser === seat) this.setTrump(E.botChooseTrump(g.hands[seat], this.botLevel));
    });
  }

  setTrump(suit, msg) {
    if (this.phase !== 'choosing' || !E.SUITS.includes(suit)) return;
    const g = this.g;
    g.trump = suit;
    this.curDeal().trump = suit;
    this.curDeal().declarer = g.declarer;
    g.hands.forEach(h => h.sort(E.handComparator(suit)));
    this.phase = 'playing';
    this.addLog('deal', msg || `Trump is ${sym(suit)} — chosen by ${this.name(g.chooser)}.`);
    this.broadcast();
    this.nextTurn();
  }

  nextTurn() {
    if (this.phase !== 'playing') return;
    this.broadcast();
    const seat = this.g.turn;
    if (this.isAuto(seat)) this.after(this.timings.botThink, () => {
      // re-validate: state may have moved on, or a human may have reconnected to this seat
      if (this.phase !== 'playing' || this.g.turn !== seat || !this.isAuto(seat)) return;
      if (!this.g.hands[seat].length) return;
      if (this.canCallRoem(seat)) this.callRoem(seat);   // bots always call their hand roem
      const card = E.chooseBotCard(seat, this.g.hands[seat], this.g.trick, this.g.trump, { level: this.botLevel, played: this.g.played, chooser: this.g.declarer, leader: this.g.chooser, calledRoem: this.g.calledRoem });
      if (card) this.doPlay(seat, card);
    });
  }

  // Hand roem can be called once, any time after trump is set and before the
  // holder plays their first card of the deal.
  canCallRoem(seat) {
    const g = this.g;
    return this.handRoem && this.phase === 'playing' && seat >= 0 && !g.roemCalled[seat] &&
      g.hands[seat].length === 8 && E.handRoem(g.hands[seat], g.trump).roem > 0;
  }
  callRoem(seat) {
    if (!this.canCallRoem(seat)) return;
    const g = this.g, tm = E.teamOf(seat), { roem, labels, announce } = E.handRoem(g.hands[seat], g.trump);
    g.roemCalled[seat] = true;
    this.curDeal().roemCalls.push({ seat, roem, labels, auto: this.isAuto(seat), t: Date.now(), afterPlays: this.curDeal().plays.length });
    g.dealRoem[tm] += roem; g.calledRoem[tm] += roem;
    this.addLog('roem', `${this.name(seat)} calls roem +${roem}: ${announce.join(', ')}.`);   // suits stay hidden
    this.broadcast();
  }

  // returns error string or null
  play(playerId, cid) {
    const seat = this.seatOf(playerId);
    if (seat < 0) return 'not seated';
    if (this.phase !== 'playing') return 'not in play';
    if (this.g.turn !== seat) return 'not your turn';
    const card = this.g.hands[seat].find(c => E.cardId(c) === cid);
    if (!card) return 'card not in hand';
    const legal = E.legalMoves(this.g.hands[seat], this.g.trick, this.g.trump);
    if (!legal.some(c => E.cardId(c) === cid)) return 'illegal move';
    this.doPlay(seat, card);
    return null;
  }

  doPlay(seat, card) {
    if (!card || this.phase !== 'playing' || this.g.turn !== seat) return;
    const g = this.g, h = g.hands[seat];
    const i = h.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (i < 0) return;
    // record the move with the legal set it was chosen from; flag anything outside it
    const legal = E.legalMoves(h, g.trick, g.trump).map(E.cardId), cid = E.cardId(card);
    const rec = { trick: g.trickNo + 1, seat, card: cid, auto: this.isAuto(seat), legal, t: Date.now() };
    if (!legal.includes(cid)) { rec.illegal = true; this.note('illegalMove', { deal: g.deal, seat, card: cid, legal }); }
    this.curDeal().plays.push(rec);
    h.splice(i, 1);
    g.trick.push({ seat, card });
    g.played.push(card);                  // deal history for card-counting (hard bots)
    if (g.trick.length < 4) {
      g.turn = (seat + 1) % 4;
      this.nextTurn();
    } else {
      g.resolving = true;                 // trick full: nobody is "on turn" until it's cleared
      this.broadcast();                   // show the completed 4-card trick during the linger
      this.after(this.timings.trickLinger, () => this.resolveTrick());
    }
  }

  resolveTrick() {
    const g = this.g, tr = g.trump, trick = g.trick, cards = trick.map(t => t.card);
    const winner = E.trickWinnerSeat(trick, tr), tm = E.teamOf(winner);
    const pts = cards.reduce((s, c) => s + E.cardVal(c, tr), 0);
    const { roem, labels } = E.computeRoem(cards, tr);
    g.dealCard[tm] += pts; g.dealRoem[tm] += roem; g.tricksWon[tm]++;
    g.trickNo++;
    this.curDeal().tricks.push({ n: g.trickNo, leader: trick[0].seat, cards: trick.map(t => E.cardId(t.card)), winner, pts, roem, labels });
    let msg = `Trick ${g.trickNo}: ${this.name(winner)} wins (${pts} pts).`;
    if (roem) msg += ` Roem +${roem}: ${labels.join(', ')}.`;
    this.addLog(roem ? 'roem' : '', msg);
    if (g.trickNo === 8) {
      g.dealCard[tm] += 10;
      this.addLog('', `Last trick +10 to ${TEAM[tm]}.`);
      // leave g.resolving true so no seat is on turn during the pause; trick stays visible
      this.broadcast();
      this.after(600, () => this.scoreDeal());
    } else {
      g.trick = [];
      g.resolving = false;
      g.leader = winner; g.turn = winner;
      this.nextTurn();                    // fresh broadcast: empty trick, winner leads, correct legal
    }
  }

  scoreDeal() {
    const g = this.g;
    const play = E.teamOf(g.declarer), opp = 1 - play;
    const pitPlay = g.tricksWon[play] === 8, pitOpp = g.tricksWon[opp] === 8;
    let playPts = g.dealCard[play] + g.dealRoem[play] + (pitPlay ? 100 : 0);
    let oppPts = g.dealCard[opp] + g.dealRoem[opp] + (pitOpp ? 100 : 0);
    const totalRoem = g.dealRoem[0] + g.dealRoem[1];
    const awarded = [0, 0];
    let nat = false;
    if (playPts > oppPts) { awarded[play] = playPts; awarded[opp] = oppPts; }
    else { nat = true; awarded[opp] = 162 + totalRoem + (pitOpp ? 100 : 0); awarded[play] = 0; }
    g.cumulative[0] += awarded[0];
    g.cumulative[1] += awarded[1];
    const madeTxt = nat
      ? `${TEAM[play]} went <span class="lose">NAT</span> — ${TEAM[opp]} take everything.`
      : `${TEAM[play]} <span class="win">made it</span>.`;
    this.addLog(nat ? 'nat' : 'deal',
      `Deal ${g.deal}: ${TEAM[play]} ${playPts} vs ${TEAM[opp]} ${oppPts}. ${madeTxt}` + ((pitPlay || pitOpp) ? ' <b>PIT +100</b>!' : ''));
    g.lastResult = {
      deal: g.deal, play, opp, playPts, oppPts, nat, pitPlay, pitOpp, awarded, totalRoem,
      trump: g.trump, chooser: g.declarer, cumulative: g.cumulative.slice(),
    };
    this.curDeal().result = Object.assign({ dealCard: g.dealCard.slice(), dealRoem: g.dealRoem.slice(), tricksWon: g.tricksWon.slice() }, g.lastResult);
    this.phase = g.deal >= this.matchDeals ? 'matchover' : 'scored';
    this.broadcast();
    if (this.phase === 'scored') this.after(this.timings.dealAuto, () => this.advance());
  }

  advance() {
    if (this.advanced || this.phase !== 'scored') return;
    this.advanced = true;
    this.newDeal();
  }
  newMatch() {
    if (this.phase !== 'matchover') return;
    this.clearTimers();
    this.startGame();
  }

  /* ============================================================
                     INBOUND EVENT DISPATCH
     Both transports funnel in-room actions here so the rules stay in one place.
     ============================================================ */
  handle(playerId, event, data) {
    data = data || {};
    switch (event) {
      case 'start':
        if (this.phase === 'lobby' && this.hostId === playerId) this.startGame();
        break;
      case 'setDifficulty':
        if (this.hostId === playerId && this.phase === 'lobby' && ['easy', 'normal', 'hard', 'family'].includes(data.level)) {
          this.botLevel = data.level; this.broadcast();
        }
        break;
      case 'setHandRoem':
        if (this.hostId === playerId && this.phase === 'lobby') { this.handRoem = !!data.on; this.broadcast(); }
        break;
      case 'callRoem':
        this.callRoem(this.seatOf(playerId));
        break;
      case 'claimSeat':
        if (this.claimSeat(playerId, data.seat)) this.broadcast();
        break;
      case 'chooseTrump':
        if (this.phase === 'choosing' && this.trumpMode === 'choose' && this.seatOf(playerId) === this.g.chooser) this.setTrump(data.suit);
        break;
      case 'bid':
        this.bid(this.seatOf(playerId), !!data.take);
        break;
      case 'setTrumpMode':
        if (this.hostId === playerId && this.phase === 'lobby' && ['choose', 'draw'].includes(data.mode)) { this.trumpMode = data.mode; this.broadcast(); }
        break;
      case 'play': {
        const err = this.play(playerId, data.cardId);
        if (err) this.send(playerId, 'error', { msg: err });
        break;
      }
      case 'next': this.advance(); break;
      case 'newMatch': this.newMatch(); break;
      default: break;
    }
  }

  /* ============================================================
                        STATE BROADCAST
     ============================================================ */
  broadcast() {
    for (const s of this.seats) {
      if (s && !s.isBot && s.connected) this.send(s.playerId, 'state', this.viewFor(this.seatOf(s.playerId)));
    }
    for (const pid of this.spectators.keys()) this.send(pid, 'state', this.viewFor(-1));
    if (this.onChange) { try { this.onChange(); } catch (e) {} }
  }

  /* ============================================================
                 SAVE / RESUME + DEBUG EXPORT
     snapshot() is plain JSON (cards are {suit,rank}), so the host can keep it in
     localStorage and resume the same table after a reload or crash.
     ============================================================ */
  snapshot() {
    return {
      v: 1, savedAt: Date.now(), code: this.code, phase: this.phase, hostId: this.hostId,
      seats: this.seats, tokens: [...this.tokens], botLevel: this.botLevel, handRoem: this.handRoem, trumpMode: this.trumpMode,
      matchDeals: this.matchDeals, match: this.match, advanced: this.advanced,
      log: this.log, g: this.g, history: this.history, events: this.events,
    };
  }
  restore(snap) {
    Object.assign(this, {
      code: snap.code, phase: snap.phase, hostId: snap.hostId, seats: snap.seats,
      tokens: new Map(snap.tokens), botLevel: snap.botLevel, handRoem: !!snap.handRoem, trumpMode: snap.trumpMode || 'choose',
      matchDeals: snap.matchDeals, match: snap.match, advanced: snap.advanced,
      log: snap.log || [], g: snap.g, history: snap.history || [], events: snap.events || [],
    });
  }
  // Restart the game clock after restore(): every remote player starts disconnected
  // (bots cover them until they reconnect) and whatever timer was pending re-arms.
  resume() {
    this.clearTimers();
    for (const s of this.seats) if (s && !s.isBot && s.playerId !== this.hostId) s.connected = false;
    this.note('resume', { phase: this.phase });
    this.addLog('', 'Table resumed by the host.');
    const g = this.g;
    if (this.phase === 'playing') {
      if (g.resolving && g.trickNo === 8) this.after(600, () => this.scoreDeal());
      else if (g.resolving) this.after(this.timings.trickLinger, () => this.resolveTrick());
      else this.nextTurn();
    } else if (this.phase === 'choosing') {
      this.scheduleBotTrump(this.trumpMode === 'draw' && g.bid ? g.bid.turn : g.chooser);
    } else if (this.phase === 'scored') {
      this.after(this.timings.dealAuto, () => this.advance());
    }
    this.broadcast();
  }

  // Everything needed to replay/debug the match: settings, seats, every deal's
  // starting hands, each card played (with the legal set it came from), roem
  // calls, trick results, scores, and connection events. Plus a readable digest.
  export(meta) {
    const S = id => { const m = /^(clubs|diamonds|hearts|spades)(.+)$/.exec(id); return m ? m[2] + SYM[m[1]] : id; };
    const P = s => SEAT_LABEL[s][0];
    const readable = [];
    for (const d of this.history) {
      readable.push(`Match ${d.match} · Deal ${d.deal}: dealer ${P(d.dealer)}, ${P(d.chooser)} leads, ` +
        (d.trumpMode === 'draw' ? `bids ${(d.bids || []).map(b => P(b.seat) + (b.take ? ' plays ' : ' passes ') + SYM[b.suit]).join(', ') || '-'}, ` : '') +
        `${d.declarer != null ? P(d.declarer) : P(d.chooser)} declared ${d.trump ? SYM[d.trump] : '(none yet)'}`);
      d.hands.forEach((h, s) => readable.push(`  ${P(s)} hand: ${h.map(S).join(' ')}`));
      d.roemCalls.forEach(r => readable.push(`  ${P(r.seat)} calls roem +${r.roem} (${r.labels.join(', ')})`));
      for (let n = 1; n <= 8; n++) {
        const ps = d.plays.filter(p => p.trick === n); if (!ps.length) break;
        const t = d.tricks.find(x => x.n === n);
        readable.push(`  T${n}: ` + ps.map(p => `${P(p.seat)} ${S(p.card)}${p.auto ? '' : '*'}${p.illegal ? ' [ILLEGAL]' : ''}`).join(', ') +
          (t ? ` → ${P(t.winner)} wins ${t.pts}${t.roem ? ' +' + t.roem + ' roem' : ''}` : ''));
      }
      if (d.result) readable.push(`  Result: ${d.result.playPts} vs ${d.result.oppPts}${d.result.nat ? ' NAT' : ''} → total ${d.result.cumulative.join(' : ')}`);
    }
    return Object.assign({
      format: 'klaverjassen-debug/1', exportedAt: new Date().toISOString(),
      note: 'Seats: 0 South, 1 West, 2 North, 3 East. "*" in readable = played by a human; legal = cards allowed at that moment.',
      code: this.code, phase: this.phase, botLevel: this.botLevel, handRoem: this.handRoem, trumpMode: this.trumpMode,
      seats: this.seats.map((s, i) => s && { seat: i, label: SEAT_LABEL[i], name: s.name, isBot: s.isBot, connected: s.connected }),
      events: this.events, history: this.history, readable,
    }, meta || {});
  }

  viewFor(mySeat) {
    const g = this.g;
    const seats = this.seats.map((s, i) => ({
      seat: i, label: SEAT_LABEL[i],
      name: s ? s.name : '(open)',
      isBot: s ? s.isBot : false,
      connected: s ? s.connected : false,
      present: !!s,
      team: E.teamOf(i),
      cardCount: g && g.hands ? g.hands[i].length : 0,
      isHost: s && s.playerId === this.hostId,
    }));
    const base = {
      code: this.code, phase: this.phase, mySeat,
      seats, hostSeat: this.seatOf(this.hostId),
      log: this.log.slice(-40),
      canStart: this.phase === 'lobby',
      botLevel: this.botLevel,
      handRoem: this.handRoem,
      trumpMode: this.trumpMode,
    };
    if (mySeat >= 0 && this.seats[mySeat]) base.token = this.tokens.get(this.seats[mySeat].playerId);
    if (!g) return base;
    const mine = (mySeat >= 0 && g.hands) ? g.hands[mySeat].map(c => ({ suit: c.suit, rank: c.rank, id: E.cardId(c) })) : [];
    let legal = [];
    if (this.phase === 'playing' && !g.resolving && mySeat === g.turn && mySeat >= 0)
      legal = E.legalMoves(g.hands[mySeat], g.trick, g.trump).map(E.cardId);
    return Object.assign(base, {
      deal: g.deal, matchDeals: this.matchDeals,
      trump: g.trump, dealer: g.dealer, chooser: g.chooser,
      turn: g.turn, leader: g.leader, resolving: !!g.resolving,
      trick: g.trick.map(t => ({ seat: t.seat, card: { suit: t.card.suit, rank: t.card.rank, id: E.cardId(t.card) } })),
      cumulative: g.cumulative,
      hand: mine, legal,
      needTrump: this.phase === 'choosing' && this.trumpMode === 'choose' && mySeat === g.chooser,
      declarer: g.declarer,
      bid: g.bid && this.phase === 'choosing' ? { suit: g.bid.suit, turn: g.bid.turn, passes: g.bid.passes } : null,
      needBid: this.phase === 'choosing' && !!g.bid && !g.bid.forced && mySeat >= 0 && mySeat === g.bid.turn,
      lastResult: g.lastResult,
      myRoem: (this.handRoem && this.phase === 'playing' && mySeat >= 0)
        ? Object.assign(E.handRoem(g.hands[mySeat], g.trump), { canCall: this.canCallRoem(mySeat) }) : null,
    });
  }
}

const API = { GameRoom, SEAT_LABEL, TEAM, sym, DEFAULT_MATCH_DEALS, DEFAULT_TIMINGS };

if (typeof module !== 'undefined' && module.exports) module.exports = API;   // Node / server.js
else root.KJGameRoom = API;                                                  // browser (window/self)

})(typeof self !== 'undefined' ? self : this);
