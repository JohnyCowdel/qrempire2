// Shape helpers for the terrain templates (templates.ts): closed outlines as radius-by-angle tables,
// river centre lines as polylines, bank widths from bank slopes. WATER: shared water settings.

/** Closed outline around (0, 0), roughly unit radius; must be star-shaped (every direction hits it once). */
export interface WaterShape { points: [number, number][] }
/** River centre line: [u along −1..1, v sideways offset, w width multiplier] per point. */
export interface RiverShape { points: [number, number, number][] }

export const WATER = {
  heightScale: 8, // world units per height unit (the 3D view's VIEW.heightScale) – turns bank slopes into widths
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

/**
 * Closed Catmull-Rom spline through the points IN THEIR ORDER (point i -> i+1 -> … -> 0), as a dense
 * polygon of [x, y, value] (value = point index `idx`, default `fallback`). This is the curve the
 * editor draws; the terrain follows it via the radius-by-angle tables below.
 */
export function splineLoop(points: number[][], idx = 2, fallback = 1, steps = 12): [number, number, number][] {
  const n = points.length, out: [number, number, number][] = [];
  if (n < 3) return out;
  const v = (p: number[]) => p[idx] ?? fallback;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t), cr(v(p0), v(p1), v(p2), v(p3), t)]);
    }
  }
  return out;
}

/** Ray from the origin at angle a against a closed polygon: farthest hit (radius + value there), or null. */
function rayHit(loop: [number, number, number][], a: number): { r: number; v: number } | null {
  const dx = Math.cos(a), dy = Math.sin(a);
  let best: { r: number; v: number } | null = null;
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay, av] = loop[i], [bx, by, bv] = loop[(i + 1) % loop.length];
    const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den; // ray param, segment param
    if (t > 0 && u >= 0 && u <= 1 && (!best || t > best.r)) best = { r: t, v: av + (bv - av) * u };
  }
  return best;
}

/** Unnormalised radius-by-angle table of a closed outline (its spline, see splineLoop). */
function rawRadial(points: number[][]): Float32Array {
  const loop = splineLoop(points), out = new Float32Array(RADIAL_SAMPLES);
  if (!loop.length) return out.fill(1);
  for (let k = 0; k < RADIAL_SAMPLES; k++) out[k] = Math.max(0.05, rayHit(loop, -Math.PI + (k / RADIAL_SAMPLES) * Math.PI * 2)?.r ?? 0.05);
  return out;
}
/** Mean radius of an outline's spline (the unit radialTable normalises by). */
export function outlineMean(points: number[][]): number {
  const t = rawRadial(points);
  return t.reduce((s, v) => s + v, 0) / RADIAL_SAMPLES;
}
/**
 * A closed outline as a radius-by-angle table, following its spline in point order. Absolute: the
 * points' own coordinates (no normalising), so moving one point never changes the rest of the shape.
 */
export function radialTable(shape: WaterShape): Float32Array {
  return rawRadial(shape.points);
}
/** Radius of a radial table at angle a (radians). */
export function radialAt(table: Float32Array, a: number): number {
  const f = ((a + Math.PI) / (Math.PI * 2)) * RADIAL_SAMPLES;
  const i = Math.floor(f), t = f - i;
  const v0 = table[((i % RADIAL_SAMPLES) + RADIAL_SAMPLES) % RADIAL_SAMPLES], v1 = table[(((i + 1) % RADIAL_SAMPLES) + RADIAL_SAMPLES) % RADIAL_SAMPLES];
  return v0 + (v1 - v0) * t;
}

/** Any per-point value (index `idx` of each point, default `fallback`) by angle, interpolated along the spline. */
export function radialValueTable(points: number[][], idx: number, fallback: number): Float32Array {
  const loop = splineLoop(points, idx, fallback), out = new Float32Array(RADIAL_SAMPLES);
  if (!loop.length) return out.fill(fallback);
  for (let k = 0; k < RADIAL_SAMPLES; k++) out[k] = rayHit(loop, -Math.PI + (k / RADIAL_SAMPLES) * Math.PI * 2)?.v ?? fallback;
  return out;
}

/** A river centre line as a dense polyline: [x, y, widthMultiplier] in template units. */
export function riverPolyline(shape: RiverShape): [number, number, number][] {
  const p = shape.points; // in their order (no sorting: points never swap)
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
  // extend both ends well beyond the map edge, along the end segments
  const ext = (end: number[], prev: number[]) => {
    const dx = end[0] - prev[0], dy = end[1] - prev[1], l = Math.hypot(dx, dy) || 1;
    return [end[0] + (dx / l) * 1.5, end[1] + (dy / l) * 1.5, end[2]] as [number, number, number];
  };
  out.unshift(ext(p[0], p[1]));
  out.push(ext(p[p.length - 1], p[p.length - 2]));
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
