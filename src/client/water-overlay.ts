// Water embellishment: a few bands in shades of blue that follow the shoreline of lakes
// and ponds (old-map "water lines"). Pure MapLibre line layers on the base map's water
// polygons, offset inwards; rivers are left alone.

// ======================= KNOBS =======================
export const WATER = {
  // Each stripe: distance from the shore (metres), line width (px), colour, opacity.
  stripes: [
    { offsetM: 6, widthPx: 4, color: '#5d93c9', opacity: 0.85 },
    { offsetM: 16, widthPx: 3, color: '#78a9da', opacity: 0.65 },
    { offsetM: 30, widthPx: 1, color: '#97bfe6', opacity: 0.5 },
    { offsetM: 48, widthPx: 1, color: '#b6d3f0', opacity: 0.35 },
  ],
  maxOffsetPx: 24, // cap for the outermost stripe when zoomed in (all stripes scale down together)
  excludeClasses: ['river'], // water polygon classes left un-striped
  showFromZoom: 15, // stripes appear only when zoomed IN to at least this zoom (further out they'd cross / be tiny)
  fadeZooms: 1, // fade in over this many zoom levels above showFromZoom
};
// =====================================================

export const WATER_STRIPE_LAYERS = WATER.stripes.map((_, i) => `water-stripe-${i}`);

/** Base-style river layers (lines) plus our copy of the water fill limited to river polygons. */
const RIVER_LINE_LAYERS = ['waterway_tunnel', 'waterway_river', 'waterway_other'];
const RIVER_FILL_LAYER = 'water-river-top';

/** Id of the layer drawn right after `id` (undefined = it's the last one). */
export function layerAfter(map: any, id: string): string | undefined {
  const layers = map.getStyle().layers as { id: string }[];
  const i = layers.findIndex((l) => l.id === id);
  return i >= 0 ? layers[i + 1]?.id : undefined;
}

/**
 * Put rivers back on top of everything drawn between the water fill and `aboveLayer`
 * (e.g. forest trees): moves the river line layers and adds a river-only water fill.
 */
export function raiseRiversAbove(map: any, aboveLayer: string): void {
  const before = layerAfter(map, aboveLayer);
  if (map.getLayer('water') && !map.getLayer(RIVER_FILL_LAYER)) {
    map.addLayer({
      id: RIVER_FILL_LAYER, type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
      filter: ['==', ['get', 'class'], 'river'],
      paint: { 'fill-color': map.getPaintProperty('water', 'fill-color') ?? '#a0c8f0' },
    }, before);
  }
  for (const id of RIVER_LINE_LAYERS) if (map.getLayer(id)) map.moveLayer(id, before);
}

/** Add the stripe layers right above the base style's water fill. */
export function addWaterStripes(map: any, refLat: number, waterLayer = 'water'): void {
  const pxPerMeterAtZ0 = 512 / (40_075_016.686 * Math.cos((refLat * Math.PI) / 180));
  const outermost = Math.max(...WATER.stripes.map((s) => s.offsetM));
  // Layer drawn right after the water fill (so stripes sit on the water, under everything else).
  const beforeId = layerAfter(map, waterLayer);

  WATER.stripes.forEach((s, i) => {
    // metres -> px per zoom, scaled down together once the outermost stripe hits the cap
    const stops: number[] = [];
    for (let z = Math.floor(WATER.showFromZoom); z <= 22; z++) {
      const ppm = pxPerMeterAtZ0 * 2 ** z;
      stops.push(z, s.offsetM * ppm * Math.min(1, WATER.maxOffsetPx / (outermost * ppm)));
    }
    map.addLayer({
      id: WATER_STRIPE_LAYERS[i], type: 'line', source: 'openmaptiles', 'source-layer': 'water', minzoom: WATER.showFromZoom,
      filter: ['!', ['in', ['get', 'class'], ['literal', WATER.excludeClasses]]],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': s.color,
        // invisible at showFromZoom, full opacity fadeZooms later
        'line-opacity': ['interpolate', ['linear'], ['zoom'],
          WATER.showFromZoom, 0, WATER.showFromZoom + Math.max(0.01, WATER.fadeZooms), s.opacity],
        'line-width': s.widthPx,
        'line-offset': ['interpolate', ['linear'], ['zoom'], ...stops], // positive = into the polygon
      },
    }, beforeId);
  });
}
