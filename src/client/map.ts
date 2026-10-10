// World map page. Markers + ownership come from /api/map (refetched when the viewport
// changes); roaming units are computed locally by the shared engine every frame-ish,
// so they move smoothly without any server traffic.
import {
  buildMapView, hash32, LOCATION_TYPES, regionsInBounds, type Bounds, type LatLng, type MapMarker, type MapUnit,
} from '../engine/index.ts';
import { addHeightOverlay, HEIGHT_LAYERS } from './height-overlay.ts';
import { LabelOverlay } from './label-overlay.ts';
import { LABEL_FONTS, LABEL_KINDS, RIVER_LABEL_LAYER, RIVER_LABEL_PAINT } from './labels.ts';
import { LayerToggleControl, type LayerGroup } from './layer-toggle.ts';
import { CloudOverlay } from './cloud-overlay.ts';
import { FOREST_BLOB_LAYER, FOREST_LAYERS, ForestOverlay } from './forest-overlay.ts';
import { addWaterStripes, layerAfter, raiseRiversAbove, WATER_STRIPE_LAYERS } from './water-overlay.ts';
import { iconSizeExpression, locationIconId, registerLocationIcons, TIER_ICON_SCALE } from './location-icons.ts';
import { TerrainControl } from './terrain-control.ts';

declare const maplibregl: any; // loaded from the CDN <script> in index.html

interface WorldInfo {
  worldSeed: number;
  center: LatLng;
  now: number;
}

const world: WorldInfo = await (await fetch('/api/world')).json();
const clockOffset = world.now - Date.now(); // align with server time so units match everyone else's
const hud = document.getElementById('hud-body')!;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [world.center.lng, world.center.lat],
  zoom: 13,
  pitch: 10,
  maxPitch: 90,
  bearing: -20,
});
registerLocationIcons(map); // location symbols: emoji by default, image assets when configured
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'top-right');

// Our own labels (any web font) replace the base style's text layers entirely.
const storedFont = (() => {
  try {
    return localStorage.getItem('qre.font');
  } catch {
    return null;
  }
})();
const labels = new LabelOverlay(map, LABEL_KINDS, storedFont ?? LABEL_FONTS[0]);
// Map-anchored clouds drifting with the wind (layers added on load). Knobs: CLOUDS in cloud-overlay.ts.
const clouds = new CloudOverlay(map, world.worldSeed, world.center.lat);
// Decorative blobs inside forests. Knobs: FOREST in forest-overlay.ts (water: WATER in water-overlay.ts).
const forest = new ForestOverlay(map, world.worldSeed, world.center.lat);
const fontSelect = document.getElementById('font-select') as HTMLSelectElement;
fontSelect.innerHTML = LABEL_FONTS.map((f) => `<option style="font-family:'${f}'">${f}</option>`).join('');
fontSelect.value = storedFont ?? LABEL_FONTS[0];
fontSelect.onchange = () => {
  labels.setFont(fontSelect.value);
  try {
    localStorage.setItem('qre.font', fontSelect.value);
  } catch {
    // ignore
  }
};

// Layer ids refer to the OpenFreeMap "liberty" style (OpenMapTiles schema).
const LAYER_GROUPS: LayerGroup[] = [
  { section: 'Game', id: 'locations', label: 'Locations', layers: ['location-rings', 'location-icons', 'location-labels'] },
  { section: 'Game', id: 'units', label: 'Roaming units', layers: ['unit-dots', 'unit-labels'] },
  { section: 'Labels', id: 'labelPlaces', label: 'Place names', onChange: (v) => labels.setKindVisible('places', v) },
  {
    section: 'Labels', id: 'labelWater', label: 'Water names',
    layers: [RIVER_LABEL_LAYER], // rivers: base style layer
    onChange: (v) => labels.setKindVisible('water', v), // lakes: our overlay
  },
  { section: 'Decor', id: 'forestBlobs', label: 'Forest blobs', layers: FOREST_LAYERS },
  { section: 'Decor', id: 'waterStripes', label: 'Water stripes', layers: WATER_STRIPE_LAYERS },
  { section: 'Height', id: 'tint', label: 'Elevation colours', layers: HEIGHT_LAYERS.tint },
  { section: 'Height', id: 'hillshade', label: 'Hillshade', layers: HEIGHT_LAYERS.hillshade },
  { section: 'Height', id: 'contours', label: 'Contour lines', layers: HEIGHT_LAYERS.contours },
  {
    section: 'Base map', id: 'baseLabels', label: 'Original map labels', visible: false,
    layers: (l) => l.type === 'symbol' && l.source === 'openmaptiles' && l.id !== RIVER_LABEL_LAYER,
  },
  { section: 'Base map', id: 'railways', label: 'Railways & tram lines', visible: false, layers: (l) => /_(major|transit)_rail/.test(l.id) },
  { section: 'Base map', id: 'buildings', label: 'Buildings (2D)', layers: ['building'] },
  { section: 'Base map', id: 'buildings3d', label: '3D buildings', visible: false, layers: ['building-3d'] },
  { section: 'Base map', id: 'boundaries', label: 'Boundaries', layers: (l) => l.id.startsWith('boundary_') },
];
map.addControl(new LayerToggleControl(LAYER_GROUPS, 'qre.layers.v2'), 'top-right');
const terrain = new TerrainControl();
map.addControl(terrain, 'top-right');
map.addControl(clouds.control(), 'top-right'); // cloud on/off button

const ownerColor = (ownerId?: string) => (ownerId ? `hsl(${hash32(ownerId) % 360}, 75%, 45%)` : '#8a8f98');
const UNIT_COLORS: Record<string, string> = { bandits: '#d33', merchant: '#e9a400', wolves: '#555', dragon: '#9b30ff' };

function viewportBounds(): Bounds {
  const b = map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

const point = (p: LatLng, properties: Record<string, unknown>) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
  properties,
});

const markersGeoJson = (markers: MapMarker[]) => ({
  type: 'FeatureCollection',
  features: markers.map((m) => point(m, {
    id: m.id, name: m.name, tier: m.tier, type: m.type, icon: locationIconId(m.type),
    ownerId: m.ownerId ?? '', color: ownerColor(m.ownerId),
  })),
});

const unitsGeoJson = (units: MapUnit[]) => ({
  type: 'FeatureCollection',
  features: units.map((u) => point(u, { id: u.id, kind: u.kind, color: UNIT_COLORS[u.kind] ?? '#333' })),
});

let markers: MapMarker[] = [];
let unitCount = 0;

function updateHud() {
  const owned = markers.filter((m) => m.ownerId).length;
  hud.innerHTML = `${markers.length} locations in view (${owned} claimed)<br>${unitCount} roaming units<br>` +
    `<span class="muted">zoom ${map.getZoom().toFixed(1)}</span>`;
}

let fetchTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshMarkers() {
  const b = viewportBounds();
  const res = await fetch(`/api/map?s=${b.south}&w=${b.west}&n=${b.north}&e=${b.east}`);
  if (!res.ok) return;
  markers = (await res.json()).markers;
  map.getSource('locations').setData(markersGeoJson(markers));
  updateHud();
}
const scheduleRefresh = () => {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(refreshMarkers, 250);
};

function tickUnits() {
  const bounds = viewportBounds();
  const ctx = { worldSeed: world.worldSeed, now: Date.now() + clockOffset, locations: new Map() };
  const { units } = buildMapView(ctx, bounds, new Map(), regionsInBounds(bounds));
  unitCount = units.length;
  map.getSource('units').setData(unitsGeoJson(units));
}

map.on('load', () => {
  addHeightOverlay(map, 'waterway_tunnel', 'waterway_line_label');
  terrain.apply();
  // Draw order: lakes + stripes  <  forest trees  <  rivers
  addWaterStripes(map, world.center.lat);
  const lastStripe = WATER_STRIPE_LAYERS[WATER_STRIPE_LAYERS.length - 1];
  forest.addLayers(layerAfter(map, lastStripe)); // trees right above the water stripes
  raiseRiversAbove(map, FOREST_BLOB_LAYER); // rivers stay on top of trees
  if (map.getLayer(RIVER_LABEL_LAYER)) {
    for (const [prop, value] of Object.entries(RIVER_LABEL_PAINT)) map.setPaintProperty(RIVER_LABEL_LAYER, prop, value);
  }

  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('locations', { type: 'geojson', data: empty });
  map.addSource('units', { type: 'geojson', data: empty });

  // Ownership ring under each symbol (owner colour, grey when unclaimed), sized like the symbol.
  const ringRadius = ['*', 16, ['match', ['get', 'tier'], ...Object.entries(TIER_ICON_SCALE).flatMap(([t, s]) => [Number(t), s]), 1]];
  map.addLayer({
    id: 'location-rings', type: 'circle', source: 'locations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['*', 0.6, ringRadius], 16, ringRadius],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.25,
      'circle-stroke-width': 2,
      'circle-stroke-color': ['get', 'color'],
      'circle-pitch-alignment': 'map',
    },
  });
  // Location symbol: image `loc-<type>` (emoji or asset, see location-icons.ts), size by stars.
  map.addLayer({
    id: 'location-icons', type: 'symbol', source: 'locations',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': iconSizeExpression(),
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['-', 0, ['get', 'tier']], // bigger places drawn on top
    },
  });
  map.addLayer({
    id: 'location-labels', type: 'symbol', source: 'locations', minzoom: 13,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.8], 'text-anchor': 'top' },
    paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
  map.addLayer({
    id: 'unit-dots', type: 'circle', source: 'units',
    paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
  });
  map.addLayer({
    id: 'unit-labels', type: 'symbol', source: 'units', minzoom: 14,
    layout: { 'text-field': ['get', 'kind'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' },
    paint: { 'text-color': '#444', 'text-halo-color': '#fff', 'text-halo-width': 1 },
  });
  clouds.addLayers(); // clouds above everything on the map

  const openLocationPopup = async (e: any) => {
    const f = e.features[0];
    const res = await fetch(`/api/location/${f.properties.id}`);
    const scene = await res.json();
    const buildings = scene.structures.filter((s: any) => s.level !== undefined);
    const type = LOCATION_TYPES[scene.location.type as keyof typeof LOCATION_TYPES];
    const html = `<h3>${type?.emoji ?? ''} ${scene.location.name} ${'★'.repeat(scene.location.tier)}</h3>` +
      `<div style="color:#888;margin-bottom:4px">${type?.name ?? scene.location.type}</div>` +
      (scene.ownerId ? `Owner: <b style="color:${ownerColor(scene.ownerId)}">${scene.ownerId}</b>` : 'Unclaimed – scan the QR code here to claim it') +
      (buildings.length ? `<ul>${buildings.map((b: any) => `<li>${b.label} lvl ${b.level}</li>`).join('')}</ul>` : '') +
      `<div style="color:#888;margin-top:4px">${scene.npcs.length} creatures roam here</div>`;
    new maplibregl.Popup().setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  };
  map.on('click', 'location-icons', openLocationPopup);
  for (const layer of ['location-icons']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

  map.on('moveend', scheduleRefresh);
  refreshMarkers();
  setInterval(refreshMarkers, 15_000); // pick up claims by other players
  tickUnits();
  setInterval(tickUnits, 500);
});
