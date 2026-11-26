> **Historical document (superseded 2026-11-26).** Unity was removed from the project and host-customizable squad/overseas limits were added (`maxSquadSize` 15–25, `maxOverseas` 0–8). Current authoritative docs: `README.md`, `docs/CLOUDFLARE_ARCHITECTURE.md`, `docs/CLOUDFLARE_DEPLOYMENT_GUIDE.md`, `docs/SOCKETIO_TO_WEBSOCKET_MAPPING.md`, `docs/SESSION_LIFECYCLE.md`.

# Cloudflare Migration Audit: IPL Multiplayer Auction Simulator

**Document:** `docs/CLOUDFLARE_MIGRATION_AUDIT.md`  
**Status:** Audit Complete  
**Date:** 2026-11-21  
**Target Environment:** Cloudflare Workers, Durable Objects, Native WebSockets, DO SQLite, Neon PostgreSQL, Cloudflare Static Assets  
**Budget Constraint:** Strict ₹0 initial budget  

---

## 1. Executive Summary

This audit catalogs every HTTP route, WebSocket event, state machine transition, persistence mechanism, security constraint, and external dependency in the existing IPL Multiplayer Auction Simulator repository.

The application currently operates as a stateful, single-process, server-authoritative Node.js (Express + Socket.IO) system with optional Neon PostgreSQL persistence and an embedded Unity 6 WebGL client. The proposed Cloudflare target moves room management into per-room Cloudflare Durable Objects with native WebSocket hibernation, alarms for 15-second countdowns, SQLite durable room storage, and central PostgreSQL persistence for SaaS reporting.

---

## 2. Express API Endpoints Audit

All REST routes are defined in `server/index.js` and prefixed under `/api`:

| Method | Path | Request Body / Params | Response | Auth / Validation | Existing Implementation | Proposed Cloudflare Worker Equivalent |
|---|---|---|---|---|---|---|
| `GET` | `/api/health` | None | `{ status: 'ok' \| 'starting' \| 'standby' \| 'degraded', time, storage: {...} }` | Public | Direct Express handler reading `roomManager.storageStatus` | Handled at Worker edge router. Queries DO namespace / Neon status. |
| `GET` | `/api/franchises` | None | Array of 10 IPL franchise definitions (CSK, MI, RCB, KKR, etc.) | Public | Direct Express handler returning `IPL_FRANCHISES` | Static JSON response cached at Cloudflare edge (`Cache-Control: public, max-age=86400`). |
| `POST` | `/api/rooms` | `{ hostName, hostToken, config: { basePurse } }` | `{ roomCode, room: PublicRoomState }` | Validates `cleanName(hostName)`, `isValidToken(hostToken)`, `validateConfig(config)` | Synchronously creates room in memory, assigns 6-char code, commits | Worker verifies payload, generates unique `roomCode`, forwards to Durable Object `AUCTION_ROOMS.get(idFromName(roomCode))`, initializes DO SQLite state. |
| `GET` | `/api/rooms/:code` | URL param `code` (6 chars) | Public room state without participant tokens or private keys | Validates `isValidRoomCode(code)`. 404 if not found; 503 if hold | Express fetches from `roomManager.getRoom(code)`, strips secrets | Worker extracts `code`, routes to `AUCTION_ROOMS.idFromName(code)`, calls DO `GET /state`. Returns 404 if unitialized. |
| `GET` | `/api/rooms/:code/analysis` | URL param `code` | `{ roomCode, analysis, aiAnalysis }` | 404 if not found; 409 if not completed; 503 if hold | Fetches from room state. Analysis precomputed upon auction completion | Routed to `AUCTION_ROOMS.idFromName(code)`, calls DO `GET /analysis`. Returns deterministic Cricket Mastermind verdict. |

---

## 3. Realtime Socket.IO Events Audit

The system uses Socket.IO v4. All client-to-server messages pass through `resolveSession(socket, payload)` in `server/index.js` to ensure the sender is bound to the room and holds the verified participant token.

### 3.1 Client-to-Server Events (Inbound)

| Socket.IO Event Name | Payload Format | Expected Ack / Response | Authorization Requirement | State Mutation & Side Effects | Proposed Cloudflare Native WS Message Type |
|---|---|---|---|---|---|
| `join_room` | `{ roomCode: string, participantName: string, participantToken: string }` | Ack: `{ success: true, room: PublicState, participant: SelfParticipant }` or `{ success: false, error: string }` | Validates name (1-30 chars), token (16-128 chars), code (4-12 chars) | Binds socket to room; creates participant or re-attaches existing session; revokes older socket; broadcasts `state_updated` | `JOIN_ROOM` |
| `select_franchise` | `{ roomCode: string, franchiseId: string }` | Ack: `{ success: true, franchiseId: string }` or `{ success: false, error: string }` | Verified participant; franchise unclaimed | Claims franchise for participant; recalculates dynamic purse; broadcasts `state_updated` | `SELECT_FRANCHISE` |
| `update_config` | `{ roomCode: string, config: { autoAdvanceDelay, minParticipants, ... } }` | Ack: `{ success: true }` or `{ success: false, error: string, errors: array }` | **Host only** (`requireHost: true`); room must be in `'lobby'` | Validates fixed/adjustable config constraints; applies config; broadcasts `state_updated` | `UPDATE_CONFIG` |
| `update_playing_xi` | `{ roomCode: string, franchiseId: string, playingXI: string[], captainId, viceCaptainId, wicketKeeperId, impactPlayerId }` | Ack: `{ success: true }` or `{ success: false, error: string }` | **Franchise Owner only** (session-bound) | Validates lineup against purchased squad; updates configuration; broadcasts `state_updated` | `UPDATE_PLAYING_XI` |
| `start_auction` | `{ roomCode: string }` | Ack: `{ success: true }` or `{ success: false, error: string }` | **Host only**; status must be `'lobby'`; at least 1 claimed team | Status becomes `'active'`; shuffles set; presents first player; starts 15s timer; broadcasts `state_updated`, `lot_presented` | `START_AUCTION` |
| `pause_auction` | `{ roomCode: string }` | Ack: `{ success: true, room: PublicState }` or `{ success: false, error: string }` | **Host only**; status must be `'active'` | Stops timer; records remaining seconds; sets status `'paused'`; broadcasts `state_updated` | `PAUSE_AUCTION` |
| `resume_auction` | `{ roomCode: string }` | Ack: `{ success: true, room: PublicState }` or `{ success: false, error: string }` | **Host only**; status must be `'paused'` | Restores countdown; restarts clock; sets status `'active'`; broadcasts `state_updated` | `RESUME_AUCTION` |
| `place_bid` | `{ roomCode: string, franchiseId: string, bidAmount: number, expectedVersion: number }` | Ack: `{ success: true }` or `{ success: false, error: string }` | Verified owner of `franchiseId`; lot must be open; amount must equal `nextValidBid` | Updates lot highest bid; increments stateVersion; resets 15s timer; broadcasts `bid_accepted` with sound cues | `PLACE_BID` |
| `advance_lot` | `{ roomCode: string }` | Ack: `{ success: true }` or `{ success: false, error: string }` | **Host only**; status `'active'` | If lot open, forces hammer fall (SOLD/UNSOLD); if lot closed, presents next player; broadcasts `lot_presented` or completion | `ADVANCE_LOT` |
| `skip_set` | `{ roomCode: string }` | Ack: `{ success: true }` or `{ success: false, error: string }` | **Host only**; status `'active'` | Marks remaining un-auctioned players in set as SKIPPED; advances to next category/set; broadcasts `set_skipped` | `SKIP_SET` |
| `finish_auction` | `{ roomCode: string }` | Ack: `{ success: true }` or `{ success: false, error: string }` | **Host only**; status `'active'` or `'paused'` | Closes auction immediately; marks remaining catalogue un-auctioned; triggers Cricket Mastermind; broadcasts `auction_completed` | `FINISH_AUCTION` |
| `request_ai_analysis`| `{ roomCode: string, force?: boolean }` | Ack: `{ success: true, status: 'generating' \| 'ready' }` or `{ success: false, error: string }` | Any participant in room; regeneration host-only | Triggers optional AI analysis job if Anthropic key configured; broadcasts `analysis_updated` | `REQUEST_AI_ANALYSIS` |

---

### 3.2 Server-to-Client Events (Outbound Broadcasts)

| Server Event Name | Trigger Condition | Payload Contents | Frontend Handler Action | Proposed Cloudflare Native WS Event Type |
|---|---|---|---|---|
| `state_updated` | Room config changed, participant joined, franchise claimed, auction paused/resumed | Complete sanitized `PublicRoomState` (franchises, current status, config, history, audit log) | Updates React `room` state; updates participant franchise assignment | `STATE_UPDATED` |
| `lot_presented` | New player presented on stage | Complete `PublicRoomState` with fresh `currentLot` | Resets local completed lot overlay; triggers gavel sound audio | `LOT_PRESENTED` |
| `bid_accepted` | Server accepts a valid bid | `{ bid: BidRecord, currentLot: LotState, nextValidBid: number, franchises: object }` | Plays bid ping sound; updates current highest bidder and bid history | `BID_ACCEPTED` |
| `timer_tick` | Server countdown tick (every 1 second) | `{ countdown: number, hammerStatus: 'OPEN' \| 'GOING_ONCE' \| 'GOING_TWICE' \| 'SOLD' \| 'UNSOLD', stateVersion: number }` | Updates countdown display; triggers tick sound audio at <=5s | `TIMER_TICK` |
| `lot_completed` | Hammer falls (clock hits 0 or host advances) | `{ result: 'SOLD' \| 'UNSOLD', lot: LotState, historyEntry: object, franchises: object, playersCatalog: array }` | Triggers SOLD fanfare or UNSOLD audio; displays cinematic overlay banner | `LOT_COMPLETED` |
| `set_skipped` | Host skips current set | `{ skippedSetName: string, skippedCount: number, playersCatalog: array, history: array }` | Updates local player catalogue and lot index display | `SET_SKIPPED` |
| `auction_completed` | All players auctioned or host ends auction | Complete `PublicRoomState` with `status: 'completed'` | Displays Final Results View; renders Cricket Mastermind rankings and squad verdicts | `AUCTION_COMPLETED` |
| `analysis_updated` | Post-auction AI generation completes | Complete `PublicRoomState` including `room.aiAnalysis` | Refreshes AI tab on Results View without changing deterministic rankings | `ANALYSIS_UPDATED` |
| `session_replaced` | Same participant token connects from a new tab/socket | `{ roomCode: string }` | Sets `sessionReplaced: true`; displays reconnect warning modal | `SESSION_REPLACED` |

---

## 4. Auction Engine & Rules Audit

The core auction rules are centralized in `server/auctionEngine.js` and `server/config.js`:
- **Franchise Capacity**: Exactly 10 franchises (CSK, DC, GT, KKR, LSG, MI, PK, RR, RCB, SRH).
- **Starting Purse**: ₹120.00 Crore per franchise (`DEFAULT_CONFIG.basePurse`).
- **Squad Requirements**: Min 15 players, Max 25 players.
- **Overseas Restriction**: Max 8 overseas players per franchise.
- **Wicketkeeper Requirement**: At least 1 wicketkeeper required per squad.
- **Bid Increment Slabs**:
  - `currentBid < 10.00 Cr`: increment is **₹0.25 Cr** (25 Lakh).
  - `10.00 Cr <= currentBid < 15.00 Cr`: increment is **₹0.50 Cr** (50 Lakh).
  - `currentBid >= 15.00 Cr`: increment is **₹1.00 Cr** (100 Lakh).
- **Timer Rules**: Authoritative 15-second countdown.
  - Reset to exactly 15 seconds upon valid bid acceptance.
  - Invalid bid does NOT reset clock.
  - Hammer states: `15-6s: OPEN`, `5-4s: GOING_ONCE`, `3-1s: GOING_TWICE`, `0s: SOLD` (if highest bid >= base price) or `UNSOLD`.
  - Financial elimination check: If a franchise has remaining purse < minimum reserve needed to buy remaining players up to 15, further bidding is blocked.

---

## 5. Persistence & Database Audit

### 5.1 JSON File Store (`server/data/persisted_rooms.json`)
- Stores 21 rooms: 14 lobby rooms and 7 interrupted active rooms (`R8VNTD`, `6HBFKN`, `6J8BTZ`, `K6WFQ6`, `TJ6HGV`, `LDACKW`, `A5GLQ7`).
- File is 5.8 MB; atomic debounced write using temporary file rename.
- Ephemeral on cloud containers (Render wiped this upon spin-down).

### 5.2 PostgreSQL Store (Neon) (`server/persistence/`)
- Tables:
  1. `storage_meta`: Writer lease (`key='writer_lease'`), schema version, token hash scheme verifier.
  2. `rooms`: `room_code`, `status`, `host_name`, `host_token_hash`, `config`, `snapshot`, `snapshot_version`.
  3. `participants`: `room_code`, `token_hash`, `public_id`, `name`, `franchise_id`, `is_host`.
  4. `bids`: Append-only audit of accepted bids. Unique index on `(room_code, lot_number, state_version)`.
  5. `lot_results`: Lot outcomes (`SOLD`, `UNSOLD`, `SKIPPED`). Unique index on `(room_code, player_id)`.
  6. `lot_order`: Shuffled player IDs per room.
  7. `quarantined_rooms`: Stores corrupt or unparsable rooms safely.
  8. `playing_xi`: Franchise playing XI, captain, vice-captain, keeper, impact player.
- Single-Writer Lease: Acquired via `tryAcquireLease()` in `storage_meta`. Heartbeat every TTL/3 (default TTL 30s). Prevents multi-instance conflicts.

---

## 6. Unity 3D WebGL Arena Audit

- Project located in `unity/IPLAuctionArena/`; built into `client/public/unity/arena/`.
- Embedded in React via `client/src/components/UnityArena.jsx`.
- Interface: Pure unidirectional JSON messages via `SendMessage('ArenaBridge', 'ApplyState', json)`.
- Communication Protocol: `v: 1` JSON payload with `status`, `lot`, `franchises`.
- Unity emits only two window events: `ipl-arena` with `{ type: 'ready' }` or `{ type: 'error' }`.
- Unity has **zero network connection** and **zero state authority**. It is 100% compatible with the Cloudflare migration without requiring any recompilation of Unity assets.

---

## 7. Existing Test Suites Audit

The repository contains 32 test suites in `tests/runAll.js`:
- Unit & Engine Tests: `auction.test.js`, `newCatalogue.test.js`, `modifications.test.js`, `config.test.js`, `cricketMastermind.test.js`, `pgMapper.test.js`.
- Security & Isolation Tests: `security.test.js`, `payloadPrivacy.test.js`, `roomIsolation.test.js`, `playingXiAuthorization.test.js`, `squadOwnership.test.js`.
- Realtime & Integrity Tests: `auctionIntegrity.test.js`, `persistence.test.js`, `restoreRelink.test.js`, `arenaBridge.test.js`, `multiplayerSimulation.test.js`.
- PostgreSQL Integration Tests (Skipped when no local DB is running): `pgSchema.test.js`, `pgPersistence.test.js`, `pgRecovery.test.js`, `pgMigration.test.js`, `pgSecurity.test.js`, `pgDurability.test.js`, `pgInstance.test.js`, `pgGameplay.test.js`, `pgAnalysis.test.js`.

---

## 8. Summary Mapping Table

| Existing Component | Existing File | Existing Mechanism | Proposed Cloudflare Equivalent |
|---|---|---|---|
| HTTP API Server | `server/index.js` | Express 4 on Node.js http server | Cloudflare Worker `fetch()` export with router |
| Room Authority | `server/roomManager.js` | In-memory `Map<string, Room>` | Cloudflare Durable Object `AuctionRoomDO` (singleton per `roomCode`) |
| Realtime Sockets | `server/index.js` (Socket.IO) | Socket.IO engine.io long-polling & websocket | Cloudflare Native WebSockets with WebSocket Hibernation API |
| Bidding Countdown | `room.timer` (`setInterval`) | Node.js in-memory interval ticking every 1000ms | Durable Object Alarms (`ctx.storage.setAlarm`) + Absolute Deadlines |
| Room State Storage | `persisted_rooms.json` | Whole-map JSON write to local filesystem | Durable Object SQLite (`ctx.storage.sql`) |
| Single-Writer Lease | `server/persistence/postgresStore.js` | Global Postgres row lease (`storage_meta`) | **Eliminated**: Cloudflare Durable Objects guarantee exactly one active instance globally per room ID |
| Central Data Store | Neon PostgreSQL via `pg` pool | Node.js TCP pool connecting to Neon | Neon Serverless driver (`@neondatabase/serverless`) via HTTP/WebSocket |
| WebGL 3D Arena | `client/src/components/UnityArena.jsx` | Window message bridge `toArenaState()` | Preserved 100% unchanged (protocol `v: 1`) |
| Static Assets | Render express.static / Vercel | Vite build served via Vercel CDN | Cloudflare Workers Static Assets or existing Vercel deployment |
| Cricket Mastermind | `server/analysis/cricketMastermind.js` | Pure JS deterministic evaluation function | Reused directly inside Durable Object upon auction completion |

---

## 9. Independent Review Findings & Hardening Audit

An independent senior engineering audit was performed on the `feature/cloudflare-migration` branch across `cloudflare/src/index.js`, `cloudflare/src/AuctionRoomDO.js`, `client/src/utils/wsAdapter.js`, and `tests/cloudflareMigration.test.js`.

### Audit Findings & Fix Summary

| # | Component | Severity | Finding / Defect | Root Cause | Fix Applied | Verification Test |
|---|---|---|---|---|---|---|
| 1 | `cloudflare/src/index.js` | High | CORS Wildcard with Credentials | `Access-Control-Allow-Origin: *` with `credentials: true` rejected by modern browsers | Switched to dynamic origin reflection with `Vary: Origin` | Scenario 1 / HTTP Gateway |
| 2 | `client/src/utils/wsAdapter.js` | Critical | Callback envelope missing `success: true` | `cb(msg.payload)` omitted `success` flag; `App.jsx` checks `if (res?.success)` | Wrapped ACK payloads as `{ success: true, ...payload }` | Scenario 20 |
| 3 | `client/src/utils/wsAdapter.js` | Medium | Leaking event listeners | `off(event)` without handler parameter failed to remove listeners | Implemented full event cleanup if handler is omitted | Scenario 20 |
| 4 | `client/src/utils/wsAdapter.js` | High | Inactive countdown display | Cloudflare DO hibernates and does not tick every 1000ms | Implemented local authoritative countdown timer driven by `deadlineEpochMs` | Scenario 20 |
| 5 | `cloudflare/src/AuctionRoomDO.js` | Critical | Unpersisted Bids & Lot Results in SQLite | `bids` and `lot_results` tables were initialized but never inserted to | Added explicit parameterized `INSERT INTO bids` and `INSERT INTO lot_results` | Scenario 4 & 11 |
| 6 | `cloudflare/src/AuctionRoomDO.js` | High | Alarm vs. Bid Race Condition | Outdated alarm could close lot prematurely when valid bid arrived at expiry | Replaced arbitrary timing tolerance with exact boundary comparison: bids at or after active deadline are rejected; alarms firing before deadline re-arm | Scenario 19 & 22 |
| 7 | `cloudflare/src/AuctionRoomDO.js` | High | Auction Halted After Lot Sale | 3-second post-lot display alarm did not advance to next lot | Added branch in `alarm()`: if lot is closed (`SOLD`/`UNSOLD`), invoke `presentNextLot()` | Scenario 11 |
| 8 | `cloudflare/src/AuctionRoomDO.js` | Medium | Missing Message Size Limit & Rate Limiting | Sockets could flood memory with huge payloads or spam | Added 32 KB payload size guard and 30 msgs/sec rate limiting | Scenario 18 |
| 9 | `cloudflare/src/AuctionRoomDO.js` | High | Duplicate Bid Replays | Network retries could re-execute same message ID | Implemented persistent SQLite `processed_messages` deduplication surviving eviction | Scenario 17 & 21 |
| 10 | `cloudflare/src/AuctionRoomDO.js` | High | Outbox Sync Mechanism | No synchronization path existed between SQLite outbox and Neon DB | Implemented `flushOutbox()` with idempotent transaction status updates and partial retry | Scenario 16 & 23 |

---

## 10. Official Cloudflare Free-Tier Quota Reconciliation

The target architecture leverages Cloudflare Workers and Durable Objects on the SQLite storage backend under strict ₹0 budget constraints:

| Quota Dimension | Official Cloudflare Allowance | Usage Profile & Behavioral Rules |
|---|---|---|
| **Worker Requests** | **100,000 requests / day** | HTTP routing and room creation (<0.5% consumed) |
| **Durable Object Requests** | **100,000 DO requests / day** | Incoming WebSockets billed at 20:1 ratio + alarm executions |
| **Incoming WebSocket Messages** | **20:1 Request Ratio** | 20 inbound messages = 1 billable DO request |
| **Outgoing WebSocket Messages** | **Free / Uncounted** | Broadcasts incur 0 request count against daily quota |
| **DO Compute Duration** | **13,000 GB-seconds / day** | Hibernation API: 0 GB-s when idle; ~1.5ms per bid |
| **DO SQLite Storage** | **5 GB total storage** / account | Capacity for >10,000 completed auctions |
| **DO SQLite Reads** | **5,000,000 rows read / day** | State lookups and deduplication verification |
| **DO SQLite Writes** | **100,000 rows written / day** | Bids, lot results, outbox, and processed messages |
| **Worker CPU Limit** | **10 ms per invocation** | Lightweight JSON routing completes in <0.5 ms |
| **DO Default CPU Limit** | **30 seconds per request** | Wall-clock execution ceiling avoiding timeouts |

> [!IMPORTANT]
> **Independent Quota Dimensions**: Request quotas, compute duration (GB-seconds), and SQLite read/write row operations are three separate, independently enforced limits. Exceeding any single metric triggers a graceful hard stop (HTTP 429 / WebSocket 1015). Free tier plans have no automated card charging.


