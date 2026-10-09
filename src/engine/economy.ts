// Lazy economy: nothing ticks on the server. A base stores (stock, settledAt) and
// pending upgrades as (toLevel, finishAt); the state at any time t is computed on read.
import { BUILDINGS, RESOURCE_KINDS } from './content.ts';
import type { BaseState, BuildingState, Millis, Resources } from './types.ts';

const HOUR = 3600_000;

export function addRes(a: Resources, b: Resources, sign = 1): Resources {
  const out: Resources = { ...a };
  for (const k of RESOURCE_KINDS) {
    if (b[k]) out[k] = (out[k] ?? 0) + sign * b[k];
  }
  return out;
}

export const canAfford = (stock: Resources, cost: Resources) =>
  RESOURCE_KINDS.every((k) => (stock[k] ?? 0) >= (cost[k] ?? 0));

export function productionPerHour(buildings: readonly BuildingState[]): Resources {
  let rate: Resources = {};
  for (const b of buildings) {
    const prod = BUILDINGS[b.kind].production;
    if (prod && b.level > 0) rate = addRes(rate, prod(b.level));
  }
  return rate;
}

export function storageCap(buildings: readonly BuildingState[]): Resources {
  let cap: Resources = {};
  for (const b of buildings) {
    const storage = BUILDINGS[b.kind].storage;
    if (storage && b.level > 0) cap = addRes(cap, storage(b.level));
  }
  return cap;
}

function accrue(stock: Resources, buildings: readonly BuildingState[], dt: Millis): Resources {
  if (dt <= 0) return stock;
  const rate = productionPerHour(buildings);
  const cap = storageCap(buildings);
  const out: Resources = { ...stock };
  for (const k of RESOURCE_KINDS) {
    const r = rate[k];
    if (!r) continue;
    const cur = out[k] ?? 0;
    // Production stops at the cap, but deposits above the cap are never destroyed.
    out[k] = Math.max(cur, Math.min(cap[k] ?? 0, cur + (r * dt) / HOUR));
  }
  return out;
}

/**
 * Pure: advance a base to `now`, completing finished upgrades in chronological order
 * so production rates change exactly when each building finished. Used both for
 * read-only projections (views) and right before a mutation is applied.
 */
export function settleBase(base: BaseState, now: Millis): BaseState {
  if (now <= base.settledAt) return base;
  let buildings = base.buildings;
  let stock = base.stock;
  let t = base.settledAt;
  const finished = buildings
    .filter((b) => b.upgrade && b.upgrade.finishAt <= now)
    .sort((a, b) => a.upgrade!.finishAt - b.upgrade!.finishAt);
  for (const done of finished) {
    const at = done.upgrade!.finishAt;
    stock = accrue(stock, buildings, at - t);
    buildings = buildings.map((b) => (b.id === done.id ? { id: b.id, kind: b.kind, level: b.upgrade!.toLevel } : b));
    t = at;
  }
  stock = accrue(stock, buildings, now - t);
  return { ...base, buildings, stock, settledAt: now };
}
