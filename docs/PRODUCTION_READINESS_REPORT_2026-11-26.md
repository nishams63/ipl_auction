# Production-Readiness Report: React-only IPL Auction Platform
Date: 2026-11-26 · Branch: `feature/cloudflare-migration` (nothing committed, pushed, merged or deployed)

## 1. Overall readiness status

**READY FOR DEPLOYMENT PREPARATION**

All critical flows pass locally in real browsers against the real Worker and Durable Object code
running in local workerd. Before the status can move to *ready for authorized production deployment*,
three things are still needed:
(a) set the production secret and env vars, (b) deploy to a staging URL and repeat the 10-player
and session suites over the public internet, and (c) decide the two rule ambiguities in §14.
Nothing has been tested over the public internet.

## 2. Unity files and dependencies removed

| Removed | Notes |
|---------|-------|
| `unity/IPLAuctionArena/` (≈255 MB: Assets, ProjectSettings, Packages, Library, Builds/Win64, Logs, `_Recovery`) | Source-only archive kept at `backups/pre_react_only_20261126/unity_source.tgz` (Library/Builds/Logs/Temp excluded) |
| `client/public/unity/arena/**` (WebGL build: `arena.loader.js`, `arena.wasm.unityweb` 4.2 MB, `arena.data.unityweb`, `arena.framework.js.unityweb`, `index.html`, TemplateData) | |
| `client/src/components/UnityArena.jsx` | |
| `client/src/utils/arenaController.js` (loader, retry/timeout, quality, `createUnityInstance`, `SendMessage`) | |
| `client/src/utils/arenaState.js` (Unity state protocol v1) | |
| `tests/arenaBridge.test.js` | |
| `docs/UNITY_ARENA.md`, `scripts/local-arena-preview.cmd` | |
| Unity entries in `.gitignore`, `.dockerignore`, `tests/runAll.js` | |
| Unity imports and usages in `LiveAuctionView.jsx`, `FinalResultsView.jsx` | |

There were no npm dependencies used only by Unity, so no packages were removed. The three tests
that asserted the Unity snapshot format (`cricketMastermind` #20, `newCatalogue` #17,
`cloudflareMigration` scenario 15) now assert the equivalent state contract consumed by React.
Historical docs keep their Unity text under a "superseded" banner. `ArenaBuild/…Presenter/…State`
names existed only inside the Unity project.

Also removed as dead code: `MobileRotateOverlay.jsx` (rendered `null`, imported nowhere).
`tests/tenBrowserUiE2E.test.js` was **replaced** by `tests/e2e/tenPlayerUi.test.js`. The old file
was bound to the old markup ("+ BID", "TEAMS OVERVIEW", `window.confirm`) and had a hard-coded
Windows Chrome path. Its overseas-cap UI scenario was ported into the new suite.

## 3. React works without Unity

A repository-wide search finds no `Unity`, `WebGL`, `.wasm`, `createUnityInstance`, `SendMessage`,
`ArenaBridge` or `IPLAuctionArena` in code, config or tests. Docs mention Unity only as removed.
The production build contains no Unity assets, and building, running and deploying need no Unity
tooling. The 10-browser suite plays the whole auction from first page load to the results with zero
uncaught page errors.

## 4. Old-room restoration: root cause

Reproduced on the baseline build in headless Chrome (`tests/e2e/reproBaseline.mjs`):

* A fresh tab opened straight into the previous tab's room.
* After going back to the site there was no landing page, and the lobby had **no Leave control**.
* Two tabs on the same seat sent each other 3 `SESSION_REPLACED` messages in 12 s, in an endless steal-back loop.

There were three root causes:
1. **`ipl_room_code` in `localStorage` acted as an auto-rejoin order** on every load, in every tab.
   It was cleared only on the results screen.
2. **The adapter fell back to the old room.** `connect()` without an argument used the previous or
   stored room, `disconnect()` did not forget it, and `handleJoinRoom` called `socket.connect()`
   with no room. A Node check confirmed it reopened `ROOMAA` after a disconnect.
3. **One shared socket and no generation guard.** Late acks, broadcasts and `onclose` handlers from
   the previous socket could act on the new session, and a replaced tab auto-reconnected every 3 s.

## 5. Session lifecycle implementation

The full description is in `docs/SESSION_LIFECYCLE.md`. In short:

* The token stays in `localStorage` as the device identity. The **active room is per tab
  (`sessionStorage`)** and is written only after the server confirms the join.
* A recent room is shown only as an explicit "Rejoin XYZ" button. The legacy key is migrated.
* `RoomSessionController` is the single client source of truth. It creates a **new connection
  object per room**, uses a generation counter and an `AbortController`, and makes every callback
  check that it is still current.
* The adapter has no storage fallback. Stale-socket handlers are ignored. Reconnection uses backoff
  and targets the same room only. `SESSION_REPLACED` suspends reconnection until the user clicks
  "Use this tab". Acks time out after 15 s.
* There is an explicit **Leave room** and **Sign out** in the account menu, using in-app dialogs. Sign-out rotates the token and other tabs react through the `storage` event.
* The server handles `LEAVE_ROOM` (keeps participant and franchise). A reconnect-join no longer
  broadcasts a full snapshot to everyone.

## 6. Files changed

**Added:**
* `client/src/utils/{roomSession,roomState,useRoomSession,bidStatus,socketIoConnection}.js`
* `client/src/components/ConfirmDialog.jsx`
* `tests/sessionLifecycle.test.js`, `tests/doSecurityRules.test.js`
* `tests/e2e/{harness,ui,sessionRegression.test,tenPlayerUi.test,reproBaseline}.js`
* `scripts/build-worker.mjs`
* `docs/SESSION_LIFECYCLE.md`, this report

**Modified:**
* `client/src/App.jsx` (rewritten)
* `client/src/utils/{wsAdapter,session,socket,audio}.js`
* `client/src/components/{Navbar,LandingView,LobbyView,LiveAuctionView,FinalResultsView,FranchiseDashboardModal,CinematicAuctionOverlay,AuctionHistoryModal}.jsx`
* `client/src/assets/*.jpg` (re-encoded: 1.64 MB → 248 KB, same artwork)
* `cloudflare/src/{index,AuctionRoomDO}.js`
* `tests/{runAll,cloudflareMigration,localWorkerdRuntime,e2eMultiplayerBrowser,browserUiViewport,fullGameRenderPlayback,cricketMastermind,newCatalogue}.js`
* `package.json` (scripts only)
* `README.md` (rewritten), `.gitignore`, `.dockerignore`
* `docs/CLOUDFLARE_ARCHITECTURE.md`, `docs/CLOUDFLARE_DEPLOYMENT_GUIDE.md`, banners on three historical docs

**Deleted:** see §2.

**Untouched:** game rules, the catalogue, `server/data/persisted_rooms.json` (MD5 `928872ed950657abe3c1403a9d5478d7`, 21 rooms incl. the 7 interrupted auctions R8VNTD, 6HBFKN, 6J8BTZ, K6WFQ6, TJ6HGV, LDACKW, A5GLQ7), `backups/`, `wrangler.jsonc`, `.env.local`, `.vercel`.

The full pre-change working tree is archived at `backups/pre_react_only_20261126/`
(`working_tree_source.tgz`, `uncommitted.diff`).

## 7. Frontend audit results (fixed)

* Old-room auto-restore; no Leave or Logout; two-tab ping-pong (P1).
* Every new lot scrolled the **whole page** (`scrollIntoView`), hiding the stage and host controls (P1 usability).
* A wrong value was shown: the leader badge displayed **"MI" when nobody had bid**. The highest bid showed the base price as if it were a bid.
* `window.confirm` blocked the page during the live timer. It was replaced by accessible dialogs.
* On mobile the bid button sat below the fold. Phones now get a **sticky bid bar** (44 px+ target, safe-area aware) and the bidding panel comes first.
* The franchise panel now shows purse, squad x/25, overseas x/8, owner, and a **"Can bid / Cannot bid / Highest bid"** state. That state is computed with the server's own `validateBid`, so it cannot drift from what the server accepts.
* A stage ribbon shows the hammer status: OPEN / GOING ONCE / GOING TWICE / SOLD / UNSOLD / PAUSED.
* A room-wide **activity feed** covers bids, rejections, sold, unsold, pause, resume, skip and completion.
* The previous-lot context is shown, and so are explicit accepted/rejected bid messages.
* The countdown is now **clock-skew safe** (server time offset). It used to trust the device clock.
* The results screen invented a winner (`'CSK'`) and reasons when the analysis lacked a verdict. It no longer does.
* The squad modal said "Max 15 Squad". It now reads 15–25 / 8 OS.
* Clipboard calls are guarded. Labels are linked to inputs, there is `role=dialog/timer/tablist`, and `aria-live` feeds.
* Lint: 0 errors, 9 warnings left. All are style hints (`set-state-in-effect` / `exhaustive-deps`) in components that predate this work.

## 8. Backend audit results (fixed)

* **Room-code collision overwrote an existing room.** The DO `init` had no existence check. It now returns 409 and the Worker retries with a new code.
* **Raw tokens were stored** in DO SQLite (`hostToken`, `rawToken`, `ownerToken`). Only HMAC hashes are stored now, and older rooms are migrated when they load.
* The export endpoint accepted the host token in the **URL query**. Headers are required now.
* Unjoined sockets bypassed the 30 msgs/s rate limit. That is fixed.
* There was no limit on room creation. It is now 10/min per client IP (best effort, per isolate), and the create body is capped at 4 KB.
* Malformed message envelopes are rejected. Participants are capped at 30 per room.
* JOIN acks (about 400 KB each) were cached in `processed_messages` on every join. They are no longer cached.
* **Bandwidth:** every lot used to send the full room state 2–3 times to every phone (~870 KB per lot per client, measured). Deltas bring this to ~14 KB per lot (≈60× less).
* Unchanged and verified: every mutation is validated on the server, and the bid and the room snapshot are committed in one `transactionSync` **before** the broadcast. Alarms are authoritative and resume after a restart. Replayed message IDs return the cached ack.

## 9. Authentication and security

These are all verified in local workerd (`tests/doSecurityRules.test.js`, 25/25):
* No token or hash appears in the public state.
* Non-host start, config and finish are refused, and a spoofed `hostToken` gets "Unauthorized".
* Cross-room and unjoined actions are refused.
* Franchise impersonation is refused.
* A replaced connection cannot act.
* In production, a disallowed or missing Origin is refused for WebSocket and room creation. Without `TOKEN_HASH_SECRET` the Worker returns 503.
* The 413, oversized-frame, malformed and rate-limit paths all behave as intended.
* Migrating rooms from raw tokens to hashes works.

There are no secrets in the bundle (searched). Server logs are generic and contain no token
material. Remaining limitation: the room code is the only access control for viewing a room, by design.

## 10. Durable Object and SQLite

The following survive a **Worker restart** with persisted DO storage: room, current lot, highest
bid, franchise ownership and rejoin. This was tested at the protocol level and in the browser.
Simultaneous bids at the same version: exactly one is accepted. No duplicate sale, and purses are
debited in integer lakhs. The existing 34-scenario mock-DO suite and the 11-check workerd suite pass.

## 11. WebSocket

* After a network drop the client reconnects to the same room with no duplicate participant (browser).
* The replaced tab neither reconnects nor steals the seat back (0 new sockets in 9 s, browser).
* A late message or close from a stale socket is ignored (unit test).
* Countdowns on all 10 screens were within 1 s of each other and of the server deadline.

## 12. Ten-player real browser results

`tests/e2e/tenPlayerUi.test.js` uses 10 independent Chrome contexts (8 desktop, 2 phones at
390×844). All actions go through the DOM against the production build and local workerd.
**14/14 passed, in two consecutive full runs (~5.3 min each).**

Covered:
* Create, 9 joins, 10 distinct franchise claims, lobby in sync.
* Identical first player on every screen and a 15 s timer.
* Three bids fired at the same instant: exactly 1 accepted and 2 rejected with a visible reason. Every screen shows the same amount and leader, and the leader is blocked from bidding again.
* SOLD: purse = 120 − price on every screen.
* A valid bid (from a phone's sticky bar) reset all 10 clocks to ≥13 s. Without valid bids the clock keeps falling.
* Pause freezes all clocks and disables bidding; resume works.
* Refresh mid-auction restores the same lot and franchise.
* Closing a tab, then using the explicit "Rejoin" button, returns to the same franchise with no duplicate.
* Skip Set works on all screens.
* Overseas cap in the UI: MI bought 8 overseas players. The 9th was blocked with "Overseas player limit reached", and every screen shows MI as "Cannot bid".
* Squad built through the UI. An invalid Playing XI cannot be saved, and a valid XI was saved and confirmed by the server.
* Conclude: all 10 screens show the same winner, with ranks 1–10 unique.
* Zero uncaught errors.

Screenshots are in `playback_screenshots/ten-player/`.

## 13. Session regression results

`tests/e2e/sessionRegression.test.js` (real Chrome): **12/12 passed.**

Covered:
* Room A plus refresh, including franchise restore.
* **Leave A, then create B: the only code ever rendered was B.**
* Refresh B, leave, then explicit join A.
* The cycle repeated 3 more times.
* Back/forward.
* Fresh tabs never inherit a room, and two tabs keep separate rooms across refresh.
* Same-seat take-over with no ping-pong.
* A delayed create response after Cancel: nothing opens.
* WebSocket drop.
* Worker restart.
* Sign-out: a new identity, and the old franchise stays with the old owner.
* No page errors.

The unit suite `tests/sessionLifecycle.test.js` passes 19/19 and covers late acks, cancelled
creates and stale sockets.

## 14. Auction rules verification

Rules are canonical and verified by the existing suites plus the new DO and E2E checks: ₹120 Cr,
squad 15–25, 8 overseas, ≥1 WK, fixed 15 s bid timer, valid bid resets the timer, invalid bid does not,
canonical increments (`< ₹10 Cr` +0.25, `₹10 to < ₹15 Cr` +0.50, `≥ ₹15 Cr` +1.00 Cr), integer lakhs,
no duplicate sale, no negative purse, humans only, 409-player catalogue intact.

## 15. Cricket Mastermind

Unchanged, deterministic, ₹0 cost, with no paid AI turned on. The 20 Mastermind checks and 18
analysis checks pass. The E2E run confirmed exactly one winner and unique ranks 1–10 on all screens.
The UI fallback that invented a verdict was removed.

## 16. Mobile verification

At 390×844 (2 of the 10 E2E browsers): no horizontal overflow on the landing, lobby, live and
results screens. The countdown and current bid are visible, and the sticky bid button is on screen
without scrolling (≥44 px tall). Bidding from a phone was exercised. These are emulated mobile
viewports in Chrome; no physical device was tested.

## 17. Performance and bundle sizes

| Item | Before | After |
|------|--------|-------|
| Main JS | 466.0 KB (130.6 KB gzip) | 448.5 KB (125.6 KB gzip). Socket.IO moved to a lazy 41 KB chunk that loads only in legacy mode |
| CSS | 100.5 KB (14.4 KB gzip) | 102.9 KB (14.7 KB gzip) |
| Images | 1.64 MB | 248 KB |
| Unity WebGL payload | 5.1 MB in `public/` | 0 |
| Worker bundle (`wrangler --dry-run`) | n/a | 678 KiB / 78 KiB gzip (Free plan limit: 3 MB compressed) |
| WS bytes per lot per client (measured, 40 lots) | ~870 KB | ~14 KB |
| `BID_ACCEPTED` size | ~19.7 KB | ~2.6 KB |

## 18. Cloudflare Free-tier limits and capacity (estimates)

Official Workers Free limits for Durable Objects: 100,000 requests/day, 13,000 GB-s/day, 5 M rows
read/day, 100,000 rows written/day, 5 GB storage. Incoming WebSocket messages count 20:1 as
requests, outgoing messages are free, and hibernated sockets accrue no duration. When a limit is
hit, further operations fail until 00:00 UTC.

**Estimated** per 10-player, 409-lot auction (~2 h, ~2,000 bids):
* ~1.5k requests
* up to ~900 GB-s if the object stays awake the whole time
* ~10–11k rows written

**Capacity: roughly 7–9 full auctions per day** on the Free plan. Duration and rows written are the
binding limits. Shorter auctions (with Skip Set) fit more. This is an estimate, not a measurement,
and capacity is not unlimited. The ₹0 constraint is maintained, with no paid features enabled.

## 19. Exact test commands and results

| Command | Result |
|---------|--------|
| `npm test` | 24/33 suites passed, **291 checks passed, 0 failed**, 9 PostgreSQL suites SKIPPED |
| `npm run test:cloudflare` | node:test 56/56 passed + `doSecurityRules` 25/25 |
| `node --test tests/e2e/sessionRegression.test.js` | 12/12 |
| `node --test tests/e2e/tenPlayerUi.test.js` | 14/14 (twice) |
| `node --test tests/browserUiViewport.test.js` | 3/3 |
| `node tests/fullGameRenderPlayback.js` | completed |
| `npm --prefix client run lint` | 0 errors, 9 warnings |
| `npm --prefix client run build` | OK |
| `npm run build:worker` | OK |

Logs are in `test-results/2026-11-26/`. Environment: Linux, Node 22.23.5, Google Chrome headless,
Miniflare/workerd from wrangler 3.114.

## 20. Failed and skipped tests

* **Skipped:** 9 PostgreSQL suites (no disposable database). This covers the optional Neon path only; production uses DO SQLite.
* **No failures** in the final runs.
* `tests/e2eMultiplayerBrowser.test.js` drives the protocol from Node. It is relabelled as a protocol test and is **not** counted as browser E2E.

## 21. Remaining risks and blockers

* **Not deployed and not tested over the public internet.** Cloudflare login was not used, and no deploy was attempted (not authorized).
* Lot-close persistence: if the SQLite commit in `closeCurrentLot` fails, the broadcast still happens. The rows go to the outbox and the snapshot is saved on the next mutation, but this is not strictly persist-before-broadcast. Rare, but documented.
* The room-creation rate limit is per isolate (best effort). A global limit would need a paid or extra product.
* The two rule ambiguities in §14.
* Capacity estimates are unmeasured. Watch the Cloudflare dashboard during the first real auctions.
* The historical interrupted auctions live in the legacy Node server's JSON file. To finish them, run that server and set `VITE_USE_SOCKETIO=true` (the path is kept and lazy-loaded). They have not been imported into Durable Objects.
* The local `node_modules` on your PC is Windows-built and was not changed. Run `npm install` and `npm --prefix client install` once if anything is missing.

## 22. Steps remaining before public deployment

1. Review the diff and commit on the feature branch (I did not commit).
2. `cd cloudflare && npx wrangler login`, then `npx wrangler secret put TOKEN_HASH_SECRET` with ≥32 random bytes. Do not paste it anywhere else.
3. Confirm `wrangler.jsonc` → `ENVIRONMENT=production` and `FRONTEND_URL=<exact frontend origin>`. Keep `DATABASE_URL` unset.
4. Deploy the Worker to a **staging** name first, then set Vercel preview env `VITE_SERVER_URL=https://<worker>.workers.dev` (no trailing slash) with `VITE_USE_SOCKETIO` unset.
5. Run the 10-player and session E2E suites against the staging URLs (point the harness at them), then do a short real 10-device playtest on mixed networks.
6. Decide the §14 rules.
7. Only then deploy production and change the status to *LIVE AND VERIFIED* after a verified public run.
