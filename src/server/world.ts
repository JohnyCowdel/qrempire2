// World bootstrap shared by the dev server and the simulator.
// Real deployments would load the location list from a JSON file of physical QR spots.
import { rngFor, type LatLng, type LocationDef } from '../engine/index.ts';
import type { GameService } from './game-service.ts';

export const DEMO_CENTER: LatLng = { lat: 50.087, lng: 14.421 }; // Prague

export function makeLocations(seed: number, center: LatLng = DEMO_CENTER, n = 60): Map<string, LocationDef> {
  const r = rngFor(seed, 'locations');
  const out = new Map<string, LocationDef>();
  for (let i = 0; i < n; i++) {
    const tier = (r.chance(0.1) ? 3 : r.chance(0.3) ? 2 : 1) as 1 | 2 | 3;
    const loc = { id: `loc${i}`, name: `Spot ${i}`, tier, lat: center.lat + (r.next() - 0.5) * 0.12, lng: center.lng + (r.next() - 0.5) * 0.18 };
    out.set(loc.id, loc);
  }
  return out;
}

/** Give a few demo players some claimed bases so the map isn't empty. */
export async function seedDemo(game: GameService, locations: Map<string, LocationDef>, seed: number, players = 8) {
  const ids = [...locations.keys()];
  for (let p = 0; p < players; p++) {
    const r = rngFor(seed, 'demo', p);
    const playerId = `demo${p}`;
    for (let b = 0; b < r.int(1, 3); b++) {
      const locationId = r.pick(ids);
      if ((await game.execute(playerId, { type: 'scan', locationId })).ok) {
        await game.execute(playerId, { type: 'claim', locationId });
      }
    }
  }
}
