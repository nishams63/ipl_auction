# Stage 4: Unity 3D auction arena (display only, ₹0)

An optional 3D auction hall, built in Unity 6 and embedded in the React app as WebGL. It **shows** the auction. It cannot change it.

## 1. Audit (start of Stage 4)

| Item | Finding |
|---|---|
| Unity editor | 6000.3.28f1 at `C:\Program Files\Unity\Hub\Editor\6000.3.28f1` |
| Installed build modules | Android and Windows at first. **Web (WebGL) Build Support was added in Stage 4.1**; the WebGL build succeeded. |
| Unity project in repo | None existed. One was created: `unity/IPLAuctionArena/` |
| Client test runner | None (scripts are dev/build/lint/preview). Arena tests run in the Node suite. |
| Render pipeline | Built-in (no URP/HDRP package, so nothing to download) |
| Assets | None imported. The hall is generated at runtime from primitives, built-in shaders and Unity's built-in font. |

## 2. Architecture

```
server (authority) ──socket.io──▶ React (App state: room)
                                     │  toArenaState(room)   (pure, public fields only)
                                     ▼
                          ArenaController (one per page)
                                     │  SendMessage('ArenaBridge','ApplyState', json)
                                     ▼
                Unity WebGL: ArenaBridge → ArenaPresenter → hall visuals
                                     │  only: window 'ipl-arena' {type:'ready'|'error'}
                                     ▼
                          React shows loading / fallback
```

- **One direction for auction data.** Unity gets a snapshot of the public room state. It has no socket, no network code and no callback into React that could bid, pause, advance, change a purse or declare a result. The jslib exposes only `ArenaNotifyReady` and `ArenaNotifyError`. These guarantees are enforced by `tests/arenaBridge.test.js` (C1–C3).
- **Snapshots, not commands.** Every push is the full current picture (protocol `v: 1`). Unity compares it with the previous snapshot to decide what to animate: new player, new bid, SOLD, UNSOLD, pause/resume, completion. The first snapshot after a load, refresh or reconnect is shown **statically**, so a page refresh never replays a SOLD celebration.
- **The auction never depends on Unity.**
  - No WebGL → a small "unavailable" note.
  - Build not deployed → the arena hides itself.
  - Loader error, Unity error event or a 60 s timeout → a "could not start" panel with Retry.
  - In every case all existing controls keep working.
- **Lifecycle.**
  - One controller and one canvas per page. The loader script is injected once.
  - Moving from the live view to the results view re-parents the canvas, so there is no reload.
  - Hiding the arena or leaving the room shuts Unity down after 8 s, which frees GPU memory.
  - The `ipl-arena` listener is added once and removed on teardown.

### Snapshot (protocol v1)

```json
{ "v":1, "status":"active|paused|completed", "hasLot":true,
  "lot":{ "number":3,"total":250,"playerId":"PL_001","name":"…","role":"…","category":"BAT","country":"India",
          "overseas":false,"basePrice":2,"highestBid":2.4,"bidder":"MI","bidCount":3,"version":7,
          "countdown":5,"timerDuration":15,"hammer":"OPEN|GOING_ONCE|GOING_TWICE|SOLD|UNSOLD" },
  "franchises":[{ "id":"CSK","code":"CSK","name":"…","color":"#FACC15","color2":"#1E3A8A","purse":118.5,"squad":1,"claimed":true }] }
```

- No tokens, socket ids, owner ids, names of people or image URLs are included.
- Strings are length-capped. Unity rejects payloads over 200 000 characters and any protocol version other than 1.

## 3. What the hall shows

Original design: a premium indoor hall with a central stage, a large LED screen, a truss with stage lights, and an auctioneer's lectern with a gavel. Ten franchise booths sit on an arc facing the stage, each in its colours with a **text abbreviation only** (no logos).

| Event (from the server) | Visual |
|---|---|
| New player | Camera moves to the stage; the screen shows lot, name, role, India/Overseas and base price |
| New bid | Amount punch; the bidder's booth flashes and becomes the glowing leader; the camera cuts to the booth (High quality) |
| ≤ 5 s left | Timer bar turns red and the screen pulses red |
| SOLD | Gavel strikes; "SOLD to X for Rs N Cr" in the buyer's colour; confetti (High quality) |
| UNSOLD | One gavel strike; grey "UNSOLD" banner |
| Paused / resumed | Lights dim and a "PAUSED" banner appears, then both are restored |
| Completed | "AUCTION COMPLETE", slow orbiting finale camera, confetti |

Money reads "Rs" because Unity's built-in font has no ₹ glyph, and WebGL has no system fonts to fall back on.

## 4. Performance choices (target: i5-13420H / RTX 2050 4 GB / Intel UHD)

- **Geometry and textures:** primitives only, **no textures at all**. Static meshes are combined with `StaticBatchingUtility`, and the 20 timer segments share one material.
- **Lighting:** one shadow-casting spot light (soft shadows on High only), two fill spots that are switched off on Low, and flat ambient light. No real-time GI and no post-processing.
- **Quality levels:**
  - Auto: starts on High and drops to Low after 4 s below 28 fps. Single long frames, such as a hidden tab or a modal dialog, are ignored.
  - High: 60 fps cap.
  - Low: 30 fps cap, no AA, no shadows, no fill spots, no confetti, no booth close-ups.
- **Resolution:** device pixel ratio is capped at 1.5.
- **Build:** WebGL build uses Gzip with decompression fallback, high managed stripping and engine stripping.
- **Layout:** collapsed by default on phones (≤ 640 px) and remembers the user's Show/Hide choice. The canvas height adapts (220/340/420 px).

## 5. Building it (free)

1. Unity Hub → Installs → 6000.3.28f1 → Add modules → **Web Build Support** (free; installed in Stage 4.1). If the editor was already open while installing, **restart it**: an open editor does not load a newly installed module, and the build fails with "Build target 'WebGL' not supported".
2. Open `unity/IPLAuctionArena` in that editor.
3. Run **IPL Arena → 3. Build WebGL (into the React client)**. It regenerates the scene first (**1. Prepare Scene**), then writes to `client/public/unity/arena/`. The Console ends with `BUILD_RESULT OK …` or `BUILD_RESULT FAILED …`; any logged error counts as failed.

Batch mode (same steps, no UI; close the editor first, because a project can be open in only one Unity at a time):

```
"C:\Program Files\Unity\Hub\Editor\6000.3.28f1\Editor\Unity.exe" -batchmode -quit -projectPath unity\IPLAuctionArena -executeMethod IplArena.Editor.ArenaBuild.BuildWebGL -logFile webgl.log
```

- Exit code 2 means the WebGL module is missing.
- `CompileCheck` and `BuildWindows` are also available for verification.

### Build result (Stage 4.1)

| File | Size |
|---|---|
| `Build/arena.loader.js` | 40 KB |
| `Build/arena.framework.js.unityweb` | 78 KB (gzip) |
| `Build/arena.wasm.unityweb` | 4.2 MB (gzip) |
| `Build/arena.data.unityweb` | 0.8 MB (gzip) |
| `index.html`, `TemplateData/` | Unity's Minimal template (unused by the site, harmless) |

About **5.2 MB** in total.

Settings:
- IL2CPP with optimise-for-size code generation, high managed stripping and engine stripping.
- Gzip with decompression fallback, so no server headers are needed.
- Memory starts at 64 MB and grows on demand up to 512 MB.
- Stable file names; Unity's data cache is off (see 7).

### Local preview (Windows)

Double-click `scripts\local-arena-preview.cmd`. It opens two windows:
- **Backend** on port 4000. It uses JSON storage in a TEMP file, not `server/data/persisted_rooms.json`. It forces `PERSISTENCE=json`, clears `DATABASE_URL`, and keeps the AI key and switch off.
- **Website** on http://localhost:5180. It runs with `VITE_SERVER_URL` set to its own address, so every API and socket call goes through Vite's proxy.

Re-running the script only starts whichever server is stopped. Close both windows to stop.

**Deployment note:**
- `client/public/unity/arena/` is copied into `client/dist/` by `npm run build`.
- Until the build is committed or otherwise deployed, deployed sites simply hide the arena.
- Vercel's free static hosting serves `.unityweb` files without extra configuration.

## 6. Dependencies and licences

| Dependency | Cost / licence |
|---|---|
| Unity 6 editor (already installed) | Unity Personal: free under Unity's revenue/funding threshold. Personal builds show the "Made with Unity" splash. |
| Built-in modules in `Packages/manifest.json` (`com.unity.modules.*`) | Ship with the editor; no extra licence |
| Built-in shaders (Standard, Unlit/Color, Particles/Standard Unlit) and `LegacyRuntime.ttf` | Ship with the editor |
| npm packages | **None added**. The client dependency list is unchanged; test C4 enforces this. |
| Third-party assets, Asset Store items, fonts, textures, models | **None** |

No paid services, subscriptions, trials, hosting upgrades or AI APIs are involved. Stage 3's AI commentary stays **off by default**: it needs both `AI_ANALYSIS_ENABLED=true` and a key, and the deterministic analysis never needs it.

## 7. Verification and known limits

**Verified in a real browser (Stage 4.1, final build).** Testing used the Claude desktop app's built-in browser against the local preview, with the host using the real UI and a second player connected through the same socket API.
- **Events:** auction start, new player, bid, leader change, countdown warning, SOLD, UNSOLD, pause, resume, refresh while paused, and completion.
- **Sync:** Unity's snapshots matched the server's state at every step.
- **Lifecycle:** one Unity instance and one loader. Hiding the arena, or leaving the room, releases Unity after 8 s. A Unity error shows the failure panel, and Retry recovers.
- **Privacy:** no tokens or names were found in what was sent to Unity.
- **Console:** zero console errors.

**Fixed after browser testing:**
- `CreatePrimitive` adds colliders, but physics is stripped from the WebGL build. This produced hundreds of "BoxCollider doesn't exist" errors. The hall is now built from the primitive meshes directly.
- Unity's IndexedDB data cache served the old `.data` file to new code after a rebuild, causing a stack overflow. Data caching is now off; the normal HTTP cache still applies.

**Known limits:**
- **Unity splash:** Unity Personal shows the "Made with Unity" splash for a few seconds on each load. Snapshots sent during it are kept.
- **Phones:** below 640 px wide the panel starts collapsed. A tap on **Show** loads it, and the choice is remembered.
- **Readability:** booth text is small in the compact panel, and the countdown warning's red tint is subtle at small sizes.
- **Results screen:** the completion effect plays there, because that is where React shows completed rooms; the arena panel is there too, in compact form.
