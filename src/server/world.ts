// World bootstrap shared by the dev server and the simulator.
// Real deployments would load the location list from a JSON file of physical QR spots.
import { LOCATION_TRAITS, LOCATION_TYPES, rngFor, type LatLng, type LocationDef, type LocationTrait, type LocationType, type Rng } from '../engine/index.ts';
import type { GameService } from './game-service.ts';

export const DEMO_CENTER: LatLng = { lat: 49.5868333, lng: 15.7536722 }; // near Přibyslav

/** Chance of each trait in generated demo locations; one entry per exclusive group. */
const TRAIT_ODDS: { pick: [LocationTrait, number][] }[] = [
  { pick: [['central-high-spot', 0.6]] },
  { pick: [['fields', 0.35]] },
  { pick: [['dry', 0.25], ['wet', 0.25]] },
  { pick: [['bog', 0.2]] },
  { pick: [['valley', 0.25]] },
  { pick: [['river-direct', 0.12], ['river-curvy', 0.15], ['river-peninsula', 0.08]] },
  { pick: [['lake-island', 0.08], ['lake-peninsula', 0.08], ['lake-nearby', 0.2]] },
  { pick: [['perimeter-wood', 0.5], ['perimeter-meadows', 0.25], ['perimeter-fields', 0.25]] },
  { pick: [['iron-ore', 0.12], ['copper-ore', 0.1], ['stone-quarry', 0.15], ['mud-quarry', 0.08], ['salt-quarry', 0.06]] },
];

/** Random but consistent trait set (real spots would have theirs listed by hand). */
export function rollTraits(r: Rng): LocationTrait[] {
  const traits: LocationTrait[] = [];
  for (const group of TRAIT_ODDS) {
    let roll = r.next();
    for (const [trait, p] of group.pick) {
      if (roll < p) { traits.push(trait); break; }
      roll -= p;
    }
  }
  const has = (t: LocationTrait) => traits.includes(t);
  const drop = (t: LocationTrait) => traits.splice(traits.indexOf(t), 1);
  // Combinations that fight over the centre or contradict each other:
  if ((has('lake-island') || has('lake-peninsula')) && traits.some((t) => t.startsWith('river-'))) drop(traits.find((t) => t.startsWith('river-'))!);
  if (has('bog') && has('dry')) drop('bog');
  if (has('lake-island') && !has('central-high-spot')) traits.push('central-high-spot'); // the island
  // mud quarries like wet ground: bog / wet places without a deposit often get one
  if ((has('bog') || has('wet')) && !traits.some((t) => LOCATION_TRAITS[t].group === 'deposit') && r.chance(0.35)) traits.push('mud-quarry');
  return traits;
}

export function makeLocations(seed: number, center: LatLng = DEMO_CENTER, n = 60): Map<string, LocationDef> {
  const r = rngFor(seed, 'locations');
  const out = new Map<string, LocationDef>();
  for (let i = 0; i < n; i++) {
    const tier = (r.chance(0.1) ? 3 : r.chance(0.3) ? 2 : 1) as 1 | 2 | 3;
    const type = r.pick(Object.keys(LOCATION_TYPES) as LocationType[]);
    const loc: LocationDef = {
      id: `loc${i}`, name: `${LOCATION_TYPES[type].name} ${i}`, type, tier,
      lat: center.lat + (r.next() - 0.5) * 0.12, lng: center.lng + (r.next() - 0.5) * 0.18,
      traits: rollTraits(rngFor(seed, 'traits', i)),
    };
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
