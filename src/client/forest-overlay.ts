// Forest embellishment: organic tree crowns in shades of green/yellow scattered inside the
// base map's forest polygons (OpenMapTiles landcover class=wood). Tree positions come from a
// world-anchored grid, so they stay put while panning. Every tree is the same precomputed
// outline (a smooth curve through 5 fixed points), just rotated and scaled per tree, and
// stacked in a few lighter tiers. Shades follow smooth noise -> patches, not confetti.
import { hash32 } from '../engine/index.ts';
import { valueNoise } from '../engine/noise.ts';

// ======================= KNOBS =======================
export const FOREST = {
  spacingMeters: 20, // grid spacing between tree candidates (smaller = denser, more work)
  jitter: 0.6, // 0 = perfect grid, 1 = fully random within a cell
  sizes: [10, 12, 15], // metres: tree radii (each tree picks one; shapes are precomputed per size)
  colors: ['#2d5e27', '#3b7230', '#4f8636', '#6b9a3c', '#93ad48', '#bdbd5a'], // dark → light/yellow
  patchMeters: 700, // size of same-shade patches
  colorRandomness: 0.2, // 0 = shade purely from patches, 1 = fully random per blob
  opacity: 1,
  shadowOffset: [3, -3], // metres east / north from the tree to its shadow (default: sun from the north-west)
  shadowScale: 1.05, // shadow size relative to the tree's outer crown
  shadowColor: '#0f1f0a',
  shadowOpacity: 0.35,
  showFromZoom: 15.5, // forest detail appears only when zoomed IN to at least this zoom (not computed when further out)
  fadeZooms: 1, // fade in over this many zoom levels above showFromZoom
  maxCandidates: 20_000, // work budget: if the view needs more grid checks than this, skip (zoom in / raise spacing)
  maxBlobs: 10_000, // safety cap per recompute (trees; each tree is 3 stacked shapes)
  recomputeDelayMs: 50, // debounce after panning / tile loads
};
// =====================================================

export const FOREST_BLOB_LAYER = 'forest-blobs';
const FOREST_SHADOW_LAYER = 'forest-shadows';
export const FOREST_LAYERS = [FOREST_SHADOW_LAYER, FOREST_BLOB_LAYER];
const SHADOW = -1; // `k` of shadow features (tree tiers are 0, 1, 2)
const SOURCE = 'forest-blobs';
const M_PER_DEG = 111_320;

// ---- precomputed once ----

/** The tree outline's 5 control points: [angle in degrees, radius 0..1]. Fixed "random" values. */
const SHAPE_POINTS: [number, number][] = [[0, 1], [79, 0.82], [138, 0.96], [221, 0.74], [287, 0.9]];
const CURVE_SEGMENTS = 2; // curve samples between two control points -> 10-point outline

/** Unit outline (max radius 1): closed Catmull-Rom spline through SHAPE_POINTS. */
const TEMPLATE: number[][] = (() => {
  const pts = SHAPE_POINTS.map(([deg, r]) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r]);
  const n = pts.length, out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let s = 0; s < CURVE_SEGMENTS; s++) {
      const t = s / CURVE_SEGMENTS, t2 = t * t, t3 = t2 * t;
      // uniform Catmull-Rom: passes through p1 (t=0) and p2 (t=1)
      const c = (k: 0 | 1) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([c(0), c(1)]);
    }
  }
  return out;
})();

/** Crown tiers: each tree is the outline stacked 3×, each copy 30% smaller and a bit lighter. */
const TIER_SCALES = [1, 0.7, 0.49];
const TIER_TINT = '#a7d651';
const TIER_TINT_STEP = 0.15;
const TIER_COLORS = FOREST.colors.map((base) => TIER_SCALES.map((_, k) => mixHex(base, TIER_TINT, k * TIER_TINT_STEP)));

/** Rotation variants per size (trees pick one instead of rotating at runtime). */
const ROTATIONS = 12;

/**
 * SHAPES_M[size][rotation] = rings of [dx, dy] metre offsets from the tree centre (closed):
 * index 0 is the shadow (outer crown, scaled + shifted), then one ring per crown tier.
 */
const SHAPES_M: number[][][][][] = FOREST.sizes.map((radius) =>
  Array.from({ length: ROTATIONS }, (_, r) => {
    const a = (r / ROTATIONS) * Math.PI * 2, cos = Math.cos(a) * radius, sin = Math.sin(a) * radius;
    const ring = (sc: number, ox = 0, oy = 0) => {
      const out = TEMPLATE.map(([ux, uy]) => [ox + (ux * cos - uy * sin) * sc, oy + (ux * sin + uy * cos) * sc]);
      out.push(out[0]); // GeoJSON rings are closed
      return out;
    };
    const [sx, sy] = FOREST.shadowOffset;
    return [ring(FOREST.shadowScale, sx, sy), ...TIER_SCALES.map((sc) => ring(sc))];
  }));

type Ring = number[][]; // [x, y] in metres

export class ForestOverlay {
  private readonly map: any;
  private readonly seed: number;
  private readonly mPerDegLng: number;
  private readonly shapes: number[][][][][]; // SHAPES_M converted to [dLng, dLat] offsets
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(map: any, seed: number, refLat: number) {
    this.map = map;
    this.seed = seed;
    this.mPerDegLng = M_PER_DEG * Math.cos((refLat * Math.PI) / 180);
    this.shapes = SHAPES_M.map((rots) => rots.map((tiers) => tiers.map((ring) =>
      ring.map(([dx, dy]) => [dx / this.mPerDegLng, dy / M_PER_DEG]))));
  }

  /** Call after the style (and height overlay) is loaded. */
  addLayers(beforeId?: string): void {
    const map = this.map;
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
    // invisible at showFromZoom, full opacity fadeZooms later
    const fade = (alpha: number) => ['interpolate', ['linear'], ['zoom'],
      FOREST.showFromZoom, 0, FOREST.showFromZoom + Math.max(0.01, FOREST.fadeZooms), alpha];
    // Shadows: their own layer under all trees, so a shadow never darkens a neighbouring crown.
    map.addLayer({
      id: FOREST_SHADOW_LAYER, type: 'fill', source: SOURCE, minzoom: FOREST.showFromZoom,
      filter: ['==', ['get', 'k'], SHADOW],
      paint: { 'fill-color': FOREST.shadowColor, 'fill-opacity': fade(FOREST.shadowOpacity), 'fill-antialias': false },
    }, before);
    map.addLayer({
      id: FOREST_BLOB_LAYER, type: 'fill', source: SOURCE, minzoom: FOREST.showFromZoom,
      filter: ['>=', ['get', 'k'], 0],
      layout: { 'fill-sort-key': ['get', 'k'] }, // all bottom tiers first, then middle, then top
      // antialias off: MapLibre's anti-aliased fill edge is an extra 1px outline that shows
      // as a visible line wherever semi-transparent shapes overlap.
      paint: { 'fill-color': ['get', 'c'], 'fill-opacity': fade(FOREST.opacity), 'fill-antialias': false },
    }, before);

    map.on('moveend', this.schedule);
    map.on('sourcedata', (e: any) => e.sourceId === 'openmaptiles' && e.isSourceLoaded && this.schedule());
    map.on('styledata', this.schedule); // e.g. toggled visible again
    this.schedule();
  }

  private readonly schedule = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.recompute, FOREST.recomputeDelayMs);
  };

  private readonly recompute = () => {
    const map = this.map;
    const source = map.getSource(SOURCE);
    const empty = { type: 'FeatureCollection', features: [] };
    if (!source || map.getLayoutProperty(FOREST_BLOB_LAYER, 'visibility') === 'none') return;
    if (map.getZoom() < FOREST.showFromZoom) return source.setData(empty); // too far out: no detail, no work

    // Viewport in metres (+ margin so blobs don't pop at the edges).
    const b = map.getBounds();
    const margin = Math.max(...FOREST.sizes) * 2;
    const view = {
      x0: b.getWest() * this.mPerDegLng - margin, x1: b.getEast() * this.mPerDegLng + margin,
      y0: b.getSouth() * M_PER_DEG - margin, y1: b.getNorth() * M_PER_DEG + margin,
    };
    // Work budget: grid points in view. Better to show nothing than to stall or half-fill.
    const candidates = ((view.x1 - view.x0) * (view.y1 - view.y0)) / FOREST.spacingMeters ** 2;
    if (candidates > FOREST.maxCandidates) {
      console.info(`forest blobs skipped: ${Math.round(candidates)} grid points > maxCandidates (zoom in or raise spacingMeters)`);
      return source.setData(empty);
    }

    const forests = map.querySourceFeatures('openmaptiles', { sourceLayer: 'landcover', filter: ['==', ['get', 'class'], 'wood'] });
    const s = FOREST.spacingMeters;
    const done = new Set<string>(); // tiles overlap at their borders -> same grid point twice
    const features: object[] = [];
    let trees = 0;

    for (const f of forests) {
      const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) {
        const rings: Ring[] = poly.map((ring) => ring.map(([lng, lat]) => [lng * this.mPerDegLng, lat * M_PER_DEG]));
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of rings[0]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        // Only the part of the polygon that's on screen.
        x0 = Math.max(x0, view.x0); x1 = Math.min(x1, view.x1);
        y0 = Math.max(y0, view.y0); y1 = Math.min(y1, view.y1);
        if (x0 > x1 || y0 > y1) continue;

        for (let gy = Math.floor(y0 / s); gy <= Math.floor(y1 / s); gy++) {
          for (let gx = Math.floor(x0 / s); gx <= Math.floor(x1 / s); gx++) {
            const key = `${gx},${gy}`;
            if (done.has(key)) continue;
            const h = hash32(this.seed, 'forest', gx, gy);
            const jx = ((h & 0xffff) / 0xffff - 0.5) * FOREST.jitter, jy = ((h >>> 16) / 0xffff - 0.5) * FOREST.jitter;
            const x = (gx + 0.5 + jx) * s, y = (gy + 0.5 + jy) * s;
            if (!insideRings(x, y, rings)) continue;
            done.add(key);

            // Per tree: pick a precomputed shape (size + rotation) and a colour, then just shift it.
            const h2 = hash32(this.seed, 'forest-r', gx, gy);
            const rnd = (h2 & 0xffff) / 0x10000; // colour randomness
            const shape = this.shapes[((h2 >>> 16) & 0xf) % FOREST.sizes.length][(h2 >>> 20) % ROTATIONS]; // separate hash bits
            const patch = valueNoise(this.seed, x / FOREST.patchMeters, y / FOREST.patchMeters);
            const t = Math.min(0.999, Math.max(0, patch * (1 - FOREST.colorRandomness) + rnd * FOREST.colorRandomness));
            const colors = TIER_COLORS[Math.floor(t * FOREST.colors.length)];
            const lng = x / this.mPerDegLng, lat = y / M_PER_DEG;
            // shape[0] = shadow (k = -1), shape[1..] = crown tiers (k = 0, 1, 2)
            for (let i = 0; i < shape.length; i++) {
              const k = i === 0 ? SHADOW : i - 1;
              const ring = shape[i].map(([dLng, dLat]) => [lng + dLng, lat + dLat]);
              features.push({ type: 'Feature', properties: { c: k === SHADOW ? '' : colors[k], k }, geometry: { type: 'Polygon', coordinates: [ring] } });
            }
            if (++trees >= FOREST.maxBlobs) return source.setData({ type: 'FeatureCollection', features });
          }
        }
      }
    }
    source.setData({ type: 'FeatureCollection', features });
  };
}

/** Blend two #rrggbb colours: t = 0 -> a, t = 1 -> b. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/** Even-odd point-in-polygon over all rings (holes included). */
function insideRings(x: number, y: number, rings: Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
