# Cloudflare Architecture: IPL Multiplayer Auction Simulator

**Document:** `docs/CLOUDFLARE_ARCHITECTURE.md`  
**Status:** Architecture Design Complete  
**Target Platform:** Cloudflare Workers + Durable Objects + SQLite + Native WebSockets + Neon PostgreSQL  
**Budget:** Strict ₹0 initial budget  

---

## 1. System Overview

The target Cloudflare architecture decomposes the monolithic Node.js auction engine into serverless, globally distributed actors:

```
                      ┌──────────────────────────────────────────────┐
                      │          Cloudflare Edge Network             │
                      │                                              │
  Browser / React     │  ┌────────────────────────────────────────┐  │
  Client (Vercel)  ───┼─►│  Cloudflare Worker Router (Entrypoint) │  │
                      │  └───────────────────┬────────────────────┘  │
                      │                      │                       │
                      │         env.AUCTION_ROOMS.get(idFromName)    │
                      │                      ▼                       │
                      │  ┌────────────────────────────────────────┐  │
                      │  │   AuctionRoomDO (Durable Object)       │  │
                      │  │   * Singleton per roomCode             │  │
                      │  │   * Strongly consistent actor          │  │
                      │  │   * Single-threaded mutation loop      │  │
                      │  │                                        │  │
                      │  │   ┌────────────────────────────────┐   │  │
                      │  │   │ Native WebSocket Hibernation   │   │  │
                      │  │   │ ctx.acceptWebSocket()          │   │  │
                      │  │   └────────────────────────────────┘   │  │
                      │  │   ┌────────────────────────────────┐   │  │
                      │  │   │ Durable Alarms (15s Countdown) │   │  │
                      │  │   │ ctx.storage.setAlarm()         │   │  │
                      │  │   └────────────────────────────────┘   │  │
                      │  │   ┌────────────────────────────────┐   │  │
                      │  │   │ Durable Object SQLite Storage  │   │  │
                      │  │   │ ctx.storage.sql (Zero-latency) │   │  │
                      │  │   └────────────────┬───────────────┘   │  │
                      │  └────────────────────┼───────────────────┘  │
                      └───────────────────────┼──────────────────────┘
                                              │ Outbox Sync (Async)
                                              ▼
                               ┌─────────────────────────────┐
                               │     Neon PostgreSQL         │
                               │   (Central SaaS Store)      │
                               └─────────────────────────────┘
```

---

## 2. Component Design

### 2.1 Cloudflare Worker Router (`src/index.js`)

The Worker acts as a lightweight edge gateway:
1. **Static / Cached Endpoints**:
   - `GET /api/franchises`: Returns the 10 immutable IPL franchise metadata with edge caching.
   - `GET /api/health`: Aggregates storage health and platform status.
2. **Room Dispatcher**:
   - `POST /api/rooms`: Validates host input, generates a cryptographic 6-character room code, routes to the matching Durable Object namespace `AUCTION_ROOMS.idFromName(code)`, and initializes room state.
   - `GET /api/rooms/:code`: Forwards to DO for public state.
   - `GET /api/rooms/:code/analysis`: Forwards to DO for Cricket Mastermind results.
3. **WebSocket Upgrade Gate**:
   - `GET /api/rooms/:code/ws`: Validates upgrade headers (`Upgrade: websocket`). Forwards request to DO `fetch()` which performs `new WebSocketPair()`, accepts the server socket with `ctx.acceptWebSocket()`, and returns the client socket with HTTP 101 Switching Protocols.

---

### 2.2 Cloudflare Durable Object (`src/AuctionRoomDO.js`)

Each active auction room is an independent, isolated Durable Object singleton identified by `env.AUCTION_ROOMS.idFromName(roomCode)`.

#### A. Single-Writer Authority (Replacing the Global Lease)
- **Elimination of Global Postgres Lease**:
  In traditional container deployments (Render), multiple container instances could run simultaneously, requiring a fragile database row lock (`storage_meta` lease) to prevent dual writes.
  In Cloudflare, the Durable Object runtime guarantees **globally unique single-threaded execution**:
  - Exactly **ONE** instance of `AuctionRoomDO` exists for room `ABCDEF` worldwide.
  - All incoming bids, joins, and timer events are queued and executed sequentially in the DO's event loop.
  - Dual writes and race conditions are physically impossible by platform architecture.
- **Room Isolation**:
  Room `ROOM_1` and Room `ROOM_2` run in separate, memory-isolated Durable Objects. Memory corruption, heavy load, or errors in Room 1 have zero impact on Room 2.

#### B. Native WebSocket Hibernation
- Standard WebSockets keep a server process running continuously in memory, which consumes memory and billing seconds.
- The Cloudflare **WebSocket Hibernation API** (`ctx.acceptWebSocket(ws, [tags])`):
  - Cloudflare edge holds the active TCP/TLS connection open.
  - While users wait between bids, the Durable Object hibernates and consumes **zero billable CPU time**.
  - When a user sends a message or the 15-second timer alarm triggers, Cloudflare wakes the DO in ~1ms.
  - Broadcasting uses `ctx.getWebSockets()` to send messages to all active participants.

#### C. Absolute Deadline Alarms (Authoritative Countdown)
- Traditional `setInterval` fails when serverless processes pause or restart.
- Durable Object **Alarms** (`ctx.storage.setAlarm(timestamp)`):
  - When lot bidding opens or a valid bid is accepted:
    $$\text{deadlineEpochMs} = \text{Date.now()} + 15000$$
    `await ctx.storage.setAlarm(deadlineEpochMs);`
  - The alarm timestamp is durably committed to SQLite.
  - Even if all users temporarily close their browsers, the DO alarm wakes up at the exact millisecond and processes the lot hammer fall (SOLD or UNSOLD).
  - A valid bid resets the alarm timestamp. Invalid bids leave the existing alarm untouched.

#### D. Zero-Latency Room Storage via Durable Object SQLite
- Every DO contains a private, embedded SQLite database (`ctx.storage.sql`).
- All room mutations are committed synchronously to SQLite before broadcasting acknowledgements:
  ```sql
  CREATE TABLE IF NOT EXISTS room_meta (
    room_code TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    deadline_epoch_ms INTEGER,
    updated_at TEXT NOT NULL,
    max_squad_size INTEGER NOT NULL DEFAULT 15,
    max_overseas_players INTEGER NOT NULL DEFAULT 8
  );
  CREATE TABLE IF NOT EXISTS bids (
    bid_id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    lot_number INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    franchise_id TEXT NOT NULL,
    amount_cr REAL NOT NULL,
    state_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lot_results (
    room_code TEXT NOT NULL,
    lot_number INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    status TEXT NOT NULL,
    final_bid_cr REAL NOT NULL,
    winning_franchise_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_code, lot_number)
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processed_messages (
    room_code TEXT NOT NULL,
    participant_token_hash TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ack_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, participant_token_hash, message_id)
  );
  ```

---

### 2.3 Optional Central Store (Neon PostgreSQL) & Dual-Write Prevention

In production (`DATABASE_URL` unset), **Durable Object SQLite is the sole authoritative store**. If `DATABASE_URL` is optionally configured, `syncOutboxToNeon()` prevents inconsistent dual writes via a local outbox:

1. **Local DO SQLite is the Authoritative Source of Truth for Live & Completed Rooms**:
   - Bids, lots, timers, custom room limits, and squad updates are committed atomically to local DO SQLite in `< 2ms` (inside `transactionSync` with rollback + `storageFailure` pause hold on error).
   - Clients never experience network latency waiting for a round-trip to an external database.
2. **Optional Transactional Outbox Sync (`DATABASE_URL`)**:
   - When a lot closes (`LOT_SOLD` / `LOT_UNSOLD`) or an auction finishes (`AUCTION_COMPLETED`), the DO queues an outbox row in the same SQLite transaction.
   - If `DATABASE_URL` is set, `syncOutboxToNeon()` posts parameterized queries directly via `fetch()` to the Neon HTTPS `/sql` endpoint (`ON CONFLICT DO UPDATE`), preserving order (`ORDER BY id ASC`) without requiring a Node TCP pool or extra driver dependency.
   - Note: `syncOutboxToNeon` mirrors completed lot results and `UPDATE rooms SET status = 'completed'` as an optional event sink; full `room_meta` config/limits remain authoritative in DO SQLite.

---

## 3. Request & Event Lifecycle

### 3.1 Bidding Sequence
```
Client A                  Cloudflare Worker / DO                 All Other Clients
   │                               │                                     │
   │── WS: PLACE_BID ─────────────►│                                     │
   │   (franchiseId, amount)       │                                     │
   │                               │ 1. Validate session & franchise     │
   │                               │ 2. Validate increment & purse       │
   │                               │ 3. Check lot is OPEN                │
   │                               │ 4. Commit to DO SQLite              │
   │                               │ 5. setAlarm(Date.now() + 15000)     │
   │◄── WS: ACK (success: true) ───│                                     │
   │                               │── WS: BID_ACCEPTED ────────────────►│
   │                               │   (lot, bidder, nextValidBid)       │
```

### 3.2 Timer Expiry Sequence
```
Cloudflare Alarm Engine          AuctionRoomDO                   All Clients
        │                              │                              │
        │── alarm() fires ────────────►│                              │
        │   (at deadlineEpochMs)       │ 1. Verify lot still open     │
        │                              │ 2. If bids exist: SOLD       │
        │                              │    - Deduct franchise purse  │
        │                              │    - Add player to squad     │
        │                              │ 3. Else: UNSOLD              │
        │                              │ 4. Commit result to SQLite   │
        │                              │ 5. Queue outbox event        │
        │                              │── WS: LOT_COMPLETED ────────►│
        │                              │   (result, lot, history)     │
        │                              │ 6. Present next player       │
        │                              │── WS: LOT_PRESENTED ────────►│
        │                              │ 7. setAlarm(Date.now() + 15000)
```

---

## 4. Frontend (React only)

Unity was removed on 2026-11-26. The whole interface, from the landing page to the results, is React.
Nothing loads WebGL or WASM. The client keeps one `CloudflareNativeWsAdapter` per room session,
owned by `RoomSessionController` (see `docs/SESSION_LIFECYCLE.md`). Broadcasts are deltas where
possible:

| Event | Payload |
|-------|---------|
| `STATE_UPDATED` | full public room state (join of a new participant, franchise claim, pause/resume, start) |
| `LOT_PRESENTED` | `{partial: true, currentLot, currentPlayerIndex, status, lotNumber, totalLots, deadlineEpochMs}` |
| `BID_ACCEPTED` | `{bid, currentLot, nextValidBid, deadlineEpochMs}` (purses only change on a sale) |
| `LOT_COMPLETED` | `{result, lot, historyEntry, franchiseUpdates, playerUpdate}` (only the franchises that changed) |

Measured in local workerd over 40 lots, ~14 KB per lot per client against ~870 KB before this change.

---

## 5. Independent Review Findings & Hardening Architecture

During the pre-deployment independent review, several critical architectural invariants were hardened:

### 5.1 Persistent Message-ID Deduplication (SQLite-Backed)
Rather than relying on volatile memory, message deduplication is backed directly by the Durable Object's SQLite storage engine via table `processed_messages`:
- **Schema**: `PRIMARY KEY (room_code, participant_token_hash, message_id)`, with `ack_json` and `created_at`.
- **Scope & Isolation**: Deduplication is strictly scoped to the authenticated participant's session token hash and room code.
- **Hibernation & Eviction Survival**: Replayed messages arriving after the DO has hibernated or been evicted from memory hit the SQLite cache, immediately returning the original response without incrementing lot state versions or re-executing state mutations.
- **Retention Policy**: A 2-hour retention window (7,200,000 ms) ensures message IDs are preserved across reconnections and cannot be prematurely pruned while active.

### 5.2 Deterministic Timer & Bid Race Ordering
The system does not rely on arbitrary timing tolerances (such as magic millisecond offsets). Instead, a rigorous state machine and exact timestamp ordering rule govern bidding and lot expiry:
1. **Authoritative Expiry Rule**:
   $$\text{activeDeadline} = \text{room.deadlineEpochMs} \parallel \text{lot.deadlineEpochMs}$$
   Any bid arriving at or after `activeDeadline` ($\text{bidEpoch} \ge \text{activeDeadline}$) is rejected as expired (`'Bidding is closed for this player'`).
2. **Alarm Extension Detection**:
   When `alarm()` executes while `lot.hammerStatus === 'OPEN'`:
   - If $\text{now} < \text{activeDeadline}$, a valid bid arrived before this alarm fired and extended the deadline. The DO re-arms the alarm for `activeDeadline` and returns without mutating lot state.
   - If $\text{now} \ge \text{activeDeadline}$, the lot is atomically transitioned from `'OPEN'` to `'SOLD'` or `'UNSOLD'`. Once transitioned, no subsequent bid can be accepted.
3. **Atomic 4-Second Post-Lot Hammer Advancement**:
   Upon lot closure, a 4-second display pause (`DEFAULT_CONFIG.autoAdvanceDelay = 4`) is scheduled via `ctx.storage.setAlarm`. When the alarm wakes:
   - If `lot.hammerStatus` is `'SOLD'` or `'UNSOLD'`, it automatically calls `presentNextLot()`, resetting the countdown to 15s and advancing the catalogue round-robin.
   - If the alarm is retried, the lot has already advanced; the new lot's deadline is in the future, guaranteeing that the next player is presented **exactly once**.

### 5.3 Outbox Durability & Database Authority Matrix
Every accepted bid and lot disposition is committed to local SQLite before network transmission:
1. **Accepted Bids**: Written synchronously to `bids` table inside `transactionSync`.
2. **Lot Outcomes**: Written synchronously to `lot_results`, `room_meta`, and `outbox` inside one SQLite `transactionSync` **before** broadcasting `LOT_COMPLETED` (rolling back cleanly to a `storageFailure` pause hold on error).
3. **Optional Idempotent Neon Sync**:
   `syncOutboxToNeon()` / `flushOutbox()` delivers pending `outbox` events when `DATABASE_URL` is configured. If Neon is unconfigured (`DATABASE_URL` unset, the production default), outbox rows remain locally inspectable via `/export` and Durable Object SQLite stays the complete source of truth.

#### Database Authority Matrix

| Data Domain | Authoritative Store | Optional Secondary Store (`DATABASE_URL`) | Consistency Model |
|---|---|---|---|
| **Live Room State & Config** | **Durable Object SQLite** (`room_meta`) | Not replicated by outbox | Strongly consistent (Single-writer actor) |
| **Accepted Bids** | **Durable Object SQLite** (`bids`) | Retained locally; `/export` | Realtime local SQLite |
| **Lot Outcomes** | **Durable Object SQLite** (`lot_results`) | Neon PostgreSQL (`lot_results` via Outbox) | Realtime local SQLite; Eventual sync when `DATABASE_URL` set |
| **Pending Sync Queue** | **Durable Object SQLite** (`outbox`) | Neon PostgreSQL | At-least-once with idempotent delivery |
| **Legacy Historical Rooms** | **Legacy Node Server / PostgreSQL** | `persisted_rooms.json` / Postgres | Kept separate on Node/Socket.IO path (`VITE_USE_SOCKETIO=true`) |
| **Participant Sessions** | **Durable Object SQLite** (`processed_messages`) | Transient WebSocket attachment | Strongly consistent per room |

### 5.4 Official Cloudflare Resource Limits & Non-Guaranteed Uptime
1. **Three Distinct Limit Dimensions**:
   - **Request Quota**: 100k Worker requests/day + 100k DO requests/day (incoming WebSockets billed at 20:1 ratio; outbound broadcasts free).
   - **Compute Duration**: 13,000 GB-seconds/day (hibernating WebSockets consume 0 GB-seconds).
   - **SQLite Quotas**: 5 GB storage, 5,000,000 reads/day, and 100,000 writes/day.
2. **Uptime & Quota Reality**:
   Neither 100% uptime nor unlimited free headroom is guaranteed. If daily write limits or request quotas are exceeded, Cloudflare enforces a hard stop (HTTP 429 / WebSocket 1015). The ₹0 budget is strictly protected because no automated billing or card charging can occur on the free tier.


