// Water shapes for the procedural location terrain: lake / pond outlines and river centre lines
// as editable templates (the asset editor's Water tab), plus depth and bank slope per water type.
// Each location picks one template per water body (by its seed) and scales / rotates it.
// The server uses these defaults; the client can override them (setWater) before generating
// terrain – shapes only change how the ground looks, not the game rules.

/** Closed outline around (0, 0), roughly unit radius; must be star-shaped (every direction hits it once). */
export interface WaterShape { points: [number, number][] }
/** River centre line: [u along −1..1, v sideways offset, w width multiplier] per point. */
export interface RiverShape { points: [number, number, number][] }

export const WATER = {
  heightScale: 8, // world units per height unit (the 3D view's VIEW.heightScale) – turns bank slopes into widths
  lake: {
    depth: 0.08, // how far the bed lies below the water line (height units)
    bankSlope: [0.3, 0.7] as [number, number], // min / max steepness of the banks (height per tile); each lake picks one (cliffs start at ~0.8)
    templates: [
      { points: [[1, 0], [0.7, 0.6], [0, 0.85], [-0.6, 0.7], [-1.05, 0.05], [-0.7, -0.65], [0.05, -0.9], [0.75, -0.55]] },
      { points: [[1, 0.1], [0.6, 0.55], [0.05, 0.4], [-0.5, 0.7], [-1, 0.1], [-0.8, -0.5], [-0.1, -0.8], [0.7, -0.6]] },
      { points: [[1.2, 0], [0.8, 0.45], [0, 0.55], [-0.8, 0.5], [-1.2, 0], [-0.8, -0.45], [0, -0.6], [0.8, -0.4]] },
    ] as WaterShape[],
  },
  pond: {
    depth: 0.05,
    bankSlope: [0.35, 0.8] as [number, number],
    count: [1, 3] as [number, number], // ponds per bog location
    size: [0.035, 0.065] as [number, number], // radius (1 = map width)
    templates: [
      { points: [[1, 0], [0.6, 0.75], [-0.3, 0.9], [-0.95, 0.3], [-0.85, -0.5], [-0.1, -0.95], [0.7, -0.65]] },
      { points: [[1, 0.2], [0.35, 0.55], [-0.2, 1], [-0.8, 0.45], [-0.6, -0.2], [-0.9, -0.8], [0.1, -0.7], [0.75, -0.6]] },
    ] as WaterShape[],
  },
  river: {
    depth: 0.06,
    bankSlope: [0.3, 0.7] as [number, number],
    width: [0.02, 0.032] as [number, number], // channel width (1 = map width)
    templates: [
      { points: [[-1, 0, 1], [-0.5, 0.3, 1], [0, 0, 1.1], [0.5, -0.3, 1], [1, 0, 1]] },
      { points: [[-1, 0.2, 1], [-0.6, -0.4, 0.9], [-0.2, 0.4, 1.2], [0.2, -0.3, 1], [0.6, 0.35, 0.9], [1, -0.1, 1]] },
      { points: [[-1, 0, 0.7], [-0.3, 0.15, 1], [0.3, -0.1, 1.4], [1, 0, 1.6]] },
    ] as RiverShape[],
  },
  /** Editor preview only: force one water body of this kind / template into the centre. */
  preview: null as null | { kind: 'lake' | 'pond' | 'river'; index: number },
};
export type WaterKind = 'lake' | 'pond' | 'river';

const listeners: (() => void)[] = [];
/** Called when the water config changes (terrain caches subscribe). */
export function onWaterChange(fn: () => void): void { listeners.push(fn); }

/** Replace the water config (deep, keys the engine knows only) and drop cached terrain. */
export function setWater(values: unknown): void {
  const assign = (target: any, source: any) => {
    for (const [k, v] of Object.entries(source ?? {})) {
      if (!(k in target)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) assign(target[k], v);
      else target[k] = JSON.parse(JSON.stringify(v));
    }
  };
  assign(WATER, values);
  listeners.forEach((fn) => fn());
}

/** Catmull-Rom point between p1 and p2. */
const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

const RADIAL_SAMPLES = 128;
/** A closed outline as a smooth radius-by-angle table (mean radius 1). */
export function radialTable(shape: WaterShape): Float32Array {
  const pts = shape.points.map(([x, y]) => ({ a: Math.atan2(y, x), r: Math.hypot(x, y) })).sort((p, q) => p.a - q.a);
  const n = pts.length, out = new Float32Array(RADIAL_SAMPLES);
  if (n < 3) return out.fill(1);
  for (let k = 0; k < RADIAL_SAMPLES; k++) {
    const a = -Math.PI + (k / RADIAL_SAMPLES) * Math.PI * 2;
    let i = pts.findIndex((p) => p.a > a) - 1; // segment pts[i] -> pts[i+1] (wrapping)
    if (i < 0) i = n - 1;
    const p1 = pts[i], p2 = pts[(i + 1) % n], p0 = pts[(i - 1 + n) % n], p3 = pts[(i + 2) % n];
    let span = p2.a - p1.a; if (span <= 0) span += Math.PI * 2;
    let da = a - p1.a; if (da < 0) da += Math.PI * 2;
    out[k] = Math.max(0.05, cr(p0.r, p1.r, p2.r, p3.r, Math.min(1, da / span)));
  }
  const mean = out.reduce((s, v) => s + v, 0) / RADIAL_SAMPLES;
  return out.map((v) => v / mean);
}
/** Radius of a radial table at angle a (radians). */
export function radialAt(table: Float32Array, a: number): number {
  const f = ((a + Math.PI) / (Math.PI * 2)) * RADIAL_SAMPLES;
  const i = Math.floor(f), t = f - i;
  const v0 = table[((i % RADIAL_SAMPLES) + RADIAL_SAMPLES) % RADIAL_SAMPLES], v1 = table[(((i + 1) % RADIAL_SAMPLES) + RADIAL_SAMPLES) % RADIAL_SAMPLES];
  return v0 + (v1 - v0) * t;
}

/** A river centre line as a dense polyline: [x, y, widthMultiplier] in template units. */
export function riverPolyline(shape: RiverShape): [number, number, number][] {
  const p = [...shape.points].sort((a, b) => a[0] - b[0]);
  if (p.length < 2) return [[-1, 0, 1], [1, 0, 1]];
  const out: [number, number, number][] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    for (let k = 0; k < 12; k++) {
      const t = k / 12;
      out.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t), cr(p0[2], p1[2], p2[2], p3[2], t)]);
    }
  }
  out.push([...p[p.length - 1]]);
  // extend both ends well beyond the map edge
  const a = out[0], b = out[out.length - 1];
  out.unshift([a[0] - 1, a[1], a[2]]);
  out.push([b[0] + 1, b[1], b[2]]);
  return out;
}

/** Distance from (x, y) to a polyline, and the interpolated width multiplier there. */
export function polylineDistance(line: [number, number, number][], x: number, y: number): { d: number; w: number } {
  let best = Infinity, w = 1;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay, aw] = line[i], [bx, by, bw] = line[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    if (d < best) { best = d; w = aw + (bw - aw) * t; }
  }
  return { d: best, w };
}

/** Bank width (map-width units) for a bank of the given steepness: how far the ground takes to drop to the bed. */
export const bankWidth = (depth: number, slope: number, mapWidth: number) => ((0.1 + depth) * WATER.heightScale) / Math.max(0.05, slope) / mapWidth;
