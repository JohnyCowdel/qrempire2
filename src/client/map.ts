// World map page. Markers + ownership come from /api/map (refetched when the viewport
// changes); roaming units are computed locally by the shared engine every frame-ish,
// so they move smoothly without any server traffic.
import { buildMapView, hash32, regionsInBounds, type Bounds, type LatLng, type MapMarker, type MapUnit } from '../engine/index.ts';

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
  zoom: 12,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'top-right');

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
  features: markers.map((m) => point(m, { id: m.id, name: m.name, tier: m.tier, ownerId: m.ownerId ?? '', color: ownerColor(m.ownerId) })),
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
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('locations', { type: 'geojson', data: empty });
  map.addSource('units', { type: 'geojson', data: empty });

  map.addLayer({
    id: 'location-circles', type: 'circle', source: 'locations',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['+', 3, ['get', 'tier']], 16, ['+', 8, ['*', 3, ['get', 'tier']]]],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': ['match', ['get', 'tier'], 3, '#ffd700', 2, '#c0c0c0', '#ffffff'],
    },
  });
  map.addLayer({
    id: 'location-labels', type: 'symbol', source: 'locations', minzoom: 13,
    layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top' },
    paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });
  map.addLayer({
    id: 'unit-dots', type: 'circle', source: 'units',
    paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
  });
  map.addLayer({
    id: 'unit-labels', type: 'symbol', source: 'units', minzoom: 14,
    layout: { 'text-field': ['get', 'kind'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' },
    paint: { 'text-color': '#444', 'text-halo-color': '#fff', 'text-halo-width': 1 },
  });

  map.on('click', 'location-circles', async (e: any) => {
    const f = e.features[0];
    const res = await fetch(`/api/location/${f.properties.id}`);
    const scene = await res.json();
    const buildings = scene.structures.filter((s: any) => s.level !== undefined);
    const html = `<h3>${scene.location.name} ${'★'.repeat(scene.location.tier)}</h3>` +
      (scene.ownerId ? `Owner: <b style="color:${ownerColor(scene.ownerId)}">${scene.ownerId}</b>` : 'Unclaimed – scan the QR code here to claim it') +
      (buildings.length ? `<ul>${buildings.map((b: any) => `<li>${b.label} lvl ${b.level}</li>`).join('')}</ul>` : '') +
      `<div style="color:#888;margin-top:4px">${scene.npcs.length} creatures roam here</div>`;
    new maplibregl.Popup().setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  });
  for (const layer of ['location-circles']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

  map.on('moveend', scheduleRefresh);
  refreshMarkers();
  setInterval(refreshMarkers, 15_000); // pick up claims by other players
  tickUnits();
  setInterval(tickUnits, 500);
});
