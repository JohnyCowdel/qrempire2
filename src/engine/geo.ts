import { TUNING } from './content.ts';
import type { LatLng } from './types.ts';

export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

const cellIdx = (deg: number) => Math.floor(deg / TUNING.regionCellDeg);

export const regionIdOf = (p: LatLng) => `${cellIdx(p.lat)}_${cellIdx(p.lng)}`;

export function regionBounds(regionId: string): Bounds {
  const [y, x] = regionId.split('_').map(Number);
  const d = TUNING.regionCellDeg;
  return { south: y * d, west: x * d, north: (y + 1) * d, east: (x + 1) * d };
}

/** Region cells covering a viewport. Capped so a zoomed-out client can't trigger a huge read. */
export function regionsInBounds(b: Bounds, max = 64): string[] {
  const out: string[] = [];
  for (let y = cellIdx(b.south); y <= cellIdx(b.north); y++) {
    for (let x = cellIdx(b.west); x <= cellIdx(b.east); x++) {
      out.push(`${y}_${x}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export const inBounds = (p: LatLng, b: Bounds) =>
  p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
