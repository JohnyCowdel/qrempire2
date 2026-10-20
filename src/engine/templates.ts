// Terrain templates = location traits. Every trait a location can have is a NAMED template
// (e.g. 'curvy-river', 'medium-central-highspot', 'iron-ore'): its kind tells the engine how to
// apply it, its params / shape say how exactly. A location's traits are template names; the
// engine combines them (scene.ts). The asset editor creates / edits the templates, the dev server
// stores them in data/templates.json – server and browser use the same list, so what the editor
// previews is what locations get.

export type TemplateKind = 'highspot' | 'lake' | 'pond' | 'river' | 'forest' | 'rocky' | 'quarry' | 'climate' | 'valley' | 'fields' | 'perimeter' | 'cliff';

/** Templates of one group exclude each other (a location has at most one of each group). */
export const TEMPLATE_GROUP: Record<TemplateKind, string> = {
  highspot: 'centre', lake: 'lake', pond: 'bog', river: 'river', forest: 'forest', rocky: 'rocky',
  quarry: 'deposit', climate: 'climate', valley: 'valley', fields: 'fields', perimeter: 'perimeter', cliff: 'cliff',
};

export interface TerrainTemplate {
  name: string; // the trait id
  title: string; // display name
  kind: TemplateKind;
  chance: number; // roll weight within its group (a group's weights add up to the chance it appears at all)
  params: Record<string, number | string | boolean | [number, number]>;
  /** highspot / lake / pond: closed outline [x, y, extra] around 0 (extra: highspot height multiplier); river: [u, v, width] */
  points?: number[][];
  /** forest: outlines in map coordinates (−1..1 = map edge) */
  blobs?: { points: number[][] }[];
}

/** Default params per kind (new templates start from these; missing params fall back to them). */
export const KIND_DEFAULTS: Record<TemplateKind, TerrainTemplate['params']> = {
  highspot: { radius: 0.17, slope: 0.16, height: 0.25, tierHeight: 0.02, calm: 0.22, rimRock: 0.22 },
  lake: {
    mode: 'nearby', radius: 0.11, ringWidth: 0.05, depth: 0.08, bankSlope: [0.3, 0.7],
    color: '#2f5f8f', opacity: 0.88, reflectivity: 0.8, waveScale: 1.4, waveSpeed: 0.5, waveStrength: 0.03, shoreTexture: 'sand', shoreWidth: 0.03, bedTexture: 'sand',
  },
  pond: {
    count: [1, 3], size: [0.035, 0.065], depth: 0.05, bankSlope: [0.35, 0.8], bog: 0.58,
    color: '#3e5b3c', opacity: 0.93, reflectivity: 0.55, waveScale: 2.4, waveSpeed: 0.2, waveStrength: 0.012, shoreTexture: 'path', shoreWidth: 0.02, bedTexture: 'path',
  },
  river: {
    mode: 'line', width: [0.02, 0.032], depth: 0.06, bankSlope: [0.3, 0.7], straight: 1,
    color: '#36708c', opacity: 0.85, reflectivity: 0.7, waveScale: 1.8, waveSpeed: 1.4, waveStrength: 0.04, shoreTexture: 'rock', shoreWidth: 0.025, bedTexture: 'sand',
  },
  forest: { amount: 0.45, edge: 0.05, rotate: true },
  rocky: { amount: 0.35, scale: 7, threshold: 0.55 },
  quarry: { quarry: 'stone', radius: [0.08, 0.11], distance: [0.15, 0.3] },
  climate: { moist: 0, height: 0, rock: 0 },
  valley: { ridge: 0.2, width: 0.12 },
  fields: { threshold: 0.5 },
  perimeter: { moist: 0.4, fields: 0 },
  // cliffs: steep ground (any cause – high spot, banks, valley) gets this cliff type
  cliff: {
    minSlope: 0.8, fullSlope: 1.4, p1: 0.6, color: '#868c93', gridSize: 1, protrude: 0.08, bulge: 0.2, topBulge: 0.1, topBulgeAt: 0.15, bottomBulge: 0.15, bottomBulgeAt: 0.85, depth: 0.5,
    gridJitter: 0.5, reachJitter: 0.2, chamfer: 0.12, sink: 0.25, rubblePerRock: 2, rubbleSize: [0.06, 0.2],
  },
};
/** Allowed values of string params (editor dropdowns). */
export const PARAM_OPTIONS: Record<string, string[]> = {
  mode: ['nearby', 'island', 'peninsula', 'line', 'loop'],
  quarry: ['stone', 'iron', 'copper', 'mud', 'salt'],
  shoreTexture: ['grass', 'field', 'sand', 'rock', 'path'],
  bedTexture: ['grass', 'field', 'sand', 'rock', 'path'],
};

/** Cliff settings of a location: its cliff template, else the first cliff template, else the defaults. */
export function cliffOf(traits: string[]): Record<string, any> {
  const t = traits.map((n) => byName.get(n)).find((x) => x?.kind === 'cliff') ?? templates.find((x) => x.kind === 'cliff');
  return { ...KIND_DEFAULTS.cliff, ...(t?.params ?? {}) };
}

/** Water look of one environment (from its template's params). */
export interface WaterLook {
  color: string; opacity: number; reflectivity: number; waveScale: number; waveSpeed: number; waveStrength: number;
  shoreTexture: string; shoreWidth: number; bedTexture: string;
}
export type WaterLooks = Record<'lake' | 'pond' | 'river', WaterLook>;
/** The water looks of a location: each environment from the location's template of that kind (else the kind defaults). */
export function waterLooks(traits: string[]): WaterLooks {
  const look = (kind: 'lake' | 'pond' | 'river'): WaterLook => {
    const t = traits.map((n) => byName.get(n)).find((x) => x?.kind === kind);
    return { ...KIND_DEFAULTS[kind], ...(t?.params ?? {}) } as unknown as WaterLook;
  };
  return { lake: look('lake'), pond: look('pond'), river: look('river') };
}

const blob = (cx: number, cy: number, r: number, wob: number, n = 8, ph = 0): { points: number[][] } => ({
  points: Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, rr = r * (1 + wob * Math.sin(i * 2.3 + ph));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  }),
});
const ring = (n: number, wob: number, ph = 0, extra?: number) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2, r = 1 + wob * Math.sin(i * 2.1 + ph);
  return extra === undefined ? [Math.cos(a) * r, Math.sin(a) * r] : [Math.cos(a) * r, Math.sin(a) * r, extra];
});

/** The built-in set (the former fixed traits) – used until data/templates.json exists. */
export const DEFAULT_TEMPLATES: TerrainTemplate[] = [
  { name: 'central-high-spot', title: 'Central high spot', kind: 'highspot', chance: 0.6, params: { ...KIND_DEFAULTS.highspot }, points: ring(8, 0.08, 0, 1) },
  { name: 'fields', title: 'Fields', kind: 'fields', chance: 0.35, params: { threshold: 0.5 } },
  { name: 'dry', title: 'Dry', kind: 'climate', chance: 0.25, params: { moist: -0.18, height: 0.04, rock: 0.04 } },
  { name: 'wet', title: 'Wet', kind: 'climate', chance: 0.25, params: { moist: 0.12, height: -0.03, rock: 0 } },
  { name: 'bog', title: 'Bog', kind: 'pond', chance: 0.2, params: { ...KIND_DEFAULTS.pond }, points: [[1, 0], [0.6, 0.75], [-0.3, 0.9], [-0.95, 0.3], [-0.85, -0.5], [-0.1, -0.95], [0.7, -0.65]] },
  { name: 'valley', title: 'Valley', kind: 'valley', chance: 0.25, params: { ...KIND_DEFAULTS.valley } },
  { name: 'river-direct', title: 'Straight river', kind: 'river', chance: 0.12, params: { ...KIND_DEFAULTS.river, straight: 0.3 }, points: [[-1, 0, 1], [-0.5, 0.3, 1], [0, 0, 1.1], [0.5, -0.3, 1], [1, 0, 1]] },
  { name: 'river-curvy', title: 'Curvy river', kind: 'river', chance: 0.15, params: { ...KIND_DEFAULTS.river }, points: [[-1, 0.2, 1], [-0.6, -0.4, 0.9], [-0.2, 0.4, 1.2], [0.2, -0.3, 1], [0.6, 0.35, 0.9], [1, -0.1, 1]] },
  { name: 'river-peninsula', title: 'River peninsula', kind: 'river', chance: 0.08, params: { ...KIND_DEFAULTS.river, mode: 'loop' }, points: [[-1, 0, 1], [1, 0, 1]] },
  { name: 'lake-island', title: 'Lake island', kind: 'lake', chance: 0.08, params: { ...KIND_DEFAULTS.lake, mode: 'island' }, points: ring(8, 0.1, 1) },
  { name: 'lake-peninsula', title: 'Lake peninsula', kind: 'lake', chance: 0.08, params: { ...KIND_DEFAULTS.lake, mode: 'peninsula' }, points: ring(8, 0.1, 2) },
  { name: 'lake-nearby', title: 'Lake nearby', kind: 'lake', chance: 0.2, params: { ...KIND_DEFAULTS.lake }, points: [[1, 0], [0.7, 0.6], [0, 0.85], [-0.6, 0.7], [-1.05, 0.05], [-0.7, -0.65], [0.05, -0.9], [0.75, -0.55]] },
  { name: 'perimeter-wood', title: 'Woods around', kind: 'perimeter', chance: 0.5, params: { moist: 0.4, fields: 0 } },
  { name: 'perimeter-meadows', title: 'Meadows around', kind: 'perimeter', chance: 0.25, params: { moist: -0.45, fields: 0 } },
  { name: 'perimeter-fields', title: 'Fields around', kind: 'perimeter', chance: 0.25, params: { moist: -0.3, fields: 1.2 } },
  { name: 'forest-patches', title: 'Forest patches', kind: 'forest', chance: 0.3, params: { ...KIND_DEFAULTS.forest }, blobs: [blob(-0.45, -0.3, 0.22, 0.25), blob(0.4, 0.45, 0.18, 0.3, 8, 2)] },
  { name: 'rocky', title: 'Rocky', kind: 'rocky', chance: 0.3, params: { ...KIND_DEFAULTS.rocky } },
  { name: 'iron-ore', title: 'Iron ore', kind: 'quarry', chance: 0.12, params: { quarry: 'iron', radius: [0.08, 0.11] } },
  { name: 'copper-ore', title: 'Copper ore', kind: 'quarry', chance: 0.1, params: { quarry: 'copper', radius: [0.08, 0.11] } },
  { name: 'stone-quarry', title: 'Stone quarry', kind: 'quarry', chance: 0.15, params: { quarry: 'stone', radius: [0.08, 0.11] } },
  { name: 'mud-quarry', title: 'Mud quarry', kind: 'quarry', chance: 0.08, params: { quarry: 'mud', radius: [0.08, 0.11] } },
  { name: 'grey-cliffs', title: 'Grey cliffs', kind: 'cliff', chance: 0.6, params: { ...KIND_DEFAULTS.cliff } },
  { name: 'sandstone-cliffs', title: 'Sandstone cliffs', kind: 'cliff', chance: 0.25, params: { ...KIND_DEFAULTS.cliff, color: '#b08a62', gridSize: 1.4, chamfer: 0.2 } },
  { name: 'dark-cliffs', title: 'Dark cliffs', kind: 'cliff', chance: 0.15, params: { ...KIND_DEFAULTS.cliff, color: '#55595f', gridSize: 0.8, reachJitter: 0.35 } },
  { name: 'salt-quarry', title: 'Salt quarry', kind: 'quarry', chance: 0.06, params: { quarry: 'salt', radius: [0.08, 0.11] } },
];

let templates: TerrainTemplate[] = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
let byName = new Map(templates.map((t) => [t.name, t]));
const listeners: (() => void)[] = [];
/** Called whenever the template list changes (terrain caches subscribe). */
export function onTemplatesChange(fn: () => void): void { listeners.push(fn); }
/** The current template list (do not mutate without calling setTemplates afterwards). */
export const getTemplates = (): TerrainTemplate[] => templates;
export const getTemplate = (name: string): TerrainTemplate | undefined => byName.get(name);
/** Replace the template list (server: from data/templates.json; browser: from /api/templates or the editor). */
export function setTemplates(list: TerrainTemplate[]): void {
  templates = list;
  byName = new Map(templates.map((t) => [t.name, t]));
  listeners.forEach((fn) => fn());
}
/** A saved list plus the built-in templates of every kind it has none of (new kinds after an update). */
export function withMissingKinds(list: TerrainTemplate[]): TerrainTemplate[] {
  const kinds = new Set(list.map((t) => t.kind));
  const names = new Set(list.map((t) => t.name));
  return [...list, ...JSON.parse(JSON.stringify(DEFAULT_TEMPLATES.filter((t) => !kinds.has(t.kind) && !names.has(t.name))))];
}
/** Display name of a trait. */
export const traitTitle = (name: string): string => byName.get(name)?.title ?? name;
/** A template param with the kind default as fallback. */
export function param<T extends TerrainTemplate['params'][string]>(t: TerrainTemplate, key: string): T {
  return (t.params[key] ?? KIND_DEFAULTS[t.kind][key]) as T;
}

/**
 * Random but consistent trait set from the templates: per group, its templates' chances decide
 * whether one appears and which (so e.g. dry / wet never combine). Then combinations get fixed:
 * one water body only, a high spot excludes lake / valley / bog / wet climate, bogs don't go with
 * dry places, every location gets a quarry (wet places prefer mud).
 */
export function rollTraits(next: () => number): string[] {
  const groups = new Map<string, TerrainTemplate[]>();
  for (const t of templates) {
    const g = TEMPLATE_GROUP[t.kind];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(t);
  }
  const picked: TerrainTemplate[] = [];
  for (const list of groups.values()) {
    let roll = next();
    for (const t of list) {
      if (roll < t.chance) { picked.push(t); break; }
      roll -= t.chance;
    }
  }
  const of = (k: TemplateKind) => picked.find((t) => t.kind === k);
  const drop = (t: TerrainTemplate | undefined) => { if (t) picked.splice(picked.indexOf(t), 1); };
  const isWet = (t?: TerrainTemplate) => !!t && Number(param(t, 'moist')) > 0;
  const isDry = (t?: TerrainTemplate) => !!t && Number(param(t, 'moist')) < 0;
  // 1) one water body per location: lake, river or bog/pond – a random one of those rolled
  const waters = picked.filter((t) => t.kind === 'lake' || t.kind === 'river' || t.kind === 'pond');
  if (waters.length > 1) {
    const keep = waters[Math.floor(next() * waters.length) % waters.length];
    waters.filter((t) => t !== keep).forEach(drop);
  }
  // 2) a high spot excludes a lake, a valley, a bog and a wet climate – a coin decides which side stays
  //    (ring lakes then surround a flat island)
  if (of('highspot') && (of('lake') || of('valley') || of('pond') || isWet(of('climate')))) {
    if (next() < 0.5) { drop(of('lake')); drop(of('valley')); drop(of('pond')); if (isWet(of('climate'))) drop(of('climate')); }
    else drop(of('highspot'));
  }
  // 4) a bog doesn't go with a dry climate
  if (of('pond') && isDry(of('climate'))) drop(of('pond'));
  // 5) every location has a quarry: wet places (bog, wet climate) prefer mud; otherwise one by the quarries' chances
  if (!of('quarry')) {
    const quarries = templates.filter((t) => t.kind === 'quarry');
    const mud = quarries.find((t) => param(t, 'quarry') === 'mud');
    if (mud && (of('pond') || isWet(of('climate'))) && next() < 0.6) picked.push(mud);
    else if (quarries.length) {
      const total = quarries.reduce((s, t) => s + Math.max(0, t.chance), 0);
      let roll = next() * (total || quarries.length), pick = quarries[quarries.length - 1];
      for (const t of quarries) { roll -= total ? Math.max(0, t.chance) : 1; if (roll < 0) { pick = t; break; } }
      picked.push(pick);
    }
  }
  return picked.map((t) => t.name);
}
