# IPL Multiplayer Auction Simulator

A real-time, multiplayer IPL auction for up to ten human franchise owners. The interface is
**React only**. The backend runs on **Cloudflare Workers + Durable Objects** (SQLite storage,
native WebSockets with hibernation). Every rule is enforced on the server.

> Unity was removed on 2026-11-26. Building, running or deploying the project does not need
> Unity Editor or WebGL build support. See `docs/PRODUCTION_READINESS_REPORT_2026-11-26.md`.

## Architecture

```
Browser (React 19 + Vite + Tailwind 4)          Cloudflare
┌───────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
│ RoomSessionController         │──────────►│ Worker (cloudflare/src/index.js)     │
│  · one connection per room    │  POST /api/rooms   CORS + Origin allowlist     │
│  · generation guard (races)   │   WSS     │   room-creation rate limit           │
│ CloudflareNativeWsAdapter     │──────────►│ Durable Object per room (AuctionRoomDO)│
│ React views (lobby/live/results)│◄────────│  · authoritative state, timer alarms │
└───────────────────────────────┘ broadcasts│  · SQLite: room_meta, bids, results  │
                                            └──────────────────────────────────────┘
```

* The browser never decides auction state. Bids, sales, purse, squads, timer and results come
  from the room's Durable Object, which persists every mutation before broadcasting it.
* Session lifecycle (refresh, leave, new room, join, logout, multiple tabs) is described in
  `docs/SESSION_LIFECYCLE.md`.
* The legacy Node/Express + Socket.IO server (`server/index.js`) is kept for the historical
  interrupted auctions in `server/data/persisted_rooms.json` and for the legacy test suites.
  The frontend uses it only when `VITE_USE_SOCKETIO=true`.

## Fixed auction rules (server-enforced)

| Rule | Value |
|------|-------|
| Franchises | CSK, MI, RCB, KKR, SRH, RR, DC, PBKS, GT, LSG (humans only, no AI teams) |
| Purse | ₹120 Cr each |
| Squad | 15 minimum, 25 maximum, max 8 overseas, at least 1 wicketkeeper |
| Timer | 15 s by default; a valid bid resets it, a rejected bid does not |
| Increments | below ₹10 Cr +₹0.25 Cr · ₹10 Cr up to below ₹15 Cr +₹0.50 Cr · ₹15 Cr and above +₹1 Cr |
| Money | integer lakhs internally; no negative purse; no duplicate sales |
| Catalogue | 409 players in the existing round/category/set order (shuffled only within a set) |
| Not supported | RTM, retention, WPL, automatic purchases |

Results come from **Cricket Mastermind**, the deterministic cricket analysis. It costs ₹0 and needs
no AI key. It produces exactly one winner and unique ranks from 1 to 10.

## Getting started

```bash
npm install
npm --prefix client install
```

Local development against the Cloudflare backend:

```bash
cd cloudflare && npx wrangler dev --var ENVIRONMENT:development  # Worker on :8787 (no login needed)
# client/.env.local:  VITE_SERVER_URL=http://localhost:8787
npm run client                                                    # Vite on :5173
```

## Tests

| Command | What it runs |
|---------|--------------|
| `npm test` | Unit and integration suites, the session-lifecycle regression suite, and the Durable Object security/rules suite in local workerd. PostgreSQL suites are skipped unless a disposable database is available. |
| `npm run test:cloudflare` | Durable Object and Worker suites in local workerd (Miniflare) |
| `npm run test:e2e` | Builds the client, then runs **real-browser** suites in headless Chrome: 10-player auction and session regression |
| `npm run lint` | oxlint on the React client |
| `npm run build` / `npm run build:worker` | Production frontend build / Worker bundle (`wrangler --dry-run`, no deploy) |

The E2E suites look for Chrome at the standard Windows, macOS and Linux paths. Set `CHROME_PATH` if
yours is somewhere else.

## Production configuration

| Setting | Where | Value |
|---------|-------|-------|
| `TOKEN_HASH_SECRET` | Cloudflare **secret** (`npx wrangler secret put TOKEN_HASH_SECRET`) | ≥ 32 bytes of random data, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `ENVIRONMENT` | `wrangler.jsonc` vars | `production` (turns on the strict Origin checks) |
| `FRONTEND_URL` | `wrangler.jsonc` vars | your exact frontend origin(s), comma-separated, no trailing slash |
| `VITE_SERVER_URL` | Vercel env | the HTTPS Worker URL, no trailing slash |
| `VITE_USE_SOCKETIO` | Vercel env | unset (or `false`) |
| `DATABASE_URL` | Cloudflare | unset (Durable Object SQLite is the authoritative store) |

Never put secrets in `VITE_*` variables: those end up in the browser bundle.
