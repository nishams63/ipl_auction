> **Historical document (superseded 2026-11-26).** Unity was removed from the project; any Unity/WebGL references below describe the former architecture. Current architecture: `README.md`, `docs/CLOUDFLARE_ARCHITECTURE.md`, `docs/SESSION_LIFECYCLE.md`.

# IPL Multiplayer Auction Simulator: Stage 0 Upgrade Audit

**Date:** 16 Nov 2026
**Scope:** Read-only inspection of the `ipl_auction` repository (branch `main`, HEAD `f2dc3b8`, working tree clean).
**Production code changed during audit:** None. Tests ran on a separate scratch copy, so the local `persisted_rooms.json` was not touched.

---

## 0. Executive summary

The app is a compact, working **Node/Express + Socket.IO** backend with a **React 19 + Vite + Tailwind 4** frontend. The codebase is about 8,000 lines across 22 source files. The auction engine is server-authoritative and well tested. The bid increments match your specification exactly.

However, the master prompt assumes several things that **do not exist** in this repository:

| Assumed in master prompt | Actual state |
|---|---|
| Existing database | **None.** All state lives in memory and is periodically written to `server/data/persisted_rooms.json`. |
| Existing authentication / user accounts | **None.** Identity is a random token generated in the browser (`localStorage.ipl_user_token`) plus a display name. |
| Historical results store | **None** beyond the JSON file. On Render's free plan that file is lost on every redeploy or restart. |
| Dynamic purse (₹120 Cr × active/10) | **Not implemented.** The purse is a flat ₹120 Cr. This was changed deliberately in commit `a4c44b6`. |
| Squad 15–25, timer 20 s | Code defaults are **squad 11–15** and **timer 15 s**. |

The audit also found **three confirmed security defects** that should be fixed before any new feature is added, chat in particular (§6).

---

## 1. Technical stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js (ES modules) | v22 tested locally |
| Backend | Express 4.21, Socket.IO 4.8, cors | `server/` |
| Frontend | React 19.3, Vite 8.3, Tailwind CSS 4.3, lucide-react, canvas-confetti | `client/` |
| Real-time | Socket.IO (websocket + polling fallback) | single connection per tab |
| Persistence | JSON file (`server/data/persisted_rooms.json`, gitignored) | no DB driver installed |
| Audio | Web Audio API synthesis (`client/src/utils/audio.js`) | no audio assets |
| Tests | Plain Node scripts with `node:assert` | `tests/` |
| Lint | oxlint (client) | |

Unused dependency: `ws` (root). `socket.io-client` sits in the root dependencies only for tests.

## 2. Deployment

| Item | Finding |
|---|---|
| **Render** | `render.yaml`: one web service on the **free** plan. Build: `npm install && npm run build`. Start: `npm start` (`node server/index.js`). Binds `0.0.0.0:$PORT`. It also serves `client/dist` statically, so Render hosts a full copy of the app too. |
| **Vercel** | Root `vercel.json` (output `client/dist`) and `client/vercel.json` (output `dist`), both with an SPA rewrite. |
| **Env vars** | Only `NODE_ENV` (Render) and `VITE_SERVER_URL` (Vercel, read in `client/src/utils/socket.js`). No secrets exist today. |
| **CORS** | `origin: '*'` on both Express and Socket.IO. |
| **Free-plan implications** | Render free instances sleep after inactivity and have an **ephemeral filesystem**. Any rooms saved to JSON disappear on restart or redeploy. |

## 3. Repository map (important files)

```
server/
  index.js            222 lines  Express routes + all Socket.IO handlers
  roomManager.js      915 lines  Room state, timers, bids, lot close, skip set, persistence, Playing XI
  auctionEngine.js    359 lines  DEFAULT_CONFIG, increments, validateBid, elimination, evaluation, ranking
  data/buildPlayers.js 771 lines Hard-coded 300 raw cards → dedupe → 290 players → players.json
  data/players.json   290 players (generated)
  data/franchises.js  10 IPL franchises (colours, names; no logo assets)
client/src/
  App.jsx             Socket listeners, top-level view routing (Landing / Lobby / Live / Results)
  utils/socket.js     Socket singleton, localStorage session token
  components/LiveAuctionView.jsx  1,278 lines: 3-column broadcast layout, marquee, bid panel, mobile tabs
  components/LobbyView.jsx        Franchise grid, host config
  components/FinalResultsView.jsx Podium + score breakdown
  components/FranchiseDashboardModal.jsx  Squad view + Playing XI builder (C/VC/WK/Impact)
  components/AuctionHistoryModal.jsx      Lot history
  components/CinematicAuctionOverlay.jsx  SOLD/UNSOLD overlay
tests/  auction.test.js, modifications.test.js, multiplayerSimulation.test.js
ipl_auction_all_rounds_player_cards (1).html   Original 300-card source catalogue
```

## 4. Existing contracts

### 4.1 REST API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/franchises` | Static franchise list |
| POST | `/api/rooms` | Create room `{hostName, hostToken, config}` → `{roomCode, room}` |
| GET | `/api/rooms/:code` | **Unauthenticated** full public room state |

### 4.2 Socket.IO: client → server (all use an ack callback)

| Event | Payload | Auth check |
|---|---|---|
| `join_room` | roomCode, participantName, participantToken | token = identity; new joins only while `lobby` |
| `select_franchise` | roomCode, participantToken, franchiseId | participant must exist; lobby only |
| `update_config` | roomCode, hostToken, config | hostToken match; lobby only |
| `start_auction` | roomCode, hostToken | hostToken match |
| `pause_auction` / `resume_auction` | roomCode, hostToken | hostToken match |
| `place_bid` | roomCode, participantToken, franchiseId, bidAmount, expectedVersion | token owns franchise |
| `advance_lot` | roomCode, hostToken | hostToken (closes the current lot early) |
| `skip_set` | roomCode, hostToken | hostToken |
| `finish_auction` | roomCode, hostToken | hostToken |
| `update_playing_xi` | roomCode, participantToken, franchiseId, playingXI, captainId, viceCaptainId, wicketKeeperId, impactPlayerId | owner or host |

### 4.3 Socket.IO: server → room broadcasts

| Event | Payload | Unity mapping (proposed) |
|---|---|---|
| `state_updated` | full public room state | Franchise/desk refresh, initial sync |
| `lot_presented` | full public room state | **Player reveal** |
| `bid_accepted` | `{bid, currentLot, nextValidBid, franchises}` | **Accepted-bid desk highlight + camera C** |
| `timer_tick` | `{countdown, hammerStatus, stateVersion}` every 1 s | Optional "going once/twice" lighting |
| `lot_completed` | `{result:'SOLD'|'UNSOLD', lot, historyEntry, franchises, playersCatalog}` | **SOLD / UNSOLD sequence** |
| `set_skipped` | `{skippedSetName, skippedCount, playersCatalog, history}` | Arena wide shot |
| `auction_completed` | full public room state (with `evaluationResults`) | **Podium** |

Pause and resume do not have dedicated events. They arrive as `state_updated` with `status: 'paused' | 'active'`.

### 4.4 Data models (in memory)

**Room:** `roomCode, createdAt, hostToken, hostName, status ('lobby'|'active'|'paused'|'completed'), config, playersCatalog[] (deep copy per room), currentPlayerIndex, currentLot, franchises{}, playingXIConfigurations{}, participants Map(token → {token,name,socketId,franchiseId,isHost}), history[], allBids[], auditLog[] (cap 200), evaluationResults`.

**Player:** `id (PL_001…PL_290), name, category (BAT|BOWL|AR|SP|WK), categoryTitle, setName, setNumber, lotInSet, setTotal, overallLot, round, categorySet, country, countryFlag, countryCode, isOverseas, initials, role, basePrice, rating, stats{matches, runs/wickets, sr/econ, hs/bbi/dis}, imageUrl, status, soldTo, soldPrice`.

**Franchise (per room):** static fields + `ownerToken, ownerName, ownerSocketId, isClaimed, initialPurse, remainingPurse, totalSpent, squad[], overseasCount, isEliminated, eliminationReason, playingXI[], captainId, viceCaptainId, wicketKeeperId, impactPlayerId`.

**currentLot:** `player, lotNumber, totalLots, set info, nextPlayer, highestBid, highestBidderFranchiseId, nextValidBid, countdown, stateVersion, bidHistory[], hammerStatus`.

## 5. Feature inventory

| Feature | Status | Notes |
|---|---|---|
| Private rooms (6-char code) | ✅ Working | |
| Franchise selection (10 IPL teams) | ✅ Working | Fewer than 10 supported; min 2 claimed to start |
| Server-authoritative timer | ✅ Working | 15 s default, resets on bid; GOING_ONCE at 7 s, GOING_TWICE at 3 s |
| Automatic increments | ✅ **Matches spec exactly** | Verified all 8 spec examples |
| Custom bid amounts blocked | ✅ Working | |
| Concurrency (stateVersion) | ✅ Working | |
| Overseas / squad cap / feasibility reserve | ⚠️ Partial | Reserve check can be bypassed (§6.3) |
| Financial elimination | ✅ Working | |
| Pause / resume / skip lot / skip set / force finish | ✅ Working | Host only |
| Persistent full marquee (all 290) | ✅ **Already exists** | Search, filters, jump-to-active, status, mobile tab (commit `29d9ad8`) |
| Auction history modal | ✅ Working | |
| Franchise dashboard + Playing XI (C/VC/WK/Impact, ≤4 overseas) | ✅ Working | Already covers most of the requested "Dream XI" |
| SOLD/UNSOLD cinematic overlay (2D) | ✅ Working | |
| Mobile portrait mode + quick-bid bar | ✅ Working | |
| Final ranking (deterministic weighted formula) | ✅ Working | 30% average rating, which is the exploit you described |
| Dynamic purse | ❌ Not implemented | Flat ₹120 Cr (deliberate, commit `a4c44b6`). README still describes it as dynamic. |
| Randomized player order | ❌ Not implemented | Fixed round-robin order from `buildPlayers.js`; identical every auction |
| Room chat | ❌ Missing | |
| Connection indicator / auto-rejoin on socket reconnect | ❌ Missing | See §7.2 |
| AI analysis | ❌ Missing | |
| Analytics / franchise comparison | ❌ Missing | |
| Unity 3D | ❌ Missing | |
| Database / auth / accounts | ❌ Do not exist | |

### 5.1 Test results (actually executed, 16 Nov 2026, scratch copy)

| Suite | Result |
|---|---|
| `tests/auction.test.js` | ✅ 14/14 passed |
| `tests/modifications.test.js` | ✅ All passed (Playing XI persistence, skip set, increment-only) |
| `tests/multiplayerSimulation.test.js` (two real socket clients against a local server) | ✅ Passed: join, claim, pause/resume, two bids, timer reset, SOLD, purse deduction, evaluation |
| Increment probe (8 spec examples) | ✅ All match |

`npm test` only runs two of the three suites. `modifications.test.js` is not wired in.

## 6. Security findings (confirmed by executed probes)

### 6.1 CRITICAL: Every participant token is leaked publicly
`getPublicRoomState()` returns `franchises`, and each franchise includes `ownerToken`. This is broadcast on every `state_updated` and is also available **without any socket** via `GET /api/rooms/:code`.

The host's participant token equals the `hostToken`, so the host's credential leaks too.

**Probe result:** an outsider who knew only the room code read both tokens from the REST endpoint and then called `start_auction` successfully.

### 6.2 CRITICAL: Impersonation and joining after the auction starts
`join_room` treats a known token as a reconnection, even after the auction has started.

**Probe result:** an outsider rejoined as another player using the leaked token and placed a bid for that player's franchise. It was accepted.

Fix direction: strip `ownerToken` from all public payloads, and issue a separate server-generated secret per participant. The client currently relies on `ownerToken` to find "my franchise" (`App.jsx`), so that must switch to the `participant` returned by `join_room`.

### 6.3 HIGH: Purse and reserve check bypassed when `bidAmount` is omitted
`validateBid` computes `remainingPurse - bidAmount`. With `bidAmount` undefined this is `NaN`, and every comparison against `NaN` is false.

**Probe result:** a franchise with ₹0.50 Cr remaining was allowed to open at ₹2.00 Cr. The same request with `bidAmount: 2` was correctly rejected.

The official client always sends `bidAmount`, but a modified client can exploit this. Fix: validate against `validNextAmount`, not the client value.

### 6.4 Other
- CORS `*` everywhere. Acceptable while there is no cookie auth, but it should be narrowed to the Vercel and Render origins.
- No rate limiting on any event.
- Player images are Bing thumbnail-search URLs (`tse1.mm.bing.net/th?q=…`). These are unstable, could return any image, and carry licensing uncertainty. The prompt asks to avoid unreliable temporary image URLs.

## 7. Reliability and performance findings

1. **Persistence gaps:** `saveToStorage()` is called only on room creation, Playing XI update and skip set. It is **not** called on bids, sales or auction completion. After a restart, an active room is restored with `status: 'active'` but **no timer**, so it stalls.
2. **No socket-reconnect rejoin:** the client joins the room once on page load. If Socket.IO reconnects silently (network blip, Render cold start), the new socket is never re-added to the room channel, and the user stops receiving events until they refresh. There is also no connecting / reconnecting indicator.
3. **Payload size:** every `state_updated`, `lot_presented` and `lot_completed` sends the full 290-player catalogue plus all squads, which is roughly 150–250 KB per event to every client. This is fine today but will grow with the catalogue import and with Unity.
4. Each room deep-copies the full catalogue, and the local test-generated JSON file is already 5.8 MB.
5. React `StrictMode` runs the auto-join effect twice in development. This is harmless because joining is idempotent, but noisy.

## 8. Rule discrepancies (reported, not changed)

| Rule | Your spec | Code today | Source |
|---|---|---|---|
| Purse | ₹120 Cr × active/10 | Flat ₹120 Cr (host-editable) | `calculateDynamicPurse`, `recalculateLobbyPurses`; tests assert flat |
| Min / max squad | 15 / 25 | **11 / 15** | `DEFAULT_CONFIG` |
| Max overseas | 8 | 8 ✅ | |
| Min WK | 1 | 1 ✅ | |
| Timer | 20 s | **15 s** (host can set ≥10) | `DEFAULT_CONFIG`; LobbyView input min 15 |
| Increments | spec table | ✅ identical | |
| Opening bid = base price | ✅ | ✅ | |
| Min player price (reserve) | — | ₹0.20 Cr, below the lowest catalogue base price of ₹0.30 Cr | |
| Landing page copy | — | Says "min 15 players"; engine uses 11 | `LandingView.jsx:482` |

Your spec says to use the existing approved configuration where it differs. I need you to confirm which values are approved (§12, Q3).

## 9. Player catalogue state

- 290 players: BAT 57, BOWL 60, AR 58, SP 58, WK 57. 97 overseas. Base prices ₹0.30–2.00 Cr.
- No duplicate names or IDs in `players.json`. Deduplication is exact lowercase-name only.
- **IDs are positional** (`PL_001` = first in round-robin order). Re-running `buildPlayers.js` with new players inserted would **renumber existing players**. The import needs stable IDs (keep existing IDs, append new ones from `PL_291`).
- `rating` (OVR 81–99) and `stats` are hand-entered in `buildPlayers.js` with **no source or as-of date**. I cannot verify them. Some look outdated; for example, Travis Head is listed with 26 IPL matches. The new evaluation should treat these as "catalogue-provided" and disclose that.
- **The "missing players" document is not in the repository.** The HTML file in the repo is the *original* 300-card source the current catalogue was built from.

## 10. Proposed design per feature

### 10.1 Persistence foundation (prerequisite decision)
Chat history, locked shuffle order, evaluation snapshots and AI caching all need durable storage. The JSON file on a free Render instance cannot provide that. Options are in §12, Q1. Whichever you choose, I'd keep the in-memory `RoomManager` as the live authority and persist **after** each state change, so the auction engine itself is not rewritten.

### 10.2 Randomized order
- On `start_auction` (not at room creation, so lobby rejoins never affect it), the server builds the order with a **Fisher–Yates shuffle using `crypto.randomInt`**. It then stores `room.lotOrder` (player IDs) and `room.shuffleSeedHash`, and sets `orderLocked = true`.
- `nextPlayer` walks `lotOrder`. Sold, unsold and skipped players are never revisited, because the index only moves forward.
- The existing set and skip-set feature depends on category sets, so there are two modes (§12, Q4):
  - **A, set-preserving:** shuffle players inside each category, then shuffle which set comes next, keeping set sizes. Skip set still works.
  - **B, full shuffle:** ignore sets. Skip set would be removed or changed to "skip next N".
- The order travels in the room state. Every client renders the marquee from the same server array, so refresh and reconnect cannot change it.

### 10.3 Marquee
Already built, so I'll extend it rather than replace it: drive it from `lotOrder`, show position numbers, and add explicit CURRENT / UPCOMING / SOLD / UNSOLD / SKIPPED badges. I'll also check that the panel never covers the bid button at any breakpoint. The OVR badge comes off the live card (§10.4).

### 10.4 Team evaluation (Layer A + Layer B)
- **During the auction:** hide `rating`/OVR from the live player card, marquee and dashboard. Keep role, category, nationality, base price and stats.
- **Layer A (deterministic, `server/evaluation/teamEvaluator.js`):** squad-level scoring based on role coverage and depth, using the role strings (top-order, finisher, pace, spin, WK, AR). It applies eligibility gates and budget usage. Player quality is capped, for example to the best-XI average rather than the whole-squad average, so hoarding stars has diminishing returns. The output is versioned (`evaluationVersion`) and the input is snapshotted.
- **Layer B (AI, backend only):** a single call after the auction completes, sending each squad's verified fields and the Layer A scores. The response is validated against a JSON schema. The AI writes explanations and can suggest adjustments within a bounded range (for example ±5 points, with reasons). **It cannot change eligibility.** The result is cached in the snapshot so it is never re-billed. If the AI fails or returns invalid output, rankings come from Layer A alone and are marked "AI analysis unavailable".
- **Provider:** an Anthropic API key held as a Render environment variable (§12, Q5). I estimate roughly ₹1–5 per auction.

### 10.5 Room chat
- New events `chat_send` (with ack) → `chat_message`, and `chat_history` for loading on join or reconnect. Moderation events `chat_delete` and `chat_mute` are host only.
- Sender identity comes from `socket.data` set at `join_room`, never from the payload. This depends on fixing §6.1 and §6.2 first.
- Messages are limited to 300 characters, rate-limited to 5 per 10 s per participant, and capped at the last 200 per room.
- Messages are stored in the room record, or in a table if a DB is chosen.
- UI: a collapsible panel with an unread count. On desktop it sits in the right column below the franchise list; on mobile it is a fourth tab.

### 10.6 Unity
- `unity-auction/` (Unity 6, URP, WebGL). I'll build the arena, desks, the three cameras and the event-driven sequences as C# scripts plus a scene-assembly editor script.
- **Limitation:** this workspace cannot run the Unity Editor. You will need to open the project in Unity 6 on your PC and run the WebGL build (I'll write exact steps). I cannot honestly claim WebGL load or frame-rate tests passed until you run them.
- The build output goes to `client/public/unity/` (Brotli-compressed, served by Vercel). It is lazy-loaded only on the auction page and disabled on low-end or mobile devices.
- **Bridge (`client/src/unity/UnityBridge.js`):** subscribes to the existing socket events in `App.jsx` (no second connection). It maps them to `SendMessage('AuctionDirector', …)` with small JSON payloads. Every message carries `lotNumber + stateVersion`, and stale or duplicate messages are dropped. Messages are queued while Unity loads, and the current snapshot is replayed after load or reconnect. If Unity fails or WebGL2 is unavailable, the bridge falls back to the current 2D UI.
- Unity never emits auction actions.

### 10.7 Stage 8 extras
- Lobby presence and connection state: needs server-side tracking of disconnects (`socket.on('disconnect')` currently only logs).
- Analytics and franchise comparison: computed from `history` and `allBids`.
- Dream XI: **already exists** as the Playing XI builder. I'll only polish it.

## 11. New files and changes (planned)

| Area | New | Modified |
|---|---|---|
| Security fix | `tests/security.test.js` | `roomManager.js` (public state, join), `auctionEngine.js` (validateBid), `App.jsx` (my-franchise lookup) |
| Persistence | `server/storage/*` (adapter) | `roomManager.js` save points, startup timer recovery |
| Catalogue | `server/data/importPlayers.js`, `server/data/player_aliases.json`, `docs/PLAYER_CATALOGUE_IMPORT_REPORT.md` | `players.json` (after approval only) |
| Randomization | `server/shuffle.js`, `tests/randomization.test.js` | `roomManager.js` (start/next), `LiveAuctionView.jsx` (marquee) |
| Chat | `client/src/components/RoomChatPanel.jsx`, `docs/ROOM_CHAT_SYSTEM.md`, `tests/chat.test.js` | `index.js`, `roomManager.js`, `App.jsx`, `LiveAuctionView.jsx`, `LobbyView.jsx` |
| Evaluation | `server/evaluation/teamEvaluator.js`, `server/evaluation/aiAnalyst.js`, `docs/TEAM_EVALUATION_SYSTEM.md`, `tests/evaluation.test.js` | `roomManager.finishAuction`, `FinalResultsView.jsx`, rating removed from live UI |
| Unity | `unity-auction/**`, `client/src/unity/*`, `client/public/unity/` (build output) | `LiveAuctionView.jsx` (canvas layer) |
| Connection UX | `client/src/components/ConnectionBadge.jsx` | `utils/socket.js`, `App.jsx` (rejoin on `connect`) |

## 12. Decisions I need from you

1. **Durable storage.** There is no database today. Pick one:
   (a) a free managed Postgres such as Neon or Supabase, with the URL added as a Render env var (recommended: free, survives restarts);
   (b) a Render persistent disk (paid plan required; keeps the JSON approach);
   (c) stay with the JSON file and accept that chat, history and results are lost on every Render restart.
2. **Security fix first.** May I add the §6 fixes as "Stage 0.5" before the catalogue work? This changes the private token flow, but no visible behaviour.
3. **Approved rules.** Keep the code's flat ₹120 Cr, squad 11–15 and 15 s timer, or switch to your spec's dynamic purse, 15–25 and 20 s?
4. **Shuffle mode.** A (set-preserving, skip set kept) or B (full shuffle)?
5. **AI provider.** Is using the Anthropic API with your own key on Render acceptable?
6. **Player document.** Please upload the missing-players document. It is not in the repo or the conversation.
7. **Unity build.** Do you have Unity 6 installed on this PC, or can you install it? The WebGL build must be produced there.

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Token leak exploited in production now | Room hijack | Stage 0.5 fix |
| Render free restarts wipe rooms | Lost auctions, chat, results | Decision Q1 |
| Positional player IDs | Re-numbering breaks references | Import appends stable IDs |
| Unverified stats and ratings | AI could repeat inaccurate data | Label as catalogue-provided; AI may only cite supplied fields |
| Unity bundle size or performance | Slow load, mobile issues | Lazy load, Brotli, quality tiers, static fallback |
| Payload growth (bigger catalogue + Unity) | Lag on bids | Send catalogue once; emit deltas thereafter (contract-compatible) |
| Changing hidden-rating UX | Players lose a familiar cue | Stats remain visible; full breakdown shown after the auction |
| Two frontends (Vercel + Render static) | Version drift | Document; optionally stop serving `client/dist` from Render later |

## 14. Implementation order

0.5. Security and reliability fixes (token leak, bid bypass, reconnect rejoin, save points). *Needs approval.*
1. Catalogue import and report. *Blocked on the document; no data change until the report is approved.*
2. Server shuffle and marquee upgrade, with the rating hidden during the auction.
3. Room chat.
4. Unity project (scripts and scene); you run the build.
5. Unity bridge and fallback.
6. Cinematic sequences.
7. Evaluation Layer A + Layer B.
8. Lobby presence, analytics, comparison, results page.
9. Full regression, two-client tests, rollback docs.

Each stage ends with a report, and nothing is committed, pushed or deployed without your approval.
