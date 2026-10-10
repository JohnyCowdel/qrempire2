// What our label overlay draws and how. Data comes from the OpenMapTiles schema
// served by OpenFreeMap (source "openmaptiles").
import type { LabelKind } from './label-overlay.ts';

export const LABEL_FONTS = ['Cinzel', 'IM Fell English', 'Alegreya', 'MedievalSharp', 'Inter'] as const;

const INK = '#2b2116';
const HALO = 'rgba(250, 245, 232, 0.9)';
const WATER = '#2c5d8a';

const PLACE_MIN_ZOOM: Record<string, number> = {
  country: 0, state: 5, city: 0, town: 9, village: 11.5, suburb: 11.5, quarter: 13, neighbourhood: 14, hamlet: 14, isolated_dwelling: 15,
};

export const LABEL_KINDS: LabelKind[] = [
  {
    id: 'places',
    source: 'openmaptiles',
    sourceLayer: 'place',
    placement: 'point',
    filter: (p, z) => z >= (PLACE_MIN_ZOOM[p.class] ?? 99) && !(p.class === 'country' && z > 7) && !(p.class === 'state' && z > 9),
    priority: (p) => ({ country: 0, state: 5, city: 10, town: 20, village: 30, suburb: 35, quarter: 40 } as Record<string, number>)[p.class] ?? 50 + (p.rank ?? 0),
    style: (p) => {
      switch (p.class) {
        case 'country':
        case 'state':
          return { size: 16, weight: 600, color: '#6b5a48', uppercase: true, letterSpacing: 4, halo: HALO, haloWidth: 2 };
        case 'city':
          return { size: p.capital === 2 ? 24 : 20, weight: 700, color: INK, uppercase: true, letterSpacing: 2, halo: HALO, haloWidth: 2.5 };
        case 'town':
          return { size: 16, weight: 600, color: INK, halo: HALO, haloWidth: 2 };
        case 'village':
          return { size: 13, weight: 600, color: INK, halo: HALO, haloWidth: 2 };
        case 'suburb':
        case 'quarter':
          return { size: 12, weight: 600, color: '#5c4a38', uppercase: true, letterSpacing: 1.5, halo: HALO, haloWidth: 2 };
        default:
          return { size: 11, weight: 400, color: '#5c4a38', halo: HALO, haloWidth: 1.5 };
      }
    },
  },
  {
    id: 'water',
    source: 'openmaptiles',
    sourceLayer: 'water_name',
    placement: 'point',
    priority: () => 60,
    style: () => ({ size: 13, italic: true, color: WATER, letterSpacing: 1, halo: HALO, haloWidth: 1.5 }),
  },
  // River names stay with the base style's `waterway_line_label` (see map.ts): MapLibre's
  // line placement is stable across zooms, our centre-nearest anchor jumped around.
];

/** Make the base style's river labels match our water label colours. */
export const RIVER_LABEL_LAYER = 'waterway_line_label';
export const RIVER_LABEL_PAINT = { 'text-color': WATER, 'text-halo-color': HALO, 'text-halo-width': 1.5 };
