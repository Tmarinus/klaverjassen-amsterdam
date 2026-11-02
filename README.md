# Klaverjassen (Amsterdam rules)

Play Klaverjassen — solo against bots, or with up to 3 friends across the internet.
Any empty seats are played by the AI, so a game can start with 1–4 humans.

## ▶ Play now

**Web (any device, no install):** **https://tmarinus.github.io/klaverjassen-amsterdam/**

Open it on a PC or phone browser, pick a name, then:
- **🤖 Play solo** — offline vs bots, no network needed.
- **🌐 Host a game** — you get a 4-letter code; share it with friends.
- **Join** — enter a friend's code.

Multiplayer is **peer-to-peer** (WebRTC via the free PeerJS matchmaker) — **no server to run**.
Everyone just needs internet; the host keeps their tab/app open. PC browsers, phone browsers,
and the Android app all interoperate.

**Android app:** install the APK from the repo's
[Actions → Build Android APK](https://github.com/Tmarinus/klaverjassen-amsterdam/actions) → latest run →
Artifacts. Same game, native. (iOS: the Capacitor project supports it, but building needs a Mac.)

## Repo layout
- `engine.js` — pure Amsterdam rules engine (deal, legal moves, roem, scoring, bot AI). Verified by simulation.
- `game-room.js` — transport-agnostic game-flow orchestrator (shared by the server and the app).
- `app/` — the peer-to-peer web app + Capacitor Android project. See [`app/README.md`](app/README.md).
  - `app/www/` — the site published to GitHub Pages (index.html + net.js + generated `lib/`).
- `klaverjassen.html` — the original standalone **offline single-player** file (double-click to play).
- `public/` + `server.js` — the legacy self-hosted server version (see below).
- `test/sim.js` — engine self-play tests: legality, the 162-point invariant, and
  bot-strength ordering (easy < normal < hard < family). Run with `npm test`;
  gated in CI by `.github/workflows/test.yml`.

## Rules
Amsterdam Klaverjassen: follow suit; if void and **your partner is winning the trick** you may
play **any card** (but no undertrumping). Otherwise you **must trump**; with a trump already down
you **must overtrump** if you can, and if you can't you must play a card of **another suit** —
undertrumping is never allowed unless you hold nothing but trumps.
Declaring team must score more than the opponents (points + roem) or go *nat*. Roem: runs
(3 = 20, 4 = 50) and *stuk* (trump K+Q = 20). 16 deals; highest cumulative total wins. Full
reference is in the in-game **Rules** panel.

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
