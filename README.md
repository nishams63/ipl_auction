# IPL Multiplayer Real-Time Auction Simulator

A complete, production-ready, customized **IPL Multiplayer Auction Simulator** built with a real-time server-authoritative backend, modern React frontend, and broadcast-grade IPL styling.

---

## ⚡ Key Highlights & Core Features

* **Multiplayer Private Auction Rooms**: Create a private room with a unique 6-character room code, share with friends, and bid in real-time over WebSockets (Socket.IO).
* **All 10 Official IPL Franchises**: CSK, MI, RCB, KKR, SRH, RR, DC, PBKS, GT, and LSG with authentic franchise colors, logos, and home venues.
* **Dynamic Purse Allocation System**:
  $$\text{Individual Franchise Purse} = \text{Base Purse} \times \left(\frac{\text{Number of Active Franchises}}{10}\right)$$
  *Example (Base ₹120 Cr):*
  * 10 Teams: ₹120.00 Cr
  * 8 Teams: ₹96.00 Cr
  * 5 Teams: ₹60.00 Cr
  * 2 Teams: ₹24.00 Cr
* **Strict Automatic Bid Increments (Mandatory)**:
  Participants **cannot** manually enter or skip bid amounts. The server automatically calculates the exact next valid bid:
  * ₹0 to ₹5.00 Cr: **+₹0.25 Cr**
  * Above ₹5.00 Cr to ₹10.00 Cr: **+₹0.25 Cr**
  * Above ₹10.00 Cr to ₹15.00 Cr: **+₹0.50 Cr**
  * Above ₹15.00 Cr: **+₹1.00 Cr**
  * *Opening Bid*: Uses the player's configured base price.
* **290 Verified Candidate Players**: Extracted from the uploaded HTML catalogue across all 10 rounds and 5 categories (`BAT`, `FAST`, `SPIN`, `AR`, `WK`), deduplicated while retaining catalogue presentation order and statistics.
* **Server-Authoritative Timer & Concurrency Protection**:
  * 30-second countdown controlled entirely by the server.
  * Resets on each accepted valid bid.
  * Atomic state versioning (`stateVersion`) prevents simultaneous duplicate bidding race conditions.
* **Financial Elimination & Mathematical Feasibility**:
  * Enforces minimum squad requirements (15 players default, min 1 WK, max 8 overseas).
  * Automatically calculates whether a franchise will retain enough purse reserve to complete remaining mandatory slots at the minimum floor price before accepting any bid.
  * Teams that cannot complete their minimum squad are marked as financially eliminated and excluded from the winner ranking.
* **100% Deterministic Team Evaluation & Podium Ranking**:
  Transparent weighted formula:
  * 30% Verified Player Quality & Ratings
  * 20% Batting Firepower & Depth
  * 20% Bowling Depth & Variety
  * 10% All-Rounder Balance
  * 10% Squad Role Composition
  * 5% Overseas / Domestic Ratio
  * 5% Budget Efficiency
  * Ranks Champion (1st), Runner-Up (2nd), and Third Place with full breakdown scorecards.
* **Audio Synthesizer (Web Audio API)**:
  * Crisp gavel hammer strikes, electronic bid pings, countdown warning beeps, and triumphant victory fanfares.
  * No external broken audio asset dependencies.

---

## 🛠️ Project Structure

```text
ipl_auction/
├── package.json               # Root dependencies & scripts
├── server/
│   ├── index.js               # Express + Socket.IO server entrypoint
│   ├── roomManager.js         # Authoritative room state, timer loop & socket events
│   ├── auctionEngine.js       # Core math, bid increments, feasibility & evaluation logic
│   └── data/
│       ├── buildPlayers.js    # Ingestion & deduplication script for 300 cards
│       ├── players.json       # Cleaned 290 player database
│       └── franchises.js      # 10 IPL franchises configuration
├── client/
│   ├── index.html
│   ├── vite.config.js         # Vite configuration with Tailwind CSS v4 & API proxy
│   └── src/
│       ├── App.jsx            # Main view controller & socket sync
│       ├── index.css          # Broadcast glassmorphism & dark IPL design system
│       ├── components/
│       │   ├── Navbar.jsx
│       │   ├── LandingView.jsx
│       │   ├── LobbyView.jsx
│       │   ├── LiveAuctionView.jsx
│       │   ├── FinalResultsView.jsx
│       │   ├── FranchiseDashboardModal.jsx
│       │   └── AuctionHistoryModal.jsx
│       └── utils/
│           ├── socket.js      # Socket.io connection & session recovery
│           └── audio.js       # Web Audio API sound synthesizer
└── tests/
    ├── auction.test.js        # Unit test suite covering formulas & feasibility
    └── multiplayerSimulation.test.js # Real-time 2-player socket integration test
```

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
npm --prefix client install
```

### 2. Run in Development Mode
```bash
# Starts both the backend server (port 4000) and the Vite client (port 5173):
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 3. Run in Production Mode
```bash
npm run build
npm run server
```
Open [http://localhost:4000](http://localhost:4000) in your browser.

---

## 🧪 Running the Automated Test Suite

```bash
npm test
```
This runs:
1. `tests/auction.test.js`: Validates dynamic purse calculations, increment thresholds, concurrency versioning, financial feasibility, and deterministic team evaluation.
2. `tests/multiplayerSimulation.test.js`: Spawns two real-time socket participants, joins a private room, claims CSK and KKR, tests dynamic purse adjustment, places opening and incremental bids, executes hammer down, and performs final evaluation.
