// Location page scene: procedural terrain + structures + NPCs.
// Terrain is a pure function of (worldSeed, locationId), so the client can generate it
// itself; the server only ever sends the small dynamic bits (owner, buildings, chest).
import { BUILDINGS, TUNING } from './content.ts';
import { settleBase } from './economy.ts';
import { fbm } from './noise.ts';
import { hash32, rngFor } from './rng.ts';
import { bankWidth, onWaterChange, polylineDistance, radialAt, radialTable, radialValueTable, riverPolyline } from './water.ts';
import { getTemplate, onTemplatesChange, param, type TemplateKind, type TerrainTemplate } from './templates.ts';
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
  preview: boolean;
  plateau: { R: number; slope: number; height: number; calm: number; rimRock: number; shape: Float32Array; heights: Float32Array; rot: number } | null;
  foot: number; // where the centre's influence ends (r units)
  climate: { moist: number; height: number; rock: number };
  valley: { angle: number; ridge: number; width: number } | null;
  perimeter: { moist: number; fields: number } | null;
  fields: { threshold: number } | null;
  bog: number | null; // bog noise threshold (pond template)
  rocky: { amount: number; scale: number; threshold: number } | null;
  forests: { cx: number; cy: number; R: number; shape: Float32Array; rot: number; edge: number; amount: number }[];
  river: { kind: 'line' | 'peninsula'; angle: number; width: number; loopR: number; line: [number, number, number][]; bank: number; depth: number } | null;
  lake: { kind: 'island' | 'peninsula' | 'nearby'; ringR: number; ringW: number; neck: number; cx: number; cy: number; radius: number; shape: Float32Array; rot: number; bank: number; depth: number } | null;
  ponds: { cx: number; cy: number; radius: number; shape: Float32Array; rot: number; bank: number; depth: number }[];
  deposit: { kind: DepositKind; cx: number; cy: number; radius: number } | null; // square units, origin at the centre
}

export type DepositKind = 'iron' | 'copper' | 'stone' | 'mud' | 'salt';
const layoutCache = new Map<string, Layout>();
const clearCaches = () => { layoutCache.clear(); terrainCache.clear(); };
onWaterChange(clearCaches);
onTemplatesChange(clearCaches);
const pair = (v: unknown, fallback: [number, number]): [number, number] => (Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : fallback);

/** The location's templates, resolved by kind (first one of each kind wins). */
function templatesOf(loc: LocationDef): Partial<Record<TemplateKind, TerrainTemplate>> {
  const out: Partial<Record<TemplateKind, TerrainTemplate>> = {};
  for (const name of loc.traits ?? []) {
    const t = getTemplate(name) ?? loc.extraTemplates?.find((x) => x.name === name);
    if (t && !out[t.kind]) out[t.kind] = t;
  }
  return out;
}

function layoutFor(worldSeed: number, loc: LocationDef): Layout {
  const key = `${worldSeed}:${loc.id}:${loc.traits?.join(',')}:${loc.preview ? 'p' : ''}`;
  let l = layoutCache.get(key);
  if (!l) {
    const seed = hash32(worldSeed, 'terrain', loc.id);
    const r = rngFor(seed, 'layout');
    const pv = !!loc.preview; // editor preview: everything centred, unrotated
    const T = templatesOf(loc);
    const num = (t: TerrainTemplate, k: string) => Number(param(t, k));
    const wr = rngFor(seed, 'water-shapes'), wn = () => wr.next(); // own stream for water shapes / banks
    const between = (t: TerrainTemplate, k: string) => { const [a, b] = pair(param(t, k), [0, 0]); return a + wn() * (b - a); };
    // centre
    const hs = T.highspot;
    const plateau: Layout['plateau'] = hs ? {
      R: num(hs, 'radius') * (pv ? 1 : 0.85 + r.next() * 0.3), slope: num(hs, 'slope') * (pv ? 1 : 0.8 + r.next() * 0.4),
      height: num(hs, 'height') + loc.tier * num(hs, 'tierHeight'), calm: num(hs, 'calm'), rimRock: num(hs, 'rimRock'),
      shape: radialTable({ points: (hs.points ?? []) as [number, number][] }),
      heights: radialValueTable(hs.points ?? [], 2, 1), rot: pv ? 0 : r.next() * Math.PI * 2,
    } : null;
    const foot = plateau ? plateau.R + plateau.slope : 0.3;
    // modifiers
    const climate = { moist: 0, height: 0, rock: 0 };
    if (T.climate) { climate.moist = num(T.climate, 'moist'); climate.height = num(T.climate, 'height'); climate.rock = num(T.climate, 'rock'); }
    // forests: outlines in map coordinates, rotated around the centre by the seed
    const frot = T.forest && param(T.forest, 'rotate') && !pv ? r.next() * Math.PI * 2 : 0;
    const forests: Layout['forests'] = (T.forest?.blobs ?? []).filter((b) => b.points.length >= 3).map((b) => {
      const n = b.points.length, cx0 = b.points.reduce((s, p) => s + p[0], 0) / n, cy0 = b.points.reduce((s, p) => s + p[1], 0) / n;
      const local = b.points.map((p) => [p[0] - cx0, p[1] - cy0] as [number, number]);
      const c = Math.cos(frot), s = Math.sin(frot);
      return { cx: (cx0 * c - cy0 * s) * 0.5, cy: (cx0 * s + cy0 * c) * 0.5, R: 0.5, shape: radialTable({ points: local }), rot: frot, // absolute: map coords ×0.5
        edge: num(T.forest!, 'edge'), amount: num(T.forest!, 'amount') };
    });
    // water
    const lt = T.lake, rt = T.river, pt = T.pond;
    const lakeDir = r.next() * Math.PI * 2;
    const lakeMode = lt ? String(param(lt, 'mode')) : 'nearby';
    const ponds: Layout['ponds'] = [];
    if (pt) {
      const [c0, c1] = pair(param(pt, 'count'), [1, 3]), size = pair(param(pt, 'size'), [0.035, 0.065]);
      const n = pv ? 1 : Math.round(c0 + wn() * (c1 - c0));
      for (let i = 0; i < n; i++) {
        const a = wn() * Math.PI * 2, d = pv ? 0 : 0.12 + wn() * 0.26;
        ponds.push({ cx: Math.cos(a) * d, cy: Math.sin(a) * d, radius: pv ? size[1] * 3 : size[0] + wn() * (size[1] - size[0]),
          shape: radialTable({ points: (pt.points ?? []) as [number, number][] }), rot: pv ? 0 : wn() * Math.PI * 2,
          bank: bankWidth(num(pt, 'depth'), between(pt, 'bankSlope'), SCENE_W), depth: num(pt, 'depth') });
      }
    }
    const qt = T.quarry;
    const dr = rngFor(seed, 'deposit'); // own stream: adding deposits changes nothing else
    // quarry: random direction, random distance from the centre (template 'distance', map units: 0.5 = the edge)
    const [d0, d1] = qt ? pair(param(qt, 'distance'), [0.15, 0.3]) : [0.15, 0.3];
    const depAngle = dr.next() * Math.PI * 2, depDist = d0 + dr.next() * (d1 - d0);
    l = {
      seed, preview: pv, plateau, foot, climate,
      valley: T.valley ? { angle: r.next() * Math.PI, ridge: num(T.valley, 'ridge'), width: num(T.valley, 'width') } : null,
      perimeter: T.perimeter ? { moist: num(T.perimeter, 'moist'), fields: num(T.perimeter, 'fields') } : null,
      fields: T.fields ? { threshold: num(T.fields, 'threshold') } : null,
      bog: pt ? num(pt, 'bog') : null,
      rocky: T.rocky ? { amount: num(T.rocky, 'amount'), scale: num(T.rocky, 'scale'), threshold: num(T.rocky, 'threshold') } : null,
      forests,
      river: rt ? {
        kind: param(rt, 'mode') === 'loop' ? 'peninsula' : 'line', angle: pv ? 0 : r.next() * Math.PI,
        width: (() => { const [a, b] = pair(param(rt, 'width'), [0.02, 0.032]); return a + r.next() * (b - a); })() * (pv ? 2 : 1),
        loopR: 0.22 + r.next() * 0.08,
        // centre line in map units: along ±0.5 (the map edge), sideways ±0.25 × straightness
        line: riverPolyline({ points: (rt.points ?? []) as [number, number, number][] }).map(([u, v, w]) => [u * 0.5, v * 0.25 * num(rt, 'straight'), w] as [number, number, number]),
        bank: bankWidth(num(rt, 'depth'), between(rt, 'bankSlope'), SCENE_W), depth: num(rt, 'depth'),
      } : null,
      lake: lt ? {
        kind: lakeMode === 'island' ? 'island' : lakeMode === 'peninsula' ? 'peninsula' : 'nearby',
        ringR: foot * 0.95 + 0.06, ringW: num(lt, 'ringWidth') * (pv ? 1 : 0.7 + r.next() * 0.6),
        neck: lakeDir, cx: pv ? 0 : Math.cos(lakeDir) * 0.24, cy: pv ? 0 : Math.sin(lakeDir) * 0.14,
        radius: num(lt, 'radius') * (pv ? 2 : 0.85 + r.next() * 0.3),
        shape: radialTable({ points: (lt.points ?? []) as [number, number][] }), rot: pv ? 0 : wn() * Math.PI * 2,
        bank: bankWidth(num(lt, 'depth'), between(lt, 'bankSlope'), SCENE_W), depth: num(lt, 'depth'),
      } : null,
      ponds,
      deposit: qt ? {
        kind: String(param(qt, 'quarry')) as DepositKind, cx: Math.cos(depAngle) * depDist, cy: Math.sin(depAngle) * depDist, // random also in previews
        radius: (() => { const [a, b] = pair(param(qt, 'radius'), [0.08, 0.11]); return a + dr.next() * (b - a); })(),
      } : null,
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

/** Distance (square units) from (px, py) to a looping (peninsula) river's centre line. */
function riverDistance(river: NonNullable<Layout['river']>, px: number, py: number): number {
  // the river loops around the centre (a ~270° arc) and both ends run off to the map edge side
  // by side, leaving a land neck between them
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
 * Continuous terrain field at tile coords (x, y), combined from the location's templates
 * (traits, see templates.ts): high spot, climate, valley, perimeter, fields, bog + ponds, forests,
 * rocky patches, lake, river and quarry deposit – each by its kind, shaped by its params / outline.
 * Returns height h (~0..1), moisture, rockiness, field and bog masks, deposit and water
 * environments. Pure – the client samples it at any resolution for a smooth 3D surface.
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
  const ang = Math.atan2(py, px);
  const outer = smooth(r, 0.62, 0.95); // 0 inside, 1 at the outskirts
  const foot = L.foot;

  const noise = fbm(L.seed, nx * 4, ny * 3, 4);
  let plateau = 0, plateauH = 0;
  if (L.plateau) {
    const P = L.plateau, R = P.R * radialAt(P.shape, ang - P.rot);
    plateau = 1 - smooth(r, R, R + P.slope);
    plateauH = P.height * radialAt(P.heights, ang - P.rot);
  }
  // The top is calmer (less noise) so it stays flat and buildable.
  let h = 0.42 + plateau * plateauH + (noise - 0.5) * (0.3 - plateau * (L.plateau?.calm ?? 0));
  let moist = fbm(L.seed ^ 0x9e3779b9, nx * 3, ny * 3, 3) - plateau * 0.35 - (1 - smooth(r, foot, foot + 0.2)) * 0.12;
  // rock: only the plateau rim and 'rocky' patches get really rocky
  let rock = fbm(L.seed ^ 0x51ed270b, nx * 9, ny * 6, 2) * 0.8 + 4 * plateau * (1 - plateau) * (L.plateau?.rimRock ?? 0);
  if (L.rocky) rock += smooth(fbm(L.seed ^ 0x3c6ef372, nx * L.rocky.scale, ny * L.rocky.scale, 2), L.rocky.threshold, L.rocky.threshold + 0.12) * L.rocky.amount;
  let field = 0;
  let bog = 0;

  if (L.valley) {
    const across = Math.abs(-px * Math.sin(L.valley.angle) + py * Math.cos(L.valley.angle));
    h += smooth(across, L.valley.width, L.valley.width + 0.33) * L.valley.ridge; // ridges on both sides
    rock += smooth(across, 0.3, 0.5) * 0.08;
  }
  moist += L.climate.moist;
  h += L.climate.height;
  rock += L.climate.rock;

  // Outskirts
  if (L.perimeter) {
    moist += outer * L.perimeter.moist;
    if (L.perimeter.fields > 0) field = Math.max(field, outer * L.perimeter.fields);
  } else moist += outer * 0.15;

  // Forests: template outlines make the ground moist enough for woods
  for (const f of L.forests) {
    const ax = px - f.cx, ay = py - f.cy;
    const s = Math.hypot(ax, ay) - f.R * radialAt(f.shape, Math.atan2(ay, ax) - f.rot);
    moist += (1 - smooth(s, -f.edge, f.edge)) * f.amount;
  }

  // Crop fields in open, flat land between the centre and the outskirts
  if (L.fields) {
    field = Math.max(field, smooth(fbm(L.seed ^ 0x2c1b3c6d, nx * 2.5, ny * 2, 3), L.fields.threshold, L.fields.threshold + 0.06) * (1 - plateau) * smooth(r, foot, foot + 0.1));
  }
  // Bog: low, flat, soggy patches just above the water line
  if (L.bog !== null) {
    bog = smooth(fbm(L.seed ^ 0x7f4a7c15, nx * 3, ny * 3, 3), L.bog, L.bog + 0.07) * (1 - plateau);
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
      const ringR = lk.ringR * (1 + (radialAt(lk.shape, ang - lk.rot) - 1) * 0.5); // wobbly ring around the island
      const off = Math.abs(r - ringR);
      depth = 1 - smooth(off, lk.ringW, lk.ringW + lk.bank * 2);
      lakeEnv = 1 - smooth(off, lk.ringW + lk.bank * 2, lk.ringW + lk.bank * 2 + reach * 2);
      if (lk.kind === 'peninsula') {
        const neck = smooth(angleDiff(ang, lk.neck), 0.35, 0.6);
        depth *= neck; // land neck towards the shore
        depth = Math.max(depth, (1 - smooth(r, ringR, ringR + lk.ringW * 2.5)) * smooth(r, ringR - lk.ringW, ringR) * neck);
        lakeEnv *= neck;
      }
    }
    h += (W - lk.depth - h) * depth;
    rock -= depth;
    field *= 1 - depth;
    bog *= 1 - depth;
  }
  // Ponds (bog template): small template-shaped pools
  for (const pd of L.ponds) {
    const ax = px - pd.cx, ay = py - pd.cy;
    const s = Math.hypot(ax, ay) - pd.radius * radialAt(pd.shape, Math.atan2(ay, ax) - pd.rot);
    const depth = 1 - smooth(s, -pd.bank, 0);
    pondEnv = Math.max(pondEnv, 1 - smooth(s, 0, reach));
    h += (W - pd.depth - h) * depth;
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
    h -= valley * plateau * plateauH * (L.river.kind === 'peninsula' ? 0.3 : 0.85); // cuts through the plateau
    h += (W - L.river.depth - h) * channel; // runs below the water line
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
  const key = `${worldSeed}:${loc.id}:${loc.traits?.join(',')}:${loc.preview ? 'p' : ''}`;
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
  rot?: number; // radians (player-placed buildings)
}

/** Minimum distance (tiles) between building centres – until real building footprints / blockers exist. */
export const BUILDING_SPACING = 1.8;

/**
 * Why a building can't be placed at tile coords (x, y) of a location, or null if it can: inside the
 * play area, on buildable ground (grass / sand), not too close to existing buildings. Pure – the
 * client uses it for the placement preview, the engine re-checks it on the 'upgrade' command.
 */
export function placementProblem(worldSeed: number, loc: LocationDef, base: BaseState | undefined, x: number, y: number): string | null {
  const terrain = generateTerrain(worldSeed, loc);
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !insideArea(tx, ty, 1.5)) return 'outside the buildable area';
  if (!buildable(terrain.tiles[ty * terrain.width + tx])) return 'can only build on open ground';
  const seed = hash32(worldSeed, 'scene', loc.id), taken = new Set<number>();
  for (const b of [...(base?.buildings ?? [])].sort((a, c) => a.id.localeCompare(c.id))) {
    const [bx, by] = b.x !== undefined && b.y !== undefined ? [b.x, b.y] : placeNear(terrain, taken, [seed, 'b', b.id]).map((v) => v + 0.5);
    if (Math.hypot(bx - x, by - y) < BUILDING_SPACING) return 'too close to another building';
  }
  return null;
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
      // player-placed: exact spot (structure x/y = centre - 0.5, like tile-placed ones); else automatic
      const placed = b.x !== undefined && b.y !== undefined;
      const [x, y] = placed ? [b.x! - 0.5, b.y! - 0.5] : placeNear(terrain, taken, [seed, 'b', b.id]);
      if (placed) taken.add(Math.floor(b.y!) * terrain.width + Math.floor(b.x!));
      structures.push({
        id: b.id, kind: b.kind, label: BUILDINGS[b.kind].name, x, y, level: b.level,
        upgradingTo: b.upgrade?.toLevel, finishAt: b.upgrade?.finishAt, rot: b.rot,
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
