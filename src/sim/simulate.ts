// Headless simulation: N bots play for D days of game time against the real service
// layer + in-memory repository. Deterministic (seeded), so balance changes can be
// compared run-to-run, and DB op counts give a direct cost estimate.
import { createHash } from 'node:crypto';
import {
  BUILDINGS, itemScore, ITEMS, rngFor, sceneToAscii, SLOTS,
  type BuildingKind, type EngineContext, type PlayerState,
} from '../engine/index.ts';
import { GameService } from '../server/game-service.ts';
import { signQr } from '../server/qr.ts';
import { DEMO_CENTER as CENTER, makeLocations } from '../server/world.ts';
import { MemoryRepository } from '../storage/memory.ts';

const SEED = Number(process.env.SEED ?? 42);
const BOTS = Number(process.env.BOTS ?? 40);
const DAYS = Number(process.env.DAYS ?? 7);
const SECRET = 'sim-secret';
const START = Date.UTC(2026, 9, 5, 6, 0);

async function run() {
  const locations = makeLocations(SEED, CENTER, 60);
  const locList = [...locations.values()];
  let now = START;
  const ctx = (): EngineContext => ({ worldSeed: SEED, now, locations });
  const repo = new MemoryRepository();
  const game = new GameService(repo, ctx, SECRET);
  const tokens = new Map(await Promise.all(locList.map(async (l) => [l.id, await signQr(SECRET, l.id)] as const)));

  const counts: Record<string, { ok: number; fail: number }> = {};
  const tally = (type: string, ok: boolean) => {
    counts[type] ??= { ok: 0, fail: 0 };
    counts[type][ok ? 'ok' : 'fail']++;
  };

  const bots = Array.from({ length: BOTS }, (_, i) => ({ id: `bot${i}`, next: START + rngFor(SEED, 'start', i).int(0, 3 * 3600_000) }));
  const end = START + DAYS * 86400_000;
  const wallStart = performance.now();

  while (true) {
    bots.sort((a, b) => a.next - b.next);
    const bot = bots[0];
    if (bot.next > end) break;
    now = bot.next;
    const r = rngFor(SEED, 'act', bot.id, now);

    // Outdoor: walk to a location and scan its QR.
    const loc = r.pick(locList);
    const scan = await game.scanQr(bot.id, tokens.get(loc.id)!, { lat: loc.lat + 0.0002, lng: loc.lng });
    tally('scan', scan.ok);
    if (scan.ok && r.chance(0.5)) tally('claim', (await game.execute(bot.id, { type: 'claim', locationId: loc.id })).ok);

    // Indoor: manage bases.
    const me = await game.playerPage(bot.id);
    for (const baseId of me.baseIds) {
      if (Object.keys(me.wallet).length) tally('deposit', (await game.execute(bot.id, { type: 'deposit', baseId })).ok);
      const base = (await game.basePage(baseId))!;
      const existing = r.pick(base.buildings);
      const kind = r.chance(0.6) ? existing.kind : r.pick(Object.keys(BUILDINGS) as BuildingKind[]);
      const buildingId = kind === existing.kind ? existing.id : undefined;
      tally('upgrade', (await game.execute(bot.id, { type: 'upgrade', baseId, kind, buildingId })).ok);
    }

    // Character: equip the best item per slot.
    for (const slot of SLOTS) {
      const best = me.inventory.filter((i) => i.slot === slot).sort((a, b) => sum(b.stats) - sum(a.stats))[0];
      if (best && !best.equipped) tally('equip', (await game.execute(bot.id, { type: 'equip', itemUid: best.uid })).ok);
    }

    // Next session in 1-4 h; nobody plays at night.
    let next = now + r.int(60, 240) * 60_000;
    const hour = new Date(next).getUTCHours();
    if (hour >= 21 || hour < 6) next += ((30 - hour) % 24) * 3600_000;
    bot.next = next;
  }
  const wallMs = performance.now() - wallStart;

  // ---- report ----
  const players = [...repo.docs].filter(([k]) => k.startsWith('player:')).map(([, v]) => JSON.parse(v) as PlayerState);
  const totalCmds = Object.values(counts).reduce((s, c) => s + c.ok + c.fail, 0);
  console.log(`\n== ${BOTS} bots, ${DAYS} days, seed ${SEED} — simulated in ${wallMs.toFixed(0)} ms ==`);
  console.table(counts);
  console.log('DB ops:', repo.stats, `| docs stored: ${repo.docs.size}`);
  console.log(`≈ ${(repo.stats.readCalls / totalCmds).toFixed(2)} read calls & ${(repo.stats.commits / totalCmds).toFixed(2)} commits per command (incl. page reads)`);

  const top = await Promise.all(players.map((p) => game.playerPage(p.id)));
  top.sort((a, b) => b.xp - a.xp);
  console.log('\nTop players:');
  for (const p of top.slice(0, 5)) {
    const gear = Object.values(p.equipment).map((i) => i.name).join(', ');
    console.log(`  ${p.id.padEnd(6)} lvl ${p.level} xp ${p.xp} bases ${p.baseIds.length} atk ${p.stats.attack} def ${p.stats.defense} | ${gear}`);
  }

  const bases = await Promise.all(top.flatMap((p) => p.baseIds).map((id) => game.basePage(id)));
  const richest = bases.sort((a, b) => level(b!) - level(a!))[0]!;
  console.log(`\nMost developed base ${richest.id} (owner ${richest.ownerId}):`);
  for (const b of richest.buildings) console.log(`  ${b.name.padEnd(12)} lvl ${b.level}${b.upgrade ? ` -> ${b.upgrade.toLevel} in ${Math.ceil(b.remainingMs / 60000)} min` : ''}`);
  console.log('  stock', fmt(richest.stock), '| /h', fmt(richest.productionPerHour));

  const scene = (await game.locationPage(richest.locationId, richest.ownerId))!;
  console.log(`\nLocation scene ${scene.location.name} (tier ${scene.location.tier}):  ~ water . sand , grass T forest ^ rock * snow  m npc  $ chest  capitals = buildings`);
  console.log(sceneToAscii(scene));

  const map = await game.mapPage({ south: CENTER.lat - 0.06, west: CENTER.lng - 0.09, north: CENTER.lat + 0.06, east: CENTER.lng + 0.09 });
  console.log(`\nMap view: ${map.markers.length} markers (${map.markers.filter((m) => m.ownerId).length} owned), ${map.units.length} roaming units`);

  const items = players.flatMap((p) => p.inventory);
  const best = items.sort((a, b) => itemScore(b) - itemScore(a))[0];
  if (best) console.log(`Best item dropped: ${ITEMS[best.defId].name} (score ${itemScore(best)})`);

  return createHash('sha256').update(JSON.stringify([...repo.docs].sort())).digest('hex').slice(0, 16);
}

const sum = (o: object) => Object.values(o).reduce((s: number, v) => s + (v ?? 0), 0);
const level = (b: { buildings: { level: number }[] }) => b.buildings.reduce((s, x) => s + x.level, 0);
const fmt = (r: object) => Object.entries(r).map(([k, v]) => `${k}:${Math.floor(v)}`).join(' ');

const h1 = await run();
if (process.argv.includes('--verify')) {
  const h2 = await run();
  console.log(`\nDeterminism: ${h1 === h2 ? 'OK' : 'MISMATCH'} (${h1} vs ${h2})`);
} else {
  console.log(`\nFinal state hash: ${h1}  (run with --verify to check determinism)`);
}
