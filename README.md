## Forked from https://github.com/Judoka0420/klaverjassen
Claude created the slop.

# Klaverjassen (Amsterdam rules)

Play Klaverjassen — solo against bots, or with up to 3 friends across the internet.
Any empty seats are played by the AI, so a game can start with 1–4 humans.

This is the **Amsterdam-rules** version of
[Judoka0420/klaverjassen](https://github.com/Judoka0420/klaverjassen) (which plays Rotterdam rules).
Only the trumping obligations differ — see [Rules](#rules).

## ▶ Play now

**Web (any device, no install):** **https://tmarinus.github.io/klaverjassen-amsterdam/**

Open it on a PC or phone browser, pick a name, then:
- **🤖 Play solo** — offline vs bots, no network needed.
- **🌐 Host a game** — you get a 4-letter code; share it with friends.
- **Join** — enter a friend's code.

Multiplayer is **peer-to-peer** (WebRTC via the free PeerJS matchmaker) — **no server to run**.
Everyone just needs internet; the host keeps their tab/app open. PC browsers, phone browsers,
and the Android app all interoperate.

**Bad internet?** Players reconnect by themselves when the link drops (a bot plays their cards
meanwhile, and the banner at the top shows the status). After a reload, use **↻ Rejoin table** on
the start screen. The host's game is autosaved in the browser, so if the host's page reloads or
crashes, **↻ Resume your table** reopens it with the same code and everyone reconnects.

**Something looks wrong?** The host (or solo player) can use **⚙ View → 🐞 Export game log**: it
saves a JSON file (copied to the clipboard in the Android app) with every deal's hands, each card
played with the cards that were legal at that moment, roem calls, scores and connection events,
plus a readable digest. Anything outside the legal set is flagged `[ILLEGAL]`.

**Android app:** download
[klaverjassen.apk](https://github.com/Tmarinus/klaverjassen-amsterdam/releases/latest/download/klaverjassen.apk)
from the latest [Release](https://github.com/Tmarinus/klaverjassen-amsterdam/releases/latest) and
install it. Same game, native; it checks this repo's Releases for updates and can install them
itself. (iOS: the Capacitor project supports it, but building needs a Mac.)

## Repo layout
- `engine.js` — pure Amsterdam rules engine (deal, legal moves, roem, scoring, bot AI). Verified by simulation.
- `game-room.js` — transport-agnostic game-flow orchestrator (shared by the server and the app).
- `app/` — the peer-to-peer web app + Capacitor Android project. See [`app/README.md`](app/README.md).
  - `app/www/` — the site published to GitHub Pages (index.html + net.js + generated `lib/`).
- `klaverjassen.html` — the original standalone **offline single-player** file (double-click to play).
- `public/` + `server.js` — the legacy self-hosted server version (see below).
- `test/sim.js` — engine tests: hand-built Amsterdam obligation positions, self-play
  legality, the 162-point invariant, and bot-strength ordering (easy < normal < hard <
  family). Run with `npm test`; gated in CI by `.github/workflows/test.yml`.

## Rules
Amsterdam Klaverjassen — what you must play:

1. **Follow suit** if you can. When trump is led, follow and play **higher** if you can.
2. Can't follow and **your partner is winning the trick**? You **don't have to trump** — play any
   card, except that you may not undertrump a trump already in the trick.
3. Otherwise you **must trump**. If a trump is already down you **must overtrump** if you can;
   if you can't, play a card of **another suit**.
4. **No undertrumping** — a lower trump is only allowed when you hold nothing but trumps.

(Rotterdam rules differ: there you must always trump, even over your partner.)

Declaring team must score more than the opponents (points + roem) or go *nat*. Roem: runs
(3 = 20, 4 = 50), *stuk* (trump K+Q = 20) and four of a kind (four Jacks = 200; four Queens, Kings
or Aces = 100) among the four cards of a trick, to the trick's winner.

**Roem in hand** (optional, chosen by the host on the start screen or in the lobby): runs in your
own hand (3 = 20, 4 = 50, 5+ = 100), four of a kind (J 200; Q, K, A 100) and stuk also score for your team, but only if you **call**
them (the *📣 Call roem* button) before you play your first card of the deal. Bots always call. The table hears only
what you have, not which cards ("run of 3 +20", "four of a kind +100"); stuk is named.

**Trump: Choose or Draw** (host option). *Choose*: the player left of the dealer names trump.
*Draw*: a random suit is drawn and offered round the table, starting with the player left of
the dealer; each may **play** on it (their team must then win, or go nat) or **pass**. If all four
pass, a different suit is drawn and the first player must play it. Either way the player left of
the dealer leads the first card.

16 deals; highest cumulative total wins. Full
reference is in the in-game **Rules** panel.

## Setting up a copy of this repo
Pushing to `main` runs the tests, deploys the web app and builds the APK. For a fresh copy:
- **Web app:** Settings → Pages → Source: **GitHub Actions** (workflow `pages.yml`).
- **Android signing:** follow the steps at the top of `.github/workflows/keystore.yml` once to
  create the signing secrets. Without them the APK falls back to debug signing, which breaks
  self-updates.
- **Self-update target:** `REPO` in `app/www/update.js` must point at your repo.

---

## Legacy: self-hosted server version

Before the peer-to-peer app, multiplayer ran through a Node server (`server.js`, Express +
Socket.IO) exposed via a Cloudflare quick tunnel. This still works but is **no longer the
recommended way to play** — the Pages link above needs no server and no tunnel.

```
powershell -ExecutionPolicy Bypass -File start.ps1   # start server + public tunnel
powershell -ExecutionPolicy Bypass -File stop.ps1    # stop them
```
It prints an ephemeral `https://<random>.trycloudflare.com` link; your machine must stay on
while friends are connected. `cloudflared.exe` is the tunnel client (not committed to git).

Env vars: `PORT` (default 8787); `KJ_BOT_MS` / `KJ_TRUMP_MS` / `KJ_TRICK_MS` / `KJ_DEAL_MS`
(pacing, ms); `KJ_GRACE_MS` (reconnection grace, default 60000); `KJ_MAX_ROOMS`
(global room cap, default 300) and `KJ_MAX_CREATES` (tables one connection may
create, default 40) — backstops against room-creation spam.

Reconnection is authenticated: the authority (server, or the host's device in the
P2P app) issues each seated player a per-seat token, delivered only in that
player's own private state. Reclaiming a seat requires presenting it, so knowing
someone's player id is not enough to take their seat.
