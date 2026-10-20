// Location page: procedural viewport + sidebar with the base and a building menu.
// Terrain, decorations and NPC movement are computed in the browser; the server only provides
// game state (owner, buildings, stock) and executes commands.
import {
  baseIdFor, BUILDINGS, LOCATION_TYPES, placementProblem, RESOURCE_KINDS, setTemplates, settleBase, traitTitle, type TerrainTemplate,
  type BaseState, type BuildingKind, type Command, type LocationTrait, type Resources, type SceneStructure,
} from '../engine/index.ts';
import { LocationView, STRUCTURE_EMOJI } from './location-view.ts';
import { applyDecor } from './location-decor.ts';
import { autoQuality, QUALITIES, setQuality, storedQuality, type Quality } from './quality.ts';

type BaseView = BaseState & { productionPerHour: Resources; storageCap: Resources; buildings: (BaseState['buildings'][number] & { name: string; remainingMs: number })[] };
interface ScenePayload {
  location: { id: string; name: string; type: keyof typeof LOCATION_TYPES; tier: number; lat: number; lng: number; traits: LocationTrait[] };
  ownerId?: string;
  chestAvailable: boolean;
  structures: SceneStructure[];
  error?: string;
}

const RES_ICON: Record<string, string> = { wood: '🪵', stone: '🪨', gold: '🪙', crystal: '💎' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const getJson = async <T>(url: string): Promise<T> => (await fetch(url)).json();

const locationId = decodeURIComponent(location.pathname.split('/').pop() ?? '');
const baseId = baseIdFor(locationId);
let playerId = (() => {
  try {
    return localStorage.getItem('qre.player') ?? 'you';
  } catch {
    return 'you';
  }
})();

const world = await getJson<{ worldSeed: number; now: number }>('/api/world');
setTemplates(await getJson<TerrainTemplate[]>('/api/templates')); // the terrain templates the traits refer to
// asset editor settings from the server (they win over this browser's own copy, so a phone looks like the PC)
const serverDecor = await getJson<unknown>('/api/decor').catch(() => null);
if (serverDecor) applyDecor(serverDecor);
// all locations, for quick switching (◀ ▶ buttons, the dropdown, or the [ and ] keys)
const allLocations = (await getJson<{ id: string; name: string; type: string; tier: number; traits?: string[] }[]>('/api/locations').catch(() => []))
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const locIndex = allLocations.findIndex((l) => l.id === locationId);
const goTo = (id: string | undefined) => { if (id && id !== locationId) location.href = `/location/${encodeURIComponent(id)}`; };
const goStep = (d: number) => allLocations.length && goTo(allLocations[(locIndex + d + allLocations.length) % allLocations.length].id);
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === '[') goStep(-1);
  else if (e.key === ']') goStep(1);
});
const traitNames = (t?: string[]) => (t ?? []).map(traitTitle).join(', ');
const locSwitcher = () => allLocations.length ? `
  <div class="switcher">
    <button id="loc-prev" class="btn" title="Previous location ( [ )">◀</button>
    <select id="loc-pick">${allLocations.map((l) => `<option value="${esc(l.id)}"${l.id === locationId ? ' selected' : ''}>${esc(l.name)} ${'★'.repeat(l.tier)} – ${esc(traitNames(l.traits))}</option>`).join('')}</select>
    <button id="loc-next" class="btn" title="Next location ( ] )">▶</button>
  </div>` : '';
const clockOffset = world.now - Date.now();
const now = () => Date.now() + clockOffset;

const side = document.getElementById('side')!;
let scene = await getJson<ScenePayload>(`/api/location/${encodeURIComponent(locationId)}?player=${playerId}`);
if (scene.error) {
  side.innerHTML = `<p>Unknown location.</p><a href="/">← World map</a>`;
  throw new Error(scene.error);
}
let base: BaseView | null = null;
let wallet: Resources = {};
let selected: BuildingKind | undefined;
let message = '';

const view = new LocationView(document.getElementById('viewport') as HTMLCanvasElement, world.worldSeed, scene.location as any, now);
view.onSelect = (kind) => select(kind in BUILDINGS ? (kind as BuildingKind) : undefined);
const fpsEl = document.getElementById('fps');
(window as any).qreView = view; // dev: inspect from the console
view.onFps = (fps, stats) => {
  (window as any).qreStats = { fps, ...stats };
  if (fpsEl) fpsEl.textContent = `${fps} fps · ${view.quality} · ${stats.calls} draw calls · ${(stats.triangles / 1e6).toFixed(2)}M tris`;
};
document.title = `${scene.location.name} – QR Empire`;

async function refresh(): Promise<void> {
  [scene, base] = await Promise.all([
    getJson<ScenePayload>(`/api/location/${encodeURIComponent(locationId)}?player=${playerId}`),
    getJson<BaseView | null>(`/api/base/${baseId}`),
  ]);
  wallet = (await getJson<{ wallet: Resources }>(`/api/player/${playerId}`)).wallet;
  view.setStructures(scene.structures);
  render();
}

async function send(command: Command, okText: string): Promise<boolean> {
  const res = await fetch('/api/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId, command }),
  });
  const out = await res.json();
  message = out.ok ? `✅ ${okText}` : `⚠️ ${out.error}`;
  await refresh();
  return out.ok;
}

function select(kind?: BuildingKind): void {
  selected = selected === kind ? undefined : kind;
  view.setHighlight(selected);
  render();
}

// ---- formatting ----

const fmtRes = (r: Resources) =>
  RESOURCE_KINDS.filter((k) => r[k]).map((k) => `${RES_ICON[k]} ${Math.floor(r[k]!)}`).join('  ') || '–';
const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const affordable = (stock: Resources, cost: Resources) => RESOURCE_KINDS.every((k) => (stock[k] ?? 0) >= (cost[k] ?? 0));

// ---- building menu logic (mirrors the engine's rules; the server re-checks everything) ----

interface Action {
  label: string;
  cost: Resources;
  ms: number;
  command?: Command;
  reason?: string;
}

/** The "build a new one" action of a kind (for the build bar), or undefined if none can ever be added. */
function newBuildAction(kind: BuildingKind, stock: Resources): Action | undefined {
  return actionsFor(kind, stock, true).find((a) => !(a.command && 'buildingId' in a.command && a.command.buildingId));
}

function actionsFor(kind: BuildingKind, stock: Resources, includeNew = false): Action[] {
  const def = BUILDINGS[kind];
  if (!base) return includeNew ? [{ label: 'Build', cost: def.cost(1), ms: def.buildMs(1), reason: scene.ownerId ? 'not your base' : 'claim this location first' }] : [];
  const mine = base.ownerId === playerId;
  const hall = base.buildings.find((b) => b.kind === 'hall')?.level ?? 0;
  const busy = base.buildings.some((b) => b.upgrade);
  const blocked = (cost: Resources, extra?: string) =>
    !mine ? 'not your base' : extra ?? (busy ? 'builders are busy' : !affordable(stock, cost) ? 'not enough resources' : undefined);

  const actions: Action[] = [];
  const existing = base.buildings.filter((b) => b.kind === kind);
  for (const b of existing) {
    if (b.upgrade) continue; // under construction: the card status shows the countdown
    const next = b.level + 1;
    const cost = next <= def.maxLevel ? def.cost(next) : {};
    const extra = next > def.maxLevel ? 'max level' : kind !== 'hall' && next > hall ? `needs Town Hall ${next}` : undefined;
    actions.push({ label: `Upgrade lvl ${b.level} → ${next}`, cost, ms: next <= def.maxLevel ? def.buildMs(next) : 0, command: { type: 'upgrade', baseId, kind, buildingId: b.id }, reason: blocked(cost, extra) });
  }
  if (includeNew && (!def.unique || existing.length === 0)) {
    const extra = kind !== 'hall' && existing.length >= hall ? `Town Hall ${hall} allows ${hall}` : undefined;
    actions.push({ label: existing.length ? 'Build another' : 'Build', cost: def.cost(1), ms: def.buildMs(1), command: { type: 'upgrade', baseId, kind }, reason: blocked(def.cost(1), extra) });
  }
  return actions;
}

// ---- rendering ----

function render(): void {
  const loc = scene.location;
  const type = LOCATION_TYPES[loc.type];
  const live = base ? settleBase(base, now()) : null; // lazy economy, evaluated in the browser
  const stock = live?.stock ?? {};
  const owner = scene.ownerId
    ? scene.ownerId === playerId ? '<b class="ok">Your base</b>' : `Owned by <b>${esc(scene.ownerId)}</b>`
    : `Unclaimed <button id="claim" class="btn">Claim (dev: skips QR scan)</button>`;

  side.innerHTML = `
    <a href="/" class="back">← World map</a> · <a href="/editor" class="back">Asset editor</a>
    ${locSwitcher()}
    <h1>${type?.emoji ?? ''} ${esc(loc.name)} <span class="stars">${'★'.repeat(loc.tier)}</span></h1>
    <div class="muted">${type?.name ?? loc.type}${scene.chestAvailable ? ' · 🎁 a chest is waiting here' : ''}</div>
    <div class="traits">${(loc.traits ?? []).map((t) => `<span class="trait">${esc(traitTitle(t))}</span>`).join('')}</div>
    <div class="row">${owner}</div>
    <label class="row muted">Playing as <input id="player" value="${esc(playerId)}" maxlength="40"></label>
    <label class="row muted">Graphics <select id="quality">${qualityOptions()}</select></label>
    ${base ? `
      <h2>Stock</h2>
      <div class="stock">${RESOURCE_KINDS.map((k) => `
        <div>${RES_ICON[k]} <b data-res="${k}">${Math.floor(stock[k] ?? 0)}</b><span class="muted"> / ${base!.storageCap[k] ?? 0}</span>
        <span class="rate">${base!.productionPerHour[k] ? `+${base!.productionPerHour[k]}/h` : ''}</span></div>`).join('')}
      </div>
      <div class="row muted">Carrying: ${fmtRes(wallet)} ${base.ownerId === playerId && Object.keys(wallet).length ? '<button id="deposit" class="btn">Deposit</button>' : ''}</div>` : ''}
    <h2>Buildings</h2>
    <div class="muted small">New buildings: pick one in the build bar over the map and place it.</div>
    <div class="cards">${(Object.keys(BUILDINGS) as BuildingKind[]).filter((k) => base?.buildings.some((b) => b.kind === k)).map((kind) => card(kind, stock)).join('')}</div>
    <div class="msg">${esc(message)}</div>`;

  side.querySelector('#loc-prev')?.addEventListener('click', () => goStep(-1));
  side.querySelector('#loc-next')?.addEventListener('click', () => goStep(1));
  side.querySelector<HTMLSelectElement>('#loc-pick')?.addEventListener('change', (e) => goTo((e.target as HTMLSelectElement).value));
  side.querySelector('#claim')?.addEventListener('click', async () => {
    if (await send({ type: 'scan', locationId }, 'Chest looted')) await send({ type: 'claim', locationId }, 'Location claimed!');
  });
  side.querySelector<HTMLSelectElement>('#quality')!.addEventListener('change', (e) => setQuality((e.target as HTMLSelectElement).value as Quality | 'auto'));
  side.querySelector('#deposit')?.addEventListener('click', () => send({ type: 'deposit', baseId }, 'Resources deposited'));
  side.querySelector<HTMLInputElement>('#player')!.addEventListener('change', (e) => {
    playerId = (e.target as HTMLInputElement).value.trim() || 'you';
    try {
      localStorage.setItem('qre.player', playerId);
    } catch {
      // ignore
    }
    message = '';
    refresh();
  });
  side.querySelectorAll<HTMLElement>('.card').forEach((el) => el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    select(el.dataset.kind as BuildingKind);
  }));
  side.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((btn) => btn.addEventListener('click', () => {
    send(JSON.parse(btn.dataset.cmd!), `${btn.dataset.name} started`);
  }));
  renderBuildBar(stock);
}

// ---- build bar: icons over the map; hover = info, click = drag a ghost onto the map, click to place ----
const buildBar = document.getElementById('buildbar')!;
const tip = document.getElementById('buildtip')!;
const hintEl = document.getElementById('buildhint')!;
function renderBuildBar(stock: Resources): void {
  buildBar.innerHTML = (Object.keys(BUILDINGS) as BuildingKind[]).map((kind) => {
    const a = newBuildAction(kind, stock);
    return `<button class="bb${a?.reason || !a ? ' off' : ''}" data-kind="${kind}">${STRUCTURE_EMOJI[kind] ?? '❔'}</button>`;
  }).join('');
  buildBar.querySelectorAll<HTMLButtonElement>('.bb').forEach((btn) => {
    const kind = btn.dataset.kind as BuildingKind;
    btn.onmouseenter = () => showTip(btn, kind, stock);
    btn.onmouseleave = () => tip.classList.remove('show');
    btn.onclick = () => startBuild(kind, stock);
  });
}
function showTip(btn: HTMLElement, kind: BuildingKind, stock: Resources): void {
  const def = BUILDINGS[kind], a = newBuildAction(kind, stock);
  const count = base?.buildings.filter((b) => b.kind === kind).length ?? 0;
  const purpose = [def.production ? `produces ${fmtRes(def.production(1))}/h per level` : '', def.storage ? 'adds storage' : '', def.unique ? 'only one per base' : ''].filter(Boolean).join(' · ');
  tip.innerHTML = `<b>${esc(def.name)}</b>${count ? ` <span class="muted">(${count} built)</span>` : ''}
    <div class="muted small">${esc(purpose || '–')}</div>
    ${a ? `<div class="small">${fmtRes(a.cost)} · ⏱ ${fmtTime(a.ms)}</div>${a.reason ? `<div class="reason small">${esc(a.reason)}</div>` : '<div class="ok small">click, then place it on the map</div>'}` : '<div class="reason small">only one allowed</div>'}`;
  const r = btn.getBoundingClientRect();
  tip.style.left = `${r.left}px`;
  tip.style.top = `${r.top - 8}px`;
  tip.classList.add('show');
}
function startBuild(kind: BuildingKind, stock: Resources): void {
  const a = newBuildAction(kind, stock);
  if (!a || a.reason) { message = `⚠️ ${a?.reason ?? 'only one allowed'}`; render(); return; }
  tip.classList.remove('show');
  const name = BUILDINGS[kind].name;
  hintEl.textContent = `Placing ${name} – click to build · R: rotate · Esc / right-click: cancel`;
  hintEl.classList.add('show');
  view.startPlacement(kind,
    (x, z) => placementProblem(world.worldSeed, scene.location as any, base ?? undefined, x, z),
    async (x, z, rot) => {
      hintEl.classList.remove('show');
      await send({ type: 'upgrade', baseId, kind, at: { x, y: z, rot } }, `${name} construction started`);
    },
    (problem) => { hintEl.textContent = problem ? `⚠️ ${problem}` : `Placing ${name} – click to build · R: rotate · Esc / right-click: cancel`; });
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hintEl.classList.remove('show'); });
document.getElementById('viewport')!.addEventListener('contextmenu', () => hintEl.classList.remove('show'));

/** Graphics dropdown: auto (device-based) or a fixed preset. Changing it reloads the page. */
function qualityOptions(): string {
  const chosen = storedQuality();
  const name = (q: Quality) => q[0].toUpperCase() + q.slice(1);
  return [
    `<option value="auto"${chosen ? '' : ' selected'}>Auto (${name(autoQuality())})</option>`,
    ...QUALITIES.map((q) => `<option value="${q}"${chosen === q ? ' selected' : ''}>${name(q)}</option>`),
  ].join('');
}

function card(kind: BuildingKind, stock: Resources): string {
  const def = BUILDINGS[kind];
  const built = base?.buildings.filter((b) => b.kind === kind) ?? [];
  const status = built.map((b) => b.upgrade
    ? `lvl ${b.level} → ${b.upgrade.toLevel} <span data-finish="${b.upgrade.finishAt}">${fmtTime(b.upgrade.finishAt - now())}</span>`
    : `lvl ${b.level}`).join(', ');
  const perks = [def.production ? `produces ${fmtRes(def.production(1))}/h per level` : '', def.storage ? 'adds storage' : ''].filter(Boolean).join(' · ');
  return `
    <div class="card${selected === kind ? ' selected' : ''}" data-kind="${kind}">
      <div class="card-head"><span class="icon">${STRUCTURE_EMOJI[kind] ?? '❔'}</span><b>${def.name}</b><span class="muted">${status || 'not built'}</span></div>
      <div class="muted small">${perks}</div>
      ${actionsFor(kind, stock).map((a) => `
        <div class="action">
          <span class="small">${fmtRes(a.cost)} · ⏱ ${fmtTime(a.ms)}</span>
          <button class="btn" ${a.reason ? `disabled title="${esc(a.reason)}"` : ''}
            data-cmd='${esc(JSON.stringify(a.command ?? null))}' data-name="${esc(def.name)}">${a.label}</button>
        </div>${a.reason ? `<div class="reason small">${esc(a.reason)}</div>` : ''}`).join('')}
    </div>`;
}

// Live numbers: stock grows and countdowns tick without refetching; refetch when a build finishes.
setInterval(() => {
  if (!base) return;
  const stock = settleBase(base, now()).stock;
  side.querySelectorAll<HTMLElement>('[data-res]').forEach((el) => (el.textContent = String(Math.floor(stock[el.dataset.res as keyof Resources] ?? 0))));
  let finished = false;
  side.querySelectorAll<HTMLElement>('[data-finish]').forEach((el) => {
    const left = Number(el.dataset.finish) - now();
    el.textContent = fmtTime(left);
    if (left <= 0) finished = true;
  });
  if (finished) refresh();
}, 1000);

await refresh();
