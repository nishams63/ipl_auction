# Post-Auction Analysis (Stage 3)

Status: implemented and tested locally. **AI reports are OFF by default (₹0 policy, Stage 4):**
they need both `AI_ANALYSIS_ENABLED=true` and `ANTHROPIC_API_KEY`. Without them, the complete
deterministic rankings and rule-based reports are shown, and no API call is ever made. **The AI integration has been verified only against
mocked Anthropic responses** (an injected mock `fetch` and a local mock HTTP server). No real
Anthropic API call has been made.

## 1. Player catalogue data audit

The catalogue (`server/data/players.json`, 290 players, unchanged) contains these fields for
every player:

| Field | Present | Used in scoring | Notes |
|---|---|---|---|
| `category` | 290/290 | **Yes** | BAT 57, WK 57, AR 58, BOWL 60 (pace), SP 58 (spin). The primary role signal. |
| `role` | 290/290 | **Yes** (all-rounders only) | Free-text label (148 distinct values). Used only to tell pace from spin all-rounders. |
| `isOverseas` | 290/290 | **Yes** | 97 overseas, 193 Indian. |
| `basePrice` | 290/290 | Awards only | 0.30–2.00 Cr. Used for the "bought at base price" list. |
| `boughtPrice` (squad entry) | sold players | Purse and spend only | Never adds to the score. |
| `country`, `countryCode` | 290/290 | No | Redundant with `isOverseas`. |
| `setName`, `categorySet`, lot numbers | 290/290 | No | Auction ordering only. |
| `rating` | 290/290 | **No** | An 80–99 number hand-typed in `buildPlayers.js`, with no source or date. It's an editorial opinion, not a verified statistic. |
| `stats` | 290/290 | **No** | Career numbers hand-typed in `buildPlayers.js`, with no source or date. They can't be verified, so the model never uses or quotes them. |

**Not available at all:**
- batting hand and batting position (only implied by some free-text role labels);
- bowling arm and bowling style for non-all-rounders, beyond the BOWL (pace) and SP (spin)
  categories;
- recent form, fitness, availability and venue data.

All-rounders whose label names no bowling type (for example, "Batting All-Rounder") count as
bowling options but not as pace or spin options. Players with an unknown category count toward
squad size only. Both are reported (`counts.unclassified`, `dataCompleteness`).

## 2. Scoring model (engine `eval-2`, `server/analysis/evaluation.js`)

Each franchise gets ten dimension scores (0–100). The overall score is their weighted sum, out
of 100:

| Dimension | Weight | How it is calculated |
|---|---|---|
| Batting depth | 15 | batting options (BAT + WK + AR) ÷ 9, capped at 100 |
| Bowling depth | 15 | bowling options (BOWL + SP + AR) ÷ 9, capped |
| Pace options | 10 | (BOWL + pace all-rounders) ÷ 5, capped |
| Spin options | 10 | (SP + spin all-rounders) ÷ 3, capped |
| All-rounders | 10 | AR ÷ 3, capped |
| Wicketkeeper coverage | 10 | 0 keepers → 0, 1 → 60, 2 or more → 100 |
| Overseas balance | 5 | overseas ÷ 4 (the XI overseas slots), capped; above the rule cap → 0 |
| Squad depth | 10 | below the minimum: 60 × size ÷ min; from min to max: 60 → 100 linearly |
| Squad composition | 10 | 100 × (1 − total variation distance) between the squad's role shares and a balanced 25-player template (BAT 24%, WK 12%, AR 24%, pace 24%, spin 16%, i.e. 6/3/6/6/4). Penalises over-concentration, such as ten keepers. |
| Playing XI compatibility | 5 | 20 points for each of five checks: 11 fieldable players (max 4 overseas), a keeper, 5 bowling options and 6 batting options within the overseas limit, at least one overseas player |

**Normalising targets.** These come from a standard T20 squad template. An XI uses 6–7 batting
and 5–6 bowling options, plus depth. Every count is capped at its target, so a 25-player squad
can't outscore a 20-player squad through sheer numbers, while a short squad is penalised in
proportion to what it lacks.

**Why composition exists.** The capped counts alone would give every full, well-stocked squad
100. In a full ten-team test auction, five squads tied at 100 before this dimension was added.
Composition separates a balanced squad from a stacked one.

**Money is never rewarded.** Spending more doesn't raise a score (tested), and remaining purse
is shown but isn't scored.

**Headline columns.**
- Batting = batting depth.
- Bowling = 50% bowling depth + 25% pace + 25% spin.
- All-round = all-rounders.
- Balance = the average of keeper coverage, overseas balance, squad depth, squad composition and XI compatibility.

**Eligibility is separate from quality.** It's judged against the room's **own** rules: squad
min/max, overseas cap, minimum keepers. Interrupted legacy auctions are therefore judged by the
11–15 squad rules they started with.

**Ranking.**
1. Squads that meet the rules come first, then squads that don't, then franchises that didn't
   take part.
2. Within each group, higher overall score ranks first (two decimals).
3. Equal scores share a rank (1, 2, 2, 4), shown as "T2", and are listed alphabetically by
   franchise id.

**Determinism.** The engine is a pure function of the squads and rules. `inputChecksum`
(sha256) identifies the exact input. `generatedAt` is metadata and doesn't affect any score.

**Category awards.** Best balanced squad (eligible squads only), strongest batting and strongest
bowling are awarded only when at least two franchises qualify and one leads outright. Otherwise
the snapshot records that there was no award and why: "tied", "fewer than two", or "no score".
"Bought at base price" is a list of players who drew no competing bid. It's a price fact, not a
value judgement, because no verified quality data exists. The biggest weakness is reported per
franchise (its lowest dimension) and league-wide (the dimension with the lowest average).

**Rule-based explanations** (strengths, weaknesses, recommendations, report) come from the
scores with fixed templates. They're always present and are what the UI shows when AI is
unavailable.

## 3. Persistence

- `room.analysis`: the deterministic snapshot. It's created once when the auction finishes and
  committed before the finish is acknowledged (Stage 1 rule). Rooms completed before Stage 3 get
  one the first time they're loaded; their legacy `evaluationResults` aren't touched. It's never
  recomputed.
- `room.aiAnalysis`: the AI reports, stored separately. Each records the model, the snapshot
  checksum it explains, attempts, timestamps and the last error. A failed regeneration keeps the
  previous good report.
- Both are ordinary room fields, so the existing persistence handles them: the JSON file in JSON
  mode, and the `rooms.extra` jsonb column in PostgreSQL mode. No schema change was needed.

## 4. AI architecture (`server/analysis/aiAnalysis.js`)

1. A participant of the completed room sends the socket event `request_ai_analysis`. The session
   is bound as for every other action, so another room's session or an unjoined socket is
   refused.
2. The request is refused if the auction isn't finished. It returns the stored report if one
   exists, or joins a generation already running (single flight per room). Regeneration is
   host-only, with a cooldown (`AI_REGENERATE_COOLDOWN_MS`, default 60 s) and a per-room cap
   (`AI_MAX_ATTEMPTS_PER_ROOM`, default 5). At most `AI_MAX_CONCURRENT` (default 2) generations
   run server-wide.
3. The prompt contains only the snapshot and squads (names, categories, role labels, overseas
   status, prices). It contains no participant names, tokens or catalogue ratings or stats. The
   system prompt forbids inventing facts, changing scores or calling an ineligible squad
   eligible.
4. The request is sent as `POST {ANTHROPIC_BASE_URL}/v1/messages` with `x-api-key` and
   `anthropic-version: 2023-06-01`, under a hard timeout (`AI_TIMEOUT_MS`, default 60 s).
5. The output is validated:
   - only JSON is accepted, and each franchise must be a known participant;
   - suggested XIs must be players from that franchise's own squad (≤ 11, ≤ 4 overseas, with a
     keeper);
   - a report that calls a rule-ineligible squad eligible is discarded;
   - text is length-capped, and anything else is ignored. The AI can't supply scores or ranks:
     none are read from it.
6. The result is saved and a room broadcast `analysis_updated` follows (after the save commits).

**Fallback.** Without a key, or after any failure (timeout, HTTP error, invalid output), the
complete deterministic results and the rule-based reports are shown. The UI says which kind of
text the user is reading.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables AI reports. Set it in the Render dashboard; never in code or the client. It's never logged or returned. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model id |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Overridable (tests point it at a local mock) |
| `AI_TIMEOUT_MS` | `60000` | Hard timeout per request (1–300 s) |
| `AI_MAX_TOKENS` | `8000` | Response budget |
| `AI_ANALYSIS_ENABLED` | **off** | AI runs only when this is exactly `true` **and** a key is set. A key on its own does nothing. The project's ₹0 policy keeps this off. |
| `AI_REGENERATE_COOLDOWN_MS` / `AI_MAX_ATTEMPTS_PER_ROOM` / `AI_MAX_CONCURRENT` | 60000 / 5 / 2 | Abuse and cost limits |

## 5. Limits

- Scores measure squad **structure** (roles, depth, balance, rule fit), not player quality,
  because no verified performance data exists. Once a sourced, dated quality dataset is
  available, it could be added as a new, separately weighted dimension.
- The pace/spin split for all-rounders depends on catalogue role labels. "Batting All-Rounder"
  has no bowling type.
- The AI check for false eligibility claims is a text pattern check. The UI always shows the
  rule engine's eligibility badge beside any AI text.
