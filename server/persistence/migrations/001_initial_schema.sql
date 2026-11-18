-- 001_initial_schema.sql
-- Normalized PostgreSQL schema for IPL auction rooms (Neon-compatible, PostgreSQL 14+).
--
-- Conventions
--  * Every row belongs to one room (room_code) and is removed with it (ON DELETE CASCADE).
--  * Intra-room foreign keys are DEFERRABLE INITIALLY DEFERRED so one sync transaction can
--    write tables in any order; they are still checked at COMMIT.
--  * Session tokens are NEVER stored. Only a one-way hash (64 hex chars) is kept.
--  * Socket ids are connection-scoped and are deliberately not persisted.
--  * jsonb "details"/"extra"/"profile" columns hold fields that have no dedicated column
--    (including unknown legacy fields), so a restore is lossless.

CREATE TABLE storage_meta (
  key   text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── rooms ───────────────────────────────────────────────────────────────
CREATE TABLE rooms (
  room_code             text PRIMARY KEY CHECK (room_code ~ '^[A-Z0-9]{4,12}$'),
  status                text NOT NULL CHECK (status IN ('lobby', 'active', 'paused', 'completed')),
  host_name             text,
  host_token_hash       text CHECK (host_token_hash ~ '^[0-9a-f]{64}$'),
  config                jsonb NOT NULL,
  current_player_index  integer NOT NULL,
  current_lot           jsonb,          -- live lot state WITHOUT the player object (see current_lot_player_id)
  current_lot_player_id text,
  evaluation_results    jsonb,
  audit_seq             integer,        -- last audit sequence number issued for this room
  extra                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),  -- optimistic concurrency
  last_write_id         text,           -- id of the write that produced this version (lost-ack detection)
  source                text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'json-import')),
  source_checksum       text            -- sha256 of the imported JSON room (idempotent import)
);

-- ── franchises (10 per room) ────────────────────────────────────────────
CREATE TABLE franchises (
  room_code          text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  franchise_id       text NOT NULL,
  display_order      integer NOT NULL,
  is_claimed         boolean,
  owner_token_hash   text CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  owner_public_id    text,
  owner_name         text,
  initial_purse      numeric NOT NULL,
  remaining_purse    numeric NOT NULL CHECK (remaining_purse >= 0),
  total_spent        numeric CHECK (total_spent >= 0),
  overseas_count     integer CHECK (overseas_count >= 0),
  is_eliminated      boolean,
  elimination_reason text,
  profile            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- name, code, colours … as stored for this room
  PRIMARY KEY (room_code, franchise_id),
  UNIQUE (room_code, display_order) DEFERRABLE INITIALLY DEFERRED
);

-- ── participants (token hash only) ──────────────────────────────────────
CREATE TABLE participants (
  room_code    text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  token_hash   text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  public_id    text NOT NULL,
  join_order   integer NOT NULL,
  name         text,
  franchise_id text,
  is_host      boolean,
  extra        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_code, token_hash),
  UNIQUE (room_code, public_id),
  UNIQUE (room_code, join_order) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, franchise_id) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- ── room catalogue: frozen per room, position = lot order ───────────────
CREATE TABLE room_players (
  room_code  text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  player_id  text NOT NULL,
  position   integer NOT NULL CHECK (position >= 0),
  snapshot   jsonb NOT NULL,            -- catalogue entry (name, role, base price, set …)
  status     text CHECK (status IN ('available', 'in_auction', 'sold', 'unsold', 'SKIPPED')),
  sold_to    text,
  sold_price numeric CHECK (sold_price > 0),
  PRIMARY KEY (room_code, player_id),
  UNIQUE (room_code, position) DEFERRABLE INITIALLY DEFERRED,
  CHECK (status IS DISTINCT FROM 'sold' OR (sold_to IS NOT NULL AND sold_price IS NOT NULL)),
  FOREIGN KEY (room_code, sold_to) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE rooms ADD CONSTRAINT rooms_current_lot_player_fk
  FOREIGN KEY (room_code, current_lot_player_id) REFERENCES room_players (room_code, player_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ── ownership: a player can be in at most ONE squad (no double sale) ────
CREATE TABLE squad_entries (
  room_code      text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  player_id      text NOT NULL,
  franchise_id   text NOT NULL,
  acquired_order integer NOT NULL,
  bought_price   numeric CHECK (bought_price > 0),
  overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- legacy fields that differ from the catalogue entry
  PRIMARY KEY (room_code, player_id),
  UNIQUE (room_code, player_id, franchise_id),
  UNIQUE (room_code, franchise_id, acquired_order) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, player_id) REFERENCES room_players (room_code, player_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, franchise_id) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- ── Playing XI / impact player / leadership ─────────────────────────────
-- kind 'franchise' = the lineup on the franchise record; 'saved' = playingXIConfigurations entry.
CREATE TABLE lineups (
  room_code        text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  franchise_id     text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('franchise', 'saved')),
  captain_id       text,
  vice_captain_id  text,
  wicket_keeper_id text,
  impact_player_id text,
  is_confirmed     boolean,
  confirmed_at     timestamptz,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_code, franchise_id, kind),
  FOREIGN KEY (room_code, franchise_id) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED,
  -- leadership and impact player must be players this franchise actually bought
  FOREIGN KEY (room_code, captain_id, franchise_id) REFERENCES squad_entries (room_code, player_id, franchise_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, vice_captain_id, franchise_id) REFERENCES squad_entries (room_code, player_id, franchise_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, wicket_keeper_id, franchise_id) REFERENCES squad_entries (room_code, player_id, franchise_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, impact_player_id, franchise_id) REFERENCES squad_entries (room_code, player_id, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lineup_players (
  room_code    text NOT NULL,
  franchise_id text NOT NULL,
  kind         text NOT NULL,
  slot         integer NOT NULL CHECK (slot BETWEEN 1 AND 11),
  player_id    text NOT NULL,
  PRIMARY KEY (room_code, franchise_id, kind, slot),
  UNIQUE (room_code, franchise_id, kind, player_id),
  FOREIGN KEY (room_code, franchise_id, kind) REFERENCES lineups (room_code, franchise_id, kind)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  -- purchased players only, enforced by the database as well as the server
  FOREIGN KEY (room_code, player_id, franchise_id) REFERENCES squad_entries (room_code, player_id, franchise_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- ── bids (append-only) ──────────────────────────────────────────────────
CREATE TABLE bids (
  room_code     text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  seq           integer NOT NULL CHECK (seq >= 0),  -- position in the room's bid log
  bid_id        text NOT NULL,
  lot_number    integer,
  player_id     text NOT NULL,
  franchise_id  text NOT NULL,
  amount        numeric NOT NULL CHECK (amount > 0),
  state_version integer NOT NULL,
  placed_at     timestamptz,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_code, seq),
  UNIQUE (room_code, bid_id),
  UNIQUE (room_code, player_id, lot_number, state_version),  -- one accepted bid per lot state
  FOREIGN KEY (room_code, player_id) REFERENCES room_players (room_code, player_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, franchise_id) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- ── sold / unsold / skipped results (append-only) ───────────────────────
CREATE TABLE lot_results (
  room_code            text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  player_id            text NOT NULL,
  seq                  integer NOT NULL CHECK (seq >= 0),  -- completion order
  status               text NOT NULL CHECK (status IN ('SOLD', 'UNSOLD', 'SKIPPED')),
  lot_number           integer,
  winning_franchise_id text,
  final_bid            numeric,
  bids_count           integer,
  completed_at         timestamptz,
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_code, player_id),   -- one result per player: no duplicate sale record
  UNIQUE (room_code, seq) DEFERRABLE INITIALLY DEFERRED,
  CHECK (status <> 'SOLD' OR (winning_franchise_id IS NOT NULL AND final_bid > 0)),
  FOREIGN KEY (room_code, player_id) REFERENCES room_players (room_code, player_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (room_code, winning_franchise_id) REFERENCES franchises (room_code, franchise_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- ── audit log (append-only; memory keeps the latest 200, the database keeps all) ──
CREATE TABLE audit_logs (
  room_code text NOT NULL REFERENCES rooms (room_code) ON DELETE CASCADE,
  seq       integer NOT NULL CHECK (seq >= 1),
  logged_at timestamptz,
  type      text,
  message   text,
  details   jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (room_code, seq)
);

-- ── rooms that could not be restored/imported: kept verbatim, never loaded ──
CREATE TABLE quarantined_rooms (
  id             bigserial PRIMARY KEY,
  room_code      text NOT NULL,
  occurrence     integer NOT NULL DEFAULT 1,
  checksum       text NOT NULL,
  reason         text NOT NULL,
  source         text NOT NULL,
  original_text  text NOT NULL,         -- the room's JSON exactly as it appeared in the source
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  UNIQUE (room_code, checksum)
);

-- ── JSON import bookkeeping ─────────────────────────────────────────────
CREATE TABLE migration_runs (
  run_id        bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  source_name   text NOT NULL,
  source_sha256 text NOT NULL,
  source_bytes  bigint NOT NULL,
  counts        jsonb,
  report        jsonb,
  tool_version  text NOT NULL
);

CREATE TABLE migration_room_log (
  run_id     bigint NOT NULL REFERENCES migration_runs (run_id) ON DELETE CASCADE,
  room_code  text NOT NULL,
  occurrence integer NOT NULL DEFAULT 1,
  outcome    text NOT NULL CHECK (outcome IN ('imported', 'skipped', 'quarantined', 'failed')),
  reason     text,
  checksum   text,
  logged_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, room_code, occurrence)
);

CREATE INDEX rooms_status_idx ON rooms (status);
CREATE INDEX squad_entries_franchise_idx ON squad_entries (room_code, franchise_id);
CREATE INDEX lot_results_seq_idx ON lot_results (room_code, seq);
