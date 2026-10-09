// Public surface of the engine. Imported by the server AND the browser client,
// so the client can render scenes / project timers locally without extra requests.
import { BUILDINGS } from './content.ts';
import { productionPerHour, settleBase, storageCap } from './economy.ts';
import type { BaseState, Millis } from './types.ts';

export * from './types.ts';
export * from './content.ts';
export * from './rng.ts';
export * from './economy.ts';
export * from './character.ts';
export * from './geo.ts';
export * from './scene.ts';
export * from './map.ts';
export * from './commands.ts';

/** View model for the base management page: the base projected to `now`, plus derived numbers. */
export function baseView(base: BaseState, now: Millis) {
  const settled = settleBase(base, now);
  return {
    ...settled,
    productionPerHour: productionPerHour(settled.buildings),
    storageCap: storageCap(settled.buildings),
    buildings: settled.buildings.map((b) => ({
      ...b,
      name: BUILDINGS[b.kind].name,
      nextCost: b.level < BUILDINGS[b.kind].maxLevel ? BUILDINGS[b.kind].cost(b.level + 1) : undefined,
      remainingMs: b.upgrade ? b.upgrade.finishAt - now : 0,
    })),
  };
}
