# PostgreSQL Persistence (Stage 1)

Status: **implemented and tested against real, disposable PostgreSQL servers. Not deployed.**
No production database has been connected to and no production setting has been changed.

---

## 1. Storage modes

| Mode | Selected by | Durable on Render | Notes |
|---|---|---|---|
| JSON file (**default**) | `PERSISTENCE` unset or `json` | **No** (ephemeral disk) | Unchanged behaviour; debounced writes |
| PostgreSQL (opt-in) | `PERSISTENCE=postgres` **and** `DATABASE_URL` | **Yes** | The JSON file is never read or written |

There is exactly one storage authority per process, and no automatic fallback. If PostgreSQL is
selected but can't be used, the server logs `[storage] FATAL: …` and exits with code 1. That
covers a missing URL, an unreachable database, a pending or edited migration, an invalid or
changed `TOKEN_HASH_SECRET`, and invalid numeric settings. `DATABASE_URL` alone never switches
modes.

## 2. Durability guarantee (PostgreSQL mode)

**A critical operation is acknowledged to a client only after its database transaction has
committed. No client is told about a change until it has committed.**

- **Covered operations:** room creation (HTTP 200), joining, franchise selection, config
  change, start, pause, resume, bid, host advance (SOLD/UNSOLD), skip set, finish, and Playing XI
  / captain / impact-player updates.
- **How it works:** every change starts its room's write immediately (there is no debounce).
  The socket ack, or the HTTP response, waits until that change is in a committed transaction.
- **Broadcasts:** `bid_accepted`, `lot_completed`, `set_skipped`, `state_updated` and timer
  ticks describing an uncommitted change are held, then released in their original order once
  it commits. That includes changes the server makes on its own, such as the hammer falling
  when the timer expires and auto-advance.
- **Committed state only:** `GET /api/rooms/:code` and join responses return only committed
  state.
- **Concurrency and duplicates:** requests for one room are serialized by the server and
  validated against the latest state (lot `stateVersion`, idempotent hammer). The database
  enforces one squad per player, one result per player and one bid per lot state.
- **Retries are idempotent:** a retry rewrites the same absolute values (purse, squad,
  results), so it can't deduct a purse twice. A commit whose acknowledgement was lost is
  recognised by `rooms.last_write_id` and adopted.
- **If saving fails** (database down after retries, a conflict, or the writer lease lost), the
  room goes on **storage hold**:
  - a live auction is paused and its clock stopped;
  - the requester gets `code: STORAGE_UNAVAILABLE`, meaning not confirmed;
  - other clients are told nothing;
  - further actions on the room are refused;
  - the store keeps retrying (backoff up to 30 s). Once the room is saved, the hold lifts, the
    held broadcasts go out, and the host resumes.

**What a crash can still lose:** only changes whose transaction had not committed. By
construction, no client was ever told those succeeded. The window is the time one room
transaction takes (milliseconds). The clock's per-second countdown is never saved (restart
rule below). Verified by crash tests that SIGKILL the server the instant an ack arrives
(`tests/pgDurability.test.js`).

**Restart rule (unchanged):**
- An auction that was ACTIVE comes back PAUSED; its open lot's countdown resets to the full
  timer, and the highest bid and bidder are kept.
- A room the host had paused keeps its exact countdown.
- Lobby and completed rooms come back unchanged.
- Participants reconnect with their existing browser session, legacy `usr_<timestamp>_<x>`
  tokens included.

## 3. Single instance only

**Run exactly one backend instance. Do not enable multiple Render instances, horizontal scaling
or autoscaling.** There is no multi-instance coordination. Enforcement:

- **Writer lease:** the server must hold a lease row in the database (`storage_meta`,
  heartbeat every TTL/3) to save anything. Every write transaction re-checks the lease, so an
  instance without it can never commit room data.
- **A second instance waits in STANDBY:**
  - `/api/health` → HTTP 200, `"status": "standby"`;
  - room endpoints → 503;
  - socket joins → `code: STARTING`.

  It becomes ACTIVE (lease acquired, all rooms loaded from the database) when the first
  instance stops gracefully (it releases the lease at once) or after `DB_LEASE_TTL_MS` (default
  30 s) if the first crashed. This is exactly what happens during a Render deploy: the new
  instance starts while the old one runs, gets traffic once healthy, and takes over when the old
  one receives SIGTERM, flushes and releases the lease. Expect a few seconds of "starting" for
  clients during a deploy (up to the TTL after a crash).
- **Lease lost** (for example, a network partition longer than the TTL while another instance
  started): this instance stops saving, puts every room on hold, logs `WRITER LEASE LOST`, and
  health reports `degraded` with `leaseLost: true`. Restart it.
- **Version check:** each room's `version` is still checked, as a second layer against a stale
  writer.

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PERSISTENCE` | `json` | `json` or `postgres`. Anything else refuses to start. |
| `DATABASE_URL` | — | PostgreSQL connection string (required for `postgres`). For Neon, use the **pooled** URL with `sslmode=require` for the app. |
| `TOKEN_HASH_SECRET` | — (unset) | Optional pepper for session-token hashes. See section 5. At least 32 characters when set. |
| `DB_LEASE_TTL_MS` | `30000` | Writer-lease expiry (2000–300000). Lower values mean faster takeover after a crash, but less tolerance for database hiccups. |
| `DB_AUTO_MIGRATE` | `false` | `true` applies pending migrations at startup (advisory-locked). Useful on Render's free plan, which has no pre-deploy command. |
| `PG_POOL_MAX` | `5` | Pool size (1–50). |
| `DB_CONNECT_ATTEMPTS` | `6` | Startup connection attempts, with backoff (~15 s; Neon computes may need to wake). |
| `ROOM_STORAGE_FILE` | `server/data/persisted_rooms.json` | JSON mode only. |
| `TEST_DATABASE_URL` | — | Tests only: admin URL of a **disposable local** server. Hosted hosts (`*.neon.tech`, AWS, Render, Supabase …) are always refused. |

Set secrets in the Render dashboard (as secret environment variables), never in the repository.

## 5. `TOKEN_HASH_SECRET`

- **What it does:** the database stores only hashes of session tokens. With the secret set,
  they're HMAC-SHA-256 hashes. A database leak alone then doesn't allow offline guessing of
  tokens, which matters for the low-entropy legacy `usr_<timestamp>_<6 chars>` tokens. Without
  it, plain SHA-256 is used. That still never exposes raw tokens, but legacy tokens could be
  brute-forced from a leaked database.
- **Generate** (on your own machine, once):
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
  The app never generates or configures it for you.
- **Configure:**
  - *Render:* dashboard → Environment → add `TOKEN_HASH_SECRET` (secret).
  - *Local development:* leave it unset, or export a separate dev-only value. Never reuse the
    production value locally.
- **Back it up before first use** in a password manager or another secret store. **Losing or
  changing it locks every participant out of every existing room**: the rooms stay intact, but
  nobody's session can be matched again.
- **Startup validation:**
  - shorter than 32 characters, or with surrounding whitespace → refused;
  - the database records the hashing scheme plus a *verifier* (the hash of a fixed constant,
    which reveals nothing usable about the secret). A missing, added or **changed** secret no
    longer matches it, so the server refuses to start with `Token hash scheme mismatch` or
    `Token hash secret mismatch`.
- **Recovery:** restore the original value from your backup and restart. If it's truly lost,
  there's no way to re-link existing sessions. Players would have to start new rooms. Don't
  delete the verifier to force startup, because that changes nothing about the lockout.
- **Never exposed:** the secret and raw tokens never appear in logs, `/api/health`, API
  responses or the database (tested).
- **Decide before the first PostgreSQL write or import.** Switching between "set" and "unset"
  later is also refused.

## 6. Schema (migration `001_initial_schema`)

| Table | Contents | Integrity |
|---|---|---|
| `rooms` | status, host, host token hash, config, current lot (no player object), evaluation, `version`, `last_write_id` | status/code CHECKs, optimistic version |
| `franchises` | owner (hash + public id), purses, overseas count, elimination, profile | `remaining_purse >= 0` |
| `participants` | token hash, public id, name, franchise, host flag, order | unique public id |
| `room_players` | the room's frozen catalogue in lot order + status / buyer / price | `sold` ⇒ buyer and price |
| `squad_entries` | ownership | **PK (room, player): no double sale** |
| `lineups`, `lineup_players` | Playing XI (ordered), captain, VC, keeper, impact, confirmed | **FKs: only players the franchise bought** |
| `bids` | every accepted bid | unique bid id; one per (player, lot, version) |
| `lot_results` | SOLD / UNSOLD / SKIPPED in order | one per player; SOLD ⇒ winner and price |
| `audit_logs` | every entry (memory keeps the newest 200) | PK (room, seq) |
| `quarantined_rooms` | rooms that couldn't be imported, original text verbatim | |
| `migration_runs`, `migration_room_log` | import bookkeeping | |
| `storage_meta` | token hash scheme + verifier, writer lease | |

The app works through Neon's pooler: queries are parameterized, statements are unnamed, and
all locks are transaction-scoped.

## 7. Commands

```bash
DATABASE_URL=<direct url> npm run db:migrate     # apply migrations (idempotent)
DATABASE_URL=<direct url> npm run db:status      # read-only: schema, rooms, quarantine, import runs
DATABASE_URL=<direct url> npm run db:import-json -- --file <COPY.json> --dry-run
DATABASE_URL=<direct url> npm run db:import-json -- --file <COPY.json> --confirm [--report out.json]

npm test                                              # PostgreSQL suites need a disposable DB:
TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npm test
npm i --no-save embedded-postgres && npm test         # or a temporary embedded cluster
npm test -- pgDurability pgInstance                   # subset
REQUIRE_PG=1 npm test                                 # CI: skipped PostgreSQL suites fail the run
```

Importer guarantees:
- **The source is only read.** It's snapshotted, and its sha256 is checked before and after.
- **One transaction per room.**
- **Idempotent:** re-running skips identical rooms.
- **Resumable** after a crash.
- **Nothing silently dropped:** duplicate keys, invalid shapes and codes, double sales, and
  values that can't be stored faithfully are quarantined verbatim.
- **Existing rooms are never overwritten.**
- **Same restore logic as the server:** legacy Playing XI cleanup and sale-record repair.
- **Same token hashing as the server:** it validates `TOKEN_HASH_SECRET` and runs the
  scheme/verifier check, so an import made with a different secret than the database (or the
  server) uses is refused instead of silently locking participants out.

Its guards: it refuses to read `server/data/persisted_rooms.json` directly, a real run needs
`--confirm`, and it **refuses to run while a server holds the writer lease** (pass
`--allow-while-server-running` to override).

## 8. Production cutover (only when approved; none of this has been done)

> **Rooms currently in production will not survive the cutover.** On Render's free plan the JSON
> file sits on an ephemeral disk that is wiped by every deploy and restart, and there's no shell
> to copy it out. The import tool is for JSON files you actually hold (for example, your local
> `server/data/persisted_rooms.json`). Announce the cutover, or do it when no auction is running.

Do the steps in order, and stop at the first failure.

1. **Back up what you have.** Copy any JSON save you want to keep, and **never** modify the
   original:
   ```bash
   mkdir -p backup && cp server/data/persisted_rooms.json backup/rooms-$(date +%F).json
   sha256sum server/data/persisted_rooms.json backup/rooms-*.json   # identical
   ```
2. **Create the Neon database** (Neon console): a new project or branch for the auction.
   Copy both connection strings: **pooled** (host contains `-pooler`) for the app, and
   **direct** for migrations and imports. Keep both secret.
3. **Decide on and back up `TOKEN_HASH_SECRET`** (section 5). Generate it yourself if you use
   one.
4. **Migrate** from your machine:
   ```bash
   export DATABASE_URL='<direct url>'
   npm run db:migrate && npm run db:status          # "Schema is up to date."
   ```
5. **Import a snapshot** if you have one. If you set `TOKEN_HASH_SECRET`, export the **same**
   value first, because the import hashes tokens and records the verifier.
   ```bash
   export TOKEN_HASH_SECRET='<the backed-up value>'   # only if you use one
   npm run db:import-json -- --file backup/rooms-YYYY-MM-DD.json --dry-run
   npm run db:import-json -- --file backup/rooms-YYYY-MM-DD.json --confirm
   ```
6. **Verify the import.** Run `npm run db:status`: the room counts should match the report, and
   any quarantined rooms are listed with reasons. Read the report: `source.unchanged: true`,
   `failed: 0`, and investigate any quarantined room before continuing.
7. **Configure Render** (dashboard → service → Environment). Don't edit `render.yaml`:
   - `PERSISTENCE=postgres`
   - `DATABASE_URL=<pooled url>`
   - `TOKEN_HASH_SECRET=<value>` if used, exactly as in step 5
   - optionally `DB_AUTO_MIGRATE=true`

   Also confirm **Instances = 1** and that autoscaling is off.
8. **Deploy backend and frontend together.** Watch the log for
   `[storage] ACTIVE: PostgreSQL (…) is the durable storage authority`.
9. **Check health and recovery:**
   - `GET /api/health`: `status: "ok"`, `storage.kind: "postgres"`, `durable: true`,
     `role: "active"`, `leaseHeld: true`, `connected: true`, `schemaUpToDate: true`,
     `pendingWrites: 0`, `conflicts: []`, `roomsOnHold: []`.
   - **Recovery test:** create a room with two browsers, select franchises, start, place a bid.
     Then restart the service from the dashboard. Both browsers should reconnect by themselves,
     and the room should be **paused** with the bid kept. The host resumes, you sell the lot,
     and the buyer can put that player in the Playing XI.

**Rollback** (any time):
- **Storage:** remove `PERSISTENCE`, or set it to `json`, and redeploy. The server goes back to
  the ephemeral JSON file. **Rooms created while on PostgreSQL stay only in PostgreSQL; there
  is no reverse sync.** Switching back later restores that PostgreSQL state.
- **Code:** redeploy the previous release. It doesn't use the database at all. The schema is
  additive and can stay.
- **Data:** Neon point-in-time restore (create a branch at a timestamp; retention depends on
  the plan), or `pg_dump --format=custom "$DIRECT_URL" > ipl-$(date +%F).dump` taken
  beforehand.

## 9. Runbook

`/api/health` returns HTTP 200 in every state, so problems don't trigger a restart loop. Read
`status`: `ok` | `degraded` | `standby` | `starting`.

| Symptom | Meaning | Action |
|---|---|---|
| `degraded`, `roomsOnHold` non-empty, `connected: false` | Database unreachable; those rooms are paused and unconfirmed actions are kept in memory | Check Neon. The store retries every ≤ 30 s and the hold lifts by itself. **Don't restart while held**: unconfirmed actions would be lost (nobody was told they succeeded). |
| `degraded`, `conflicts: [...]` | Another writer changed a room | Make sure only one instance exists, then restart (it reloads from the database). |
| `degraded`, `leaseLost: true` | Another instance took the writer lease | Make sure only one instance exists, then restart this one. |
| `standby` for longer than `DB_LEASE_TTL_MS` | Another instance is alive and holds the lease | Find and stop the extra instance (scaling must be 1). |
| `FATAL: Pending migration(s)` | New code needs a migration | `npm run db:migrate` (direct URL), or `DB_AUTO_MIGRATE=true`. |
| `FATAL: … modified after it was applied` | A migration file was edited | Restore it. Changes go in a new numbered migration. |
| `FATAL: Token hash scheme/secret mismatch` | `TOKEN_HASH_SECRET` added, removed or changed | Restore the original value (section 5). |
| `quarantinedRooms` non-empty | Rooms that couldn't be loaded or imported (data untouched) | `SELECT room_code, reason, original_text FROM quarantined_rooms WHERE resolved_at IS NULL;`. After manual repair, set `resolved_at = now()`. |

## 10. Known limits

- **Single instance only** (section 3).
- **Timer ticks aren't saved;** the restart rule applies.
- **Uncommitted changes are lost on a crash,** but they were never acknowledged (section 2).
- **Memory keeps the newest 200 audit entries;** the database keeps all of them.
