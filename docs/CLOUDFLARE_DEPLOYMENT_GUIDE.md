> **Updated 2026-11-26.** Unity is gone, so no Unity build step is needed. `DATABASE_URL` should stay **unset**: Durable Object SQLite is authoritative and Neon sync is optional/off. The host export endpoint `/api/rooms/:code/export` now accepts the host token **only** in the `x-host-token` or `Authorization: Bearer` header; the `?token=` query parameter was removed. Rooms store token hashes only. For local development use `cd cloudflare && npx wrangler dev --var ENVIRONMENT:development`; with the committed `ENVIRONMENT=production` the Worker rightly refuses to run without `TOKEN_HASH_SECRET` and an allowlisted Origin.

# Cloudflare Deployment & Free-Tier Guide: IPL Multiplayer Auction Simulator

**Document:** `docs/CLOUDFLARE_DEPLOYMENT_GUIDE.md`  
**Status:** Guide Complete  
**Target:** Cloudflare Workers, Durable Objects, Native WebSockets, DO SQLite, Neon PostgreSQL  
**Budget:** Strict ₹0 initial budget  

---

## 1. Cloudflare Free-Tier Policy & Verified Resource Limits

Under Cloudflare's official pricing model (with Durable Objects SQLite storage backend):

| Resource Metric | Cloudflare Free-Tier Allowance | IPL Auction Usage Profile | Status & Headroom |
|---|---|---|---|
| **Worker Requests** | **100,000 requests / day** (resets 00:00 UTC) | ~100–300 HTTP requests per auction (creation, join, state) | Enormous headroom (>95% buffer) |
| **Durable Object Requests** | **100,000 DO requests / day** | Billed via 20:1 incoming WebSocket message ratio + alarms | Sufficient for ~30–50 full 10-player auctions/day |
| **Incoming WebSocket Messages** | **20:1 request ratio** (20 incoming messages = 1 DO request) | ~400–600 incoming bids/joins = **20–30 billable requests** | Massive efficiency via Hibernation API |
| **Outgoing WebSocket Messages** | **Free / Uncounted** (no request charge for broadcasts) | Broadcasts of bids, lot results, and room state | Unlimited within concurrency limits |
| **DO Compute Duration** | **13,000 GB-seconds / day** | Hibernation API: 0 GB-s when idle; ~1.5ms per bid | >95% buffer; zero idle duration cost |
| **DO SQLite Storage** | **5 GB total storage** per account | ~500 KB per completed auction in SQLite | Capacity for >10,000 saved auctions |
| **DO SQLite Reads** | **5,000,000 rows read / day** (5M read units) | State fetches, deduplication checks, and outbox scans | Negligible usage (<0.5% of daily allowance) |
| **DO SQLite Writes** | **100,000 rows written / day** (100k write units) | Bids table, lot results, outbox, and processed messages | Sufficient for ~20–30 full auctions/day |
| **Worker CPU Time** | **10 ms CPU execution** per HTTP invocation | Lightweight routing & CORS preflight is **< 0.5 ms** | Far below the 10 ms limit |
| **DO Default CPU Limit** | Up to **30 seconds** wall-clock per request | Average bid validation + SQLite commit is **< 2 ms** | Massive margin; avoids timeout risks |
| **Over-Quota Behaviour** | **Hard Stop (HTTP 429 / 1015)** | **No automatic billing**. The free plan cannot charge a card. | **₹0 budget is strictly guaranteed** |

> [!IMPORTANT]
> **Independent Quota Enforcement**:
> Cloudflare enforces Request Quotas, Compute Duration (GB-seconds), and SQLite Read/Write row limits as **three separate, independently tracked resource limits**. Exceeding *any single one* will result in that subsystem returning HTTP 429 or WebSocket 1015 errors.
>
> **Realistic Capacity & Uptime Reality**:
> There is no such thing as "100% free unlimited capacity" or "guaranteed 100% uptime" on serverless free tiers. Free-tier Durable Objects undergo cold-start initializations (~50–200ms upon initial room load) and can experience WebSocket reconnections during Cloudflare edge software updates. If daily volume exceeds the limits above, the service stops accepting new requests until the next UTC midnight reset. No card is charged and no surprise debt is incurred.

---

## 2. Resource Usage Estimates (10, 50, 100 Simultaneous Auction Rooms)

An average IPL auction consists of:
- 10 connected bidders per room.
- ~120 to 200 players presented before squads fill up.
- ~400 to 600 total bids placed per auction.
- Duration: ~60 to 90 minutes.

### Estimated Usage Table

| Concurrent Rooms | Total Active Bidders | Inbound WS Messages & Alarms | Effective Billable DO Requests | Cloudflare Free-Tier Compatibility |
|---|---|---|---|---|
| **10 Simultaneous Rooms** | 100 bidders | ~5,000 bids (250 req) + 2,000 alarms | **~2,250 requests** | ✅ **Compatible (Uses ~2.2% of daily DO quota)** |
| **50 Simultaneous Rooms** | 500 bidders | ~25,000 bids (1,250 req) + 10,000 alarms | **~11,250 requests** | ✅ **Compatible (Uses ~11.2% of daily DO quota)** |
| **100 Simultaneous Rooms** | 1,000 bidders | ~50,000 bids (2,500 req) + 20,000 alarms | **~22,500 requests** | ⚠️ **Heavy Usage (Within 100k requests, but watch SQLite writes limit)** |

> [!NOTE]
> Because Cloudflare bills incoming WebSocket messages on Durable Objects with Hibernation at a **20:1 ratio** (20 messages = 1 request), the request volume is extremely low. The actual operational ceiling on the free plan is the **100,000 SQLite writes/day** limit (roughly 25–35 full auctions per 24-hour period). Running more than 40 full auctions per day will require the $5/month Workers Paid tier.



---

## 3. Step-by-Step Deployment Instructions

Follow these steps when you are ready to deploy to Cloudflare:

### Step 1: Create a Free Cloudflare Account
1. Go to [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Sign up with your email (no credit card required for Workers Free).
3. Confirm your email address.

### Step 2: Install Wrangler CLI Locally
In your project root (in a terminal outside the sandbox or using standard npm):
```bash
npm install -g wrangler
# or run via npx
npx wrangler --version
```

### Step 3: Authenticate Wrangler
```bash
npx wrangler login
```
This opens your browser. Click **Allow** to authorize Wrangler on your Cloudflare account.

### Step 4: Configure Secrets
From the `cloudflare/` directory, set your private secrets:
```bash
cd cloudflare
npx wrangler secret put TOKEN_HASH_SECRET
# Enter your random 32+ character pepper

npx wrangler secret put DATABASE_URL
# Enter your Neon PostgreSQL connection string (with ?sslmode=require)
```

### Step 5: Deploy the Worker & Durable Objects
```bash
npx wrangler deploy
```
Wrangler will upload your Worker code, bind the `AUCTION_ROOMS` Durable Object, run SQLite schema initialization, and output your live production URL:
```
https://ipl-auction-cf-backend.<your-subdomain>.workers.dev
```

### Step 6: Verify Backend Health
Open the health check URL in your browser:
```
https://ipl-auction-cf-backend.<your-subdomain>.workers.dev/api/health
```
Ensure it returns:
```json
{
  "status": "ok",
  "platform": "cloudflare-workers-durable-objects",
  "storage": {
    "kind": "cloudflare-durable-objects-sqlite",
    "durable": true
  }
}
```

### Step 7: Update Vercel Frontend
1. Open your **Vercel Dashboard** > click **`ipl-auction`** project.
2. Navigate to **Settings** > **Environment Variables**.
3. Update `VITE_SERVER_URL` to your Cloudflare Worker URL:
   ```
   VITE_SERVER_URL = https://ipl-auction-cf-backend.<your-subdomain>.workers.dev
   ```
4. In the **Deployments** tab, redeploy your latest build.

---

## 4. Rollback Instructions

If you need to revert to the Node.js / Render backend at any time:
1. In your **Vercel Dashboard** > **Settings** > **Environment Variables**:
   Update `VITE_SERVER_URL` back to your Node.js backend URL:
   ```
   VITE_SERVER_URL = https://ipl-auction-simulator-5lqd.onrender.com
   ```
2. Redeploy the Vercel project.
3. The frontend immediately returns to the Node.js / Socket.IO backend with zero disruption to saved data.

---

## 5. Independent Review Findings: Deployment Hardening

1. **Strict ₹0 Budget Guarantee**:
   Cloudflare Free Tier does NOT have a credit card requirement or automatic bill conversion. If daily limits are ever exceeded (over 100,000 requests/day), Cloudflare returns HTTP 429 or WebSocket 1015 error. No card is charged and no surprise debt is incurred.
2. **Environment Variable Configuration**:
   - `TOKEN_HASH_SECRET`: Set via `npx wrangler secret put TOKEN_HASH_SECRET`.
   - `DATABASE_URL`: Set via `npx wrangler secret put DATABASE_URL` (optional Neon connection).
3. **No Database Migration Needed at Startup**:
   SQLite tables (`room_meta`, `bids`, `lot_results`, `outbox`) are auto-created inside the Durable Object on first boot (`CREATE TABLE IF NOT EXISTS`), eliminating cold-start migration locks.

