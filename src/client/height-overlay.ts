// Height overlay built from free AWS Terrain Tiles (Terrarium-encoded DEM, no API key):
//   - colour relief (hypsometric tint) and hillshade, rendered natively by MapLibre
//   - contour lines + elevation labels, generated in the browser by maplibre-contour
// Layer ids are exported so the layer toggle control can group them.

declare const maplibregl: any;
declare const mlcontour: any; // loaded from the CDN <script> in index.html

const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_ATTRIBUTION = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain: Mapzen / AWS</a>';

export const HEIGHT_LAYERS = {
  tint: ['height-tint'],
  hillshade: ['height-hillshade'],
  contours: ['contour-lines', 'contour-labels'],
};

/** Colour ramps as (t in 0..1, colour); stretched over [tintMin, tintMax] at apply time. */
export const PALETTES = {
  atlas: [[0, '#1a6b3c'], [0.15, '#4f9a45'], [0.3, '#8fbf55'], [0.45, '#d4d77a'], [0.6, '#e8c96a'], [0.75, '#d9a050'], [0.9, '#9a5c35'], [1, '#f2efe9']],
  parchment: [[0, '#5b7f4a'], [0.3, '#a9b77a'], [0.55, '#e2d3a0'], [0.8, '#b88a55'], [1, '#6e4a2a']],
  spectral: [[0, '#2b83ba'], [0.25, '#abdda4'], [0.5, '#ffffbf'], [0.75, '#fdae61'], [1, '#d7191c']],
  grayscale: [[0, '#1a1a1a'], [1, '#ffffff']],
} satisfies Record<string, [number, string][]>;
export type PaletteName = keyof typeof PALETTES;

export const SHADE_METHODS = ['standard', 'basic', 'combined', 'igor', 'multidirectional'] as const;

export interface TerrainSettings {
  sunDirection: number; // degrees, 0 = north, clockwise
  sunAltitude: number; // degrees above horizon
  shadeStrength: number; // 0..1 (hillshade-exaggeration)
  shadeMethod: (typeof SHADE_METHODS)[number];
  palette: PaletteName;
  tintMin: number; // metres mapped to the palette's first colour
  tintMax: number; // metres mapped to the palette's last colour
  tintOpacity: number;
  autoFit: boolean; // re-fit tintMin/tintMax to the viewport after every move
  forestOpacity: number; // 0..1
  forestHue: number; // 0..360
  forestLightness: number; // %, lower = darker
}

export const DEFAULT_TERRAIN: TerrainSettings = {
  sunDirection: 315, sunAltitude: 35, shadeStrength: 0.55, shadeMethod: 'standard',
  palette: 'atlas', tintMin: 150, tintMax: 600, tintOpacity: 0.45, autoFit: true,
  forestOpacity: 0.5, forestHue: 110, forestLightness: 45,
};

/** Forest polygons of the base style (OpenMapTiles landcover class=wood). */
export const FOREST_LAYER = 'landcover_wood';

export function tintColor(s: Pick<TerrainSettings, 'palette' | 'tintMin' | 'tintMax'>): unknown[] {
  const max = Math.max(s.tintMax, s.tintMin + 1); // interpolate stops must strictly increase
  const stops = (PALETTES[s.palette] ?? PALETTES.atlas).flatMap(([t, c]) => [s.tintMin + t * (max - s.tintMin), c]);
  return ['interpolate', ['linear'], ['elevation'], ...stops];
}

export function applyTerrainSettings(map: any, s: TerrainSettings): void {
  if (map.getLayer('height-tint')) {
    map.setPaintProperty('height-tint', 'color-relief-color', tintColor(s));
    map.setPaintProperty('height-tint', 'color-relief-opacity', s.tintOpacity);
  }
  if (map.getLayer('height-hillshade')) {
    map.setPaintProperty('height-hillshade', 'hillshade-method', s.shadeMethod);
    map.setPaintProperty('height-hillshade', 'hillshade-illumination-direction', s.sunDirection);
    map.setPaintProperty('height-hillshade', 'hillshade-illumination-altitude', s.sunAltitude);
    map.setPaintProperty('height-hillshade', 'hillshade-exaggeration', s.shadeStrength);
  }
  if (map.getLayer(FOREST_LAYER)) {
    map.setPaintProperty(FOREST_LAYER, 'fill-color', `hsl(${s.forestHue}, 50%, ${s.forestLightness}%)`);
    map.setPaintProperty(FOREST_LAYER, 'fill-opacity', s.forestOpacity);
  }
}

/**
 * Elevation range (2nd–98th percentile, metres) of the current viewport, sampled from the
 * same DEM tiles at a lower zoom. Usually 2–12 small tiles, mostly straight from the HTTP cache.
 */
export async function sampleElevationRange(map: any): Promise<[number, number] | undefined> {
  const b = map.getBounds();
  const z = Math.max(0, Math.min(12, Math.floor(map.getZoom()) - 1));
  const world = 256 * 2 ** z;
  const px = (lng: number) => ((lng + 180) / 360) * world;
  const py = (lat: number) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  };
  const x0 = px(b.getWest()), x1 = px(b.getEast()), y0 = py(b.getNorth()), y1 = py(b.getSouth());
  const tiles: [number, number][] = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) tiles.push([tx, ty]);
  }
  if (tiles.length > 16) return undefined;

  const values: number[] = [];
  const n = 2 ** z;
  await Promise.all(tiles.map(async ([tx, ty]) => {
    const url = DEM_TILES.replace('{z}', String(z)).replace('{x}', String(((tx % n) + n) % n)).replace('{y}', String(ty));
    const res = await fetch(url);
    if (!res.ok) return;
    const canvas = new OffscreenCanvas(256, 256);
    const g = canvas.getContext('2d')!;
    g.drawImage(await createImageBitmap(await res.blob()), 0, 0);
    const d = g.getImageData(0, 0, 256, 256).data;
    for (let y = 0; y < 256; y += 4) {
      for (let x = 0; x < 256; x += 4) {
        const gx = tx * 256 + x, gy = ty * 256 + y;
        if (gx < x0 || gx > x1 || gy < y0 || gy > y1) continue;
        const i = (y * 256 + x) * 4;
        values.push(d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768); // Terrarium decoding
      }
    }
  }));
  if (values.length < 10) return undefined;
  values.sort((a, b) => a - b);
  const lo = Math.floor(values[Math.floor(values.length * 0.02)] / 5) * 5;
  const hi = Math.ceil(values[Math.floor(values.length * 0.98)] / 5) * 5;
  return [lo, Math.max(hi, lo + 20)];
}

const demSource = (): object => ({
  type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: DEM_ATTRIBUTION,
});

/**
 * @param belowTerrain id of the first base layer the tint/hillshade must sit under (roads, water lines...)
 * @param belowLabels  id of the first label layer, so contour lines stay under place names
 */
export function addHeightOverlay(map: any, belowTerrain?: string, belowLabels?: string): void {
  // Separate sources: MapLibre prepares DEM data differently per consumer. Same URLs, so tiles hit the HTTP cache.
  map.addSource('dem-tint', demSource());
  map.addSource('dem-hillshade', demSource());

  // Atmosphere at the horizon: gives depth when the map is pitched.
  map.setSky({
    'sky-color': '#9cc3e6', 'horizon-color': '#e8eef0', 'fog-color': '#f2efe6',
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0,
  });

  map.addLayer({
    id: 'height-tint', type: 'color-relief', source: 'dem-tint',
    paint: { 'color-relief-opacity': DEFAULT_TERRAIN.tintOpacity, 'color-relief-color': tintColor(DEFAULT_TERRAIN) },
  }, belowTerrain);

  map.addLayer({
    id: 'height-hillshade', type: 'hillshade', source: 'dem-hillshade',
    paint: { 'hillshade-shadow-color': '#473b24', 'hillshade-highlight-color': '#ffffff', 'hillshade-illumination-anchor': 'map' },
  }, belowTerrain);
  // Forests above the height tint (so it doesn't wash them out) but below the hillshade (so they get relief).
  if (map.getLayer(FOREST_LAYER)) map.moveLayer(FOREST_LAYER, 'height-hillshade');
  applyTerrainSettings(map, DEFAULT_TERRAIN);

  const contours = new mlcontour.DemSource({ url: DEM_TILES, encoding: 'terrarium', maxzoom: 13, worker: true });
  contours.setupMaplibre(maplibregl);
  map.addSource('contours', {
    type: 'vector',
    maxzoom: 15,
    tiles: [
      contours.contourProtocolUrl({
        // zoom -> [minor, major] interval in metres; `level` = 1 on major lines
        thresholds: { 11: [50, 250], 12: [25, 100], 13: [10, 50], 14: [5, 25], 15: [5, 25] },
        contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level',
      }),
    ],
  });

  map.addLayer({
    id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours',
    paint: {
      'line-color': 'rgba(110, 70, 30, 0.55)',
      'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5],
    },
  }, belowLabels);

  map.addLayer({
    id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'],
      'text-size': 10,
      'text-font': ['Noto Sans Regular'],
    },
    paint: { 'text-color': '#6e461e', 'text-halo-color': 'rgba(255,255,255,0.8)', 'text-halo-width': 1 },
  }, belowLabels);
}
