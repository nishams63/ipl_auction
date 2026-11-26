# Session lifecycle (React client ↔ Durable Object)

This document is the single description of who the user is, which room a tab is in, and how
connections are opened and closed. It replaces the previous behaviour, where a room code in
`localStorage` silently re-opened an old room.

## Sources of truth

| Concern | Source of truth | Where |
|---------|-----------------|-------|
| Device identity ("login") | private 128-bit token, `localStorage.ipl_user_token` | `client/src/utils/session.js` |
| Display name preference | `localStorage.ipl_user_name` | `session.js` |
| Room **this tab** is in | `sessionStorage.ipl_active_room`, written only after the server confirms the join | `session.js` |
| Optional "Resume room" offer | `localStorage.ipl_resume_room` (24 h); shown as a button, never auto-opened | `session.js`, `LandingView` |
| Room state, participant, franchise ownership, host rights | the room's Durable Object (authoritative) | `cloudflare/src/AuctionRoomDO.js` |
| Current connection | one `CloudflareNativeWsAdapter` per room session, owned by `RoomSessionController` | `client/src/utils/roomSession.js` |

The server stores only an HMAC of each token (`TOKEN_HASH_SECRET`), never the raw token. Rooms
written by older builds are converted to hashes when they load.

## Lifecycle

| Event | Behaviour |
|-------|-----------|
| **Refresh** | `restore()` re-enters the room in this tab's `sessionStorage` with the same token. The server matches the token hash to the existing participant, so there is no duplicate participant and the franchise does not change. |
| **New tab / browser restart** | No active room for that tab, so the landing page is shown. If a recent room exists, a "Rejoin XYZ" button is offered. Nothing opens automatically. |
| **Explicit leave** (account menu → Leave room) | The client sends `LEAVE_ROOM`. It then disposes the connection (no reconnect, pending acks cancelled, listeners removed) and clears the tab's active room and the resume offer. The server keeps the participant, franchise and all auction data. |
| **Create room** | Starts a new generation, then `POST /api/rooms` (abortable), then a new connection to the new room only. |
| **Join by code** | Starts a new generation and opens a new connection to exactly that room. Stale state cannot override it. |
| **Logout** (account menu → Sign out) | Leave, then a new device token. Name, active room and resume offer are cleared. Server history is untouched. Other tabs see the token change through the `storage` event and drop their sessions. |
| **Network drop** | The adapter reconnects with backoff to the **same** room and rejoins with the same token. |
| **Same seat in two tabs** | The server keeps the newest connection and sends `SESSION_REPLACED` to the older one. The older tab stops reconnecting and shows "Use this tab" (explicit take-over) or "Leave room here". |
| **Worker restart** | The Durable Object reloads from SQLite. Clients reconnect and rejoin automatically. |

## Race protection

* Every `createRoom` / `joinRoom` / `restore` / `leave` / `logout` increments a **generation**.
* Each attempt has its own connection object and `AbortController`. Every callback checks that
  its generation and connection are still current before it touches state.
* Inside the adapter, each WebSocket's handlers ignore events once that socket is no longer the
  current one. A late message or close from Room A therefore cannot affect Room B.
* The adapter never reads browser storage and never falls back to a "last room".

## Root cause of the reported bug (fixed)

1. `ipl_room_code` in `localStorage` was treated as an instruction to rejoin on **every** page
   load in **every** tab. There was no Leave control in the lobby or live auction, so a user who
   went back to the site was always pulled into the old room.
2. `CloudflareNativeWsAdapter.connect()` with no argument fell back to the previous room (or the
   stored code), and `disconnect()` did not forget it. The join path called `socket.connect()`
   without a room, which opened the old room's socket first.
3. One global socket was shared by every room, with no generation guard. Late acks, broadcasts
   and `onclose` handlers from the previous socket could act on the new session. A replaced tab
   reconnected every 3 s and stole the seat back (two-tab ping-pong).

## Tests

* `tests/sessionLifecycle.test.js`: unit and regression tests for the store, controller and adapter
  (exact bug, late acks, cancelled create, ping-pong, stale socket close).
* `tests/e2e/sessionRegression.test.js`: real Chrome against local workerd. Covers create A →
  refresh → leave → create B → refresh → leave → join A (repeated), multiple tabs, delayed API
  response, back/forward, WebSocket drop, Worker restart and sign out.
