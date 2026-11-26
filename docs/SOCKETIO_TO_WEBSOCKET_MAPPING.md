# Socket.IO to Native WebSocket Compatibility Mapping

**Document:** `docs/SOCKETIO_TO_WEBSOCKET_MAPPING.md`  
**Status:** Protocol Specification Complete  
**Target:** Cloudflare Native WebSockets (RFC 6455)  
**Client Adapter:** Unified Event Interface (`client/src/utils/wsAdapter.js`)  

---

## 1. Protocol Envelope Specification

To replace Socket.IO's multiplexed engine.io framing with standard, RFC-compliant native WebSockets, all messages follow a deterministic, typed JSON envelope.

### 1.1 Inbound Client Message Envelope
```json
{
  "id": "msg_01HZX8...",
  "type": "ACTION_TYPE",
  "payload": { ... }
}
```
- `id` (string, required): Unique client-generated correlation ID (UUID or timestamp+random) used to match asynchronous server acknowledgements.
- `type` (string, required): Upper-cased action descriptor.
- `payload` (object, required): Structured parameters for the operation.

### 1.2 Outbound Server Acknowledgement Envelope
```json
{
  "id": "msg_01HZX8...",
  "type": "ACK",
  "success": true,
  "payload": { ... },
  "error": null,
  "code": null
}
```
- Corresponds directly to Socket.IO's `callback(response)` pattern.
- If `success: false`, `error` provides the user-facing message and `code` provides an optional programmatic error constant (e.g., `'STORAGE_UNAVAILABLE'`, `'STARTING'`, `'FORBIDDEN'`).

### 1.3 Outbound Server Broadcast Envelope
```json
{
  "type": "EVENT_TYPE",
  "payload": { ... },
  "timestamp": "2026-11-21T14:30:00.000Z"
}
```
- Broadcast to all connected clients in the Durable Object room session via `ctx.getWebSockets()`.

---

## 2. Exhaustive Event Mapping Table

| Socket.IO Event (Old) | Native WS Type (New) | Direction | Payload Schema | Ack / Response Schema | Validation Rules | Authorization Rules | Error Handling & Code |
|---|---|---|---|---|---|---|---|
| `join_room` | `JOIN_ROOM` | Client ➔ Server | `{ roomCode: string, participantName: string, participantToken: string }` | `{ success: boolean, room: PublicRoomState, participant: SelfParticipant }` | `roomCode` 4-12 chars; `name` 1-30 chars cleaned; `token` 16-128 chars | Open to valid participants; upgrades session or replaces older connection | Returns `400 Invalid room code`, `400 Name must be 1-30 chars`, `404 Room not found` |
| `select_franchise` | `SELECT_FRANCHISE` | Client ➔ Server | `{ roomCode: string, franchiseId: string }` | `{ success: boolean, franchiseId: string }` | `franchiseId` must be 1 of 10 IPL codes (CSK, MI, etc.) | Session must be member of room; franchise must not be claimed by another token | Returns `Invalid franchise selected`, `Franchise already claimed` |
| `update_config` | `UPDATE_CONFIG` | Client ➔ Server | `{ roomCode: string, config: object }` | `{ success: boolean, errors?: string[] }` | Validates host-customizable `maxSquadSize` (15–25) & `maxOverseas` (0–8, `<= maxSquadSize`), keeping fixed IPL rules (`basePurse` ₹120 Cr, `minSquadSize` 15, `minWKs` 1, `timerDuration` 15s) via `validateConfig` | **Host only**; status must be `'lobby'` | Returns `Only the host can perform this action`, `Settings can only be modified before starting` |
| `update_playing_xi`| `UPDATE_PLAYING_XI` | Client ➔ Server | `{ roomCode: string, franchiseId: string, playingXI: string[], captainId: string, viceCaptainId: string, wicketKeeperId: string, impactPlayerId: string }` | `{ success: boolean }` | `playingXI` length max 11; all players must belong to franchise squad; max 4 overseas | **Franchise Owner only** (session token must own franchise) | Returns `Only the owner of this franchise can update its Playing XI`, `Invalid Playing XI` |
| `start_auction` | `START_AUCTION` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean }` | Room status must be `'lobby'`; at least `minParticipants` (default 2) claimed franchises | **Host only** | Returns `At least N human participants must select franchises to start.` |
| `pause_auction` | `PAUSE_AUCTION` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean, room: PublicRoomState }` | Room status must be `'active'` | **Host only** | Returns `Auction is not active` |
| `resume_auction` | `RESUME_AUCTION` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean, room: PublicRoomState }` | Room status must be `'paused'` | **Host only** | Returns `Auction is not paused` |
| `place_bid` | `PLACE_BID` | Client ➔ Server | `{ roomCode: string, franchiseId: string, bidAmount: number, expectedVersion: number }` | `{ success: boolean }` | Lot must be open; `bidAmount` must strictly equal `nextValidBid`; respects room's `maxSquadSize`, `maxOverseas`, keeper slot reserve, and minimum reserve floor | **Franchise Owner only** | Returns `Squad limit reached!`, `Overseas player limit reached!`, `Insufficient purse balance`, etc. |
| `advance_lot` | `ADVANCE_LOT` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean }` | Room status must be `'active'` (or paused under `storageFailure` recovery) | **Host only** | Returns `Only the host can advance the lot` |
| `skip_set` | `SKIP_SET` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean }` | Room status must be `'active'`; current lot has active set | **Host only** | Returns `No active player set to skip` |
| `finish_auction` | `FINISH_AUCTION` | Client ➔ Server | `{ roomCode: string }` | `{ success: boolean }` | Room status must be `'active'` or `'paused'` | **Host only** | Returns `Auction is not running` |
| `request_ai_analysis`| `REQUEST_AI_ANALYSIS` | Client ➔ Server | `{ roomCode: string, force?: boolean }` | `{ success: boolean, status: string }` | Room status must be `'completed'` | Any participant (DO returns `status: 'unavailable'` with rule-based Cricket Mastermind; Legacy Node allows optional AI) | Returns `Auction has not finished yet` |
| `state_updated` | `STATE_UPDATED` | Server ➔ Broadcast | `{ ...PublicRoomState }` | Broadcast only | Sanitized room state (tokens/hashes stripped) | Broadcast to room | Handled by all clients |
| `lot_presented` | `LOT_PRESENTED` | Server ➔ Broadcast | `{ partial: true, roomCode, status, currentPlayerIndex, lotNumber, totalLots, currentLot, deadlineEpochMs }` | Broadcast only | Fresh player lot delta | Broadcast to room | Triggers gavel sound & stage animation |
| `bid_accepted` | `BID_ACCEPTED` | Server ➔ Broadcast | `{ bid: BidRecord, currentLot: LotState, nextValidBid: number, deadlineEpochMs: number }` | Broadcast only | Validated bid details | Broadcast to room | Triggers bid audio chime & syncs deadline |
| `timer_tick` | `TIMER_TICK` | Server ➔ Broadcast (client local timer on DO) | `{ countdown: number, hammerStatus: 'OPEN' \| 'GOING_ONCE' \| 'GOING_TWICE' \| 'SOLD' \| 'UNSOLD', stateVersion: number }` | Broadcast only | Remaining seconds & hammer status derived from server clock/deadline | Room subscribers | Updates UI countdown clock |
| `lot_completed` | `LOT_COMPLETED` | Server ➔ Broadcast | `{ result: 'SOLD' \| 'UNSOLD', lot: LotState, historyEntry: object, franchiseUpdates: object, playerUpdate: object }` | Broadcast only | Delta sale or unsold disposition | Broadcast to room | Triggers sold fanfare / unsold chime |
| `set_skipped` | `SET_SKIPPED` | Server ➔ Broadcast | `{ skippedSetName: string, skippedCount: number, playersCatalog: array, history: array }` | Broadcast only | Count & names of skipped players | Broadcast to room | Updates catalogue view |
| `auction_completed`| `AUCTION_COMPLETED` | Server ➔ Broadcast | `{ ...PublicRoomState }` | Broadcast only | Final room state with complete squad lists | Broadcast to room | Renders Cricket Mastermind final rankings |
| `session_replaced` | `SESSION_REPLACED` | Server ➔ Targeted | `{ roomCode: string }` | Targeted to old socket | Replaced session notification | Targeted to specific client socket | Shows duplicate session modal |

---

## 3. Reconnection & Resiliency Specification

1. **Heartbeats & Auto-Reconnect**:
   - The native WebSocket adapter sends a ping (`{ type: "PING" }`) every 25 seconds.
   - The Durable Object replies with `{ type: "PONG" }`.
   - If no reply is received within 10 seconds, the client closes the connection and initiates an exponential backoff reconnection (`1s`, `2s`, `4s`, max `10s`).
2. **Reconnection State Restoration**:
   - Upon reconnecting, the client immediately sends `JOIN_ROOM` with its stored `participantToken` and `roomCode`.
   - The Durable Object matches the token hash, re-associates the WebSocket, marks the participant active, and returns the full `PublicRoomState`.
   - If the participant owns a franchise, ownership is maintained seamlessly.
   - If a lot is currently active, the client immediately receives the current countdown calculated from the authoritative absolute deadline:
     $$\text{remaining} = \max\left(0, \lceil(\text{deadlineEpochMs} - \text{Date.now()}) / 1000\rceil\right)$$

---

## 4. Independent Review Findings: Frontend Adapter Hardening

An exhaustive audit of `client/src/App.jsx` and `client/src/utils/wsAdapter.js` verified the following drop-in interface alignments:

### 4.1 Callback Envelope Unwrapping
- **Old Issue**: In Socket.IO, `socket.emit(event, payload, (res) => ...)` passes `res` directly to the callback. `App.jsx` checks `if (res?.success)`. The initial adapter passed `cb(msg.payload || { success: true })`. When `msg.payload` contained `{ room, participant }` without a top-level `success` key, `res?.success` was undefined.
- **Hardened Fix**: The adapter unwraps ACKs as `cb({ success: true, ...(typeof msg.payload === 'object' ? msg.payload : {}) })` for successes, and `cb({ success: false, error: msg.error, code: msg.code })` for errors.

### 4.2 Parameterless Event Cleanup (`.off(event)`)
- **Old Issue**: React `useEffect` cleanups in `App.jsx` call `socket.off('state_updated')` without passing a callback function. The initial adapter only removed matching function references, ignoring parameterless calls and leaking listeners.
- **Hardened Fix**: `off(event, handler)` deletes the entire event set if `handler` is omitted.

### 4.3 Live Connection Status & Auto-Flush Outbound Queue
- `socket.connected`: Implemented as a live getter returning `this.ws?.readyState === WebSocket.OPEN`.
- `socket.connect()`: Parameterless calls reuse `currentRoomCode` or defer until `join_room` is emitted. Outbound messages emitted before the socket opens are buffered in `this.outboundQueue` and flushed in order upon `onopen`.

### 4.4 Client-Side Authoritative Timer Tick
- When `LOT_PRESENTED`, `BID_ACCEPTED`, or `STATE_UPDATED` arrives with `deadlineEpochMs`, `wsAdapter` synchronizes a local 1000ms interval emitting `timer_tick` events (`{ countdown, hammerStatus, stateVersion }`). When the lot closes (`LOT_COMPLETED`), the local interval stops.

### 4.5 Persistent Message-ID Deduplication & Reconnect Durability
- Every client mutation generates a correlation `id` (e.g. `msg_x8y1z`).
- The Durable Object stores acknowledged message IDs in SQLite table `processed_messages` (`PRIMARY KEY (room_code, participant_token_hash, message_id)`).
- When a client reconnects or retransmits an unacknowledged message, the server immediately returns the cached ACK from SQLite without re-executing business logic.
- Survives both WebSocket hibernation and complete Durable Object memory eviction.


