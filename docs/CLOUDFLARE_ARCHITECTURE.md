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
    status TEXT NOT NULL,
    host_token_hash TEXT NOT NULL,
    config_json TEXT NOT NULL,
    current_player_index INTEGER NOT NULL,
    deadline_epoch_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS participants (
    token_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_id TEXT NOT NULL,
    franchise_id TEXT,
    is_host INTEGER NOT NULL,
    joined_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bids (
    bid_id TEXT PRIMARY KEY,
    lot_number INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    franchise_id TEXT NOT NULL,
    amount_cr REAL NOT NULL,
    state_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lot_results (
    player_id TEXT PRIMARY KEY,
    lot_number INTEGER NOT NULL,
    result TEXT NOT NULL,
    franchise_id TEXT,
    price_cr REAL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  ```

---

### 2.3 Central SaaS Store (Neon PostgreSQL) & Dual-Write Prevention

To prevent inconsistent dual writes between the local DO SQLite store and central Neon PostgreSQL:

1. **Local DO SQLite is the Authoritative Source of Truth for Live Auctions**:
   - Bids, lots, timers, and squad updates are committed to local DO SQLite in < 2ms.
   - Clients never experience network latency waiting for a round-trip to an external database.
2. **Transactional Outbox Pattern for Central Sync**:
   - When an auction completes, or when a lot is SOLD, the DO writes an event into its local SQLite `outbox` table in the *same local transaction*.
   - A non-blocking background queue reads the `outbox` table and syncs records to Neon PostgreSQL using `@neondatabase/serverless`.
   - **Resilience to Neon Outages**: If Neon is asleep, rate-limited, or experiencing downtime, the live auction continues flawlessly. The DO outbox accumulates pending events and drains them once Neon recovers.
   - Central reports and historical records remain fully preserved.

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
3. **Atomic 3-Second Post-Lot Hammer Advancement**:
   Upon lot closure, a 3-second display pause is scheduled via `ctx.storage.setAlarm`. When the alarm wakes:
   - If `lot.hammerStatus` is `'SOLD'` or `'UNSOLD'`, it automatically calls `presentNextLot()`, resetting the countdown to 15s and advancing the catalogue round-robin.
   - If the alarm is retried, the lot has already advanced; the new lot's deadline is in the future, guaranteeing that the next player is presented **exactly once**.

### 5.3 Outbox Durability & Database Authority Matrix
Every accepted bid and lot disposition is committed to local SQLite before network transmission:
1. **Accepted Bids**: Written synchronously to `bids` table with unique constraint.
2. **Lot Outcomes**: Written synchronously to `lot_results` and queued in `outbox` as `'pending'`.
3. **Idempotent Background Synchronization**:
   `flushOutbox(targetSyncFn)` delivers pending records to Neon PostgreSQL. If Neon experiences an outage or partial failure, delivered records are marked `'delivered'` while failed records remain `'pending'`, resuming cleanly upon reconnection.

#### Database Authority Matrix

| Data Domain | Authoritative Store | Secondary / Synchronized Store | Consistency Model |
|---|---|---|---|
| **Live Room State** | **Durable Object SQLite** (`room_meta`) | Memory cache inside DO actor | Strongly consistent (Single-writer actor) |
| **Accepted Bids** | **Durable Object SQLite** (`bids`) | Neon PostgreSQL (`bids` table via Outbox) | Realtime local SQLite; Eventual sync to Neon |
| **Lot Outcomes** | **Durable Object SQLite** (`lot_results`) | Neon PostgreSQL (`lot_results` via Outbox) | Realtime local SQLite; Eventual sync to Neon |
| **Pending Sync Queue** | **Durable Object SQLite** (`outbox`) | Neon PostgreSQL | At-least-once with idempotent delivery |
| **Global SaaS Records & Archives** | **Neon PostgreSQL** | DO SQLite (local only) | Global authority for multi-room analytics |
| **Participant Sessions** | **Durable Object SQLite** (`processed_messages`) | Transient WebSocket attachment | Strongly consistent per room |

### 5.4 Official Cloudflare Resource Limits & Non-Guaranteed Uptime
1. **Three Distinct Limit Dimensions**:
   - **Request Quota**: 100k Worker requests/day + 100k DO requests/day (incoming WebSockets billed at 20:1 ratio; outbound broadcasts free).
   - **Compute Duration**: 13,000 GB-seconds/day (hibernating WebSockets consume 0 GB-seconds).
   - **SQLite Quotas**: 5 GB storage, 5,000,000 reads/day, and 100,000 writes/day.
2. **Uptime & Quota Reality**:
   Neither 100% uptime nor unlimited free headroom is guaranteed. If daily write limits or request quotas are exceeded, Cloudflare enforces a hard stop (HTTP 429 / WebSocket 1015). The ₹0 budget is strictly protected because no automated billing or card charging can occur on the free tier.


