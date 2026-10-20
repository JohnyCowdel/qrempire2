# QR Empire – engine architecture

```
 browser (map / location / player / base pages)
   │  imports src/engine  → generates terrain, animates NPCs/units, counts down timers locally
   │  HTTP: commands + small view-model fetches
   ▼
 server/game-service.ts   ← the ONLY place with I/O
   │  1. derive doc keys from the command (no DB)
   │  2. ONE batched read  (repo.getMany)
   │  3. pure engine call  (engine.execute)
   │  4. ONE atomic commit (repo.commit, optimistic versions, retry on conflict)
   ▼
 storage/repository.ts    ← port: versioned key → JSON doc store
   ├─ memory.ts           (simulation / tests, counts DB ops)
   └─ postgres|d1|…       (later; one `docs` table)
```

## Rules

1. **The engine is pure.** `src/engine` has no I/O, no `Date.now()`, no `Math.random()`.
   Time comes in via `EngineContext.now`, randomness via `rngFor(worldSeed, …)`.
   ⇒ simulate years in seconds, replay bugs, run the same code in client and server.
2. **Store only what can't be derived.** Terrain, NPCs, map units, loot rolls and item stats
   are pure functions of seeds and time. The DB holds 3 aggregate types only:
   - `player:<id>` – xp, wallet, inventory `(defId, seed)`, equipment, lootLog, baseIds
   - `base:<id>` – buildings, `stock` + `settledAt`, pending upgrades `(toLevel, finishAt)`
   - `region:<cell>` – ownership index for a ~5 km cell (makes the map cost a few reads)
3. **Lazy evaluation, no cron jobs.** Resource production and construction completion are
   computed on read by `settleBase(base, now)`. A base nobody looks at costs nothing.
4. **Static content ships with the code** (`content.ts`, location list): zero DB reads,
   balance changes need no migrations.
5. **Cheap rejection first.** QR URLs are HMAC-signed and GPS-checked before any DB access.

## Cost per action (from `npm run sim`)
- command: 1 batched read + ≤1 commit (touching 1–3 docs)
- location page: 1 batched read (region + base + viewer); terrain = 0
- map page: 1 batched read of the region cells in view (edge-cacheable)

## Running locally
- `npm run dev` → http://localhost:5173 (world map; restarts on file changes, in-memory state)
- Location page: http://localhost:5173/location/<id> (or "Open location →" in a map popup).
  3D (three.js) with an RTS camera; buildings/characters are primitives unless an asset URL is
  set in `STRUCTURE_ASSETS` / `NPC_ASSETS` (src/client/location-view.ts).
  Terrain, decorations and NPC movement are generated in the browser from the world seed;
  the server only supplies game state and runs commands. `POST /api/command` is DEV ONLY
  (no auth, the "Claim" button skips the QR/GPS check).
- `npm run sim -- --verify` → headless balance/cost simulation
- The dev server serves `src/engine` and `src/client` to the browser with types stripped
  (`node:module` `stripTypeScriptTypes`), so the client runs the exact same engine code. No bundler.

## Next steps
- HTTP layer (Hono, runs on Cloudflare Workers / Node) wrapping `GameService`
- Postgres or D1 adapter for `Repository`
- Client: MapLibre/Leaflet for the world map, Canvas/PixiJS for location + base scenes,
  all driven by the engine's view models (`buildMapView`, `buildLocationScene`, `playerView`, `baseView`)
- Auth (anonymous device id → upgrade to account), combat/raids between bases
