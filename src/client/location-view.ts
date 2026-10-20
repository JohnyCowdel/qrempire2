// 3D location viewport (three.js): smooth terrain generated in the browser from the world
// seed (the engine's continuous height field), instanced trees and rocks, lakes, buildings and
// wandering characters, in an evening light with a fog bank hiding the edge of the map.
// Buildings and characters are simple primitives ("blobs") unless an asset URL is set in
// STRUCTURE_ASSETS / NPC_ASSETS – then the .stl / .glb / .gltf replaces the primitive once loaded.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import {
  cliffOf, depositOf, generateTerrain, hash32, setWater, waterLooks, insideArea, locationNpcs, rngFor, SCENE_RADIUS, TERRAIN_LEVELS, terrainField, TILES,
  type LocationDef, type SceneStructure, type Terrain,
} from '../engine/index.ts';
import { valueNoise } from '../engine/noise.ts';
import {
  ASSET_SEED, setCliff, buildRoads, type RoadNetwork, mudMaterial, applyShore, waterMaskTexture, tuftVariants, barkMaterial, cliffRocks, cliffWeight, quarryGeometry, fieldPlotAt, rockMaterial, terrainMaterial, shellGrass, updateTreeWind, broadleafTree, coniferTree, cropGeometries, pickSpecies, speciesFoliageMaterial, speciesNames, speciesTint, speciesTree, type SpeciesName, foliageMaterial, cropItemsForTile, DECOR, fieldGroundColor, grassMaterial, groundMaterial, patchAmount, tuftGroundTint, grassTuftGeometry, inPatch, loadScatterParts, rockGeometry,
  type CropItem,
} from './location-decor.ts';
import { RtsCamera } from './rts-camera.ts';
import { createWater } from './water-surface.ts';
import { applyQuality, type Quality } from './quality.ts';

// ======================= KNOBS =======================
export const VIEW = {
  // ground
  heightScale: 8, // world units per unit of the engine height field (plateau ≈ 0.2–0.3 of it)
  rockBump: 0.5, // rocky outcrops rise this much above the ground around them
  meshDetail: 3, // terrain vertices per tile edge (smoothness)
  colors: { sand: '#c9b27a', grass: '#7aa34a', forest: '#557f37', rock: '#8f887c', bog: '#4c5532' } as Record<string, string>,
  colorJitter: 0.04,
  // decor density, crop fields, trees, grass, rocks, custom models: DECOR in location-decor.ts (or /editor)
  // water
  // water: WATER_SURFACE in water-surface.ts
  // evening light
  skyTop: '#2b2d4a',
  skyHorizon: '#e08a5a',
  sunColor: '#ffb070',
  sunIntensity: 2.6,
  sunDirection: [-1, 0.42, -0.25], // low in the west
  ambientSky: '#7480b0',
  ambientGround: '#3a2f22',
  ambientIntensity: 1.5,
  exposure: 1.3,
  shadows: true,
  shadowMapSize: 2048,
  treeShadows: true, // trees cast shadows (the biggest shadow cost)
  maxPixelRatio: 2, // render resolution cap (× CSS pixels)
  // fog
  // fog effects – switched off for now (code kept): haze over the scene, fog bank at the map edge, ground mist
  haze: false,
  edgeFog: true, // fog bank around the round map edge
  mist: false,
  hazeColor: '#6b5d6e', // light haze over the whole scene…
  hazeDensity: 0.022, // every location is a bit foggy
  mistLayers: 2, // drifting ground mist over the whole map
  mistOpacity: 0.28,
  mistColor: '#c9bfc6',
  edgeFogColor: '#8a7d88', // …and an impenetrable fog bank around the map edge
  edgeFogInside: 1.5, // tiles: fog starts this far inside the map edge…
  edgeFogFade: 1, // …and is fully opaque this many tiles further out
  edgeFogLayers: 2, // stacked translucent layers above the ground (more = denser, more 3D)
};

/** Optional 3D assets. scale: asset units -> tiles (e.g. 0.001 for an STL in mm with 1 m tiles). */
export interface AssetDef {
  url?: string; // .stl, .glb or .gltf – leave empty to use the built-in primitive
  scale?: number;
  rotation?: number; // degrees around the vertical axis
  color?: string; // STL only (STLs carry no material)
  yOffset?: number;
}
export const STRUCTURE_ASSETS: Record<string, AssetDef> = {
  hall: {}, lumberyard: {}, quarry: {}, mine: {}, warehouse: {}, ruins: {}, chest: {},
  // e.g. hall: { url: '/assets/roman_tower2.stl', scale: 0.00012, color: '#cdbb9c' },
};
export const NPC_ASSETS: Record<string, AssetDef> = {};

/** Emoji used by the sidebar cards. */
export const STRUCTURE_EMOJI: Record<string, string> = {
  hall: '🏛️', lumberyard: '🪓', quarry: '🪨', mine: '⛏️', warehouse: '📦', ruins: '🏚️', chest: '🎁',
};
const NPC_COLORS: Record<string, string> = {
  villager: '#e0a96d', deer: '#a0673a', wolf: '#7d7d84', boar: '#5a3d2b', goblin: '#6aa84f', crab: '#e0603a', yeti: '#f2f2f2',
};
// =====================================================

const T = Object.fromEntries(TILES.map((t, i) => [t, i])) as Record<(typeof TILES)[number], number>;
const EDGE_MARGIN = 8; // tiles of ground / fog beyond the map edge (the fog is opaque a few tiles past the edge, so little is needed)

// ---- asset loading (cached per URL) ----

const assetCache = new Map<string, Promise<THREE.Object3D>>();
function loadAsset(def: AssetDef): Promise<THREE.Object3D> {
  const url = def.url!;
  let p = assetCache.get(url);
  if (!p) {
    p = url.toLowerCase().endsWith('.stl')
      ? new STLLoader().loadAsync(url).then((g) => {
        g.rotateX(-Math.PI / 2); // STL is usually Z-up; three.js is Y-up
        g.computeBoundingBox();
        const b = g.boundingBox!;
        g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
        return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: def.color ?? '#bfb5a5' }));
      })
      : new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene);
    assetCache.set(url, p);
  }
  return p.then((o) => {
    const copy = o.clone();
    copy.scale.setScalar(def.scale ?? 1);
    copy.rotation.y = THREE.MathUtils.degToRad(def.rotation ?? 0);
    copy.position.y = def.yOffset ?? 0;
    copy.traverse((c) => ((c as THREE.Mesh).castShadow = true));
    return copy;
  });
}

/** Put `fallback` into `holder` now; swap in the asset when (if) it loads. */
function withAsset(holder: THREE.Object3D, def: AssetDef | undefined, fallback: THREE.Object3D): void {
  holder.add(fallback);
  if (!def?.url) return;
  loadAsset(def).then((asset) => {
    holder.remove(fallback);
    holder.add(asset);
  }).catch((e) => console.warn('asset failed, keeping primitive', def.url, e));
}

// ---- primitives ----

const lambert = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function mesh(geo: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, lambert(color));
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function house(w: number, h: number, d: number, wall: string, roof: string): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(w, h, d), wall, 0, h / 2, 0));
  const r = mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.8, 4), roof, 0, h + h * 0.4, 0);
  r.rotation.y = Math.PI / 4;
  g.add(r);
  return g;
}

function structurePrimitive(kind: string): THREE.Object3D {
  switch (kind) {
    case 'hall': {
      const g = house(1.5, 0.9, 1.2, '#e2d3ac', '#a8462a');
      g.add(mesh(new THREE.BoxGeometry(0.35, 1.6, 0.35), '#cdbd92', 0.55, 0.8, 0.4)); // little tower
      return g;
    }
    case 'lumberyard': {
      const g = house(0.9, 0.55, 0.8, '#a0784e', '#6b4a2a');
      for (let i = 0; i < 3; i++) {
        const log = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 6), '#8a5a32', 0.7, 0.1 + i * 0.16, -0.15 + (i % 2) * 0.1);
        log.rotation.x = Math.PI / 2;
        g.add(log);
      }
      return g;
    }
    case 'quarry': {
      const g = new THREE.Group();
      [[0, 0.25, 0, 0.45], [0.45, 0.18, 0.2, 0.32], [-0.35, 0.15, 0.25, 0.28]].forEach(([x, y, z, r]) => g.add(mesh(new THREE.DodecahedronGeometry(r), '#9c978d', x, y, z)));
      return g;
    }
    case 'mine': {
      const g = house(0.9, 0.6, 0.9, '#5d5a55', '#3b3835');
      g.add(mesh(new THREE.BoxGeometry(0.35, 0.4, 0.05), '#1a1a1a', 0, 0.2, 0.46)); // entrance
      return g;
    }
    case 'warehouse': return house(1.7, 0.7, 1.0, '#b48f5c', '#7a4f2c');
    case 'ruins': {
      const g = new THREE.Group();
      [[-0.4, 0.5], [0.3, 0.8], [0.5, 0.3], [-0.1, 0.25]].forEach(([x, h], i) => g.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, h, 6), '#b9b3a6', x, h / 2, (i % 2) * 0.4 - 0.2)));
      return g;
    }
    case 'chest': {
      const g = new THREE.Group();
      g.add(mesh(new THREE.BoxGeometry(0.45, 0.3, 0.3), '#8b5a2b', 0, 0.15, 0));
      g.add(mesh(new THREE.BoxGeometry(0.47, 0.06, 0.32), '#e8c14a', 0, 0.24, 0));
      return g;
    }
    default: return house(0.8, 0.6, 0.8, '#ccc', '#888');
  }
}

function npcPrimitive(kind: string): THREE.Object3D {
  const g = new THREE.Group();
  const color = NPC_COLORS[kind] ?? '#ccc';
  const body = mesh(new THREE.CapsuleGeometry(0.11, 0.16, 3, 8), color, 0, 0.2, 0);
  const head = mesh(new THREE.SphereGeometry(0.09, 10, 8), kind === 'villager' ? '#f1c9a0' : color, 0, 0.45, 0);
  const nose = mesh(new THREE.SphereGeometry(0.03, 6, 4), '#222', 0, 0.46, -0.08); // shows the facing
  g.add(body, head, nose);
  return g;
}

function labelSprite(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2116';
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffd66b';
  g.font = 'bold 36px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.setScalar(0.45);
  s.renderOrder = 10;
  return s;
}

// ---- the view ----

export class LocationView {
  /** Called with a structure kind when the player clicks a building. */
  onSelect?: (kind: string) => void;

  private readonly canvas!: HTMLCanvasElement;
  private readonly renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** Everything the location consists of (the editor embeds just this). */
  readonly root: THREE.Object3D;
  private readonly embedded: boolean;
  private withTrees = true;
  private withGrass = true;
  private readonly rts!: RtsCamera;
  private readonly worldSeed: number;
  private readonly loc: LocationDef;
  private readonly terrain: Terrain;
  private readonly now: () => number;
  private readonly structureGroup = new THREE.Group();
  private readonly npcGroup = new THREE.Group();
  private readonly npcObjects = new Map<string, { obj: THREE.Object3D; last: THREE.Vector3 }>();
  private readonly ring!: THREE.Mesh;
  private structuresKey = '';
  private highlight?: string;
  private water!: { mesh: THREE.Mesh; update: (time: number) => void };
  private readonly fogLayers: THREE.Mesh[] = [];
  private readonly mistLayers: THREE.Mesh[] = [];
  /** Graphics quality in effect (low / medium / high). */
  readonly quality: Quality;
  /** Called about once a second with the measured frame rate. */
  onFps?: (fps: number) => void;
  private fpsFrames = 0;
  private fpsSince = performance.now();
  private grassUniforms?: { uTime: { value: number }; uSway: { value: number } };
  private shellUniforms?: { uTime: { value: number }; uSway: { value: number } };
  private last = performance.now();

  /**
   * canvas: the page's viewport (own renderer, camera, animation loop). Or `{ embed: group }`: just
   * build the location's content into that group (asset editor previews; call update(time) yourself).
   */
  constructor(canvas: HTMLCanvasElement | { embed: THREE.Object3D; trees?: boolean; grass?: boolean }, worldSeed: number, loc: LocationDef, now: () => number = Date.now) {
    this.worldSeed = worldSeed;
    this.loc = loc;
    this.now = now;
    this.embedded = !(canvas instanceof HTMLCanvasElement);
    this.root = canvas instanceof HTMLCanvasElement ? this.scene : canvas.embed;
    this.quality = this.embedded ? 'high' : applyQuality(VIEW); // caps detail for the chosen graphics quality (see quality.ts)
    setWater({ heightScale: VIEW.heightScale }); // bank slopes are in world units
    setCliff(cliffOf(loc.traits ?? [])); // this location's cliff type
    this.terrain = generateTerrain(worldSeed, loc);
    const { width: W, height: H } = this.terrain;
    if (!(canvas instanceof HTMLCanvasElement)) { // editor preview: content only (trees / grass only where relevant – they are slow)
      this.withTrees = canvas.trees ?? true;
      this.withGrass = canvas.grass ?? true;
      this.buildTerrain();
      this.buildDecor();
      if (DECOR.shells.enabled && this.withGrass) this.buildShellGrass();
      return;
    }
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(VIEW.maxPixelRatio, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = VIEW.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = VIEW.exposure;

    // Evening sky: vertical gradient from dusky blue to an orange horizon, plus a light haze.
    const sky = document.createElement('canvas');
    sky.width = 2;
    sky.height = 256;
    const sg = sky.getContext('2d')!;
    const grad = sg.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, VIEW.skyTop);
    grad.addColorStop(0.75, VIEW.skyHorizon);
    grad.addColorStop(1, VIEW.hazeColor);
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(sky);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = skyTex;
    if (VIEW.haze) this.scene.fog = new THREE.FogExp2(VIEW.hazeColor, VIEW.hazeDensity);

    // Lights: cool sky/ground fill + a low, warm sun with long shadows over the whole map.
    this.root.add(new THREE.HemisphereLight(VIEW.ambientSky, VIEW.ambientGround, VIEW.ambientIntensity));
    const sun = new THREE.DirectionalLight(VIEW.sunColor, VIEW.sunIntensity);
    const dir = new THREE.Vector3(...VIEW.sunDirection).normalize();
    sun.position.set(W / 2 + dir.x * 70, dir.y * 70, H / 2 + dir.z * 70);
    sun.target.position.set(W / 2, 0, H / 2);
    sun.castShadow = VIEW.shadows;
    sun.shadow.mapSize.set(VIEW.shadowMapSize, VIEW.shadowMapSize);
    const ext = Math.max(W, H) * 0.8; // low sun -> the map's shadow footprint is stretched
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 200 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    this.root.add(sun, sun.target);

    this.buildTerrain();
    this.buildDecor();
    if (DECOR.shells.enabled) this.buildShellGrass();
    this.root.add(this.structureGroup, this.npcGroup);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.05, 32), new THREE.MeshBasicMaterial({ color: '#ffd700', transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;

    this.rts = new RtsCamera(canvas, new THREE.Vector3(W / 2, 0, H / 2), { cx: W / 2, cz: H / 2, radius: SCENE_RADIUS - 2 });
    this.rts.onClick = (x, y) => (this.placing ? this.clickPlacement(x, y) : this.pick(x, y));
    canvas.addEventListener('pointermove', (e) => this.movePlacement(e.clientX, e.clientY));
    canvas.addEventListener('contextmenu', (e) => { if (this.placing) { e.preventDefault(); this.cancelPlacement(); this.placing = undefined; } });
    window.addEventListener('keydown', (e) => {
      if (!this.placing) return;
      if (e.key === 'Escape') this.cancelPlacement();
      else if (e.key === 'r' || e.key === 'R') { this.placing.rot += Math.PI / 4; this.placing.ghost.rotation.y = this.placing.rot; }
    });
    this.renderer.setAnimationLoop(this.frame);
  }

  /** Embedded mode: animate water, grass and trees. */
  update(time: number): void {
    this.water?.update(time);
    if (this.grassUniforms) this.grassUniforms.uTime.value = time;
    if (this.shellUniforms) { this.shellUniforms.uTime.value = time; this.shellUniforms.uSway.value = DECOR.grassSway; }
    updateTreeWind(time);
  }
  /** Embedded mode: free GPU resources (the water's reflection target, geometries). */
  dispose(): void {
    (this.water?.mesh as { dispose?: () => void } | undefined)?.dispose?.();
    this.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }

  setStructures(structures: SceneStructure[]): void {
    const key = JSON.stringify(structures.map((s) => [s.id, s.kind, s.level, s.upgradingTo, s.x, s.y, s.rot]));
    if (key === this.structuresKey) return;
    this.structuresKey = key;
    this.structureGroup.clear();
    for (const s of structures) {
      const holder = new THREE.Group();
      holder.position.set(s.x + 0.5, this.heightAt(s.x + 0.5, s.y + 0.5), s.y + 0.5);
      holder.rotation.y = s.rot ?? 0;
      holder.userData.kind = s.kind;
      const inner = new THREE.Group();
      inner.scale.setScalar(s.level ? 0.9 + 0.06 * s.level : 0.85);
      withAsset(inner, STRUCTURE_ASSETS[s.kind], structurePrimitive(s.kind));
      if (s.upgradingTo) {
        // under construction: see-through + scaffolding cage
        inner.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (m) Object.assign(m, { transparent: true, opacity: 0.45 });
        });
        const cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, 1.4, 1.4)), new THREE.LineBasicMaterial({ color: '#8a6a3a' }));
        cage.position.y = 0.7;
        holder.add(cage);
      }
      holder.add(inner);
      if (s.level !== undefined) {
        const label = labelSprite(String(s.level));
        label.position.set(0, 2.1, 0);
        holder.add(label);
      }
      this.structureGroup.add(holder);
    }
  }

  setHighlight(kind?: string): void {
    this.highlight = kind;
  }

  // ---- building placement (drag a new building onto the map) ----
  private placing?: { kind: string; ghost: THREE.Group; rot: number; check: (x: number, z: number) => string | null; place: (x: number, z: number, rot: number) => void; onHint?: (problem: string | null) => void };
  private readonly okMat = new THREE.MeshBasicMaterial({ color: '#7fd17f', transparent: true, opacity: 0.55, depthWrite: false });
  private readonly badMat = new THREE.MeshBasicMaterial({ color: '#e06a5a', transparent: true, opacity: 0.55, depthWrite: false });

  /**
   * Start placing a building: a see-through ghost follows the cursor over the ground (green = ok,
   * red = `check` returned a problem). Click places it (`place`), R / mouse wheel + Shift rotates,
   * Esc or right-click cancels. `onHint` reports the current problem (for a status line).
   */
  startPlacement(kind: string, check: (x: number, z: number) => string | null, place: (x: number, z: number, rot: number) => void, onHint?: (problem: string | null) => void): void {
    this.cancelPlacement();
    const ghost = new THREE.Group();
    const model = structurePrimitive(kind);
    ghost.add(model);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 32), this.okMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ghost.add(ring);
    ghost.visible = false;
    this.root.add(ghost);
    this.placing = { kind, ghost, rot: 0, check, place, onHint };
    this.canvas.style.cursor = 'crosshair';
  }
  cancelPlacement(): void {
    if (!this.placing) return;
    this.placing.ghost.removeFromParent();
    this.placing = undefined;
    this.canvas.style.cursor = '';
  }
  get isPlacing(): boolean { return !!this.placing; }

  /** Ground point under the cursor: march along the view ray until it dips below the height field (cheap, no mesh raycast). */
  private groundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.rts.ndc(clientX, clientY), this.rts.camera);
    const o = ray.ray.origin, d = ray.ray.direction, p = new THREE.Vector3();
    if (d.y >= 0) return null;
    const t0 = Math.max(0, (o.y - VIEW.heightScale * 0.7) / -d.y), t1 = (o.y + VIEW.heightScale * 0.5) / -d.y; // only where the ground can be
    let prev = t0;
    for (let t = t0; t < t1; t += 0.2) {
      p.copy(o).addScaledVector(d, t);
      if (p.y < this.heightAt(p.x, p.z)) { // crossed: refine between prev and t
        let a = prev, b = t;
        for (let k = 0; k < 8; k++) { const m = (a + b) / 2; p.copy(o).addScaledVector(d, m); if (p.y < this.heightAt(p.x, p.z)) b = m; else a = m; }
        p.y = this.heightAt(p.x, p.z);
        return p;
      }
      prev = t;
    }
    return null;
  }
  private movePlacement(clientX: number, clientY: number): void {
    const P = this.placing;
    if (!P) return;
    const at = this.groundPoint(clientX, clientY);
    P.ghost.visible = !!at;
    if (!at) return;
    P.ghost.position.copy(at);
    P.ghost.rotation.y = P.rot;
    const problem = P.check(at.x, at.z);
    const mat = problem ? this.badMat : this.okMat;
    P.ghost.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat; });
    P.onHint?.(problem);
  }
  private clickPlacement(clientX: number, clientY: number): void {
    const P = this.placing;
    if (!P) return;
    const at = this.groundPoint(clientX, clientY);
    if (!at || P.check(at.x, at.z)) return; // stays in placement mode until a valid spot
    const { place, rot } = P;
    this.cancelPlacement();
    place(at.x, at.z, rot);
  }

  // ---- world building ----

  /** Ground height at tile coords, straight from the engine's continuous field (smooth everywhere). */
  private heightAt(x: number, z: number): number {
    const { h, rock } = terrainField(this.worldSeed, this.loc, x, z);
    const L = TERRAIN_LEVELS;
    // rocky outcrops rise a little above the surrounding ground
    return (h - L.water) * VIEW.heightScale + THREE.MathUtils.smoothstep(rock, L.rockiness - 0.04, L.rockiness + 0.1) * VIEW.rockBump;
  }

  private buildTerrain(): void {
    const { width: W, height: H } = this.terrain;
    const M = EDGE_MARGIN; // ground continues under the edge fog
    const R = VIEW.meshDetail, nx = (W + 2 * M) * R, nz = (H + 2 * M) * R;
    const pos: number[] = [], col: number[] = [], idx: number[] = [], wts: number[] = [], paths: number[] = [], cliffW: number[] = [], roadW: number[] = [];
    const roads = this.roadNetwork();
    const hAt = (x: number, z: number) => this.heightAt(x, z);
    const L = TERRAIN_LEVELS, P = VIEW.colors;
    const mudDeposit = depositOf(this.worldSeed, this.loc)?.kind === 'mud', mudGround = new THREE.Color(DECOR.quarries.mud.color);
    const looks = waterLooks(this.loc.traits ?? []);
    const shoreColors = { grass: P.grass, field: DECOR.fields.soilColor, sand: P.sand, rock: P.rock, path: '#8a7350' };
    const sand = new THREE.Color(P.sand), grass = new THREE.Color(P.grass), forest = new THREE.Color(P.forest), rock = new THREE.Color(P.rock);
    const bogColor = new THREE.Color(P.bog);
    const c = new THREE.Color(), fieldGround = new THREE.Color();
    // ground beneath grass/crops takes their colours (same seeds as buildDecor)
    const decorSeed = hash32(this.worldSeed, 'decor', this.loc.id);
    const patchSeed = hash32(decorSeed, 'grass-patches');
    const fieldSeed = hash32(this.worldSeed, 'fields', this.loc.id);
    const P2 = DECOR.placement;
    const ss = THREE.MathUtils.smoothstep;
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = i / R - M, z = j / R - M;
        const { h, moist, rock: rockiness, field, bog, lake, pond, river, deposit } = terrainField(this.worldSeed, this.loc, x, z);
        pos.push(x, this.heightAt(x, z), z);
        // Blend colours continuously: grass/forest by moisture, sand at the shore, rock on outcrops.
        c.copy(grass).lerp(forest, ss(moist, L.forestMoisture - 0.05, L.forestMoisture + 0.05));
        // meadow grass patches tint the ground beneath them; reed beds and crop plots likewise
        tuftGroundTint(DECOR.tufts.meadow, c, patchAmount(patchSeed, x, z, P2.grassPatchScale, P2.grassPatchThreshold) * (1 - ss(field, 0.3, 0.5)));
        // texture weights [grass, field, sand, rock, path], blended in the same order as the colours
        const w = [1, 0, 0, 0, 0];
        const towards = (k: number, a: number) => { for (let q = 0; q < 5; q++) w[q] = w[q] * (1 - a) + (q === k ? a : 0); };
        if (field > 0.3) {
          const a = ss(field, L.field - 0.08, L.field + 0.08);
          c.lerp(fieldGroundColor(fieldSeed, x, z, W / 2, H / 2, fieldGround), a);
          const edge = fieldPlotAt(fieldSeed, x, z, W / 2, H / 2).edge, F = DECOR.fields;
          const onPath = 1 - ss(edge, F.pathWidth * 0.5, F.pathWidth * 0.5 + 0.3);
          towards(1, a * (1 - onPath));
          towards(4, a * onPath);
        }
        c.lerp(bogColor, ss(bog, L.bog - 0.05, L.bog + 0.05));
        tuftGroundTint(DECOR.tufts.reed, c, ss(bog, L.bog - 0.05, L.bog + 0.1)); // reed beds
        if (mudDeposit && deposit > 0) { c.lerp(mudGround, deposit * 0.9); towards(4, deposit * 0.9); } // trodden mud around a mud quarry
        applyShore({ lake, pond, river }, h, L.water, c, w, shoreColors, looks); // shore + bed textures of the nearby water (its template)
        c.lerp(rock, ss(rockiness, L.rockiness - 0.05, L.rockiness + 0.03));
        towards(3, ss(rockiness, L.rockiness - 0.05, L.rockiness + 0.03));
        // roads on top of everything (dusty road = the path texture)
        const rw = roads.at(x, z);
        if (h >= L.water) {
          towards(4, rw.dusty);
          for (let q = 0; q < 5; q++) w[q] *= 1 - Math.max(rw.stone, rw.path);
        }
        wts.push(w[0], w[1], w[2], w[3]);
        paths.push(w[4]);
        roadW.push(h >= L.water ? rw.stone : 0, h >= L.water ? rw.path : 0);
        cliffW.push(h < L.water ? 0 : cliffWeight(hAt, x, z)); // steep ground: cliff colour
        if (h < L.water) c.multiplyScalar(0.75); // lake bed
        c.offsetHSL(0, 0, (hash32(this.worldSeed, 'tc', this.loc.id, i, j) / 4294967296 - 0.5) * VIEW.colorJitter);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aW', new THREE.Float32BufferAttribute(wts, 4));
    geo.setAttribute('aPath', new THREE.Float32BufferAttribute(paths, 1));
    geo.setAttribute('aCliff', new THREE.Float32BufferAttribute(cliffW, 1));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(roadW, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // per-pixel terrain textures (DECOR.terrain); the old ground detail shader (groundMaterial, DECOR.ground) is unused
    const dep = depositOf(this.worldSeed, this.loc);
    const groundMat = terrainMaterial(new THREE.Vector2(W / 2, H / 2), dep && (dep.kind === 'iron' || dep.kind === 'copper') ? { ore: dep.kind, x: dep.x, z: dep.y, radius: dep.radius } : undefined);
    const ground = new THREE.Mesh(geo, groundMat.material);
    ground.receiveShadow = true;
    this.root.add(ground);

    // Lakes/rivers: a reflective, rippling water plane at height 0, visible where the ground dips
    // below it. Knobs: WATER_SURFACE in water-surface.ts.
    const mask = waterMaskTexture((x, z) => terrainField(this.worldSeed, this.loc, x, z), -M, -M, W + 2 * M, 2); // lake / pond / river looks
    this.water = createWater(W + 2 * M, W / 2, H / 2, new THREE.Vector3(...VIEW.sunDirection), () => looks, { mask, x0: -M, z0: -M, size: W + 2 * M });
    this.root.add(this.water.mesh);

    if (VIEW.edgeFog) this.buildEdgeFog();
    if (VIEW.mist) this.buildMist();
  }

  /** Wispy ground mist: noise-textured layers at low heights, so it pools in valleys and lowlands. */
  private buildMist(): void {
    const { width: W, height: H } = this.terrain;
    const M = EDGE_MARGIN, PX = 3;
    const cw = (W + 2 * M) * PX, ch = (H + 2 * M) * PX;
    const seed = hash32(this.worldSeed, 'mist', this.loc.id);
    const color = new THREE.Color(VIEW.mistColor);
    for (let l = 0; l < VIEW.mistLayers; l++) {
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const g = canvas.getContext('2d')!;
      const img = g.createImageData(cw, ch);
      for (let py = 0; py < ch; py++) {
        for (let px = 0; px < cw; px++) {
          const n = 0.65 * valueNoise(seed + l, px / PX / 7, py / PX / 7) + 0.35 * valueNoise(seed + l + 9, px / PX / 2.5, py / PX / 2.5);
          const k = (py * cw + px) * 4;
          img.data[k] = color.r * 255;
          img.data[k + 1] = color.g * 255;
          img.data[k + 2] = color.b * 255;
          img.data[k + 3] = THREE.MathUtils.smoothstep(n, 0.45, 0.8) * 255;
        }
      }
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mist = new THREE.Mesh(new THREE.PlaneGeometry(W + 2 * M, H + 2 * M), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: VIEW.mistOpacity, depthWrite: false,
      }));
      mist.rotation.x = -Math.PI / 2;
      mist.position.set(W / 2, 0.35 + l * 0.7, H / 2);
      mist.renderOrder = 4;
      this.mistLayers.push(mist);
      this.root.add(mist);
    }
  }

  /**
   * Fog bank around the map: a stack of horizontal layers sharing one texture that is clear over
   * the map and opaque outside it (with a wobbly edge). Seen at an angle, the stack reads as a
   * thick wall of fog you can't see through.
   */
  private buildEdgeFog(): void {
    const enlargeFactor = 1.5; // how much the fog extends beyond the map (the texture is larger than the map)
    const { width: W, height: H } = this.terrain;
    const M = 20, PX = 4; // texture pixels per tile
    const cw = (W + 2 * M) * PX, ch = (H + 2 * M) * PX;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(cw, ch);
    const fog = new THREE.Color(VIEW.edgeFogColor);
    const seed = hash32(this.worldSeed, 'edgefog', this.loc.id);
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        const tx = px / PX - M, tz = py / PX - M;
        // signed distance to the round play area (negative inside)
        const d = Math.hypot(tx - W / 2, tz - H / 2) - SCENE_RADIUS;
        const wobble = (valueNoise(seed, tx * 0.35, tz * 0.35) - 0.5) * 3;
        const a = THREE.MathUtils.smoothstep(d + wobble, -VIEW.edgeFogInside, VIEW.edgeFogFade);
        const k = (py * cw + px) * 4;
        img.data[k] = fog.r * 255;
        img.data[k + 1] = fog.g * 255;
        img.data[k + 2] = fog.b * 255;
        img.data[k + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const top = VIEW.heightScale * 0.45 + VIEW.rockBump + 1;
    for (let i = 0; i < VIEW.edgeFogLayers; i++) {
      const layer = new THREE.Mesh(new THREE.PlaneGeometry(W + 2 * M, H + 2 * M), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
      }));
      layer.rotation.x = -Math.PI / 2;
      // from just above the ground up to above the hills – no layer under the map
      layer.position.set(W / 2, THREE.MathUtils.lerp(2, top, VIEW.edgeFogLayers > 1 ? i / (VIEW.edgeFogLayers - 1) : 1), H / 2);
      layer.renderOrder = 5;
      this.fogLayers.push(layer);
      this.root.add(layer);
    }
  }

  private roads?: RoadNetwork;
  /** The location's roads (DECOR.roads), built once from its terrain. */
  private roadNetwork(): RoadNetwork {
    if (this.roads) return this.roads;
    const { width: W, height: H } = this.terrain, L = TERRAIN_LEVELS, R = DECOR.roads;
    const field = (x: number, z: number) => terrainField(this.worldSeed, this.loc, x, z);
    const dep = depositOf(this.worldSeed, this.loc);
    const targets: { x: number; z: number; water?: boolean }[] = [];
    if (dep && R.pathToQuarry) targets.push({ x: dep.x, z: dep.y });
    if (R.pathToWater) { // nearest water to the centre
      let best: { x: number; z: number } | null = null, bd = Infinity;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!insideArea(x, y, 2) || field(x + 0.5, y + 0.5).h >= L.water) continue;
        const d = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2);
        if (d > 4 && d < bd) { bd = d; best = { x: x + 0.5, z: y + 0.5 }; }
      }
      if (best) targets.push({ ...best, water: true });
    }
    this.roads = buildRoads({
      seed: hash32(this.worldSeed, 'roads', this.loc.id), W, H, heightAt: (x, z) => this.heightAt(x, z),
      isWater: (x, z) => field(x, z).h < L.water + 0.005, inside: (x, z) => insideArea(Math.floor(x), Math.floor(z), 1),
      important: this.loc.tier >= R.stoneRoadMinTier, targets,
    });
    return this.roads;
  }

  /** Meadow patches as shell grass (same patches as the tufts would use; see DECOR.shells). */
  private buildShellGrass(): void {
    const { width: W, height: H, tiles } = this.terrain;
    const P = DECOR.placement;
    const patchSeed = hash32(hash32(this.worldSeed, 'decor', this.loc.id), 'grass-patches');
    const share: Record<number, number> = { [T.grass]: 1, [T.forest]: DECOR.shells.forestAmount, [T.sand]: 0.4, [T.rock]: 0.4 };
    const maskAt = (x: number, z: number) => {
      if (x < 0 || z < 0 || x >= W || z >= H || !insideArea(Math.floor(x), Math.floor(z), -2)) return 0;
      const s = share[tiles[Math.floor(z) * W + Math.floor(x)]] ?? 0;
      const road = this.roadNetwork().at(x, z);
      const quarry = depositOf(this.worldSeed, this.loc); // quarries rank above meadows
      if (quarry && Math.hypot(x - quarry.x, z - quarry.y) < quarry.radius * 1.1) return 0;
      return s && s * patchAmount(patchSeed, x, z, P.grassPatchScale, P.grassPatchThreshold) * (1 - Math.max(road.dusty, road.stone, road.path));
    };
    const shells = shellGrass(0, 0, W, H, (x, z) => this.heightAt(x, z), maskAt);
    if (!shells) return;
    this.shellUniforms = shells.uniforms;
    this.root.add(shells.mesh);
  }

  private buildDecor(): void {
    const { width: W, height: H, tiles } = this.terrain;
    const seed = hash32(this.worldSeed, 'decor', this.loc.id);
    interface Item { x: number; z: number; s: number; rot: number; v: number; tint: THREE.Color; sp?: SpeciesName; mossy?: boolean; y?: number; sy?: number }
    const broadleaf: Item[] = [], conifer: Item[] = [], rocks: Item[] = [], grass: Item[] = [], reeds: Item[] = [];
    const D = DECOR.placement;
    const patchSeed = hash32(seed, 'grass-patches');
    // Grass grows only in patches: smooth noise above a threshold (checked per tuft -> organic edges).
    const grassPatch = (px: number, pz: number) => inPatch(patchSeed, px, pz, D.grassPatchScale, D.grassPatchThreshold);
    const leafTints = ['#ffffff', '#e6efd2', '#f3ead0', '#d6e3c2'].map((c) => new THREE.Color(c)); // multiplies vertex colours
    const grassTints = ['#ffffff', '#e9f2cf', '#f5ecc4', '#d9e6bd'].map((c) => new THREE.Color(c));
    const white = new THREE.Color('#ffffff');
    const fieldSeed = hash32(this.worldSeed, 'fields', this.loc.id);
    const crops: [CropItem[], CropItem[], CropItem[]] = [[], [], []];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!insideArea(x, y, -2)) continue; // nothing beyond the fog line
        const t = tiles[y * W + x];
        const r = rngFor(seed, x, y);
        const at = (pad = 0) => ({ x: x + pad + r.next() * (1 - 2 * pad), z: y + pad + r.next() * (1 - 2 * pad) });
        const tree = (s0: number, s1: number, coniferChance: number) => {
          if (!this.withTrees) return;
          const item = { ...at(), s: s0 + r.next() * (s1 - s0), rot: r.next() * Math.PI * 2, tint: r.pick(leafTints), v: 0 };
          const isConifer = r.chance(coniferChance);
          const v = r.int(0, D.treeVariants - 1);
          if (DECOR.foliageSkirts) { // species trees (skirts): kind -> species by share, colour from its palette
            const sp = pickSpecies(isConifer ? 'conifer' : 'broadleaf', r);
            if (sp) (isConifer ? conifer : broadleaf).push({ ...item, v, sp, tint: speciesTint(sp, r) });
          } else (isConifer ? conifer : broadleaf).push({ ...item, v });
        };
        const tufts = (n: number, into = grass, masked = true) => {
          if (!this.withGrass) return;
          if (DECOR.shells.enabled && into === grass) return; // meadow grass = shell layers (buildShellGrass)
          for (let i = 0; i < n; i++) {
            const p = at();
            if (masked && !grassPatch(p.x, p.z)) continue;
            into.push({ ...p, s: 0.7 + r.next() * 0.7, rot: r.next() * Math.PI * 2, v: r.int(0, Math.max(1, D.tuftVariants) - 1), tint: r.pick(grassTints) });
          }
        };
        const stone = (s0: number, s1: number) => {
          const mossy = D.mossyRockVariants > 0 && (D.rockVariants < 1 || r.chance(D.mossyShare));
          rocks.push({ ...at(0.15), s: s0 + r.next() * (s1 - s0), rot: r.next() * Math.PI * 2, v: r.int(0, (mossy ? D.mossyRockVariants : D.rockVariants) - 1), tint: white, mossy });
        };

        if (t === T.forest) {
          for (let i = 0; i < D.treesPerForestTile; i++) tree(0.75, 1.3, D.coniferShare);
          tufts(D.forestGrassPerTile);
        } else if (t === T.grass) {
          tufts(D.grassPatchDensity);
          if (r.chance(D.grassTreeChance)) tree(0.9, 1.3, 0.25);
          if (r.chance(D.pebbleChance)) stone(0.05, 0.12);
        } else if (t === T.sand) {
          tufts(Math.round(D.grassPatchDensity / 4));
          if (r.chance(D.pebbleChance * 2)) stone(0.05, 0.1);
        } else if (t === T.rock) {
          if (r.chance(D.rockChance)) stone(0.25, 0.55);
          for (let i = 0; i < 2; i++) if (r.chance(0.6)) stone(0.05, 0.12);
          tufts(Math.round(D.grassPatchDensity / 4));
        } else if (t === T.bog) {
          tufts(D.reedsPerBogTile, reeds, false); // reeds everywhere in the bog
        } else if (t === T.field) {
          cropItemsForTile(fieldSeed, x, y, W / 2, H / 2, crops); // plots fan out from the centre
          // trees rank above fields: where the ground is moist enough for woods they grow among the crops
          if (terrainField(this.worldSeed, this.loc, x + 0.5, y + 0.5).moist > TERRAIN_LEVELS.forestMoisture) {
            for (let i = 0; i < D.treesPerForestTile; i++) tree(0.75, 1.3, D.coniferShare);
          }
        }
      }
    }

    // nothing grows / lies on the roads
    const roadAt = this.roadNetwork().at;
    const offRoad = (list: Item[]) => {
      const keep = list.filter((i) => { const rw = roadAt(i.x, i.z); return Math.max(rw.dusty, rw.stone, rw.path) < 0.3; });
      list.length = 0;
      list.push(...keep);
    };
    [broadleaf, conifer, rocks, grass, reeds].forEach(offRoad);

    // Stacking priority (a higher layer clears the lower ones where they overlap):
    //   roads > quarries > water > trees > fields > meadows
    const quarry = depositOf(this.worldSeed, this.loc);
    const inQuarry = (x: number, z: number) => !!quarry && Math.hypot(x - quarry.x, z - quarry.y) < quarry.radius * 1.1;
    const onWater = (x: number, z: number) => this.heightAt(x, z) < 0.02;
    const onRoad = (x: number, z: number) => { const rw = roadAt(x, z); return Math.max(rw.dusty, rw.stone, rw.path) >= 0.3; };
    const keepOnly = <I extends { x: number; z: number }>(list: I[], ok: (i: I) => boolean) => { const k = list.filter(ok); list.length = 0; list.push(...k); };
    keepOnly(broadleaf, (i) => !inQuarry(i.x, i.z) && !onWater(i.x, i.z)); // quarries, water > trees
    keepOnly(conifer, (i) => !inQuarry(i.x, i.z) && !onWater(i.x, i.z));
    const treeCells = new Set<number>(); // half-tile cells around every tree (fast lookup for the crops)
    for (const t of [...broadleaf, ...conifer]) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) treeCells.add((Math.floor(t.z * 2) + dz) * 1000 + Math.floor(t.x * 2) + dx);
    keepOnly(grass, (i) => !inQuarry(i.x, i.z) && !onWater(i.x, i.z)); // > meadows
    keepOnly(reeds, (i) => !inQuarry(i.x, i.z));
    const treeNear = (x: number, z: number) => treeCells.has(Math.floor(z * 2) * 1000 + Math.floor(x * 2)); // trees > fields
    for (const list of crops) keepOnly(list, (c) => !onRoad(c.x, c.z) && !inQuarry(c.x, c.z) && !onWater(c.x, c.z) && !treeNear(c.x, c.z));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    /** One InstancedMesh for all items of one geometry. */
    const place = (geo: THREE.BufferGeometry, material: THREE.Material, items: Item[], shadows: boolean, sink = 0, lift = 0) => {
      if (!items.length) return;
      const im = new THREE.InstancedMesh(geo, material, items.length);
      im.castShadow = shadows;
      im.receiveShadow = true;
      items.forEach((it, i) => {
        m.compose(v.set(it.x, it.y ?? this.heightAt(it.x, it.z) - sink * it.s + lift, it.z), q.setFromAxisAngle(UP, it.rot), sc.set(it.s, it.sy ?? it.s, it.s));
        im.setMatrixAt(i, m);
        im.setColorAt(i, it.tint);
      });
      this.root.add(im);
    };

    const bark = lambert(DECOR.barkColor);
    if (DECOR.foliageSkirts) {
      const trees = [...broadleaf, ...conifer];
      for (const name of speciesNames()) {
        for (let k = 0; k < D.treeVariants; k++) {
          const items = trees.filter((i) => i.sp === name && i.v === k);
          if (!items.length) continue;
          const t = speciesTree(name, ASSET_SEED, k); // shared asset pool
          place(t.wood, barkMaterial(), items.map((i) => ({ ...i, tint: white })), VIEW.treeShadows);
          place(t.foliage, speciesFoliageMaterial(name), items, VIEW.treeShadows);
        }
      }
    }
    for (let k = 0; k < (DECOR.foliageSkirts ? 0 : D.treeVariants); k++) {
      const b = broadleafTree(seed, k), c = coniferTree(seed, k);
      const ts = VIEW.treeShadows;
      place(b.wood, bark, broadleaf.filter((i) => i.v === k), ts);
      place(b.foliage, foliageMaterial('broadleaf'), broadleaf.filter((i) => i.v === k), ts);
      place(c.wood, bark, conifer.filter((i) => i.v === k), ts);
      place(c.foliage, foliageMaterial('conifer'), conifer.filter((i) => i.v === k), ts);
    }
    const stoneMat = rockMaterial().material; // smooth + rock texture (no visible polygons)
    // Quarry on the deposit (DECOR.quarries): the model (one of the pooled variants of its kind),
    // boulders around stone / ore quarries, ore veins on the rocks there.
    const dep = depositOf(this.worldSeed, this.loc), Q = DECOR.quarries;
    const ore = dep && (dep.kind === 'iron' || dep.kind === 'copper') ? dep.kind : undefined;
    const onDeposit = (i: Item) => !!dep && Math.hypot(i.x - dep.x, i.z - dep.y) < dep.radius;
    if (dep) {
      const r = rngFor(seed, 'deposit-rocks');
      for (let i = 0; i < Q.boulders; i++) { // random bare boulders around every quarry kind
        const a = r.next() * Math.PI * 2, d = Math.sqrt(r.next()) * dep.radius;
        const x = dep.x + Math.cos(a) * d, z = dep.y + Math.sin(a) * d;
        if (d < 2.8) continue; // keep the quarry itself clear
        if (this.heightAt(x, z) > 0.05) rocks.push({ x, z, s: Q.boulderSize[0] + r.next() * (Q.boulderSize[1] - Q.boulderSize[0]), rot: r.next() * 6.28, v: r.int(0, D.rockVariants - 1), tint: white });
      }
      const v = r.int(0, Math.max(1, Q.variants) - 1), rot = r.next() * Math.PI * 2;
      const mat = dep.kind === 'mud' ? mudMaterial() : ore ? rockMaterial(ore).material : dep.kind === 'salt' ? rockMaterial(undefined, false, 0.95).material : stoneMat; // salt: nearly pure colours
      place(quarryGeometry(ASSET_SEED, dep.kind, v), mat, [{ x: dep.x, z: dep.y, s: 1, rot, v, tint: white }], true, 0.1);
    }
    const oreMat = ore ? rockMaterial(ore).material : stoneMat;
    for (let k = 0; k < D.rockVariants; k++) {
      const geo = rockGeometry(ASSET_SEED, k), mine = rocks.filter((i) => i.v === k && !i.mossy);
      place(geo, stoneMat, mine.filter((i) => !onDeposit(i)), true, 0.15);
      place(geo, oreMat, mine.filter(onDeposit), true, 0.15);
    }
    const mossMat = rockMaterial(undefined, true).material;
    for (let k = 0; k < D.mossyRockVariants; k++) {
      place(rockGeometry(ASSET_SEED, k, undefined, true), mossMat, rocks.filter((i) => i.v === k && i.mossy), true, 0.15);
    }
    const g = grassMaterial();
    this.grassUniforms = g.uniforms;
    tuftVariants(ASSET_SEED, DECOR.tufts.meadow).forEach((geo, k) => place(geo, g.material, grass.filter((i) => i.v === k), false));
    tuftVariants(ASSET_SEED, DECOR.tufts.reed).forEach((geo, k) => place(geo, g.material, reeds.filter((i) => i.v === k), false));

    // Crop fields: green unripe grain, yellow ripe grain (swaying tufts), brown clods on tilled plots.
    const cg = cropGeometries(ASSET_SEED);
    const asItems = (list: CropItem[]): Item[] => list.map((c) => ({ ...c, tint: white }));
    cg.unripe.forEach((geo, k) => place(geo, g.material, asItems(crops[0].filter((c) => c.v === k)), false));
    cg.ripe.forEach((geo, k) => place(geo, g.material, asItems(crops[1].filter((c) => c.v === k)), false));

    // Cliffs: blocky low-poly rocks lining each steep slope from its top edge to its foot, rubble below (DECOR.cliffs).
    const cr = cliffRocks(0, 0, W, H, (x, z) => this.heightAt(x, z),
      (x, z) => insideArea(Math.floor(x), Math.floor(z), -1) && this.heightAt(x, z) > 0.05, hash32(seed, 'cliffs'));
    if (cr.rocks) {
      const rockMesh = new THREE.Mesh(cr.rocks, rockMaterial(undefined, true).material); // grass / moss on their flat tops
      rockMesh.castShadow = rockMesh.receiveShadow = true;
      this.root.add(rockMesh);
    }
    for (let k = 0; k < D.rockVariants; k++) {
      place(rockGeometry(ASSET_SEED, k), stoneMat, cr.rubble.filter((s) => s.v === k).map((s) => ({ ...s, tint: white })), true);
    }

    // Custom models (DECOR.scatters): instanced in patches like grass, on their allowed tiles.
    DECOR.scatters.forEach((def, si) => {
      const allowed = new Set(def.tiles.map((name) => TILES.indexOf(name as (typeof TILES)[number])));
      const pSeed = hash32(seed, 'scatter', si);
      const items: Item[] = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!insideArea(x, y, -2) || !allowed.has(tiles[y * W + x])) continue;
          const r = rngFor(pSeed, x, y);
          for (let i = 0; i < def.perTile; i++) {
            const px = x + r.next(), pz = y + r.next();
            const s = def.scale[0] + r.next() * (def.scale[1] - def.scale[0]), rot = r.next() * Math.PI * 2;
            if (inPatch(pSeed, px, pz, def.patchScale, def.patchThreshold)) items.push({ x: px, z: pz, s, rot, v: 0, tint: white });
          }
        }
      }
      if (!items.length) return;
      loadScatterParts(def).then((parts) => {
        for (const part of parts) place(part.geometry, part.material, items, true, 0, def.yOffset);
      }).catch((e: unknown) => console.warn('scatter model failed', def.url, e));
    });
  }

  // ---- per frame ----

  private readonly frame = () => {
    const nowPerf = performance.now();
    const dt = Math.min(0.1, (nowPerf - this.last) / 1000);
    this.last = nowPerf;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, false);
    this.rts.update(dt, w, h);
    const time = nowPerf / 1000;

    // Characters: blobs (or assets) walking along the engine's deterministic paths.
    const seen = new Set<string>();
    for (const n of locationNpcs(this.worldSeed, this.loc, this.now())) {
      seen.add(n.id);
      let entry = this.npcObjects.get(n.id);
      if (!entry) {
        const holder = new THREE.Group();
        withAsset(holder, NPC_ASSETS[n.kind], npcPrimitive(n.kind));
        this.npcGroup.add(holder);
        entry = { obj: holder, last: new THREE.Vector3(n.x + 0.5, 0, n.y + 0.5) };
        this.npcObjects.set(n.id, entry);
      }
      const x = n.x + 0.5, z = n.y + 0.5;
      const moving = Math.hypot(x - entry.last.x, z - entry.last.z);
      if (moving > 0.0005) entry.obj.rotation.y = Math.atan2(-(x - entry.last.x), -(z - entry.last.z)); // face where it walks
      entry.obj.position.set(x, Math.max(0, this.heightAt(x, z)) + Math.abs(Math.sin(time * 8 + x)) * 0.04, z);
      entry.last.set(x, 0, z);
    }
    for (const [id, e] of this.npcObjects) if (!seen.has(id)) { this.npcGroup.remove(e.obj); this.npcObjects.delete(id); }

    // Selection ring under highlighted buildings (pulsing).
    this.ring.removeFromParent();
    if (this.highlight) {
      const target = this.structureGroup.children.find((o) => o.userData.kind === this.highlight);
      if (target) {
        target.add(this.ring);
        this.ring.position.y = 0.05;
        (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.4 * Math.sin(time * 5);
      }
    }

    this.water.update(time); // ripples
    if (this.grassUniforms) this.grassUniforms.uTime.value = time; // wind in the grass (sway: DECOR.grassSway)
    if (this.shellUniforms) { this.shellUniforms.uTime.value = time; this.shellUniforms.uSway.value = DECOR.grassSway; }
    updateTreeWind(time); // wind in the trees (DECOR.treeSway / treeSwaySpeed / leafFlutter)
    this.mistLayers.forEach((l, i) => {
      l.position.x = this.terrain.width / 2 + Math.sin(time * 0.03 + i * 2.1) * 3;
      l.position.z = this.terrain.height / 2 + Math.cos(time * 0.025 + i * 1.3) * 2;
    });
    // Fog bank breathes: each layer drifts slowly on its own little loop.
    this.fogLayers.forEach((l, i) => {
      l.position.x = this.terrain.width / 2 + Math.sin(time * 0.07 + i * 1.7) * 0.8;
      l.position.z = this.terrain.height / 2 + Math.cos(time * 0.05 + i * 2.3) * 0.8;
    });
    this.renderer.render(this.scene, this.rts.camera);
    this.fpsFrames++;
    if (nowPerf - this.fpsSince > 1000) {
      this.onFps?.(Math.round((this.fpsFrames * 1000) / (nowPerf - this.fpsSince)));
      this.fpsFrames = 0;
      this.fpsSince = nowPerf;
    }
  };

  private pick(clientX: number, clientY: number): void {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.rts.ndc(clientX, clientY), this.rts.camera);
    const hit = ray.intersectObjects(this.structureGroup.children, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.kind) o = o.parent;
    if (o) this.onSelect?.(o.userData.kind);
  }
}
