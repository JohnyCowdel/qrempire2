// World map view model: static location markers + ownership overlay + roaming units.
// Units are not stored anywhere: their position is a pure function of (cell, time).
import { TUNING } from './content.ts';
import { inBounds, regionBounds, regionIdOf, type Bounds } from './geo.ts';
import { hash32, rngFor } from './rng.ts';
import type { EngineContext, Id, LatLng, LocationDef, Millis, RegionState } from './types.ts';

export interface MapMarker extends LocationDef {
  ownerId?: Id;
}

export interface MapUnit extends LatLng {
  id: string;
  kind: string;
}

export interface MapView {
  markers: MapMarker[];
  units: MapUnit[];
  generatedAt: Millis;
}

const UNIT_KINDS = ['bandits', 'merchant', 'bandits', 'wolves', 'merchant', 'dragon'];

function unitsInRegion(worldSeed: number, regionId: string, now: Millis): MapUnit[] {
  const b = regionBounds(regionId);
  const count = hash32(worldSeed, 'units', regionId) % 4;
  const step = Math.floor(now / TUNING.mapUnitStepMs);
  const frac = (now % TUNING.mapUnitStepMs) / TUNING.mapUnitStepMs;
  const units: MapUnit[] = [];
  for (let i = 0; i < count; i++) {
    const wp = (k: number) => {
      const r = rngFor(worldSeed, 'unit', regionId, i, k >> 4); // new waypoint every 16 steps
      return { lat: b.south + r.next() * (b.north - b.south), lng: b.west + r.next() * (b.east - b.west) };
    };
    const t = ((step & 15) + frac) / 16;
    const a = wp(step), c = wp(step + 16);
    units.push({
      id: `${regionId}:${i}`,
      kind: rngFor(worldSeed, 'unitkind', regionId, i).pick(UNIT_KINDS),
      lat: a.lat + (c.lat - a.lat) * t,
      lng: a.lng + (c.lng - a.lng) * t,
    });
  }
  return units;
}

export function buildMapView(ctx: EngineContext, bounds: Bounds, regions: ReadonlyMap<string, RegionState>, regionIds: string[]): MapView {
  const markers: MapMarker[] = [];
  for (const loc of ctx.locations.values()) {
    if (!inBounds(loc, bounds)) continue;
    markers.push({ ...loc, ownerId: regions.get(regionIdOf(loc))?.owners[loc.id] });
  }
  const units = regionIds.flatMap((r) => unitsInRegion(ctx.worldSeed, r, ctx.now)).filter((u) => inBounds(u, bounds));
  return { markers, units, generatedAt: ctx.now };
}
