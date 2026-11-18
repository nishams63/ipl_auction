# Persistent Storage Migration Plan: JSON file → Neon PostgreSQL

**Status:** IMPLEMENTED in Stage 1 (not deployed). See [DATABASE_PERSISTENCE.md](DATABASE_PERSISTENCE.md) for the as-built design, commands and runbook. This plan is kept for history. No production database has been connected to.
**Date:** 16 Nov 2026

---

## 1. Current architecture (inspected)

| Aspect | Today |
|---|---|
| Authority | In-memory `RoomManager` (`server/roomManager.js`). One `Map<roomCode, room>`; timers are `setInterval` per room. |
| Persistence | Whole `rooms` map serialised to `server/data/persisted_rooms.json`. |
| Save points (Stage 0.5) | An explicit `scheduleSave()` in each of 13 mutation paths (join, reconnect, franchise claim/release, config, start, pause, resume, bid, SOLD, UNSOLD, next lot, skip set, completion): a debounced (750 ms) atomic write. Room creation, Playing XI and skip set write immediately. SIGTERM/SIGINT flushes. Verified per mutation by `tests/persistence.test.js` (P8). |
| Not persisted | Countdown ticks (by design: no disk write per second). On a hard crash (SIGKILL/OOM), up to about 750 ms of changes can be lost. |
| Restore rule | On boot all rooms load. A room that was `active` becomes `paused`, its open lot's countdown resets to the full timer and the hammer to OPEN; the highest bid and bidder are kept. A room the host had paused keeps its exact countdown. A hammered lot stays closed, and resume presents the next player. |
| Labelling | `/api/health` → `storage: { kind: "json-file", durable: false, warning }`; a startup log warning; a header comment in `roomManager.js`. **This is not production-grade persistence.** |
| Hosting | Render **free** web service. Its filesystem is **ephemeral**, so the JSON file is wiped on every deploy, restart and spin-down. |
| Room size | Each room embeds a full copy of the 290-player catalogue, plus squads, bids, history and audit log. |
| Identity | A private client token keys `participants`; `hostToken` is stored on the room. |

**Consequence:** today, "production data" is only whatever rooms exist in the live Render instance's memory, and it disappears on every deploy. There is no historical production data to migrate. The Neon switch therefore adds durability without needing a risky data move.

## 2. Target architecture

```
Browser ──Socket.IO──► Render (Express + RoomManager, in-memory authority)
                                  │  async, debounced, non-blocking
                                  ▼
                           Storage adapter  ──► JsonFileStore   (no DATABASE_URL: current behaviour)
                                             └► PostgresStore   (DATABASE_URL set: Neon)
```

Principles:
1. **The in-memory RoomManager stays the live authority.** Bids are never blocked on a database round-trip, so bidding speed is unchanged. The auction engine is not rewritten.
2. **Storage is selected by one env var.** If `DATABASE_URL` is set, Postgres is used; if it is unset, the current JSON file is used. Rollback is removing the variable.
3. **Additive only.** Migrations only create tables and indexes. Nothing is dropped or reset. Historical rows are never deleted.
4. **Same contract for both adapters.** `tests/persistence.test.js` (P1–P7) is the acceptance contract and must pass against both stores.

## 3. Proposed schema (`server/storage/migrations/001_init.sql`)

```sql
-- Live room snapshot: exact restore of RoomManager state (minus secrets)
CREATE TABLE rooms (
  room_code        TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('lobby','active','paused','completed')),
  host_name        TEXT NOT NULL,
  host_token_hash  TEXT NOT NULL,            -- sha256, never the raw token
  config           JSONB NOT NULL,
  snapshot         JSONB NOT NULL,           -- currentLot, franchises (public), history, auditLog, lot order …
  snapshot_version BIGINT NOT NULL DEFAULT 0,-- monotonic; stale writes rejected
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX rooms_status_idx ON rooms (status) WHERE status <> 'completed';

CREATE TABLE participants (
  room_code     TEXT NOT NULL REFERENCES rooms(room_code),
  token_hash    TEXT NOT NULL,              -- sha256(private token)
  public_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  franchise_id  TEXT,
  is_host       BOOLEAN NOT NULL DEFAULT false,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_code, token_hash),
  UNIQUE (room_code, public_id),
  UNIQUE (room_code, franchise_id)          -- one owner per franchise per room
);

-- Append-only audit of accepted bids (history, analytics, dispute checks)
CREATE TABLE bids (
  bid_id        TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL REFERENCES rooms(room_code),
  lot_number    INT  NOT NULL,
  player_id     TEXT NOT NULL,
  franchise_id  TEXT NOT NULL,
  amount_cr     NUMERIC(6,2) NOT NULL,
  state_version INT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (room_code, lot_number, state_version)  -- no duplicate accepted bids
);
CREATE INDEX bids_room_idx ON bids (room_code, lot_number);

-- One row per lot outcome
CREATE TABLE lot_results (
  room_code     TEXT NOT NULL REFERENCES rooms(room_code),
  lot_number    INT  NOT NULL,
  player_id     TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('SOLD','UNSOLD','SKIPPED')),
  franchise_id  TEXT,
  price_cr      NUMERIC(6,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_code, player_id)        -- a player is auctioned at most once per auction
);

-- Shuffle order, written once at auction start (Stage 2)
CREATE TABLE lot_order (
  room_code  TEXT NOT NULL REFERENCES rooms(room_code),
  position   INT  NOT NULL,
  player_id  TEXT NOT NULL,
  PRIMARY KEY (room_code, position),
  UNIQUE (room_code, player_id)             -- every player exactly once
);

-- Reserved for later stages; created now so later stages need no schema change
CREATE TABLE chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(room_code),
  sender_public_id TEXT NOT NULL,
  body        TEXT NOT NULL CHECK (char_length(body) <= 300),
  hidden      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_room_idx ON chat_messages (room_code, id);

CREATE TABLE evaluation_snapshots (
  room_code          TEXT PRIMARY KEY REFERENCES rooms(room_code),
  evaluation_version TEXT NOT NULL,
  inputs             JSONB NOT NULL,         -- squads as evaluated
  objective_result   JSONB NOT NULL,         -- deterministic rankings
  ai_analysis        JSONB,                  -- null if AI unavailable
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
```

Design notes:
- **Tokens are hashed at rest.** At migration time, the in-memory `participants` map will be keyed by `sha256(token)` rather than the raw token, so a restore from the database works without ever storing raw tokens. `join_room` hashes the incoming token before lookup. This is internal only; the socket contract is unchanged.
- **The catalogue is not copied into every room.** A room stores its lot order and per-player status; player data comes from the catalogue. This shrinks each room snapshot from about 150 KB to a few KB. This lands with Stage 2 (shuffle).
- **`snapshot_version` is checked on every write** (`UPDATE … WHERE snapshot_version < $new`), so a delayed write can never overwrite newer state.

## 4. Neon free-plan fit

From Neon's own FAQ (last updated 1 Oct 2026): 100 CU-hours of compute per project per month, 1 GB storage per project, 5 GB public transfer, scale-to-zero after 5 minutes idle, and resume in a few hundred milliseconds.

| Concern | Assessment |
|---|---|
| Storage (1 GB) | With catalogue-free snapshots (a few KB each) plus bids and chat, this is roughly tens of thousands of auctions. Fine. |
| Compute (100 CU-hours) | The database only wakes while an auction is writing. At 0.25 CU that is about 400 active hours a month. Fine for hobby use, **as long as nothing polls the database when idle** (the health check must not query it). |
| Cold start | First write after idle waits a few hundred ms. Writes are async and debounced, so players never feel it. Restoring a room at boot may take up to about 1 s. |
| Limit hit | Neon suspends compute until next month. The app then logs storage errors and **keeps running in memory** (§6), behaving like today. |

## 5. Rollout steps and approval gates

| Step | What | Who | Touches production? |
|---|---|---|---|
| S1 | Create a Neon project in the region closest to your Render service (check Render → Settings → Region). Neon creates a `main` branch; add a **`dev` branch** for testing. | You | No |
| S2 | Give me the **dev** branch connection string only (pooled URL, `sslmode=require`) for local test runs. Never commit it. | You | No |
| S3 | Implement `server/storage/{index,jsonStore,postgresStore}.js`, migrations runner (`npm run db:migrate`, explicit, never automatic on boot), `pg` dependency. Run P1–P7 against JSON **and** the Neon dev branch. | Me | No |
| S4 | Review: I show the diff and test results against both stores. | You approve | No |
| S5 | Run `npm run db:migrate` against the Neon **main** branch (creates empty tables only). | You approve, then run | Neon main: new empty tables |
| S6 | Add `DATABASE_URL` (main branch, pooled) to Render env vars, then deploy **when no auction is live**. A deploy already wipes in-memory rooms today, so this is no worse. | You approve, then deploy | Yes |
| S7 | Verify: create a room, bid, trigger a manual Render restart, rejoin, confirm the state survived. | Both | Yes (read/verify) |

Optional: `npm run db:import-json -- <file>` imports a local `persisted_rooms.json` (for example, your dev rooms) into a branch. The live Render file can't be pulled on the free plan (no shell), and it has no lasting data anyway.

## 6. Failure handling

- Database writes are queued per room and coalesced. On failure: retry with exponential backoff (up to 60 s), keep serving from memory, and log once per failure streak.
- `/api/health` gains `storage: { kind, ok, lastWriteAt, lastError }`, read from memory with no database query.
- If Postgres is unreachable at boot, the server starts with no restored rooms and keeps retrying in the background. New rooms work immediately.

## 7. Rollback

| Situation | Action | Data impact |
|---|---|---|
| Problem after S6 | Remove `DATABASE_URL` in Render and redeploy | App returns to JSON behaviour; Neon data is kept, untouched |
| Bad migration | Migrations are additive; to undo, drop only the new tables on the **dev** branch first, then main, with your approval | None to existing app data (there was none in Postgres before) |
| Neon outage | Nothing to do; app runs in memory | Changes made during the outage are saved once Neon returns |

## 8. Security

- `DATABASE_URL` lives only in the Render environment, never in client code, `vite` env, the repo, logs or Unity.
- Raw tokens are never stored (sha256 only). Public payloads stay sanitised (`toPublicFranchises`).
- Later hardening (optional): a separate Neon role for migrations (DDL) vs the app (DML only).

## 9. Open questions for you

1. Which Render region is the service in, so Neon can be placed next to it?
2. When should completed rooms stop being restored into memory at boot? Proposal: load active, paused and lobby rooms only; load completed rooms on demand via `GET /api/rooms/:code`.
