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
    // trump led, can't go higher: must still follow trump
    ['trump led, cannot go higher', hand, [{ seat: 0, card: C('hearts', 'J') }, { seat: 1, card: C('hearts', '8') }, { seat: 2, card: C('hearts', '9') }], onlyTrumps],
  ];
  let bad = [];
  for (const [name, h, trick, want] of cases)
    if (ids(E.legalMoves(h, trick, T)) !== ids(want)) bad.push(name);
  check('Amsterdam obligations (hand-built positions)', bad.length === 0, bad.length ? 'wrong: ' + bad.join('; ') : `${cases.length} cases`);
})();

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
  ['hard',   'normal', Math.round(1200 * SCALE), 0.505],
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
