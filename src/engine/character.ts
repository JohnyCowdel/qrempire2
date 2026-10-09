import { BASE_STATS, ITEMS, SLOTS, STAT_KINDS, STATS_PER_LEVEL, type Slot } from './content.ts';
import { rng } from './rng.ts';
import type { ItemInstance, PlayerState, Stats } from './types.ts';

export const levelForXp = (xp: number) => Math.floor(Math.sqrt(xp / 100)) + 1;

/** Item stats are derived from the item's seed, so only (defId, seed) needs storing. */
export function rollItemStats(item: ItemInstance): Partial<Stats> {
  const def = ITEMS[item.defId];
  const r = rng(item.seed);
  const out: Partial<Stats> = {};
  for (const k of STAT_KINDS) {
    const range = def.stats[k];
    if (range) out[k] = r.int(range[0], range[1]);
  }
  return out;
}

export const itemScore = (item: ItemInstance) =>
  Object.values(rollItemStats(item)).reduce((s, v) => s + (v ?? 0), 0);

export function characterStats(player: PlayerState): Stats {
  const level = levelForXp(player.xp);
  const stats = { ...BASE_STATS };
  for (const k of STAT_KINDS) stats[k] += STATS_PER_LEVEL[k] * (level - 1);
  for (const slot of SLOTS) {
    const item = player.inventory.find((i) => i.uid === player.equipment[slot]);
    if (!item) continue;
    const rolled = rollItemStats(item);
    for (const k of STAT_KINDS) stats[k] += rolled[k] ?? 0;
  }
  return stats;
}

export interface PlayerView {
  id: string;
  name: string;
  level: number;
  xp: number;
  nextLevelXp: number;
  stats: Stats;
  wallet: PlayerState['wallet'];
  equipment: Partial<Record<Slot, ItemView>>;
  inventory: ItemView[];
  baseIds: string[];
}

export interface ItemView {
  uid: string;
  defId: string;
  name: string;
  slot: Slot;
  rarity: string;
  stats: Partial<Stats>;
  equipped: boolean;
}

/** View model for the player page; the client renders the character + paper doll from this. */
export function playerView(player: PlayerState): PlayerView {
  const level = levelForXp(player.xp);
  const equippedUids = new Set(Object.values(player.equipment));
  const inventory = player.inventory.map((i): ItemView => {
    const def = ITEMS[i.defId];
    return { uid: i.uid, defId: i.defId, name: def.name, slot: def.slot, rarity: def.rarity, stats: rollItemStats(i), equipped: equippedUids.has(i.uid) };
  });
  const equipment: Partial<Record<Slot, ItemView>> = {};
  for (const v of inventory) if (v.equipped) equipment[v.slot] = v;
  return {
    id: player.id, name: player.name, level, xp: player.xp, nextLevelXp: 100 * level * level,
    stats: characterStats(player), wallet: player.wallet, equipment, inventory, baseIds: player.baseIds,
  };
}
