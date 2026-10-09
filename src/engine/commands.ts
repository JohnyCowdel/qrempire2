// The engine's write path: a pure reducer.
//   execute(ctx, snapshot, command) -> { changed aggregates, events }
// No I/O, no clock, no randomness except seeded RNG => fully simulatable and replayable.
import { BUILDINGS, ITEMS, LOOT_TABLES, TUNING, type BuildingKind } from './content.ts';
import { addRes, canAfford, settleBase } from './economy.ts';
import { regionIdOf } from './geo.ts';
import { hash32, rngFor, weighted } from './rng.ts';
import { lootEpoch } from './scene.ts';
import type { BaseState, EngineContext, Id, ItemInstance, PlayerState, RegionState, Resources } from './types.ts';

export type Command =
  | { type: 'scan'; locationId: Id } // QR already verified by the service (signature + GPS)
  | { type: 'claim'; locationId: Id }
  | { type: 'deposit'; baseId: Id }
  | { type: 'upgrade'; baseId: Id; kind: BuildingKind; buildingId?: Id } // no buildingId = construct new
  | { type: 'equip'; itemUid: Id };

export type GameEvent =
  | { type: 'looted'; locationId: Id; resources: Resources; items: ItemInstance[] }
  | { type: 'claimed'; locationId: Id; baseId: Id }
  | { type: 'deposited'; baseId: Id; resources: Resources }
  | { type: 'upgradeStarted'; baseId: Id; buildingId: Id; toLevel: number; finishAt: number }
  | { type: 'equipped'; itemUid: Id };

/** Everything a command may read. The service loads exactly these docs, in one batch. */
export interface Snapshot {
  player: PlayerState;
  base?: BaseState;
  region?: RegionState;
}

export type Outcome =
  | { ok: true; changed: Partial<Snapshot>; events: GameEvent[] }
  | { ok: false; error: string };

export const baseIdFor = (locationId: Id) => `b_${locationId}`;

/** Which aggregates (besides the player) a command needs. Derivable without any DB access. */
export function requirements(ctx: EngineContext, cmd: Command): { baseId?: Id; regionId?: string } {
  switch (cmd.type) {
    case 'claim': {
      const loc = ctx.locations.get(cmd.locationId);
      return loc ? { baseId: baseIdFor(loc.id), regionId: regionIdOf(loc) } : {};
    }
    case 'deposit':
    case 'upgrade':
      return { baseId: cmd.baseId };
    default:
      return {};
  }
}

export function createPlayer(id: Id, name: string): PlayerState {
  return { id, name, xp: 0, wallet: {}, inventory: [], equipment: {}, lootLog: {}, baseIds: [], version: 0 };
}

const fail = (error: string): Outcome => ({ ok: false, error });

export function execute(ctx: EngineContext, snap: Snapshot, cmd: Command): Outcome {
  switch (cmd.type) {
    case 'scan': return scan(ctx, snap, cmd.locationId);
    case 'claim': return claim(ctx, snap, cmd.locationId);
    case 'deposit': return deposit(ctx, snap, cmd.baseId);
    case 'upgrade': return upgrade(ctx, snap, cmd);
    case 'equip': return equip(snap, cmd.itemUid);
  }
}

function scan(ctx: EngineContext, { player }: Snapshot, locationId: Id): Outcome {
  const loc = ctx.locations.get(locationId);
  if (!loc) return fail('unknown location');
  const epoch = lootEpoch(ctx.now);
  if (player.lootLog[locationId] === epoch) return fail('chest is empty, come back later');

  // Loot is a pure function of (world, location, player, epoch): re-rolling can't be cheated.
  const r = rngFor(ctx.worldSeed, 'loot', locationId, player.id, epoch);
  let resources: Resources = {};
  const items: ItemInstance[] = [];
  const drops = r.int(1, 2 + loc.tier);
  for (let i = 0; i < drops; i++) {
    const entry = weighted(r, LOOT_TABLES[loc.tier]);
    if ('item' in entry) {
      const seed = hash32(ctx.worldSeed, 'item', locationId, player.id, epoch, i);
      items.push({ uid: `i${seed.toString(36)}`, defId: entry.item, seed });
    } else {
      resources = addRes(resources, { [entry.resource]: r.int(entry.min, entry.max) });
    }
  }
  return {
    ok: true,
    changed: {
      player: {
        ...player,
        xp: player.xp + TUNING.xpPerScan * loc.tier,
        wallet: addRes(player.wallet, resources),
        inventory: [...player.inventory, ...items],
        lootLog: { ...player.lootLog, [locationId]: epoch },
      },
    },
    events: [{ type: 'looted', locationId, resources, items }],
  };
}

function claim(ctx: EngineContext, { player, base, region }: Snapshot, locationId: Id): Outcome {
  const loc = ctx.locations.get(locationId);
  if (!loc || !region) return fail('unknown location');
  if (region.owners[locationId] || base) return fail('location already claimed');
  if (player.lootLog[locationId] !== lootEpoch(ctx.now)) return fail('scan the QR code here first');
  if (player.baseIds.length >= TUNING.maxBasesPerPlayer) return fail('too many bases');

  const baseId = baseIdFor(locationId);
  const newBase: BaseState = {
    id: baseId, ownerId: player.id, locationId, version: 0, settledAt: ctx.now,
    stock: { wood: 200, stone: 200 },
    buildings: [
      { id: 'hall', kind: 'hall', level: 1 },
      { id: 'lumberyard_1', kind: 'lumberyard', level: 1 },
    ],
  };
  return {
    ok: true,
    changed: {
      base: newBase,
      region: { ...region, owners: { ...region.owners, [locationId]: player.id } },
      player: { ...player, xp: player.xp + TUNING.xpPerClaim, baseIds: [...player.baseIds, baseId] },
    },
    events: [{ type: 'claimed', locationId, baseId }],
  };
}

function ownedBase(snap: Snapshot): BaseState | string {
  if (!snap.base) return 'unknown base';
  if (snap.base.ownerId !== snap.player.id) return 'not your base';
  return snap.base;
}

function deposit(ctx: EngineContext, snap: Snapshot, baseId: Id): Outcome {
  const base = ownedBase(snap);
  if (typeof base === 'string') return fail(base);
  const resources = snap.player.wallet;
  if (Object.keys(resources).length === 0) return fail('nothing to deposit');
  const settled = settleBase(base, ctx.now);
  return {
    ok: true,
    changed: {
      base: { ...settled, stock: addRes(settled.stock, resources) },
      player: { ...snap.player, wallet: {} },
    },
    events: [{ type: 'deposited', baseId, resources }],
  };
}

function upgrade(ctx: EngineContext, snap: Snapshot, cmd: Extract<Command, { type: 'upgrade' }>): Outcome {
  const owned = ownedBase(snap);
  if (typeof owned === 'string') return fail(owned);
  const base = settleBase(owned, ctx.now);
  if (base.buildings.some((b) => b.upgrade)) return fail('builders are busy');

  const def = BUILDINGS[cmd.kind];
  const hallLevel = base.buildings.find((b) => b.kind === 'hall')?.level ?? 0;
  let target = cmd.buildingId ? base.buildings.find((b) => b.id === cmd.buildingId) : undefined;
  if (cmd.buildingId && (!target || target.kind !== cmd.kind)) return fail('unknown building');

  if (!target) {
    const sameKind = base.buildings.filter((b) => b.kind === cmd.kind);
    if (def.unique && sameKind.length > 0) return fail('only one allowed');
    if (sameKind.length >= hallLevel) return fail('upgrade the town hall to build more');
    target = { id: `${cmd.kind}_${sameKind.length + 1}`, kind: cmd.kind, level: 0 };
  }
  const toLevel = target.level + 1;
  if (toLevel > def.maxLevel) return fail('max level reached');
  if (cmd.kind !== 'hall' && toLevel > hallLevel) return fail('upgrade the town hall first');
  const cost = def.cost(toLevel);
  if (!canAfford(base.stock, cost)) return fail('not enough resources');

  const finishAt = ctx.now + def.buildMs(toLevel);
  const upgraded = { ...target, upgrade: { toLevel, finishAt } };
  const exists = base.buildings.some((b) => b.id === upgraded.id);
  return {
    ok: true,
    changed: {
      base: {
        ...base,
        stock: addRes(base.stock, cost, -1),
        buildings: exists ? base.buildings.map((b) => (b.id === upgraded.id ? upgraded : b)) : [...base.buildings, upgraded],
      },
    },
    events: [{ type: 'upgradeStarted', baseId: base.id, buildingId: upgraded.id, toLevel, finishAt }],
  };
}

function equip({ player }: Snapshot, itemUid: Id): Outcome {
  const item = player.inventory.find((i) => i.uid === itemUid);
  if (!item) return fail('item not in inventory');
  const slot = ITEMS[item.defId].slot;
  if (player.equipment[slot] === itemUid) return fail('already equipped');
  return {
    ok: true,
    changed: { player: { ...player, equipment: { ...player.equipment, [slot]: itemUid } } },
    events: [{ type: 'equipped', itemUid }],
  };
}
