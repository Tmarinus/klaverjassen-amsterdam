/* ============================================================
   Klaverjassen engine simulation tests.

   Runs pure-engine self-play (no server, no browser) and asserts the
   invariants the rest of the project relies on:

     1. Legality      — every bot move at every level is a legal move.
     2. Point total   — card points in a completed deal always sum to 162.
     3. Bot ordering  — strength strictly increases easy < normal < hard < family.

   Strength is compared at the MATCH level (16 deals, cumulative points) — the
   game's actual win unit. Small per-deal edges (e.g. hard over normal is only
   ~50% per single deal) compound over a match into a decisive one, which is what
   players experience, so that's what we gate on. Thresholds sit well below each
   pair's healthy rate; sample sizes give the marginal pair (hard>normal) a wide
   safety margin so a healthy engine passes deterministically enough for CI.

   Exits non-zero on any failure so CI can gate on it.
   Tunable via env: KJ_TEST_DEALS (invariant deals), KJ_TEST_SCALE (multiplies all
   match counts). Defaults are sized for a ~1-minute CI run.
   ============================================================ */
'use strict';

const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

const DEALS = +process.env.KJ_TEST_DEALS || 1500;    // mixed-level invariant deals
const SCALE = +process.env.KJ_TEST_SCALE || 1;       // scales every match count below
const MATCH_DEALS = 16;

// Play one full deal. levelBySeat[seat] is that seat's bot level.
// Returns { award:[team0,team1], illegal, cardTotal }.
function playDeal(levelBySeat, timing) {
  const deck = E.freshDeck();
  const hands = [[], [], [], []];
  for (let i = 0; i < 32; i++) hands[i % 4].push(deck[i]);
  const chooser = Math.floor(Math.random() * 4);
  const trump = E.botChooseTrump(hands[chooser], levelBySeat[chooser]);
  hands.forEach(h => h.sort(E.handComparator(trump)));

  let turn = chooser;
  const played = [];
  const card = [0, 0], roem = [0, 0], won = [0, 0];
  let illegal = 0;

  for (let t = 0; t < 8; t++) {
    const trick = [];
    for (let k = 0; k < 4; k++) {
      const seat = turn;
      const legal = E.legalMoves(hands[seat], trick, trump);
      const t0 = timing ? process.hrtime.bigint() : 0n;
      const c = E.chooseBotCard(seat, hands[seat], trick, trump,
        { level: levelBySeat[seat], played, chooser });
      if (timing) { const dt = Number(process.hrtime.bigint() - t0) / 1e6; timing.n++; timing.sum += dt; timing.max = Math.max(timing.max, dt); }
      if (!c || !legal.some(x => E.cardId(x) === E.cardId(c))) illegal++;
      const idx = hands[seat].findIndex(x => x.suit === c.suit && x.rank === c.rank);
      hands[seat].splice(idx, 1);
      trick.push({ seat, card: c });
      played.push(c);
      turn = (seat + 1) % 4;
    }
    const w = E.trickWinnerSeat(trick, trump), tm = E.teamOf(w);
    card[tm] += trick.reduce((s, x) => s + E.cardVal(x.card, trump), 0);
    roem[tm] += E.computeRoem(trick.map(x => x.card), trump).roem;
    won[tm]++;
    if (t === 7) card[tm] += 10;
    turn = w;
  }

  const play = E.teamOf(chooser), opp = 1 - play;
  const pitPlay = won[play] === 8, pitOpp = won[opp] === 8;
  const playPts = card[play] + roem[play] + (pitPlay ? 100 : 0);
  const oppPts = card[opp] + roem[opp] + (pitOpp ? 100 : 0);
  const totalRoem = roem[0] + roem[1];
  const award = [0, 0];
  if (playPts > oppPts) { award[play] = playPts; award[opp] = oppPts; }
  else { award[opp] = 162 + totalRoem + (pitOpp ? 100 : 0); award[play] = 0; }
  return { award, illegal, cardTotal: card[0] + card[1] };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
  if (!ok) failures++;
}

/* ---- 1 & 2: legality + 162-point invariant on a mixed table ---- */
(function invariants() {
  const levels = ['easy', 'normal', 'hard', 'family'];
  let illegal = 0, badTotal = 0;
  for (let i = 0; i < DEALS; i++) {
    const r = playDeal(levels);          // one seat of each level
    illegal += r.illegal;
    if (r.cardTotal !== 162) badTotal++;
  }
  check(`legality (${DEALS} mixed deals)`, illegal === 0, `${illegal} illegal moves`);
  check(`162-point total (${DEALS} mixed deals)`, badTotal === 0, `${badTotal} deals off 162`);
})();

/* ---- Amsterdam obligations: hand-built positions with a known answer ---- */
(function amsterdamRules() {
  const C = (suit, rank) => ({ suit, rank });
  const ids = cs => cs.map(E.cardId).sort().join(',');
  const T = 'hearts';
  // seat 3 to play, void in clubs, holding the 7 and Q of trump and two spades
  const hand = [C('hearts', '7'), C('hearts', 'Q'), C('spades', 'A'), C('spades', '8')];
  const spades = [hand[2], hand[3]];
  const onlyTrumps = [C('hearts', '7'), C('hearts', 'Q')];
  const cases = [
    // partner (seat 1) winning with a plain card, no trump down: free choice
    ['partner winning, no trump down', hand, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('clubs', 'A') }, { seat: 2, card: C('clubs', '7') }], hand],
    // partner trumped with the K: no need to trump, but no undertrumping either
    ['partner trumped', hand, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('hearts', 'K') }, { seat: 2, card: C('clubs', '7') }], spades],
    // partner trumped with the 8: may overtrump partner (Q) or play another suit, not the 7
    ['partner trumped low', hand, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('hearts', '8') }, { seat: 2, card: C('clubs', '7') }], [hand[1], hand[2], hand[3]]],
    // opponent winning, no trump down: must trump
    ['opponent winning, no trump down', hand, [{ seat: 0, card: C('clubs', 'A') }, { seat: 1, card: C('clubs', '8') }, { seat: 2, card: C('clubs', '7') }], onlyTrumps],
    // opponent trumped with the K, can't overtrump: must play another suit
    ['opponent trumped, cannot overtrump', hand, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('clubs', '7') }, { seat: 2, card: C('hearts', 'K') }], spades],
    // opponent trumped with the 8: must overtrump with the Q
    ['opponent trumped, can overtrump', hand, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('clubs', '7') }, { seat: 2, card: C('hearts', '8') }], [hand[1]]],
    // nothing but (lower) trumps: undertrumping is then forced
    ['only lower trumps left', onlyTrumps, [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('clubs', '7') }, { seat: 2, card: C('hearts', 'K') }], onlyTrumps],
    // partner trumped with the K, I hold only trumps (Q and A): no need to overtrump partner, either is fine
    ['partner trumped, only trumps', [C('hearts', 'Q'), C('hearts', 'A')], [{ seat: 0, card: C('clubs', '8') }, { seat: 1, card: C('hearts', 'K') }, { seat: 2, card: C('clubs', '7') }], [C('hearts', 'Q'), C('hearts', 'A')]],
    // trump led, can't go higher: must still follow trump
    ['trump led, cannot go higher', hand, [{ seat: 0, card: C('hearts', 'J') }, { seat: 1, card: C('hearts', '8') }, { seat: 2, card: C('hearts', '9') }], onlyTrumps],
  ];
  let bad = [];
  for (const [name, h, trick, want] of cases)
    if (ids(E.legalMoves(h, trick, T)) !== ids(want)) bad.push(name);
  check('Amsterdam obligations (hand-built positions)', bad.length === 0, bad.length ? 'wrong: ' + bad.join('; ') : `${cases.length} cases`);
})();

/* ---- roem in hand: counting + calling rules ---- */
(function handRoemRules() {
  const C = (suit, rank) => ({ suit, rank });
  const bad = [];
  const want = (name, cards, trump, pts) => { const r = E.handRoem(cards, trump).roem; if (r !== pts) bad.push(`${name} (${r}, want ${pts})`); };
  // the 9 Q K 10 A of spades from the bug report: Q-K-A is a run of 3 (9 and 10 aren't adjacent)
  want('Q-K-A + loose 9, 10', [C('spades', '9'), C('spades', 'Q'), C('spades', 'K'), C('spades', '10'), C('spades', 'A')], 'hearts', 20);
  want('two runs in one suit', [C('spades', '7'), C('spades', '8'), C('spades', '9'), C('spades', 'Q'), C('spades', 'K'), C('spades', 'A')], 'hearts', 40);
  want('run of 4', [C('clubs', '9'), C('clubs', '10'), C('clubs', 'J'), C('clubs', 'Q')], 'hearts', 50);
  want('run of 5', [C('clubs', '9'), C('clubs', '10'), C('clubs', 'J'), C('clubs', 'Q'), C('clubs', 'K')], 'hearts', 100);
  want('stuk + trump run', [C('hearts', 'J'), C('hearts', 'Q'), C('hearts', 'K')], 'hearts', 40);
  want('K-Q not trump', [C('spades', 'Q'), C('spades', 'K')], 'hearts', 0);
  want('four Jacks', ['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, 'J')), 'hearts', 200);
  want('four Aces + clubs run', ['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, 'A')).concat([C('clubs', 'K'), C('clubs', 'Q')]), 'spades', 120);
  want('four Tens score nothing', ['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, '10')), 'hearts', 0);
  const trickRoem = (cards, tr) => E.computeRoem(cards, tr).roem;
  if (trickRoem(['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, 'J')), 'hearts') !== 200) bad.push('trick of four Jacks not 200');
  if (trickRoem(['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, 'K')), 'hearts') !== 100) bad.push('trick of four Kings not 100');
  if (!/^four of a kind \+200$/.test(E.handRoem(['clubs', 'diamonds', 'hearts', 'spades'].map(x => C(x, 'J')), 'hearts').announce.join())) bad.push('four of a kind announcement reveals rank');

  // calling: only once, only before your first card, and only when the host enabled it
  const R = require(path.join(__dirname, '..', 'game-room.js'));
  const room = new R.GameRoom('T', { handRoem: true, timings: { botThink: 1e9, trumpThink: 1e9, trickLinger: 1e9, dealAuto: 1e9 } });
  room.addHuman('me', 'Me'); room.startGame(); room.clearTimers();
  const g = room.g, seat = 0, tm = E.teamOf(seat);
  g.hands[seat] = [C('spades', 'Q'), C('spades', 'K'), C('spades', 'A'), C('clubs', '7'), C('clubs', '9'), C('diamonds', '7'), C('diamonds', '9'), C('hearts', '8')];
  g.chooser = g.turn = g.leader = seat; room.phase = 'choosing'; room.setTrump('hearts'); room.clearTimers();
  const before = g.dealRoem[tm];
  if (!room.viewFor(seat).myRoem.canCall) bad.push('canCall false before first card');
  room.handle('me', 'callRoem'); room.handle('me', 'callRoem');
  if (g.dealRoem[tm] - before !== 20) bad.push(`call scored ${g.dealRoem[tm] - before}, want 20 once`);
  const callLog = room.log.map(e => e.html).find(h => /calls roem/.test(h)) || '';
  if (!/run of 3 \+20/.test(callLog) || /[♣♦♥♠]/.test(callLog)) bad.push(`announcement reveals suit or is wrong: "${callLog}"`);
  const room2 = new R.GameRoom('U', { handRoem: true, timings: room.timings });
  room2.addHuman('me', 'Me'); room2.startGame(); room2.clearTimers();
  room2.g.hands[0] = g.hands[0].slice(); room2.g.chooser = room2.g.turn = room2.g.leader = 0;
  room2.phase = 'choosing'; room2.setTrump('hearts'); room2.clearTimers();
  room2.handle('me', 'play', { cardId: 'clubs7' }); room2.clearTimers();
  room2.handle('me', 'callRoem');
  if (room2.g.dealRoem[0] !== 0) bad.push('call accepted after first card');
  const off = new R.GameRoom('V', { timings: room.timings });
  off.addHuman('me', 'Me'); off.startGame(); off.clearTimers();
  if (off.viewFor(0).handRoem) bad.push('hand roem on by default');
  check('roem in hand (counting + calling)', bad.length === 0, bad.length ? bad.join('; ') : '9 hands, 2 tricks, 3 call checks');
})();

/* ---- resume + debug export: snapshot mid-match through JSON, finish on a new room ---- */
(async function resumeAndExport() {
  const R = require(path.join(__dirname, '..', 'game-room.js'));
  const fast = { botThink: 0, trumpThink: 0, trickLinger: 0, dealAuto: 0 };
  const until = (room, ok) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() { if (ok(room)) return res(); if (Date.now() - t0 > 60000) return rej(new Error('timeout in ' + room.phase)); setTimeout(poll, 1); })();
  });
  const bad = [];
  try {
    const a = new R.GameRoom('RS', { handRoem: true, matchDeals: 4, timings: fast });
    a.addHuman('host', 'Host'); a.seats[0].connected = false;     // host away: bots play it
    a.startGame();
    await until(a, r => r.g.deal === 2 && r.phase === 'playing' && r.g.trickNo === 3);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    a.clearTimers();
    const b = new R.GameRoom('X', { timings: fast });
    b.restore(snap); b.resume();
    await until(b, r => r.phase === 'matchover');
    const ex = b.export();
    if (ex.history.length !== 4) bad.push(`${ex.history.length} deals recorded, want 4`);
    for (const d of ex.history) {
      const pts = d.tricks.reduce((x, t) => x + t.pts, 0) + 10;
      if (pts !== 162) bad.push(`deal ${d.deal}: ${pts} card pts`);
      if (d.plays.length !== 32) bad.push(`deal ${d.deal}: ${d.plays.length} plays`);
      if (d.plays.some(p => p.illegal)) bad.push(`deal ${d.deal}: illegal move flagged`);
    }
    if (!ex.events.some(e => e.type === 'resume')) bad.push('resume not logged');
    if (!ex.readable.some(l => / T8: /.test(l))) bad.push('readable digest missing tricks');
    if (JSON.stringify(ex).includes(snap.tokens[0][1])) bad.push('export leaks seat token');
  } catch (e) { bad.push(e.message); }
  check('resume from snapshot + debug export', bad.length === 0, bad.length ? bad.join('; ') : '4-deal match resumed mid-trick, 162/deal, 0 illegal');
})().then(drawTrumpMode).then(seatLevels).then(autoNext).then(strength);

/* ---- draw-trump mode: play/pass round, forced redraw, first player still leads ---- */
async function drawTrumpMode() {
  const R = require(path.join(__dirname, '..', 'game-room.js'));
  const slow = { botThink: 1e9, trumpThink: 1e9, trickLinger: 1e9, dealAuto: 1e9 };
  const bad = [];
  const fresh = (timings = slow) => {
    const r = new R.GameRoom('D', { trumpMode: 'draw', timings });
    ['a', 'b', 'c', 'd'].forEach(id => r.addHuman(id, id));
    r.startGame(); r.clearTimers(); return r;
  };
  const pid = (r, seat) => r.seats[seat].playerId;
  // everyone passes -> a different suit, first player declares and leads
  let r = fresh(Object.assign({}, slow, { trumpThink: 0 })); const first = r.g.chooser, s1 = r.g.bid.suit;   // all seats human: trumpThink only times the all-pass pause
  if (r.g.bid.turn !== first) bad.push('bidding did not start with the first player');
  r.handle(pid(r, (first + 1) % 4), 'bid', { take: true });                     // out of turn: ignored
  if (r.phase !== 'choosing') bad.push('out-of-turn bid accepted');
  for (let k = 0; k < 4; k++) r.handle(pid(r, (first + k) % 4), 'bid', { take: false });
  if (r.phase !== 'choosing' || r.g.bid.turn !== null) bad.push('no pause after the fourth pass');
  if (r.handle(pid(r, first), 'bid', { take: true }), r.phase !== 'choosing') bad.push('bid accepted during the all-pass pause');
  await new Promise(res => setTimeout(res, 5));
  r.clearTimers();
  if (r.phase !== 'playing' || r.g.declarer !== first || r.g.trump === s1 || r.g.turn !== first)
    bad.push(`all-pass: phase ${r.phase}, declarer ${r.g.declarer}, trump ${r.g.trump} (passed ${s1}), turn ${r.g.turn}`);
  // third player takes -> their team declares, the first player still leads
  r = fresh(); const f2 = r.g.chooser, s2 = r.g.bid.suit;
  r.handle(pid(r, f2), 'bid', { take: false }); r.handle(pid(r, (f2 + 1) % 4), 'bid', { take: false });
  r.handle(pid(r, (f2 + 2) % 4), 'bid', { take: true }); r.clearTimers();
  if (r.g.declarer !== (f2 + 2) % 4 || r.g.trump !== s2 || r.g.turn !== f2) bad.push(`take: declarer ${r.g.declarer}, trump ${r.g.trump}, turn ${r.g.turn}`);
  if (r.handle(pid(r, f2), 'chooseTrump', { suit: 'clubs' }), r.g.trump !== s2) bad.push('chooseTrump worked in draw mode');
  // full bot matches in draw mode: scoring follows the declarer, not the leader
  const fast = { botThink: 0, trumpThink: 0, trickLinger: 0, dealAuto: 0 };
  for (const level of ['easy', 'hard']) {
    const m = new R.GameRoom('M', { trumpMode: 'draw', botLevel: level, matchDeals: 8, timings: fast });
    m.startGame();
    await new Promise((res, rej) => { const t0 = Date.now(); (function poll() { if (m.phase === 'matchover') return res(); if (Date.now() - t0 > 60000) return rej(new Error('draw match timeout')); setTimeout(poll, 1); })(); });
    for (const d of m.history) {
      if (d.plays[0].seat !== d.chooser) bad.push(`${level} deal ${d.deal}: first lead by ${d.plays[0].seat}, not ${d.chooser}`);
      if (d.result.play !== E.teamOf(d.declarer)) bad.push(`${level} deal ${d.deal}: scored for team ${d.result.play}, declarer ${d.declarer}`);
    }
  }
  check('draw-trump mode (pass round, redraw, leader vs declarer)', bad.length === 0, bad.length ? bad.join('; ') : 'all-pass, take, 2 bot matches');
}

/* ---- per-seat bot levels: each bot plays its own level, host can change one mid-match ---- */
async function seatLevels() {
  const R = require(path.join(__dirname, '..', 'game-room.js'));
  const fast = { botThink: 0, trumpThink: 0, trickLinger: 0, dealAuto: 0 };
  const bad = [], seen = [new Set(), new Set(), new Set(), new Set()];
  const orig = E.chooseBotCard;
  E.chooseBotCard = (seat, hand, trick, trump, opts) => { seen[seat].add(opts.level); return orig(seat, hand, trick, trump, opts); };
  try {
    const m = new R.GameRoom('L', { botLevel: 'normal', seatLevels: [null, 'easy', 'hard', 'bogus'], matchDeals: 4, timings: fast });
    m.addHuman('h', 'Host'); m.seats[0].connected = false;           // away host: covered at the table default
    if (m.seatLevels[3] !== null) bad.push('unknown level accepted');
    m.handle('x', 'setSeatLevel', { seat: 1, level: 'family' });        // not the host: ignored
    if (m.levelOf(1) !== 'easy') bad.push('non-host changed a bot level');
    m.startGame();
    await new Promise(res => (function poll() { if (m.curDeal() && m.curDeal().plays.length >= 8) return res(); setTimeout(poll, 1); })());
    m.handle('h', 'setSeatLevel', { seat: 3, level: 'family' });        // mid-match change
    const snap = JSON.parse(JSON.stringify(m.snapshot()));
    await new Promise((res, rej) => { const t0 = Date.now(); (function poll() { if (m.phase === 'matchover') return res(); if (Date.now() - t0 > 60000) return rej(new Error('match timeout')); setTimeout(poll, 1); })(); });
    const got = seen.map(x => [...x].sort().join('+'));
    if (got[0] !== 'normal' || got[1] !== 'easy' || got[2] !== 'hard' || got[3] !== 'family+normal') bad.push(`levels used per seat: ${got.join(' / ')}`);
    const r = new R.GameRoom('L', {}); r.restore(snap);
    if (r.levelOf(1) !== 'easy' || r.levelOf(3) !== 'family') bad.push('seat levels lost on resume');
    if (m.viewFor(0).seats[2].level !== 'hard') bad.push('view lacks seat level');
  } catch (e) { bad.push(e.message); }
  E.chooseBotCard = orig;
  check('per-seat bot levels', bad.length === 0, bad.length ? bad.join('; ') : 'away host normal, W easy, N hard, E normal→family mid-match, survives resume');
}

async function autoNext() {
  const R = require(path.join(__dirname, '..', 'game-room.js'));
  const fast = { botThink: 0, trumpThink: 0, trickLinger: 0, dealAuto: 0 };
  const bad = [];
  const until = (cond, ms = 20000) => new Promise((res, rej) => { const t0 = Date.now(); (function poll() { if (cond()) return res(); if (Date.now() - t0 > ms) return rej(new Error('timeout')); setTimeout(poll, 1); })(); });
  const wait = ms => new Promise(res => setTimeout(res, ms));
  try {
    const m = new R.GameRoom('A', { autoNext: false, matchDeals: 3, timings: fast });
    m.addHuman('h', 'Host'); m.seats[0].connected = false;           // a bot covers the host's cards
    m.startGame();
    await until(() => m.phase === 'scored');
    await wait(30);
    if (m.phase !== 'scored' || m.g.deal !== 1) bad.push('advanced by itself while off');
    if (m.viewFor(0).autoNext !== false) bad.push('view lacks autoNext');
    m.handle('h', 'next', {});                                        // the Next deal button still works
    if (m.g.deal !== 2) bad.push('Next deal did not advance');
    await until(() => m.phase === 'scored');
    m.handle('x', 'setAutoNext', { on: true });                       // not the host: ignored
    await wait(30);
    if (m.g.deal !== 2 || m.autoNext) bad.push('non-host changed autoNext');
    const snap = JSON.parse(JSON.stringify(m.snapshot()));
    m.handle('h', 'setAutoNext', { on: true });                       // switched on while the result shows: continues
    await until(() => m.g.deal === 3);
    const r = new R.GameRoom('A', {}); r.restore(snap);
    if (r.autoNext !== false) bad.push('autoNext lost on resume');
    m.clearTimers(); r.clearTimers();
  } catch (e) { bad.push(e.message); }
  check('auto next deal option', bad.length === 0, bad.length ? bad.join('; ') : 'off waits for Next deal, host-only, switching on mid-result continues, survives resume');
}

function strength() {
/* ---- 3: strength ordering easy < normal < hard < family (match level) ---- */
// One 16-deal match: strong = team 0, weak = team 1. Returns the cumulative points.
function playMatch(strong, weak, timing) {
  const lv = [strong, weak, strong, weak];
  const cum = [0, 0];
  for (let d = 0; d < MATCH_DEALS; d++) {
    const a = playDeal(lv, timing).award;
    cum[0] += a[0]; cum[1] += a[1];
  }
  return cum;
}
function matchDuel(strong, weak, matches) {
  const timing = { n: 0, sum: 0, max: 0 };
  let sWins = 0, decided = 0;
  for (let i = 0; i < matches; i++) {
    const c = playMatch(strong, weak, timing);
    if (c[0] === c[1]) continue;
    decided++;
    if (c[0] > c[1]) sWins++;
  }
  return { rate: sWins / decided, decided, timing };
}

// [strong, weak, matches, threshold] — threshold is the min match-win share for the
// stronger tier, set with margin below its healthy rate (hard>normal ~54%, the
// marginal pair, gets the most matches; family pairs get fewer as family is costly).
const PAIRS = [
  ['normal', 'easy',   Math.round(250  * SCALE), 0.55],
  ['hard',   'normal', Math.round(2400 * SCALE), 0.505],   // true rate ~53% under Amsterdam rules: needs the big sample
  ['family', 'hard',   Math.round(120  * SCALE), 0.62],
];
for (const [strong, weak, matches, thr] of PAIRS) {
  const { rate, decided, timing } = matchDuel(strong, weak, matches);
  const pct = (100 * rate).toFixed(1);
  const timed = (strong === 'family' || weak === 'family')
    ? `, avg move ~${(timing.sum / timing.n).toFixed(2)}ms (max ${timing.max.toFixed(1)}ms)` : '';
  check(`${strong} > ${weak} (match level)`, rate > thr, `${pct}% of ${decided} matches, need >${(100 * thr).toFixed(1)}%${timed}`);
}

console.log(`\n${failures ? failures + ' check(s) FAILED' : 'All checks passed.'}`);
process.exit(failures ? 1 : 0);
}
