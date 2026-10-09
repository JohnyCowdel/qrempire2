// Location page scene: procedural terrain + structures + NPCs.
// Terrain is a pure function of (worldSeed, locationId), so the client can generate it
// itself; the server only ever sends the small dynamic bits (owner, buildings, chest).
import { BUILDINGS, TUNING } from './content.ts';
import { settleBase } from './economy.ts';
import { fbm } from './noise.ts';
import { hash32, rngFor } from './rng.ts';
import type { BaseState, EngineContext, Id, LocationDef, Millis, PlayerState } from './types.ts';

export const TILES = ['water', 'sand', 'grass', 'forest', 'rock', 'snow'] as const;
export type TileKind = (typeof TILES)[number];
const T = { water: 0, sand: 1, grass: 2, forest: 3, rock: 4, snow: 5 } as const;

export const SCENE_W = 48;
export const SCENE_H = 32;

export interface Terrain {
  width: number;
  height: number;
  tiles: Uint8Array; // index into TILES, row-major
}

const terrainCache = new Map<string, Terrain>();

export function generateTerrain(worldSeed: number, loc: LocationDef): Terrain {
  const key = `${worldSeed}:${loc.id}`;
  const cached = terrainCache.get(key);
  if (cached) return cached;

  const seed = hash32(worldSeed, 'terrain', loc.id);
  const tiles = new Uint8Array(SCENE_W * SCENE_H);
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const nx = x / SCENE_W, ny = y / SCENE_H;
      const dx = nx - 0.5, dy = ny - 0.5;
      const centre = dx * dx + dy * dy;
      // Island-ish falloff keeps the middle buildable; higher tiers are more mountainous.
      const h = fbm(seed, nx * 4, ny * 3, 4) - centre * 0.9 + 0.12 + loc.tier * 0.04;
      const moist = fbm(seed ^ 0x9e3779b9, nx * 3, ny * 3, 3);
      let tile: number;
      if (h < 0.3) tile = T.water;
      else if (h < 0.35) tile = T.sand;
      else if (h < 0.62) tile = moist > 0.55 ? T.forest : T.grass;
      else if (h < 0.76) tile = T.rock;
      else tile = T.snow;
      if (centre < 0.012 && (tile === T.water || tile === T.snow)) tile = T.grass;
      tiles[y * SCENE_W + x] = tile;
    }
  }
  const terrain = { width: SCENE_W, height: SCENE_H, tiles };
  if (terrainCache.size > 500) terrainCache.clear();
  terrainCache.set(key, terrain);
  return terrain;
}

export interface SceneStructure {
  id: Id;
  kind: string; // building kind, 'ruins' or 'chest'
  label: string;
  x: number;
  y: number;
  level?: number;
  upgradingTo?: number;
  finishAt?: Millis;
}

export interface SceneNpc {
  id: Id;
  kind: string;
  x: number; // fractional tile coords at `now`
  y: number;
}

export interface LocationScene {
  location: LocationDef;
  terrain: Terrain;
  ownerId?: Id;
  chestAvailable: boolean;
  structures: SceneStructure[];
  npcs: SceneNpc[];
}

const buildable = (t: number) => t === T.grass || t === T.sand;
const walkable = (t: number) => t !== T.water;

/** Deterministic free spot near the centre for a given key (stable as more buildings are added). */
function placeNear(terrain: Terrain, taken: Set<number>, seedParts: (string | number)[]): [number, number] {
  const r = rngFor(...seedParts);
  const cx = terrain.width >> 1, cy = terrain.height >> 1;
  for (let radius = 3; radius < terrain.width; radius += 2) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = cx + r.int(-radius, radius), y = cy + r.int(-Math.ceil(radius / 2), Math.ceil(radius / 2));
      if (x < 1 || y < 1 || x >= terrain.width - 1 || y >= terrain.height - 1) continue;
      const i = y * terrain.width + x;
      if (!taken.has(i) && buildable(terrain.tiles[i])) {
        taken.add(i);
        return [x, y];
      }
    }
  }
  return [cx, cy];
}

const NPC_BY_TILE: Record<number, string[]> = {
  [T.sand]: ['crab'],
  [T.grass]: ['villager', 'deer'],
  [T.forest]: ['wolf', 'boar'],
  [T.rock]: ['goblin'],
  [T.snow]: ['yeti'],
};

function npcsAt(seed: number, terrain: Terrain, count: number, now: Millis): SceneNpc[] {
  const npcs: SceneNpc[] = [];
  const step = Math.floor(now / TUNING.npcStepMs);
  const frac = (now % TUNING.npcStepMs) / TUNING.npcStepMs;
  for (let n = 0; n < count; n++) {
    const r = rngFor(seed, 'npc', n);
    let hx = 0, hy = 0;
    for (let tries = 0; tries < 30; tries++) {
      hx = r.int(1, terrain.width - 2);
      hy = r.int(1, terrain.height - 2);
      if (walkable(terrain.tiles[hy * terrain.width + hx])) break;
    }
    // Stateless wandering: waypoint k is a hash of (npc, k); position lerps between waypoints.
    const wp = (k: number) => {
      const w = rngFor(seed, 'npc', n, k);
      return [hx + w.next() * 4 - 2, hy + w.next() * 4 - 2];
    };
    const [ax, ay] = wp(step), [bx, by] = wp(step + 1);
    const kinds = NPC_BY_TILE[terrain.tiles[hy * terrain.width + hx]] ?? ['villager'];
    npcs.push({ id: `npc${n}`, kind: kinds[n % kinds.length], x: ax + (bx - ax) * frac, y: ay + (by - ay) * frac });
  }
  return npcs;
}

export const lootEpoch = (now: Millis) => Math.floor(now / TUNING.lootCooldownMs);

export function buildLocationScene(
  ctx: EngineContext,
  loc: LocationDef,
  opts: { ownerId?: Id; base?: BaseState; viewer?: PlayerState } = {},
): LocationScene {
  const terrain = generateTerrain(ctx.worldSeed, loc);
  const seed = hash32(ctx.worldSeed, 'scene', loc.id);
  const taken = new Set<number>();
  const structures: SceneStructure[] = [];

  if (opts.base) {
    const base = settleBase(opts.base, ctx.now);
    for (const b of [...base.buildings].sort((a, c) => a.id.localeCompare(c.id))) {
      const [x, y] = placeNear(terrain, taken, [seed, 'b', b.id]);
      structures.push({
        id: b.id, kind: b.kind, label: BUILDINGS[b.kind].name, x, y, level: b.level,
        upgradingTo: b.upgrade?.toLevel, finishAt: b.upgrade?.finishAt,
      });
    }
  } else {
    const [x, y] = placeNear(terrain, taken, [seed, 'ruins']);
    structures.push({ id: 'ruins', kind: 'ruins', label: 'Abandoned ruins', x, y });
  }

  const chestAvailable = !opts.viewer || opts.viewer.lootLog[loc.id] !== lootEpoch(ctx.now);
  if (chestAvailable) {
    const [x, y] = placeNear(terrain, taken, [seed, 'chest', lootEpoch(ctx.now)]);
    structures.push({ id: 'chest', kind: 'chest', label: 'Treasure chest', x, y });
  }

  return {
    location: loc,
    terrain,
    ownerId: opts.ownerId,
    chestAvailable,
    structures,
    npcs: npcsAt(seed, terrain, 3 + loc.tier * 2, ctx.now),
  };
}

/** Debug renderer, handy for the simulator and tests. */
export function sceneToAscii(scene: LocationScene): string {
  const glyph = ['~', '.', ',', 'T', '^', '*'];
  const { width, height, tiles } = scene.terrain;
  const rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => glyph[tiles[y * width + x]]),
  );
  for (const n of scene.npcs) {
    const x = Math.round(n.x), y = Math.round(n.y);
    if (rows[y]?.[x]) rows[y][x] = 'm';
  }
  for (const s of scene.structures) rows[s.y][s.x] = s.kind === 'chest' ? '$' : s.kind[0].toUpperCase();
  return rows.map((r) => r.join('')).join('\n');
}
