// Simple 2D clouds, drawn by MapLibre itself so they're glued to the map:
//   - every puff is a GeoJSON point rendered as a blurred circle with a radius in metres
//     (MapLibre scales it with zoom and keeps it in place while panning, no lag)
//   - wind movement = `circle-translate` (a cheap paint property), NOT re-sending the data:
//     setData makes MapLibre re-tile in a worker and tiles swap in at different moments,
//     which showed as flicker between clouds and shadows
//   - the points are only rebuilt after panning or once they've drifted half a cell, into a
//     second (hidden) buffer that's swapped in once fully loaded -> no half-updated frames
// Local clock; clouds are decoration, not game state.
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

  minZoom: 11.5, // hidden when zoomed OUT further than this (lower zoom numbers): not rendered or computed
  maxZoom: 15, // hidden when zoomed IN closer than this (higher zoom numbers)
  fadeZooms: 0.8, // fade in/out over this many zoom levels inside [minZoom, maxZoom]
  tickMs: 20, // how often the wind moves the clouds (cheap: only a paint property changes)
};
// =====================================================

/** Two buffers (A/B), each a source + shadow layer + cloud layer. Only one is visible at a time. */
interface Buffer {
  source: string;
  shadowLayer: string;
  cloudLayer: string;
  base: [number, number] | null; // wind drift (metres east/north) the data was built with
}
const BUFFERS: Buffer[] = ['a', 'b'].map((n) => ({ source: `clouds-${n}`, shadowLayer: `cloud-shadows-${n}`, cloudLayer: `clouds-${n}`, base: null }));
export const CLOUD_LAYERS = BUFFERS.flatMap((b) => [b.shadowLayer, b.cloudLayer]);

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
  private readonly pxPerMeterAtZ0: number;
  private readonly buffers = BUFFERS.map((b) => ({ ...b }));
  private active = 0; // index of the visible buffer
  private pending: number | null = null; // index of the buffer currently loading new data
  private pendingContent = false; // its new data has reached the source
  private dirty = true; // view changed -> rebuild
  private cloudOpacity?: unknown[]; // zoom-faded opacity expressions of the active buffer
  private shadowOpacity?: unknown[];
  private visible: boolean;

  constructor(map: any, seed: number, refLat: number) {
    this.map = map;
    this.seed = seed;
    this.refLat = refLat;
    this.mPerDegLng = M_PER_DEG * Math.cos((refLat * Math.PI) / 180);
    this.pxPerMeterAtZ0 = 512 / (40_075_016.686 * Math.cos((refLat * Math.PI) / 180));
    this.visible = loadJson<{ visible: boolean }>(STORAGE_KEY).visible ?? true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    saveJson(STORAGE_KEY, { visible });
    this.dirty = true;
    this.applyVisibility();
    if (visible) this.tick();
  }

  /**
   * Only the active buffer is shown. The inactive one is hidden with opacity 0, NOT with
   * visibility 'none': MapLibre doesn't build render data for 'none' layers, so a buffer
   * un-hidden that way is empty for a frame or two (a blink on every swap).
   */
  private applyVisibility(): void {
    if (!this.cloudOpacity) return; // layers not added yet
    this.buffers.forEach((b, i) => {
      const layout = this.visible && b.base !== null ? 'visible' : 'none';
      const active = i === this.active;
      for (const [id, opacity] of [[b.shadowLayer, this.shadowOpacity], [b.cloudLayer, this.cloudOpacity]] as const) {
        if (!this.map.getLayer(id)) continue;
        this.map.setLayoutProperty(id, 'visibility', layout);
        this.map.setPaintProperty(id, 'circle-opacity', active ? opacity : 0);
      }
    });
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
    for (const b of this.buffers) map.addSource(b.source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Circle radius is in pixels; radius_px = metres / metresPerPixel = metres * 2^zoom * 512 / (C * cos(lat)).
    // An exponential(2) interpolation between two zooms reproduces that 2^zoom curve exactly.
    const radius = ['interpolate', ['exponential', 2], ['zoom'],
      0, ['*', ['get', 'r'], this.pxPerMeterAtZ0],
      22, ['*', ['get', 'r'], this.pxPerMeterAtZ0 * 2 ** 22]];
    const f = CLOUDS.fadeZooms;
    const fade = (alpha: number) => ['interpolate', ['linear'], ['zoom'],
      CLOUDS.minZoom, 0, CLOUDS.minZoom + f, alpha, CLOUDS.maxZoom - f, alpha, CLOUDS.maxZoom, 0];
    const layer = (id: string, source: string, kind: string, color: string) => map.addLayer({
      id, type: 'circle', source, filter: ['==', ['get', 'kind'], kind],
      minzoom: CLOUDS.minZoom, maxzoom: CLOUDS.maxZoom,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': radius, 'circle-color': color, 'circle-opacity': 0, 'circle-blur': CLOUDS.blur,
        'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map', 'circle-translate-anchor': 'map',
        // No easing: by default MapLibre animates paint changes over 300 ms, so the translate lagged
        // behind and a freshly swapped-in buffer slid in from an old offset (the "jump back west").
        // Same for opacity, which is how buffers are swapped.
        'circle-translate-transition': { duration: 0, delay: 0 },
        'circle-opacity-transition': { duration: 0, delay: 0 },
      },
    });
    this.cloudOpacity = fade(CLOUDS.opacity);
    this.shadowOpacity = fade(CLOUDS.shadowOpacity);
    // All shadow layers below all cloud layers, whichever buffer is active.
    for (const b of this.buffers) layer(b.shadowLayer, b.source, 'shadow', CLOUDS.shadowColor);
    for (const b of this.buffers) layer(b.cloudLayer, b.source, 'cloud', CLOUDS.color);

    map.on('moveend', () => (this.dirty = true));
    map.on('sourcedata', (e: any) => {
      if (this.pending !== null && e.sourceId === this.buffers[this.pending].source && e.sourceDataType === 'content') {
        this.pendingContent = true;
      }
    });
    this.applyVisibility();
    this.tick();
    setInterval(this.tick, CLOUDS.tickMs);
  }

  /** Wind drift in metres (east, north) at this moment. */
  private wind(): [number, number] {
    const rad = (CLOUDS.windDirection * Math.PI) / 180;
    const drift = (Date.now() / 1000) * CLOUDS.windSpeed;
    return [Math.sin(rad) * drift, Math.cos(rad) * drift];
  }

  private readonly tick = () => {
    const map = this.map;
    const zoom = map.getZoom();
    if (!this.visible || !map.getSource(this.buffers[0].source) || zoom < CLOUDS.minZoom || zoom > CLOUDS.maxZoom) return;
    const [windX, windY] = this.wind();

    // 1) Move: each buffer is shifted by (wind now - wind it was built with), in pixels.
    //    With anchor 'map', translate x = east, y = south.
    const ppm = this.pxPerMeterAtZ0 * 2 ** zoom;
    for (const b of this.buffers) {
      if (!b.base) continue;
      const t = [(windX - b.base[0]) * ppm, -(windY - b.base[1]) * ppm];
      map.setPaintProperty(b.shadowLayer, 'circle-translate', t);
      map.setPaintProperty(b.cloudLayer, 'circle-translate', t);
    }

    // 2) Swap: the loading buffer becomes visible once its data has fully arrived.
    if (this.pending !== null && this.pendingContent && map.isSourceLoaded(this.buffers[this.pending].source)) {
      this.active = this.pending;
      this.pending = null;
      this.applyVisibility();
    }

    // 3) Rebuild (into the hidden buffer) after panning or once the clouds drifted half a cell.
    const cur = this.buffers[this.active].base;
    const drifted = cur ? Math.hypot(windX - cur[0], windY - cur[1]) : Infinity;
    if (this.pending === null && (this.dirty || drifted > CLOUDS.cellMeters * 0.5)) {
      const next = 1 - this.active;
      if (this.rebuild(this.buffers[next], windX, windY)) {
        this.pending = next;
        this.pendingContent = false;
        this.dirty = false;
      }
    }
  };

  /** Fill a buffer with the cloud puffs covering the view (+ margin), built at the given wind drift. */
  private rebuild(buffer: { source: string; base: [number, number] | null }, windX: number, windY: number): boolean {
    const map = this.map;
    const b = map.getBounds();
    // margin also covers the drift until the next rebuild (half a cell)
    const margin = CLOUDS.maxRadius * (1 + CLOUDS.spread) + Math.hypot(...CLOUDS.shadowOffset) + CLOUDS.cellMeters;
    const cell = CLOUDS.cellMeters;
    const gx0 = Math.floor((b.getWest() * this.mPerDegLng - margin - windX) / cell);
    const gx1 = Math.floor((b.getEast() * this.mPerDegLng + margin - windX) / cell);
    const gy0 = Math.floor((b.getSouth() * M_PER_DEG - margin - windY) / cell);
    const gy1 = Math.floor((b.getNorth() * M_PER_DEG + margin - windY) / cell);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 5000) return false;

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
    buffer.base = [windX, windY]; // its translate is computed relative to this from now on
    map.getSource(buffer.source).setData({ type: 'FeatureCollection', features });
    return true;
  }
}
