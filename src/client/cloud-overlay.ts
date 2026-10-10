// Simple 2D clouds, drawn by MapLibre itself so they're glued to the map:
//   - every puff is a GeoJSON point rendered as a blurred circle with a radius in metres
//     (MapLibre scales it with zoom and keeps it in place while panning, no lag)
//   - the wind just moves the points (local clock; clouds are decoration, not game state)
// On/off: the cloud button in the map controls (remembered per browser).
// Tune everything in CLOUDS below.
import { hash32, rngFor } from '../engine/index.ts';
import { loadJson, saveJson } from './ui.ts';

// ======================= KNOBS =======================
export const CLOUDS = {
  cellMeters: 1000, // grid spacing; each cell may hold one cloud
  coverage: 0.35, // 0..1 chance that a cell has a cloud
  minRadius: 250, // metres, size of a single puff
  maxRadius: 700,
  puffsMin: 5, // puffs per cloud
  puffsMax: 15,
  spread: 2, // how far puffs scatter from the cloud centre (× radius)
  blur: 0.9, // 0 = hard disc edge, 1 = fully soft

  windSpeed: 200, // m/s
  windDirection: 70, // degrees the wind blows TOWARDS, clockwise from north

  color: '#ffffff',
  opacity: 0.35,
  shadowColor: '#141e2d',
  shadowOpacity: 0.1,
  shadowOffset: [220, -160], // metres east / north from cloud to its shadow

  minZoom: 9, // hidden when zoomed out further than this
  maxZoom: 15, // hidden when zoomed in closer than this
  fadeZooms: 0.8, // fade in/out over this many zoom levels inside [minZoom, maxZoom]
  tickMs: 20, // how often the wind moves the clouds
};
// =====================================================

const SOURCE = 'clouds';
export const CLOUD_LAYERS = ['cloud-shadows', 'clouds'];

const M_PER_DEG = 111_320;

const STORAGE_KEY = 'qre.clouds';
const CLOUD_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
  '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18Z"/></svg>';

export class CloudOverlay {
  private readonly map: any;
  private readonly seed: number;
  private readonly refLat: number; // flat-earth reference latitude for metre <-> degree conversion
  private readonly mPerDegLng: number;
  private visible: boolean;

  constructor(map: any, seed: number, refLat: number) {
    this.map = map;
    this.seed = seed;
    this.refLat = refLat;
    this.mPerDegLng = M_PER_DEG * Math.cos((refLat * Math.PI) / 180);
    this.visible = loadJson<{ visible: boolean }>(STORAGE_KEY).visible ?? true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    saveJson(STORAGE_KEY, { visible });
    for (const id of CLOUD_LAYERS) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    if (visible) this.tick();
  }

  /** A map control button that switches the clouds on/off. */
  control(): { onAdd(map: any): HTMLElement; onRemove(): void } {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group qre-ctrl';
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = CLOUD_ICON;
    const sync = () => {
      button.title = this.visible ? 'Hide clouds' : 'Show clouds';
      button.style.opacity = this.visible ? '1' : '0.35';
    };
    button.onclick = () => {
      this.setVisible(!this.visible);
      sync();
    };
    sync();
    container.append(button);
    return { onAdd: () => container, onRemove: () => container.remove() };
  }

  /** Call once the style has loaded; layers go on top of whatever exists at that moment. */
  addLayers(): void {
    const map = this.map;
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Circle radius is in pixels; radius_px = metres / metresPerPixel = metres * 2^zoom * 512 / (C * cos(lat)).
    // An exponential(2) interpolation between two zooms reproduces that 2^zoom curve exactly.
    const pxPerMeterAtZ0 = 512 / (40_075_016.686 * Math.cos((this.refLat * Math.PI) / 180));
    const radius = ['interpolate', ['exponential', 2], ['zoom'],
      0, ['*', ['get', 'r'], pxPerMeterAtZ0],
      22, ['*', ['get', 'r'], pxPerMeterAtZ0 * 2 ** 22]];
    const f = CLOUDS.fadeZooms;
    const fade = (alpha: number) => ['interpolate', ['linear'], ['zoom'],
      CLOUDS.minZoom, 0, CLOUDS.minZoom + f, alpha, CLOUDS.maxZoom - f, alpha, CLOUDS.maxZoom, 0];
    const layer = (id: string, kind: string, color: string, alpha: number) => map.addLayer({
      id, type: 'circle', source: SOURCE, filter: ['==', ['get', 'kind'], kind],
      minzoom: CLOUDS.minZoom, maxzoom: CLOUDS.maxZoom,
      paint: {
        'circle-radius': radius, 'circle-color': color, 'circle-opacity': fade(alpha), 'circle-blur': CLOUDS.blur,
        'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map',
      },
    });
    layer('cloud-shadows', 'shadow', CLOUDS.shadowColor, CLOUDS.shadowOpacity);
    layer('clouds', 'cloud', CLOUDS.color, CLOUDS.opacity);

    this.setVisible(this.visible);
    this.tick();
    setInterval(this.tick, CLOUDS.tickMs);
  }

  private readonly tick = () => {
    const map = this.map;
    const zoom = map.getZoom();
    const source = map.getSource(SOURCE);
    if (!this.visible || !source || zoom < CLOUDS.minZoom || zoom > CLOUDS.maxZoom) return;

    // Everything in flat metres around refLat (x east, y north), clouds shifted by the wind.
    const rad = (CLOUDS.windDirection * Math.PI) / 180;
    const drift = (Date.now() / 1000) * CLOUDS.windSpeed;
    const windX = Math.sin(rad) * drift, windY = Math.cos(rad) * drift;
    const b = map.getBounds();
    const margin = CLOUDS.maxRadius * (1 + CLOUDS.spread) + Math.hypot(...CLOUDS.shadowOffset);
    const cell = CLOUDS.cellMeters;
    const gx0 = Math.floor((b.getWest() * this.mPerDegLng - margin - windX) / cell);
    const gx1 = Math.floor((b.getEast() * this.mPerDegLng + margin - windX) / cell);
    const gy0 = Math.floor((b.getSouth() * M_PER_DEG - margin - windY) / cell);
    const gy1 = Math.floor((b.getNorth() * M_PER_DEG + margin - windY) / cell);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 5000) return;

    const features: object[] = [];
    const point = (x: number, y: number, r: number, kind: string) => features.push({
      type: 'Feature', properties: { r, kind },
      geometry: { type: 'Point', coordinates: [x / this.mPerDegLng, y / M_PER_DEG] },
    });
    const [sx, sy] = CLOUDS.shadowOffset;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (hash32(this.seed, 'cloud', gx, gy) / 4294967296 >= CLOUDS.coverage) continue;
        const r = rngFor(this.seed, 'cloudshape', gx, gy);
        const cx = (gx + 0.2 + r.next() * 0.6) * cell + windX, cy = (gy + 0.2 + r.next() * 0.6) * cell + windY;
        for (let i = 0, n = r.int(CLOUDS.puffsMin, CLOUDS.puffsMax); i < n; i++) {
          const pr = CLOUDS.minRadius + r.next() * (CLOUDS.maxRadius - CLOUDS.minRadius);
          const a = r.next() * Math.PI * 2, d = r.next() * pr * CLOUDS.spread;
          const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.6; // a bit wider than tall
          point(x + sx, y + sy, pr, 'shadow');
          point(x, y, pr, 'cloud');
        }
      }
    }
    source.setData({ type: 'FeatureCollection', features });
  };
}
