/* ============================================================
   Klaverjassen rules engine — Amsterdam rules (server-authoritative)
   Pure functions, no I/O. Shared by server.js.
   Verified against a 20k-deal simulation (0 illegal moves, points
   always total 162).
   Runs in Node (server.js) and in the browser (mobile app host/solo).
   ============================================================ */
;(function (root) {
'use strict';

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEQ   = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];   // order for roem runs

const TRUMP_VAL = { J: 20, 9: 14, A: 11, '10': 10, K: 4, Q: 3, 8: 0, 7: 0 };
const PLAIN_VAL = { A: 11, '10': 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
const TRUMP_STR = { J: 8, 9: 7, A: 6, '10': 5, K: 4, Q: 3, 8: 2, 7: 1 };
const PLAIN_STR = { A: 8, '10': 7, K: 6, Q: 5, J: 4, 9: 3, 8: 2, 7: 1 };

const teamOf = s => s % 2;                       // seats 0,2 -> team 0; 1,3 -> team 1
const cardId = c => c.suit + c.rank;
const cardVal = (c, tr) => (c.suit === tr ? TRUMP_VAL[c.rank] : PLAIN_VAL[c.rank]);

function freshDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* ascending within suit; trump ranks by trump strength once known */
function handComparator(trump) {
  return (a, b) => {
    if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    if (!trump) return SEQ.indexOf(a.rank) - SEQ.indexOf(b.rank);
    const sa = a.suit === trump ? TRUMP_STR[a.rank] : PLAIN_STR[a.rank];
    const sb = b.suit === trump ? TRUMP_STR[b.rank] : PLAIN_STR[b.rank];
    return sa - sb;
  };
}

function winnerIndex(cards, trump) {
  const led = cards[0].suit;
  let bi = 0, bs = -1;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const sc = c.suit === trump ? 100 + TRUMP_STR[c.rank]
             : c.suit === led   ? PLAIN_STR[c.rank]
             : -1;
    if (sc > bs) { bs = sc; bi = i; }
  }
  return bi;
}
function trickWinnerSeat(trick, trump) {
  return trick[winnerIndex(trick.map(t => t.card), trump)].seat;
}

/* ---- Amsterdam legal moves ----
   follow suit (when trump is led: follow and go higher if able). If void:
   - partner currently winning: no obligation to trump — any card, except that
     you may not undertrump a trump already in the trick;
   - otherwise you must trump; with a trump already down you must overtrump if
     able, and if you can't you must play a card of another suit (never undertrump).
   A lower trump is only allowed when you hold nothing but trumps. */
function legalMoves(hand, trick, trump) {
  if (trick.length === 0) return hand.slice();
  const led = trick[0].card.suit;
  const trumpsInTrick = trick.filter(t => t.card.suit === trump).map(t => t.card);
  const highTrump = trumpsInTrick.length ? Math.max(...trumpsInTrick.map(c => TRUMP_STR[c.rank])) : -1;
  const myTrumps = hand.filter(c => c.suit === trump);
  if (led === trump) {
    if (myTrumps.length) {
      const higher = myTrumps.filter(c => TRUMP_STR[c.rank] > highTrump);
      return higher.length ? higher : myTrumps;      // must follow trump, so a lower one when that's all you have
    }
    return hand.slice();
  }
  const hasLed = hand.filter(c => c.suit === led);
  if (hasLed.length) return hasLed;
  if (!myTrumps.length) return hand.slice();
  const higher = myTrumps.filter(c => TRUMP_STR[c.rank] > highTrump);
  const others = hand.filter(c => c.suit !== trump);
  const partner = (trick[0].seat + trick.length + 2) % 4;   // seat to play is leader + trick.length
  if (trickWinnerSeat(trick, trump) === partner) {           // partner winning: free, but no undertrumping
    const ok = others.concat(higher);
    return ok.length ? ok : hand.slice();
  }
  if (trumpsInTrick.length === 0) return myTrumps;           // must trump in
  if (higher.length) return higher;                          // must overtrump
  return others.length ? others : hand.slice();              // can't overtrump: another suit, never undertrump
}

function computeRoem(cards, trump) {
  let roem = 0; const labels = [];
  const SYM = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
  for (const s of SUITS) {
    const idx = cards.filter(c => c.suit === s).map(c => SEQ.indexOf(c.rank)).sort((a, b) => a - b);
    let best = idx.length ? 1 : 0, cur = 1;
    for (let i = 1; i < idx.length; i++) { if (idx[i] === idx[i - 1] + 1) { cur++; best = Math.max(best, cur); } else cur = 1; }
    if (best >= 4) { roem += 50; labels.push(SYM[s] + ' run of 4 +50'); }
    else if (best >= 3) { roem += 20; labels.push(SYM[s] + ' run of 3 +20'); }
  }
  if (cards.some(c => c.suit === trump && c.rank === 'K') && cards.some(c => c.suit === trump && c.rank === 'Q')) {
    roem += 20; labels.push('stuk (trump K-Q) +20');
  }
  return { roem, labels };
}

/* Roem held in a hand (optional "roem in hand" variant): every run of 3+ in a
   suit (3 = 20, 4 = 50, 5+ = 100) plus stuk (trump K+Q = 20). Called before the
   holder's first card; never overlaps trick roem, since one player's cards never
   share a trick. */
function handRoem(cards, trump) {
  let roem = 0; const labels = [];
  const SYM = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
  for (const s of SUITS) {
    const idx = cards.filter(c => c.suit === s).map(c => SEQ.indexOf(c.rank)).sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= idx.length; i++) {
      if (i < idx.length && idx[i] === idx[i - 1] + 1) continue;
      const len = i - start;
      if (len >= 3) {
        const pts = len >= 5 ? 100 : len === 4 ? 50 : 20;
        roem += pts; labels.push(`${SYM[s]} run of ${len} +${pts}`);
      }
      start = i;
    }
  }
  if (trump && cards.some(c => c.suit === trump && c.rank === 'K') && cards.some(c => c.suit === trump && c.rank === 'Q')) {
    roem += 20; labels.push('stuk (trump K-Q) +20');
  }
  return { roem, labels };
}

/* ============================================================
   Bot AI — four difficulty levels: 'easy' | 'normal' | 'hard' | 'family'
   - easy   : plays a random legal card; naive trump pick. Beatable beginner.
   - normal : positional heuristic (lead aces, win cheap, schmear to a winning partner).
   - hard   : normal + card-counting (tracks played cards to know guaranteed
              winners / whether a card is safe, drives trumps, discards to void suits).
   - family : Perfect-Information Monte Carlo search — samples many plausible deals
              of the unseen cards (honouring each opponent's known remaining count and
              revealed voids), plays every candidate out to the end of the deal with a
              fast greedy policy, and picks the card with the best average deal score.
              Strictly stronger than hard; think-time scales with sample count.
   ============================================================ */
const ALL_CARDS = [];
for (const s of SUITS) for (const r of RANKS) ALL_CARDS.push({ suit: s, rank: r });

const valLow  = (arr, tr) => arr.reduce((x, y) => cardVal(x, tr) <= cardVal(y, tr) ? x : y);
const valHigh = (arr, tr) => arr.reduce((x, y) => cardVal(x, tr) >= cardVal(y, tr) ? x : y);
// schmear onto a winning partner: richest non-trump first, so a free discard never wastes a top trump
const schmear = (arr, tr) => { const nonT = arr.filter(c => c.suit !== tr); return valHigh(nonT.length ? nonT : arr, tr); };
const strOf   = (c, tr) => (c.suit === tr ? TRUMP_STR[c.rank] : PLAIN_STR[c.rank]);

function botChooseTrump(hand, level = 'normal') {
  if (level === 'easy') {                           // naive: pick the longest suit
    let best = SUITS[0], bc = -1;
    for (const s of SUITS) { const n = hand.filter(c => c.suit === s).length; if (n > bc) { bc = n; best = s; } }
    return best;
  }
  const strong = level === 'hard' || level === 'family';   // card-counting tiers share the sharper heuristic
  let best = SUITS[0], bs = -Infinity;
  for (const s of SUITS) {
    let sc = 0;
    for (const c of hand) sc += c.suit === s ? TRUMP_VAL[c.rank] + 6 : PLAIN_VAL[c.rank] * 0.3;
    if (hand.some(c => c.suit === s && c.rank === 'J')) sc += strong ? 22 : 15;
    if (hand.some(c => c.suit === s && c.rank === '9')) sc += strong ? 12 : 8;
    const n = hand.filter(c => c.suit === s).length;
    sc += strong ? n * n * 1.5 : n * n;
    if (strong) {                                    // value guaranteed side-suit winners (aces)
      sc += hand.filter(c => c.suit !== s && c.rank === 'A').length * 4;
      if (n < 3) sc -= 6;                            // avoid naming a short trump suit
    }
    if (sc > bs) { bs = sc; best = s; }
  }
  return best;
}

// unseen = cards not in my hand and not yet played (i.e. in the other three hands)
function unseenCards(hand, played) {
  const seen = new Set();
  hand.forEach(c => seen.add(cardId(c)));
  (played || []).forEach(c => seen.add(cardId(c)));
  return ALL_CARDS.filter(c => !seen.has(cardId(c)));
}
// would this card (as current winner) be unbeatable by any still-unseen card?
function unbeatable(card, trump, unseen) {
  if (card.suit === trump) return !unseen.some(u => u.suit === trump && TRUMP_STR[u.rank] > TRUMP_STR[card.rank]);
  if (unseen.some(u => u.suit === trump)) return false;            // could be ruffed
  return !unseen.some(u => u.suit === card.suit && PLAIN_STR[u.rank] > PLAIN_STR[card.rank]);
}
function dumpLow(legal, trump) {                     // shed lowest value, keep trumps
  const nonT = legal.filter(c => c.suit !== trump);
  return valLow(nonT.length ? nonT : legal, trump);
}

function chooseBotCard(seat, hand, trick, trump, opts = {}) {
  const legal = legalMoves(hand, trick, trump);
  if (!legal.length) return null;                    // empty hand (stale call) — caller must guard
  const level = opts.level || 'normal';
  if (level === 'easy') return legal[Math.floor(Math.random() * legal.length)];
  if (level === 'family') return familyPlay(seat, hand, trick, trump, legal, opts.played || [], opts.chooser, opts.samples, opts.calledRoem);
  if (level === 'hard') return hardPlay(seat, hand, trick, trump, legal, opts.played || [], opts.chooser);
  return normalPlay(seat, trick, trump, legal);
}

function normalPlay(seat, trick, trump, legal) {
  if (trick.length === 0) {
    const aces = legal.filter(c => c.suit !== trump && c.rank === 'A');
    if (aces.length) return aces[0];
    const plain = legal.filter(c => c.suit !== trump);
    return plain.length ? valLow(plain, trump) : valLow(legal, trump);
  }
  const winSeat = trickWinnerSeat(trick, trump);
  const partner = (seat + 2) % 4;
  const last = trick.length === 3;
  const winners = legal.filter(c => trickWinnerSeat(trick.concat([{ seat, card: c }]), trump) === seat);
  if (winSeat === partner) {
    const wc = trick.find(t => t.seat === winSeat).card;
    const solid = last || wc.suit === trump || wc.rank === 'A';
    if (solid) return schmear(legal, trump);
    if (winners.length) return valLow(winners, trump);
    return valLow(legal, trump);
  }
  if (winners.length) return valLow(winners, trump);
  return valLow(legal, trump);
}

// Hard = Normal's aggression + card-counting edges: cash guaranteed winners, draw
// trumps as declarer, schmear only onto a provably safe partner, discard to void suits.
function hardPlay(seat, hand, trick, trump, legal, played, chooser) {
  const unseen = unseenCards(hand, played);
  const declarerSide = chooser != null && teamOf(seat) === teamOf(chooser);
  if (trick.length === 0) {                          // leading
    const nonTrump = legal.filter(c => c.suit !== trump);
    const myTrumps = legal.filter(c => c.suit === trump);
    const trumpsOut = unseen.some(u => u.suit === trump);
    // 1) cash a guaranteed winner (can't be beaten or ruffed)
    const cashable = nonTrump.filter(c => unbeatable(c, trump, unseen));
    if (cashable.length) return valHigh(cashable, trump);
    // 2) as declarer holding the top trump, lead trump to draw opponents' trumps
    if (declarerSide && trumpsOut && myTrumps.length >= 3 && myTrumps.some(c => c.rank === 'J'))
      return valHigh(myTrumps, trump);
    // 3) cash a non-trump ace (usually wins the first round before it can be ruffed)
    const aces = nonTrump.filter(c => c.rank === 'A');
    if (aces.length) return aces[0];
    // 4) safe low exit
    return nonTrump.length ? valLow(nonTrump, trump) : valLow(legal, trump);
  }
  const winSeat = trickWinnerSeat(trick, trump);
  const partner = (seat + 2) % 4;
  const last = trick.length === 3;
  const winners = legal.filter(c => trickWinnerSeat(trick.concat([{ seat, card: c }]), trump) === seat);
  if (winSeat === partner) {                         // partner winning
    const wc = trick.find(t => t.seat === winSeat).card;
    // schmear on every case Normal would, plus card-counted certain wins
    if (last || wc.suit === trump || wc.rank === 'A' || unbeatable(wc, trump, unseen)) return schmear(legal, trump);
    if (winners.length) return valLow(winners, trump);   // beatable partner: secure the trick ourselves
    return dumpLow(legal, trump);                         // else shed lowest, keep trumps
  }
  if (winners.length) return valLow(winners, trump); // opponent winning: take it as cheaply as possible
  return dumpLow(legal, trump);                      // can't win: discard lowest, keep trumps
}

/* ============================================================
   Family = Perfect-Information Monte Carlo (PIMC).
   Reconstruct the deal so far from the flat `played` history to learn each
   opponent's remaining hand size, the suits they are known to be void in, and
   the card/roem/trick totals already banked. Then, many times over, deal the
   unseen cards into consistent "possible worlds", play every legal candidate
   out to the end with a fast greedy policy, and keep the candidate whose
   average final deal-score (from our team's view) is highest.
   ============================================================ */
const DEFAULT_SAMPLES = 60;

// Replay `played` (in play order) trick-by-trick to recover hidden info.
function reconstructDeal(played, trump, chooser) {
  const playedBySeat = [[], [], [], []];
  const voids = [new Set(), new Set(), new Set(), new Set()];
  const card = [0, 0], roem = [0, 0], won = [0, 0];
  let leader = chooser, completed = 0, i = 0;
  while (i < played.length) {
    const group = played.slice(i, i + 4);
    const led = group[0].suit;
    const seatCards = group.map((c, k) => ({ seat: (leader + k) % 4, card: c }));
    for (let k = 0; k < group.length; k++) {
      const s = (leader + k) % 4, c = group[k];
      playedBySeat[s].push(c);
      if (k > 0 && c.suit !== led) {                 // failed to follow the led suit -> void in it
        voids[s].add(led);
        // discarded while an opponent was winning and no trump was down -> void in trump
        // too. (A discard onto a winning partner is free, and one over an opponent's
        // trump only shows they couldn't overtrump, so neither proves a trump void.)
        const before = seatCards.slice(0, k);
        if (led !== trump && c.suit !== trump && !before.some(t => t.card.suit === trump) &&
            teamOf(trickWinnerSeat(before, trump)) !== teamOf(s))
          voids[s].add(trump);
      }
    }
    if (group.length === 4) {                        // complete trick: bank it and find next leader
      const w = trickWinnerSeat(seatCards, trump), tm = teamOf(w);
      card[tm] += group.reduce((x, c) => x + cardVal(c, trump), 0);
      roem[tm] += computeRoem(group, trump).roem;
      won[tm]++; completed++;
      leader = w; i += 4;
    } else break;                                    // partial (current) trick — stop
  }
  return { playedBySeat, voids, card, roem, won, completed };
}

// Deal `unseen` among `others`, honouring per-seat counts (`need`) and `voids`.
// Retries with reshuffles; if the void constraints prove unsatisfiable, relaxes them.
function dealUnseen(unseen, others, need, voids) {
  const eligStatic = c => others.filter(s => !voids[s].has(c.suit)).length;
  for (let attempt = 0; attempt < 40; attempt++) {
    const cap = {}, res = {};
    others.forEach(s => { cap[s] = need[s]; res[s] = []; });
    const order = unseen.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order.sort((a, b) => eligStatic(a) - eligStatic(b));   // hardest-to-place cards first
    let ok = true;
    for (const c of order) {
      const elig = others.filter(s => cap[s] > 0 && !voids[s].has(c.suit));
      if (!elig.length) { ok = false; break; }
      const s = elig[Math.floor(Math.random() * elig.length)];
      res[s].push(c); cap[s]--;
    }
    if (ok) return res;
  }
  // Relaxed fallback: still honour every void whenever a non-void seat has room,
  // violating a void only when no valid seat remains. Keeps the sampled world as
  // plausible as possible instead of discarding all the void info at once.
  const cap = {}, res = {};
  others.forEach(s => { cap[s] = need[s]; res[s] = []; });
  const order = unseen.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  order.sort((a, b) => eligStatic(a) - eligStatic(b));   // hardest-to-place cards first
  for (const c of order) {
    const roomy = others.filter(s => cap[s] > 0);
    const respectful = roomy.filter(s => !voids[s].has(c.suit));
    const pool = respectful.length ? respectful : roomy;
    const s = pool[Math.floor(Math.random() * pool.length)];
    res[s].push(c); cap[s]--;
  }
  return res;
}

// Greedy policy used inside a determinized playout. Because the world is fully
// determined, `others` (every card still in the other three hands) lets each seat
// play a realistic perfect-information line — cash a sure winner when leading and
// schmear onto a provably-safe partner — instead of a naive lead-ace/low heuristic.
// Sharper, more consistent playouts mean less strategy-fusion noise in the PIMC
// average, so the search reads positions more accurately.
function rolloutPick(seat, trick, trump, legal, others) {
  if (legal.length === 1) return legal[0];
  if (trick.length === 0) {
    const nonT = legal.filter(c => c.suit !== trump);
    const sure = nonT.filter(c => unbeatable(c, trump, others));   // cash a guaranteed winner
    if (sure.length) return valHigh(sure, trump);
    const aces = nonT.filter(c => c.rank === 'A');
    if (aces.length) return aces[0];
    return nonT.length ? valLow(nonT, trump) : valLow(legal, trump);
  }
  const winSeat = trickWinnerSeat(trick, trump), partner = (seat + 2) % 4, last = trick.length === 3;
  const winners = legal.filter(c => trickWinnerSeat(trick.concat([{ seat, card: c }]), trump) === seat);
  if (winSeat === partner) {
    const wc = trick.find(t => t.seat === winSeat).card;
    if (last || wc.suit === trump || wc.rank === 'A' || unbeatable(wc, trump, others)) return schmear(legal, trump);
    if (winners.length) return valLow(winners, trump);
    return dumpLow(legal, trump);
  }
  if (winners.length) return valLow(winners, trump);
  return dumpLow(legal, trump);
}

// Play a determinized world to the end of the deal, accumulating card/roem/tricks into acc.
function simulateToEnd(H, T, turn, trump, acc) {
  while (acc.trickNo < 8) {
    while (T.length < 4) {
      const s = turn;
      const legal = legalMoves(H[s], T, trump);
      const others = [];                               // cards still out (perfect-info world)
      for (let x = 0; x < 4; x++) if (x !== s) for (const c of H[x]) others.push(c);
      const c = rolloutPick(s, T, trump, legal, others);
      const idx = H[s].findIndex(x => x.suit === c.suit && x.rank === c.rank);
      H[s].splice(idx, 1);
      T.push({ seat: s, card: c });
      turn = (s + 1) % 4;
    }
    const cards = T.map(t => t.card);
    const w = trickWinnerSeat(T, trump), tm = teamOf(w);
    acc.card[tm] += cards.reduce((x, c) => x + cardVal(c, trump), 0);
    acc.roem[tm] += computeRoem(cards, trump).roem;
    acc.won[tm]++;
    acc.trickNo++;
    if (acc.trickNo === 8) acc.card[tm] += 10;       // last-trick bonus
    T.length = 0;
    turn = w;
  }
}

// Final deal award differential (our team minus theirs), mirroring GameRoom.scoreDeal.
function awardDiff(acc, play, myTeam) {
  const opp = 1 - play;
  const pitPlay = acc.won[play] === 8, pitOpp = acc.won[opp] === 8;
  const playPts = acc.card[play] + acc.roem[play] + (pitPlay ? 100 : 0);
  const oppPts = acc.card[opp] + acc.roem[opp] + (pitOpp ? 100 : 0);
  const totalRoem = acc.roem[0] + acc.roem[1];
  const awarded = [0, 0];
  if (playPts > oppPts) { awarded[play] = playPts; awarded[opp] = oppPts; }
  else { awarded[opp] = 162 + totalRoem + (pitOpp ? 100 : 0); awarded[play] = 0; }   // nat: opponents take all
  return awarded[myTeam] - awarded[1 - myTeam];
}

// calledRoem: [team0, team1] hand roem already called this deal (not visible in `played`).
function familyPlay(seat, hand, trick, trump, legal, played, chooser, samples, calledRoem) {
  if (legal.length === 1) return legal[0];
  const N = samples || DEFAULT_SAMPLES;
  const rec = reconstructDeal(played, trump, chooser);
  const others = [0, 1, 2, 3].filter(s => s !== seat);
  const need = {};
  others.forEach(s => { need[s] = 8 - rec.playedBySeat[s].length; });
  const unseen = unseenCards(hand, played);
  const total = others.reduce((x, s) => x + need[s], 0);
  if (total !== unseen.length)                       // reconstruction inconsistent — fall back to hard
    return hardPlay(seat, hand, trick, trump, legal, played, chooser);
  const myTeam = teamOf(seat), play = teamOf(chooser);
  const scores = legal.map(() => 0);
  for (let n = 0; n < N; n++) {
    const deal = dealUnseen(unseen, others, need, rec.voids);
    const world = [null, null, null, null];
    world[seat] = hand;
    others.forEach(s => { world[s] = deal[s]; });
    for (let ci = 0; ci < legal.length; ci++) {
      const H = world.map(h => h.slice());
      const T = trick.map(t => ({ seat: t.seat, card: t.card }));
      const acc = { card: rec.card.slice(), roem: rec.roem.map((r, t) => r + (calledRoem ? calledRoem[t] : 0)), won: rec.won.slice(), trickNo: rec.completed };
      const c = legal[ci];
      const idx = H[seat].findIndex(x => x.suit === c.suit && x.rank === c.rank);
      H[seat].splice(idx, 1);
      T.push({ seat, card: c });
      simulateToEnd(H, T, (seat + 1) % 4, trump, acc);
      scores[ci] += awardDiff(acc, play, myTeam);
    }
  }
  let bi = 0;
  for (let i = 1; i < legal.length; i++) {           // best average; tie-break toward keeping high cards
    if (scores[i] > scores[bi] + 1e-9) bi = i;
    else if (Math.abs(scores[i] - scores[bi]) <= 1e-9 && cardVal(legal[i], trump) < cardVal(legal[bi], trump)) bi = i;
  }
  return legal[bi];
}

const API = {
  SUITS, RANKS, SEQ, TRUMP_VAL, PLAIN_VAL, TRUMP_STR, PLAIN_STR,
  teamOf, cardId, cardVal, freshDeck, handComparator,
  winnerIndex, trickWinnerSeat, legalMoves, computeRoem, handRoem,
  botChooseTrump, chooseBotCard,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;   // Node / server.js
else root.KJEngine = API;                                                    // browser (window/self)

})(typeof self !== 'undefined' ? self : this);
