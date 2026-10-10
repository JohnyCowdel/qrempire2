// Static game data. Bundled with the engine (and the client), never stored in the DB.
// Changing balance = shipping a new engine version, zero migrations.
import type { Resources, Stats } from './types.ts';

export const RESOURCE_KINDS = ['wood', 'stone', 'gold', 'crystal'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type LocationType = 'castle' | 'chapel' | 'tower' | 'ruins' | 'hut' | 'mine' | 'fountain' | 'monument';

export interface LocationTypeDef {
  name: string;
  emoji: string; // default map symbol
  icon?: string; // optional image (e.g. /assets/icons/castle.png) – replaces the emoji when set
}

/** What kinds of places exist. The map renders `icon` if present, else `emoji`. */
export const LOCATION_TYPES: Record<LocationType, LocationTypeDef> = {
  castle: { name: 'Castle', emoji: '🏰' },
  chapel: { name: 'Chapel', emoji: '⛪' },
  tower: { name: 'Watchtower', emoji: '🗼' },
  ruins: { name: 'Ruins', emoji: '🏛️' },
  hut: { name: 'Hut', emoji: '🛖' },
  mine: { name: 'Mine', emoji: '🏭' },
  fountain: { name: 'Fountain', emoji: '⛲' },
  monument: { name: 'Monument', emoji: '🗿' },
};

export type BuildingKind ='hall' | 'lumberyard' | 'quarry' | 'mine' | 'warehouse';

export interface BuildingDef {
  name: string;
  maxLevel: number;
  unique?: boolean;
  cost(level: number): Resources; // cost to reach `level`
  buildMs(level: number): number;
  production?(level: number): Resources; // per hour
  storage?(level: number): Resources;
}

const sq = (n: number) => n * n;
const MIN = 60_000;

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  hall: {
    name: 'Town Hall', maxLevel: 10, unique: true,
    cost: (l) => ({ wood: 150 * sq(l), stone: 150 * sq(l), gold: 20 * sq(l) }),
    buildMs: (l) => 5 * MIN * sq(l),
    storage: (l) => ({ wood: 400 * l, stone: 400 * l, gold: 150 * l, crystal: 10 * l }),
  },
  lumberyard: {
    name: 'Lumberyard', maxLevel: 10,
    cost: (l) => ({ wood: 40 * sq(l), stone: 30 * sq(l) }),
    buildMs: (l) => 2 * MIN * sq(l),
    production: (l) => ({ wood: 12 * l }),
  },
  quarry: {
    name: 'Quarry', maxLevel: 10,
    cost: (l) => ({ wood: 50 * sq(l), stone: 20 * sq(l) }),
    buildMs: (l) => 2 * MIN * sq(l),
    production: (l) => ({ stone: 10 * l }),
  },
  mine: {
    name: 'Gold Mine', maxLevel: 10,
    cost: (l) => ({ wood: 70 * sq(l), stone: 70 * sq(l) }),
    buildMs: (l) => 3 * MIN * sq(l),
    production: (l) => ({ gold: 4 * l }),
  },
  warehouse: {
    name: 'Warehouse', maxLevel: 10,
    cost: (l) => ({ wood: 80 * sq(l), stone: 60 * sq(l) }),
    buildMs: (l) => 3 * MIN * sq(l),
    storage: (l) => ({ wood: 600 * l, stone: 600 * l, gold: 200 * l, crystal: 20 * l }),
  },
};

export const SLOTS = ['head', 'chest', 'weapon', 'offhand', 'boots', 'trinket'] as const;
export type Slot = (typeof SLOTS)[number];

export const STAT_KINDS = ['hp', 'attack', 'defense', 'speed', 'luck'] as const;
export type StatKind = (typeof STAT_KINDS)[number];

export interface ItemDef {
  name: string;
  slot: Slot;
  rarity: 'common' | 'rare' | 'epic';
  stats: Partial<Record<StatKind, [min: number, max: number]>>;
}

export const ITEMS: Record<string, ItemDef> = {
  rusty_sword: { name: 'Rusty Sword', slot: 'weapon', rarity: 'common', stats: { attack: [3, 6] } },
  oak_shield: { name: 'Oak Shield', slot: 'offhand', rarity: 'common', stats: { defense: [2, 5] } },
  leather_cap: { name: 'Leather Cap', slot: 'head', rarity: 'common', stats: { defense: [1, 3], hp: [5, 10] } },
  leather_vest: { name: 'Leather Vest', slot: 'chest', rarity: 'common', stats: { defense: [2, 4], hp: [10, 20] } },
  swift_boots: { name: 'Swift Boots', slot: 'boots', rarity: 'rare', stats: { speed: [2, 5] } },
  lucky_coin: { name: 'Lucky Coin', slot: 'trinket', rarity: 'rare', stats: { luck: [3, 8] } },
  crystal_blade: { name: 'Crystal Blade', slot: 'weapon', rarity: 'epic', stats: { attack: [12, 20], speed: [1, 3] } },
  warden_plate: { name: 'Warden Plate', slot: 'chest', rarity: 'epic', stats: { defense: [10, 15], hp: [40, 60] } },
};

export const BASE_STATS: Stats = { hp: 100, attack: 5, defense: 2, speed: 5, luck: 1 };
export const STATS_PER_LEVEL: Stats = { hp: 10, attack: 1, defense: 1, speed: 0, luck: 0 };

export type LootEntry =
  | { weight: number; item: string }
  | { weight: number; resource: ResourceKind; min: number; max: number };

/** Loot tables by location tier (1..3). */
export const LOOT_TABLES: Record<number, LootEntry[]> = {
  1: [
    { weight: 40, resource: 'wood', min: 40, max: 120 },
    { weight: 40, resource: 'stone', min: 30, max: 100 },
    { weight: 15, resource: 'gold', min: 5, max: 25 },
    { weight: 6, item: 'rusty_sword' },
    { weight: 6, item: 'leather_cap' },
    { weight: 6, item: 'leather_vest' },
    { weight: 4, item: 'oak_shield' },
  ],
  2: [
    { weight: 30, resource: 'wood', min: 100, max: 250 },
    { weight: 30, resource: 'stone', min: 80, max: 220 },
    { weight: 20, resource: 'gold', min: 20, max: 60 },
    { weight: 5, resource: 'crystal', min: 1, max: 3 },
    { weight: 6, item: 'swift_boots' },
    { weight: 6, item: 'oak_shield' },
    { weight: 4, item: 'lucky_coin' },
  ],
  3: [
    { weight: 25, resource: 'gold', min: 50, max: 150 },
    { weight: 15, resource: 'crystal', min: 3, max: 8 },
    { weight: 6, item: 'lucky_coin' },
    { weight: 3, item: 'crystal_blade' },
    { weight: 3, item: 'warden_plate' },
  ],
};

export const TUNING = {
  lootCooldownMs: 4 * 3600_000, // chest respawn period, per player
  scanRadiusM: 75, // max GPS distance from the QR location
  maxBasesPerPlayer: 3,
  xpPerScan: 25,
  xpPerClaim: 100,
  regionCellDeg: 0.05, // ~5 km map cells; one ownership doc per cell
  npcStepMs: 4000,
  mapUnitStepMs: 60_000,
} as const;
