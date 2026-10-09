// State shapes. These are the ONLY things persisted. Each top-level aggregate
// (player, base, region) is one document = one read / one write.
import type { BuildingKind, ResourceKind, Slot, StatKind } from './content.ts';

export type Id = string;
export type Millis = number;
export type Resources = Partial<Record<ResourceKind, number>>;
export type Stats = Record<StatKind, number>;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Static location data (the physical QR spots). Shipped as a JSON file / CDN asset, not the DB. */
export interface LocationDef extends LatLng {
  id: Id;
  name: string;
  tier: 1 | 2 | 3;
}

/** An item is just (def, seed). Its rolled stats are recomputed from the seed, never stored. */
export interface ItemInstance {
  uid: Id;
  defId: string;
  seed: number;
}

interface Versioned {
  version: number; // optimistic concurrency, managed by the service layer, ignored by the engine
}

export interface PlayerState extends Versioned {
  id: Id;
  name: string;
  xp: number;
  wallet: Resources; // carried loot, deposit into a base to use it
  inventory: ItemInstance[];
  equipment: Partial<Record<Slot, Id>>;
  lootLog: Record<Id, number>; // locationId -> last looted epoch
  baseIds: Id[];
}

export interface BuildingState {
  id: Id;
  kind: BuildingKind;
  level: number;
  upgrade?: { toLevel: number; finishAt: Millis };
}

/** Resources are stored as (stock, settledAt); the real amount at time t is computed lazily. */
export interface BaseState extends Versioned {
  id: Id;
  ownerId: Id;
  locationId: Id;
  buildings: BuildingState[];
  stock: Resources;
  settledAt: Millis;
}

/** Ownership index for one map cell, so the world map needs a handful of reads, not one per location. */
export interface RegionState extends Versioned {
  id: string;
  owners: Record<Id, Id>; // locationId -> playerId
}

export interface EngineContext {
  worldSeed: number;
  now: Millis;
  locations: ReadonlyMap<Id, LocationDef>;
}
