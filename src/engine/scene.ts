// Location page scene: procedural terrain + structures + NPCs.
// Terrain is a pure function of (worldSeed, locationId), so the client can generate it
// itself; the server only ever sends the small dynamic bits (owner, buildings, chest).
import { BUILDINGS, TUNING, type LocationTrait } from './content.ts';
import { settleBase } from './economy.ts';
import { fbm } from './noise.ts';
import { hash32, rngFor } from './rng.ts';
import { bankWidth, onWaterChange, polylineDistance, radialAt, radialTable, riverPolyline, WATER } from './water.ts';
import type { BaseState, EngineContext, Id, LocationDef, Millis, PlayerState } from './types.ts';

export const TILES = ['water', 'sand', 'grass', 'forest', 'rock', 'snow', 'field', 'bog'] as const; // snow unused
export type TileKind = (typeof TILES)[number];
const T = { water: 0, sand: 1, grass: 2, forest: 3, rock: 4, snow: 5, field: 6, bog: 7 } as const;

export const SCENE_W = 40;
export const SCENE_H = 40;
/** The playable area is a circle of this radius (tiles) around the map centre; beyond it is fog. */
export const SCENE_RADIUS = 20;
/** True if tile (x, y) lies inside the round play area (with an optional inset). */
export const insideArea = (x: number, y: number, inset = 0) =>
  Math.hypot(x + 0.5 - SCENE_W / 2, y + 0.5 - SCENE_H / 2) <= SCENE_RADIUS - inset;

export interface Terrain {
  width: number;
  height: number;
  tiles: Uint8Array; // index into TILES, row-major
}

const terrainCache = new Map<string, Terrain>();

/** Thresholds used to classify tiles (and by the 3D view to shape/colour the ground). */
export const TERRAIN_LEVELS = { water: 0.32, sand: 0.35, forestMoisture: 0.58, rockiness: 0.74, field: 0.5, bog: 0.5 };

/**
 * Per-location layout: the location's TRAITS decide which ingredients are present, its SEED
 * decides their proportions and placement. Same traits + different seed = same kind of place,
 * different map.
 */
interface Layout {
  seed: number;
  has: (t: LocationTrait) => boolean;
  plateauR: number; // radius of the flat top (1 = half the map width)
  plateauSlope: number; // small = steep plateau, large = rounded hill
  plateauHeight: number; // 0 without 'central-high-spot'
  valleyAngle: number; // axis of the valley floor
  river: { kind: 'direct' | 'curvy' | 'peninsula'; angle: number; amp: number; freq: number; phase: number; width: number; loopR: number; line: [number, number, number][]; bank: number } | null;
  lake: { kind: 'island' | 'peninsula' | 'nearby'; ringR: number; ringW: number; neck: number; cx: number; cy: number; radius: number; shape: Float32Array; rot: number; bank: number } | null;
  ponds: { cx: number; cy: number; radius: number; shape: Float32Array; rot: number; bank: number }[];
  deposit: { kind: DepositKind; cx: number; cy: number; radius: number } | null; // square units, origin at the centre
}

export type DepositKind = 'iron' | 'copper' | 'stone' | 'mud' | 'salt';
const layoutCache = new Map<string, Layout>();
onWaterChange(() => { layoutCache.clear(); terrainCache.clear(); });
const pickTemplate = <T>(list: T[], r: () => number): T | undefined => (list.length ? list[Math.floor(r() * list.length) % list.length] : undefined);

function layoutFor(worldSeed: number, loc: LocationDef): Layout {
  const key = `${worldSeed}:${loc.id}:${loc.traits?.join(',')}:${JSON.stringify(WATER.preview)}`;
  let l = layoutCache.get(key);
  if (!l) {
    const seed = hash32(worldSeed, 'terrain', loc.id);
    const r = rngFor(seed, 'layout');
    const traits = new Set(loc.traits ?? []);
    const has = (t: LocationTrait) => traits.has(t);
    const plateauR = 0.1 + r.next() * 0.14, plateauSlope = 0.1 + r.next() * 0.22;
    const riverKind = has('river-direct') ? 'direct' : has('river-curvy') ? 'curvy' : has('river-peninsula') ? 'peninsula' : null;
    const lakeKind = has('lake-island') ? 'island' : has('lake-peninsula') ? 'peninsula' : has('lake-nearby') ? 'nearby' : null;
    const lakeDir = r.next() * Math.PI * 2;
    const depositKind: DepositKind | null = has('iron-ore') ? 'iron' : has('copper-ore') ? 'copper' : has('stone-quarry') ? 'stone' : has('mud-quarry') ? 'mud' : has('salt-quarry') ? 'salt' : null;
    const dr = rngFor(seed, 'deposit'); // own stream: adding deposits changes nothing else
    const wr = rngFor(seed, 'water-shapes'); // own stream for water templates / banks
    const wn = () => wr.next();
    const slope = (s: [number, number]) => s[0] + wn() * (s[1] - s[0]);
    const Wl = WATER.lake, Wp = WATER.pond, Wr = WATER.river;
    const lakeShape = radialTable(pickTemplate(Wl.templates, wn) ?? { points: [] });
    const riverLine = riverPolyline(pickTemplate(Wr.templates, wn) ?? { points: [] });
    const ponds: Layout['ponds'] = [];
    if (has('bog')) {
      const n = Wp.count[0] + Math.floor(wn() * (Wp.count[1] - Wp.count[0] + 1));
      for (let i = 0; i < n; i++) {
        const a = wn() * Math.PI * 2, d = 0.12 + wn() * 0.26;
        ponds.push({ cx: Math.cos(a) * d, cy: Math.sin(a) * d, radius: Wp.size[0] + wn() * (Wp.size[1] - Wp.size[0]),
          shape: radialTable(pickTemplate(Wp.templates, wn) ?? { points: [] }), rot: wn() * Math.PI * 2, bank: bankWidth(Wp.depth, slope(Wp.bankSlope), SCENE_W) });
      }
    }
    const depAngle = dr.next() * Math.PI * 2, depDist = 0.17 + dr.next() * 0.12;
    l = {
      seed, has, plateauR, plateauSlope,
      plateauHeight: has('central-high-spot') ? 0.2 + r.next() * 0.1 + loc.tier * 0.02 : 0.03,
      valleyAngle: r.next() * Math.PI,
      river: riverKind && {
        kind: riverKind, angle: r.next() * Math.PI,
        amp: riverKind === 'curvy' ? 0.05 + r.next() * 0.06 : 0, freq: 1 + r.next() * 1.5, phase: r.next() * Math.PI * 2,
        width: Wr.width[0] + r.next() * (Wr.width[1] - Wr.width[0]), loopR: 0.22 + r.next() * 0.08,
        // template centre line in map units: along ±0.75, sideways ±0.25 (straight rivers: flattened)
        line: riverLine.map(([u, v, w]) => [u * 0.75, v * 0.25 * (riverKind === 'direct' ? 0.3 : 1), w] as [number, number, number]),
        bank: bankWidth(Wr.depth, slope(Wr.bankSlope), SCENE_W),
      },
      lake: lakeKind && {
        kind: lakeKind, ringR: plateauR + plateauSlope * 0.7 + 0.06, ringW: 0.035 + r.next() * 0.035,
        neck: lakeDir, cx: Math.cos(lakeDir) * 0.24, cy: Math.sin(lakeDir) * 0.14, radius: 0.09 + r.next() * 0.05,
        shape: lakeShape, rot: wn() * Math.PI * 2, bank: bankWidth(Wl.depth, slope(Wl.bankSlope), SCENE_W),
      },
      ponds,
      deposit: depositKind && { kind: depositKind, cx: Math.cos(depAngle) * depDist, cy: Math.sin(depAngle) * depDist, radius: 0.08 + dr.next() * 0.03 },
    };
    // keep the deposit off rivers and lakes: try 8 directions, take the one farthest from water
    if (l.deposit) {
      const lay = l, dep = l.deposit;
      const waterGap = (x: number, y: number) => {
        let g = Infinity;
        if (lay.river) {
          if (lay.river.kind === 'peninsula') g = Math.min(g, riverDistance(lay.river, x, y));
          else {
            const c = Math.cos(lay.river.angle), sn = Math.sin(lay.river.angle);
            g = Math.min(g, polylineDistance(lay.river.line, x * c + y * sn, -x * sn + y * c).d);
          }
        }
        if (lay.lake) {
          if (lay.lake.kind === 'nearby') g = Math.min(g, Math.hypot(x - lay.lake.cx, y - lay.lake.cy) - lay.lake.radius * 1.3);
          else g = Math.min(g, Math.abs(Math.hypot(x, y) / 0.5 - lay.lake.ringR) * 0.5 - lay.lake.ringW);
        }
        for (const pd of lay.ponds) g = Math.min(g, Math.hypot(x - pd.cx, y - pd.cy) - pd.radius * 1.3);
        return g;
      };
      let best = -Infinity;
      for (let k = 0; k < 8; k++) {
        const a = depAngle + (k * Math.PI) / 4, x = Math.cos(a) * depDist, y = Math.sin(a) * depDist, gap = waterGap(x, y);
        if (gap > best) { best = gap; dep.cx = x; dep.cy = y; }
        if (gap > dep.radius * 1.5) break; // first direction that is clear enough
      }
    }
    // editor preview: one water body of the chosen kind / template in the middle
    const pv = WATER.preview;
    if (pv) {
      const bank = (d: number, s: [number, number]) => bankWidth(d, (s[0] + s[1]) / 2, SCENE_W);
      l.lake = null; l.river = null; l.ponds = [];
      if (pv.kind === 'lake') {
        l.lake = { kind: 'nearby', ringR: 0, ringW: 0, neck: 0, cx: 0, cy: 0, radius: 0.24, shape: radialTable(Wl.templates[pv.index] ?? { points: [] }), rot: 0, bank: bank(Wl.depth, Wl.bankSlope) };
      } else if (pv.kind === 'pond') {
        l.ponds = [{ cx: 0, cy: 0, radius: 0.2, shape: radialTable(Wp.templates[pv.index] ?? { points: [] }), rot: 0, bank: bank(Wp.depth, Wp.bankSlope) }];
      } else {
        l.river = { kind: 'curvy', angle: 0, amp: 0, freq: 0, phase: 0, width: (Wr.width[0] + Wr.width[1]) / 2 * 2.5, loopR: 0,
          line: riverPolyline(Wr.templates[pv.index] ?? { points: [] }).map(([u, v, w]) => [u * 0.45, v * 0.2, w] as [number, number, number]), bank: bank(Wr.depth, Wr.bankSlope) };
      }
    }
    if (layoutCache.size > 500) layoutCache.clear();
    layoutCache.set(key, l);
  }
  return l;
}

const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Distance (square units) from (px, py) to the river's centre line. */
function riverDistance(river: NonNullable<Layout['river']>, px: number, py: number): number {
  const c = Math.cos(river.angle), s = Math.sin(river.angle);
  if (river.kind !== 'peninsula') {
    const u = px * c + py * s, v = -px * s + py * c; // along / across the river axis
    return Math.abs(v - river.amp * Math.sin(u * river.freq * Math.PI * 2 + river.phase));
  }
  // Peninsula: the river loops around the centre (a ~270° arc) and both ends run off to the
  // map edge side by side, leaving a land neck between them.
  const R = river.loopR, gap = 0.9; // radians of the neck
  const rad = Math.hypot(px, py), ang = Math.atan2(py, px);
  let d = angleDiff(ang, river.angle) > gap / 2 ? Math.abs(rad - R) : Infinity;
  for (const edge of [river.angle - gap / 2, river.angle + gap / 2]) {
    const ex = Math.cos(edge), ey = Math.sin(edge);
    const along = px * ex + py * ey;
    if (along >= R) d = Math.min(d, Math.abs(-px * ey + py * ex)); // straight leg outwards
  }
  return d;
}

/**
 * Continuous terrain field at tile coords (x, y), built from the location's traits:
 *   central-high-spot – plateau/hill in the middle (flat, grassy, buildable top)
 *   valley            – ridges rise on two sides of a valley floor
 *   dry / wet         – less / more moisture and water
 *   fields, bog       – patches of crop fields / boggy ground
 *   river-*           – straight, meandering, or looping around the centre (peninsula)
 *   lake-*            – ring lake around a central island, ring lake with a land neck, or a lake off-centre
 *   perimeter-*       – the outskirts are wood, meadows or fields
 * Returns height h (~0..1), moisture, rockiness, field and bog masks. Pure – the client
 * samples it at any resolution for a smooth 3D surface.
 */
export function terrainField(worldSeed: number, loc: LocationDef, x: number, y: number): {
  h: number; moist: number; rock: number; field: number; bog: number; deposit: number;
  lake: number; pond: number; river: number; // water environment near this point (1 = in it, fades out ~3 tiles past the shore)
} {
  const L = layoutFor(worldSeed, loc);
  const W = TERRAIN_LEVELS.water;
  const nx = x / SCENE_W, ny = y / SCENE_H;
  // square units (both axes scaled by the map width), origin at the centre
  const px = (x - SCENE_W / 2) / SCENE_W, py = (y - SCENE_H / 2) / SCENE_W;
  const r = Math.hypot(px, py) / 0.5; // 1 = horizontal map edge
  const outer = smooth(r, 0.62, 0.95); // 0 inside, 1 at the outskirts

  const noise = fbm(L.seed, nx * 4, ny * 3, 4);
  const plateau = L.has('central-high-spot') ? 1 - smooth(r, L.plateauR, L.plateauR + L.plateauSlope) : 0;
  const foot = L.plateauR + L.plateauSlope;
  // The top is calmer (less noise) so it stays flat and buildable.
  let h = 0.42 + plateau * L.plateauHeight + (noise - 0.5) * (0.3 - plateau * 0.22);
  let moist = fbm(L.seed ^ 0x9e3779b9, nx * 3, ny * 3, 3) - plateau * 0.35 - (1 - smooth(r, foot, foot + 0.2)) * 0.12;
  let rock = fbm(L.seed ^ 0x51ed270b, nx * 9, ny * 6, 2) + 4 * plateau * (1 - plateau) * 0.22; // more along the rim
  let field = 0;
  let bog = 0;

  if (L.has('valley')) {
    const across = Math.abs(-px * Math.sin(L.valleyAngle) + py * Math.cos(L.valleyAngle));
    h += smooth(across, 0.12, 0.45) * 0.2; // ridges on both sides
    rock += smooth(across, 0.3, 0.5) * 0.08;
  }
  if (L.has('dry')) { moist -= 0.18; h += 0.04; rock += 0.04; }
  if (L.has('wet')) { moist += 0.12; h -= 0.03; }

  // Outskirts
  if (L.has('perimeter-wood')) moist += outer * 0.4;
  else if (L.has('perimeter-meadows')) moist -= outer * 0.45;
  else moist += outer * 0.15;
  if (L.has('perimeter-fields')) { field = Math.max(field, outer * 1.2); moist -= outer * 0.3; }

  // Crop fields in open, flat land between the centre and the outskirts
  if (L.has('fields')) {
    field = Math.max(field, smooth(fbm(L.seed ^ 0x2c1b3c6d, nx * 2.5, ny * 2, 3), 0.5, 0.56) * (1 - plateau) * smooth(r, foot, foot + 0.1));
  }
  // Bog: low, flat, soggy patches just above the water line
  if (L.has('bog')) {
    bog = smooth(fbm(L.seed ^ 0x7f4a7c15, nx * 3, ny * 3, 3), 0.55, 0.62) * (1 - plateau);
    h += (W + 0.012 + (fbm(L.seed ^ 0x1234, nx * 14, ny * 10, 2) - 0.5) * 0.04 - h) * bog * 0.9; // puddles dip below
  }

  // Lakes: template outline (radius by angle), banks as steep as the lake's bank slope
  let lakeEnv = 0, pondEnv = 0, riverEnv = 0;
  const reach = 3 / SCENE_W; // environment influence beyond the shore
  if (L.lake) {
    const lk = L.lake;
    let depth = 0;
    if (lk.kind === 'nearby') {
      const ax = px - lk.cx, ay = py - lk.cy;
      const s = Math.hypot(ax, ay) - lk.radius * radialAt(lk.shape, Math.atan2(ay, ax) - lk.rot); // signed distance to the shore (approx.)
      depth = 1 - smooth(s, -lk.bank, 0);
      lakeEnv = 1 - smooth(s, 0, reach);
    } else {
      const ringR = lk.ringR * (1 + (radialAt(lk.shape, Math.atan2(py, px) - lk.rot) - 1) * 0.5); // wobbly ring around the island
      const off = Math.abs(r - ringR);
      depth = 1 - smooth(off, lk.ringW, lk.ringW + lk.bank * 2);
      lakeEnv = 1 - smooth(off, lk.ringW + lk.bank * 2, lk.ringW + lk.bank * 2 + reach * 2);
      if (lk.kind === 'peninsula') {
        const neck = smooth(angleDiff(Math.atan2(py, px), lk.neck), 0.35, 0.6);
        depth *= neck; // land neck towards the shore
        depth = Math.max(depth, (1 - smooth(r, ringR, ringR + lk.ringW * 2.5)) * smooth(r, ringR - lk.ringW, ringR) * neck);
        lakeEnv *= neck;
      }
    }
    h += (W - WATER.lake.depth - h) * depth;
    rock -= depth;
    field *= 1 - depth;
    bog *= 1 - depth;
  }
  // Ponds (bog locations): small template-shaped pools
  for (const pd of L.ponds) {
    const ax = px - pd.cx, ay = py - pd.cy;
    const s = Math.hypot(ax, ay) - pd.radius * radialAt(pd.shape, Math.atan2(ay, ax) - pd.rot);
    const depth = 1 - smooth(s, -pd.bank, 0);
    pondEnv = Math.max(pondEnv, 1 - smooth(s, 0, reach));
    h += (W - WATER.pond.depth - h) * depth;
    rock -= depth;
    field *= 1 - depth;
  }

  // Rivers
  if (L.river) {
    let d: number, w = L.river.width;
    if (L.river.kind === 'peninsula') d = riverDistance(L.river, px, py);
    else { // template centre line, rotated by the river's angle
      const c = Math.cos(L.river.angle), s = Math.sin(L.river.angle);
      const q = polylineDistance(L.river.line, px * c + py * s, -px * s + py * c);
      d = q.d;
      w *= q.w;
    }
    const channel = 1 - smooth(d, w * 0.6, w * 0.6 + L.river.bank);
    riverEnv = 1 - smooth(d, w * 0.6 + L.river.bank, w * 0.6 + L.river.bank + reach);
    const valley = 1 - smooth(d, w, w * 7);
    h -= valley * plateau * L.plateauHeight * (L.river.kind === 'peninsula' ? 0.3 : 0.85); // cuts through the plateau
    h += (W - WATER.river.depth - h) * channel; // runs below the water line
    moist += valley * 0.1;
    rock -= channel;
    field *= 1 - channel;
    bog *= 1 - channel;
  }

  // Ore / stone deposit: a rocky mound off-centre that always stays above the water
  let deposit = 0;
  if (L.deposit) {
    const d = L.deposit;
    deposit = 1 - smooth(Math.hypot(px - d.cx, py - d.cy), d.radius * 0.5, d.radius);
    if (d.kind === 'mud') { // a flat, damp patch (no rock)
      h += (Math.max(W + 0.03, Math.min(h, W + 0.06)) - h) * deposit;
      moist += deposit * 0.2;
      rock -= deposit * 0.5;
    } else { // a rocky mound
      h += deposit * 0.04;
      h += (Math.max(h, W + 0.05) - h) * deposit;
      rock += deposit * 0.6;
    }
    field *= 1 - deposit;
    bog *= 1 - deposit;
  }
  return { h, moist, rock, field, bog, deposit, lake: lakeEnv, pond: pondEnv, river: riverEnv };
}

/** Where the location's ore / stone deposit is (tile coords), or null. */
export function depositOf(worldSeed: number, loc: LocationDef): { kind: DepositKind; x: number; y: number; radius: number } | null {
  const d = layoutFor(worldSeed, loc).deposit;
  return d && { kind: d.kind, x: SCENE_W / 2 + d.cx * SCENE_W, y: SCENE_H / 2 + d.cy * SCENE_W, radius: d.radius * SCENE_W };
}

export function generateTerrain(worldSeed: number, loc: LocationDef): Terrain {
  const key = `${worldSeed}:${loc.id}:${loc.traits?.join(',')}:${JSON.stringify(WATER.preview)}`;
  const cached = terrainCache.get(key);
  if (cached) return cached;

  const L = TERRAIN_LEVELS;
  const tiles = new Uint8Array(SCENE_W * SCENE_H);
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const { h, moist, rock, field, bog } = terrainField(worldSeed, loc, x + 0.5, y + 0.5);
      let tile: number;
      if (h < L.water) tile = T.water;
      else if (bog > L.bog) tile = T.bog;
      else if (h < L.sand) tile = T.sand;
      else if (rock > L.rockiness) tile = T.rock;
      else if (field > L.field) tile = T.field;
      else tile = moist > L.forestMoisture ? T.forest : T.grass;
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
      if (!insideArea(x, y, 1.5)) continue;
      const i = y * terrain.width + x;
      // keep one free tile around every placed structure so they don't overlap when drawn
      const crowded = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => taken.has(i + dy * terrain.width + dx)));
      if (!crowded && buildable(terrain.tiles[i])) {
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
  [T.field]: ['villager'],
  [T.bog]: ['frog'],
};

/** Villagers living around the settlement centre (in addition to the terrain's wildlife). */
const CIVILIANS = 4;

function npcsAt(seed: number, terrain: Terrain, count: number, now: Millis): SceneNpc[] {
  const npcs: SceneNpc[] = [];
  const step = Math.floor(now / TUNING.npcStepMs);
  const frac = (now % TUNING.npcStepMs) / TUNING.npcStepMs;
  const cx = terrain.width >> 1, cy = terrain.height >> 1;
  for (let n = 0; n < CIVILIANS + count; n++) {
    const civilian = n < CIVILIANS;
    const r = rngFor(seed, 'npc', n);
    let hx = 0, hy = 0;
    for (let tries = 0; tries < 30; tries++) {
      hx = civilian ? cx + r.int(-6, 6) : r.int(1, terrain.width - 2);
      hy = civilian ? cy + r.int(-4, 4) : r.int(1, terrain.height - 2);
      if (walkable(terrain.tiles[hy * terrain.width + hx]) && insideArea(hx, hy, 2)) break;
    }
    // Stateless wandering: waypoint k is a hash of (npc, k); position lerps between waypoints.
    const roam = civilian ? 3 : 2;
    const wp = (k: number) => {
      const w = rngFor(seed, 'npc', n, k);
      const x = hx + (w.next() * 2 - 1) * roam, y = hy + (w.next() * 2 - 1) * roam;
      // never wade into lakes/rivers: a waypoint on water falls back to the home spot
      const tx = Math.min(terrain.width - 1, Math.max(0, Math.round(x))), ty = Math.min(terrain.height - 1, Math.max(0, Math.round(y)));
      return walkable(terrain.tiles[ty * terrain.width + tx]) ? [x, y] : [hx, hy];
    };
    const [ax, ay] = wp(step), [bx, by] = wp(step + 1);
    const kinds = civilian ? ['villager'] : NPC_BY_TILE[terrain.tiles[hy * terrain.width + hx]] ?? ['villager'];
    npcs.push({ id: `npc${n}`, kind: kinds[n % kinds.length], x: ax + (bx - ax) * frac, y: ay + (by - ay) * frac });
  }
  return npcs;
}

/** NPC positions at `now` for a location – pure, so the client can animate them every frame. */
export function locationNpcs(worldSeed: number, loc: LocationDef, now: Millis): SceneNpc[] {
  return npcsAt(hash32(worldSeed, 'scene', loc.id), generateTerrain(worldSeed, loc), 3 + loc.tier * 2, now);
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
  const glyph = ['~', '.', ',', 'T', '^', '*', '=', '%'];
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
