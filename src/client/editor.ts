// Asset editor (/editor): tweak the procedurally generated location assets in isolation –
// trees, grass patches, rocks & stones, crop fields – and add custom 3D models that are
// scattered in patches like grass. Every change regenerates the preview and is saved to
// localStorage; the location page merges the saved settings into DECOR when it loads.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { rngFor, setTemplates, type TemplateKind, type TerrainTemplate } from '../engine/index.ts';
import { createTemplateEditor } from './template-editor.ts';
import {
  ASSET_SEED, roadField, mudMaterial, applyShore, SURFACES, waterMaskTexture, tuftVariants, barkMaterial, cliffRocks, cliffWeight, quarryGeometry, fieldPlotAt, rockMaterial, terrainMaterial, shellGrass, updateTreeWind, broadleafTree, coniferTree, cropGeometries, speciesFoliageMaterial, speciesTint, speciesTree, type SpeciesName, foliageMaterial, cropItemsForTile, DECOR, DECOR_STORAGE_KEY, decorDefaults, DEFAULT_SCATTER, fieldGroundColor,
  groundMaterial, patchAmount, tuftGroundTint, type CropItem,
  grassMaterial, grassTuftGeometry, inPatch, loadScatterParts, rockGeometry, type ScatterDef,
} from './location-decor.ts';

// ---- knob definitions per tab: [path in DECOR, min, max, step] (colours/booleans need no range) ----
type Knob = [path: string, min?: number, max?: number, step?: number];
/** All knobs of one tuft style (DECOR.tufts.<name>), with a section header. */
const tuftKnobs = (name: string, title: string): Knob[] => {
  const p = `tufts.${name}`;
  return [
    [`#${title}`], [`${p}.blades`, 1, 12, 1], [`${p}.height`, 0.05, 1.2, 0.01], [`${p}.width`, 0.003, 0.05, 0.001], [`${p}.lean`, 0, 1, 0.01],
    [`${p}.base`], [`${p}.tip`], [`${p}.groundTint`, 0, 1, 0.01],
    [`${p}.headChance`, 0, 1, 0.01], [`${p}.headLength`, 0, 0.3, 0.005], [`${p}.headWidth`, 0, 0.12, 0.002], [`${p}.headKernels`, 1, 16, 1],
    [`${p}.headDroop`, 0, 1, 0.01], [`${p}.headColor`],
  ];
};

/** All knobs of one tree species (DECOR.species.<name>), with a section header. */
const speciesKnobs = (name: string, title: string): Knob[] => {
  const p = `species.${name}`;
  return [
    [`#${title}`], [`${p}.share`, 0, 5, 0.05], [`${p}.height`, 0.5, 4, 0.05], [`${p}.palette`], [`${p}.paletteJitter`, 0, 0.2, 0.005],
    [`${p}.lightenUp`, 0, 0.3, 0.01],
    [`${p}.trunkWidth`, 0.02, 0.25, 0.005], [`${p}.trunkTop`, 0.2, 1, 0.01],
    [`${p}.barkColor`], [`${p}.barkMarks`], [`${p}.barkMarkAmount`, 0, 1, 0.01],
    [`${p}.tiers`, 1, 12, 1], [`${p}.crownStart`, 0, 1, 0.01], [`${p}.crownTop`, 0, 1, 0.01],
    [`${p}.radiusBottom`, 0.05, 1.5, 0.01], [`${p}.radiusWidest`, 0.05, 1.5, 0.01], [`${p}.radiusTop`, 0.05, 1.5, 0.01], [`${p}.widestAt`, 0, 1, 0.01],
    [`${p}.dropBottom`, 0, 1, 0.01], [`${p}.dropTop`, 0, 1, 0.01], [`${p}.droopBottom`, 0.5, 4, 0.05], [`${p}.droopTop`, 0.5, 4, 0.05],
    [`${p}.tilt`, 0, 0.8, 0.01],
  ];
};

const TABS: Record<string, Knob[]> = {
  Trees: [
    ['placement.treeVariants', 1, 6, 1], ['placement.coniferShare', 0, 1, 0.01],
    ['#Wind'], ['treeSway', 0, 0.3, 0.005], ['treeSwaySpeed', 0.1, 4, 0.05], ['leafFlutter', 0, 0.08, 0.001],
    ['#Skirts (all species)'], ['foliageSkirts'], ['skirts.teeth', 4, 60, 2], ['skirts.toothDepth', 0, 0.8, 0.01],
    ['skirts.rimWobble', 0, 0.5, 0.01], ['skirts.segments', 6, 32, 1], ['skirts.alphaTest', 0.05, 0.95, 0.01],
    ['#Old branching trees (when skirts are off)'], ['broadleafDepth', 1, 4, 1], ['broadleafSpread', 0, 1.5, 0.01],
    ['leafColors'], ['barkColor'],
    ['#Foliage cards (when skirts are off)'], ['foliageCards'], ['cards.leafCardsPerTip', 1, 8, 1], ['cards.leafCardSize', 0.15, 1.2, 0.01], ['cards.leavesInTexture', 10, 200, 1],
    ['cards.leafSize', 8, 60, 1], ['cards.coniferCardsPerBranch', 1, 2, 1], ['cards.coniferCardWidth', 0.1, 0.8, 0.01], ['cards.needleDensity', 10, 100, 1],
    ['cards.alphaTest', 0.05, 0.95, 0.01],
    ['#Modelled foliage (when cards are off)'], ['leafSize', 0.03, 0.3, 0.005], ['leavesPerTip', 1, 150, 1], ['leafSpread', 0.05, 0.5, 0.01],
    ['#Conifer shape'],
    ['conifer.height', 0.8, 3, 0.05], ['conifer.whorls', 3, 14, 1], ['conifer.branches', 3, 12, 1], ['conifer.massesPerBranch', 1, 5, 1],
    ['conifer.massDetail', 0, 2, 1], ['conifer.thickness', 0.03, 0.25, 0.005], ['conifer.width', 0.2, 1.2, 0.01], ['conifer.droop', 0, 1, 0.01],
    ['conifer.fluff', 0, 1, 0.01], ['conifer.crownStart', 0, 1, 0.01], ['conifer.core'], ['conifer.color'], ['conifer.lightenUp', 0, 0.3, 0.01],
    ['conifer.colorJitter', 0, 0.2, 0.01],
  ],
  Broadleaf: [
    ...speciesKnobs('oak', 'Oak (left)'), ...speciesKnobs('birch', 'Birch (middle)'), ...speciesKnobs('aspen', 'Aspen (right)'),
  ],
  Conifers: [
    ...speciesKnobs('spruce', 'Spruce / fir (left)'), ...speciesKnobs('pine', 'Pine (right)'),
  ],
  Grass: [
    ['placement.tuftVariants', 1, 8, 1], ['grassSway', 0, 0.3, 0.005],
    ['placement.grassPatchDensity', 1, 60, 1], ['placement.grassPatchScale', 0.05, 0.6, 0.01], ['placement.grassPatchThreshold', 0, 0.95, 0.01],
    ['#Shell grass (meadow, left)'], ['shells.enabled'], ['shells.layers', 2, 24, 1], ['shells.height', 0.03, 0.6, 0.01], ['shells.density', 2, 60, 1],
    ['shells.thickness', 0.05, 0.5, 0.01], ['shells.lean', 0, 1, 0.01], ['shells.cellSize', 0.2, 2, 0.05], ['shells.base'], ['shells.tip'], ['shells.dry'], ['shells.dryAmount', 0, 1, 0.01],
    ['shells.forestAmount', 0, 1, 0.01],
    ...tuftKnobs('meadow', 'Meadow tufts (when shells are off)'),
    ['placement.reedsPerBogTile', 1, 40, 1], ...tuftKnobs('reed', 'Bog reeds (right)'),
  ],
  Stones: [
    ['placement.rockVariants', 0, 8, 1], ['placement.mossyRockVariants', 0, 8, 1], ['placement.mossyShare', 0, 1, 0.01],
    ['rockChamfer', 0, 0.5, 0.01], ['rockRoughness', 0, 1, 0.01], ['rockColor'],
    ['placement.rockChance', 0, 1, 0.01], ['placement.pebbleChance', 0, 0.5, 0.01],
    ['#Surface (stones, cliffs, quarries; texture colours: Ground tab → rock)'], ['rockTexture.tint', 0, 1, 0.01], ['rockTexture.scale', 0.5, 15, 0.1],
    ['rockTexture.bump', 0, 4, 0.05], ['rockTexture.cracks', 0, 1, 0.01],
    ['#Grass / moss on top (mossy stones, cliff ledges)'], ['rockTexture.moss', 0, 1, 0.01], ['rockTexture.mossColor'], ['rockTexture.mossHeight', 0, 1, 0.01],
  ],
  Cliffs: [],
  Quarries: [
    ['quarries.variants', 1, 6, 1], ['quarries.boulders', 0, 30, 1], ['quarries.boulderSize', 0.1, 1.2, 0.01],
    ['#Mud quarry (1st column)'], ['quarries.mud.width', 1, 6, 0.1], ['quarries.mud.mounds', 0, 20, 1], ['quarries.mud.moundSize', 0.1, 1.2, 0.01],
    ['quarries.mud.brickStacks', 0, 8, 1], ['quarries.mud.color'], ['quarries.mud.wetColor'], ['quarries.mud.puddleColor'], ['quarries.mud.brickColor'],
    ['#Stone quarry (2nd column)'], ['quarries.stone.width', 1, 8, 0.1], ['quarries.stone.stones', 0, 60, 1], ['quarries.stone.stoneSize', 0.05, 1.2, 0.01],
    ['quarries.stone.terraces', 1, 6, 1], ['quarries.stone.faceWidth', 0.5, 5, 0.05], ['quarries.stone.missing', 0, 1, 0.01],
    ['quarries.stone.blocks', 0, 20, 1], ['quarries.stone.blockSize', 0.1, 0.8, 0.01], ['quarries.stone.color'], ['quarries.stone.blockColor'],
    ['#Salt quarry (5th)'], ['quarries.salt.width', 1, 8, 0.1], ['quarries.salt.stones', 0, 60, 1], ['quarries.salt.stoneSize', 0.05, 1.2, 0.01],
    ['quarries.salt.saltShare', 0, 1, 0.01], ['quarries.salt.color'], ['quarries.salt.saltColor'],
    ['#Stone shapes for stone / ore / salt quarries: Stones tab (bare variants)'],
    ...(['iron', 'copper'] as const).flatMap((k, i): Knob[] => [
      [`#${k === 'iron' ? 'Iron' : 'Copper'} ore quarry (${i === 0 ? '3rd' : '4th'})`], [`quarries.${k}.width`, 1, 8, 0.1], [`quarries.${k}.stones`, 0, 60, 1],
      [`quarries.${k}.stoneSize`, 0.05, 1.2, 0.01], [`quarries.${k}.oreShare`, 0, 1, 0.01],
      [`quarries.${k}.color`], [`quarries.${k}.oreColor`], [`quarries.${k}.veinColor`], [`quarries.${k}.veinAmount`, 0, 1, 0.01], [`quarries.${k}.veinScale`, 0.5, 15, 0.1],
    ]),
  ],
  Water: [],
  'High spot': [],
  Forest: [],
  Traits: [],
  Roads: [
    ['#Layout (roads enter from the map edge, foot paths branch off)'], ['roads.count', 0, 6, 1], ['roads.stoneRoadMinTier', 1, 4, 1],
    ['roads.hubRadius', 0.5, 8, 0.1], ['roads.slopeCost', 0, 40, 0.5], ['roads.pathToQuarry'], ['roads.pathToWater'],
    ['#Dusty road (back; texture: Ground tab → path)'], ['roads.dusty.width', 0.3, 3, 0.05], ['roads.dusty.edge', 0.01, 1.5, 0.01],
    ['#Stone-laid road (middle)'], ['roads.stone.width', 0.3, 3, 0.05], ['roads.stone.edge', 0.01, 1.5, 0.01], ['roads.stone.stone'], ['roads.stone.grout'],
    ['roads.stone.cobbleSize', 1, 15, 0.1], ['roads.stone.bump', 0, 4, 0.05], ['roads.stone.tint', 0, 1, 0.01],
    ['#Dusty foot path (front)'], ['roads.path.width', 0.2, 2, 0.05], ['roads.path.edge', 0.01, 1.5, 0.01], ['roads.path.dark'], ['roads.path.light'],
    ['roads.path.bump', 0, 4, 0.05], ['roads.path.tint', 0, 1, 0.01],
  ],
  Fields: [
    ['fields.sectors', 3, 24, 1], ['fields.sectorCurve', 0, 0.5, 0.01], ['fields.sectorWaviness', 0, 1, 0.01], ['fields.ringSpacing', 1, 12, 0.1],
    ['fields.ringWobble', 0, 3, 0.05], ['fields.pathWidth', 0, 1, 0.01], ['fields.kindWeights', 0, 5, 0.1], ['fields.soilColor'],
    ['fields.grainPerTile', 1, 80, 1],
    ...tuftKnobs('unripe', 'Unripe grain'), ...tuftKnobs('ripe', 'Ripe grain'),
  ],
  Ground: [
    ['#Grass (1st band)'], ['terrain.grass.dark'], ['terrain.grass.light'], ['terrain.grass.dry'], ['terrain.grass.scale', 0.1, 8, 0.05],
    ['terrain.grass.dryAmount', 0, 1, 0.01], ['terrain.grass.speckle', 0, 1, 0.01], ['terrain.grass.bump', 0, 4, 0.05], ['terrain.grass.tint', 0, 1, 0.01],
    ['#Tilled field (2nd)'], ['terrain.field.dark'], ['terrain.field.light'], ['terrain.field.furrowSpacing', 0.1, 1.5, 0.01], ['terrain.field.furrowDepth', 0, 1, 0.01],
    ['terrain.field.clodScale', 0.5, 20, 0.1], ['terrain.field.bump', 0, 4, 0.05], ['terrain.field.tint', 0, 1, 0.01],
    ['#Sand (3rd)'], ['terrain.sand.dark'], ['terrain.sand.light'], ['terrain.sand.scale', 0.1, 8, 0.05], ['terrain.sand.grain', 2, 60, 1],
    ['terrain.sand.rippleSpacing', 0.1, 2, 0.01], ['terrain.sand.rippleStrength', 0, 1, 0.01], ['terrain.sand.bump', 0, 4, 0.05], ['terrain.sand.tint', 0, 1, 0.01],
    ['#Rock (4th)'], ['terrain.rock.dark'], ['terrain.rock.light'], ['terrain.rock.crackColor'], ['terrain.rock.lichenColor'], ['terrain.rock.scale', 0.2, 8, 0.05],
    ['terrain.rock.crackWidth', 0, 0.4, 0.005], ['terrain.rock.lichenAmount', 0, 1, 0.01], ['terrain.rock.bump', 0, 4, 0.05], ['terrain.rock.tint', 0, 1, 0.01],
    ['#Path (5th)'], ['terrain.path.dark'], ['terrain.path.light'], ['terrain.path.pebbleColor'], ['terrain.path.pebbleScale', 1, 30, 0.5],
    ['terrain.path.pebbleAmount', 0, 1, 0.01], ['terrain.path.bump', 0, 4, 0.05], ['terrain.path.tint', 0, 1, 0.01],
  ],
  'Custom model': [], // own panel (see scatterPanel)
};
/** Names for the entries of list-valued knobs that aren't min/max pairs. */
const ITEM_LABELS: Record<string, string[]> = { 'fields.kindWeights': ['unripe', 'ripe', 'tilled'] };
const SEED = ASSET_SEED; // same asset pool as the locations: what you see here is exactly what they use
const TILE_KINDS = ['grass', 'forest', 'sand', 'rock', 'bog', 'field'];

// ---- three.js scene ----
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#3a3f4b');
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
camera.position.set(6, 5, 8);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight('#dfe6ff', '#4a4030', 1.4));
const sun = new THREE.DirectionalLight('#fff0dc', 2.4);
sun.position.set(-8, 12, -5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22 });
scene.add(sun);
const preview = new THREE.Group();
scene.add(preview);
let grassUniforms: { uTime: { value: number }; uSway: { value: number } } | undefined;
let shellUniforms: { uTime: { value: number }; uSway: { value: number } } | undefined;

/** All preview grounds use the location ground shader (grass-scale multicolour detail + bumps). */
const terrainMat = terrainMaterial();
const stoneMat = rockMaterial();
const cliffMat = rockMaterial(undefined, true);
const mossMat = rockMaterial(undefined, true);
const ironMat = rockMaterial('iron');
const copperMat = rockMaterial('copper');
const saltMat = rockMaterial(undefined, false, 0.95);

type Weights = [grass: number, field: number, sand: number, rock: number, path: number];
function ground(size: number, color: string | ((x: number, z: number, out: THREE.Color) => THREE.Color), segments = 1, weights?: (x: number, z: number) => Weights): THREE.Mesh {
  const g = new THREE.PlaneGeometry(size, size, Math.max(segments, 8), Math.max(segments, 8));
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position'), col: number[] = [], c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    if (typeof color === 'string') c.set(color);
    else color(pos.getX(i), pos.getZ(i), c);
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const w4: number[] = [], wp: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const w = weights ? weights(pos.getX(i), pos.getZ(i)) : [1, 0, 0, 0, 0];
    w4.push(w[0], w[1], w[2], w[3]);
    wp.push(w[4]);
  }
  g.setAttribute('aW', new THREE.Float32BufferAttribute(w4, 4));
  g.setAttribute('aPath', new THREE.Float32BufferAttribute(wp, 1));
  const m = new THREE.Mesh(g, terrainMat.material); // same per-pixel terrain textures as the location view
  m.receiveShadow = true;
  return m;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, items: { x: number; z: number; s: number; rot: number; y?: number; sy?: number; tint?: THREE.Color }[], shadows = true): void {
  if (!items.length) return;
  const im = new THREE.InstancedMesh(geo, mat, items.length);
  im.castShadow = shadows;
  im.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  items.forEach((it, i) => {
    im.setMatrixAt(i, m.compose(new THREE.Vector3(it.x, it.y ?? 0, it.z), q.setFromAxisAngle(UP, it.rot), new THREE.Vector3(it.s, it.sy ?? it.s, it.s)));
    if (it.tint) im.setColorAt(i, it.tint);
  });
  preview.add(im);
}

/** Random items in a square area, kept only inside patches. */
function patchItems(size: number, perTile: number, scale: [number, number], patchSeed: number, patchScale: number, threshold: number) {
  const items: { x: number; z: number; s: number; rot: number }[] = [];
  let k = 0;
  for (let tz = -size / 2; tz < size / 2; tz++) {
    for (let tx = -size / 2; tx < size / 2; tx++) {
      for (let i = 0; i < perTile; i++) {
        const h = Math.sin(++k * 12.9898) * 43758.5453, rx = h - Math.floor(h), h2 = Math.sin(k * 78.233) * 43758.5453, rz = h2 - Math.floor(h2);
        const x = tx + rx, z = tz + rz;
        if (inPatch(patchSeed, x, z, patchScale, threshold)) items.push({ x, z, s: scale[0] + rx * (scale[1] - scale[0]), rot: rz * Math.PI * 2 });
      }
    }
  }
  return items;
}

// ---- per-tab previews ----
let scatterDraft: ScatterDef = { ...DEFAULT_SCATTER, tiles: [...DEFAULT_SCATTER.tiles], scale: [...DEFAULT_SCATTER.scale] };
let scatterMessage = '';

/** Species side by side (columns); each column shows the shape variants, one palette colour each. */
function speciesPreview(names: SpeciesName[]): void {
  preview.add(ground(24, '#6f9446'));
  const n = DECOR.placement.treeVariants, r = rngFor(SEED, 'editor-tints');
  names.forEach((name, col) => {
    const x = (col - (names.length - 1) / 2) * 2.6;
    for (let k = 0; k < Math.max(n, 3); k++) {
      const t = speciesTree(name, SEED, k % n), z = (k - 1) * 2;
      instanced(t.wood, barkMaterial(), [{ x, z, s: 1.3, rot: k }]);
      instanced(t.foliage, speciesFoliageMaterial(name), [{ x, z, s: 1.3, rot: k, tint: speciesTint(name, r, k) }]);
    }
  });
}

const builders: Record<string, () => void> = {
  Roads() {
    // the three road kinds as gentle curves across a meadow
    const curve = (z0: number, amp: number, phase: number) => Array.from({ length: 41 }, (_, i) => new THREE.Vector2(-10 + i * 0.5, z0 + Math.sin(i * 0.18 + phase) * amp));
    const roads = [{ kind: 'dusty' as const, pts: curve(-4, 1.2, 0) }, { kind: 'stone' as const, pts: curve(0, 1, 1.5) }, { kind: 'path' as const, pts: curve(4, 1.4, 3) }];
    const at = roadField(roads, -10, -10, 20, 20);
    const g = new THREE.PlaneGeometry(20, 20, 160, 160);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position'), col: number[] = [], w4: number[] = [], wp: number[] = [], wr: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const rw = at(pos.getX(i), pos.getZ(i)), rest = 1 - Math.max(rw.dusty, rw.stone, rw.path);
      col.push(0.48, 0.64, 0.29);
      w4.push(rest, 0, 0, 0);
      wp.push(rw.dusty);
      wr.push(rw.stone, rw.path);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(w4, 4));
    g.setAttribute('aPath', new THREE.Float32BufferAttribute(wp, 1));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(wr, 2));
    const m = new THREE.Mesh(g, terrainMat.material);
    m.receiveShadow = true;
    preview.add(m);
    camera.position.set(0, 9, 11);
  },
  Water: () => { templates.preview(TEMPLATE_TABS.Water); camera.position.set(0, 30, 30); controls.target.set(0, 0, 0); },
  'High spot': () => { templates.preview(TEMPLATE_TABS['High spot']); camera.position.set(0, 30, 30); controls.target.set(0, 0, 0); },
  Forest: () => { templates.preview(TEMPLATE_TABS.Forest); camera.position.set(0, 30, 30); controls.target.set(0, 0, 0); },
  Traits: () => { templates.preview(TEMPLATE_TABS.Traits); camera.position.set(0, 30, 30); controls.target.set(0, 0, 0); },
  Broadleaf: () => speciesPreview(['oak', 'birch', 'aspen']),
  Conifers: () => speciesPreview(['spruce', 'pine']),
  Trees() {
    if (DECOR.foliageSkirts) { speciesPreview(['oak', 'birch', 'aspen', 'spruce', 'pine']); return; }
    preview.add(ground(24, '#6f9446'));
    const bark = new THREE.MeshLambertMaterial({ color: DECOR.barkColor, flatShading: true });
    const n = DECOR.placement.treeVariants;
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * 2.4;
      const b = broadleafTree(SEED, k), c = coniferTree(SEED, k);
      instanced(b.wood, bark, [{ x, z: -1.5, s: 1.3, rot: 0 }]);
      instanced(b.foliage, foliageMaterial('broadleaf'), [{ x, z: -1.5, s: 1.3, rot: 0 }]);
      instanced(c.wood, bark, [{ x, z: 1.5, s: 1.3, rot: 0 }]);
      instanced(c.foliage, foliageMaterial('conifer'), [{ x, z: 1.5, s: 1.3, rot: 0 }]);
    }
  },
  Grass() {
    const P = DECOR.placement;
    // meadow on the left (ground tinted under the patches), a reed bed on the right
    preview.add(ground(16, (x, z, out) => (x < 4
      ? tuftGroundTint(DECOR.tufts.meadow, out.set('#7aa34a'), patchAmount(SEED, x, z, P.grassPatchScale, P.grassPatchThreshold))
      : tuftGroundTint(DECOR.tufts.reed, out.set('#4c5532'), 1)), 128));
    const g = grassMaterial();
    grassUniforms = g.uniforms;
    if (DECOR.shells.enabled) {
      const shells = shellGrass(-8, -8, 4, 8, () => 0, (x, z) => patchAmount(SEED, x, z, P.grassPatchScale, P.grassPatchThreshold));
      if (shells) { shellUniforms = shells.uniforms; preview.add(shells.mesh); }
    } else {
        const items = patchItems(16, P.grassPatchDensity, [0.7, 1.4], SEED, P.grassPatchScale, P.grassPatchThreshold).filter((it) => it.x < 4);
      tuftVariants(SEED, DECOR.tufts.meadow).forEach((geo, k, all) => instanced(geo, g.material, items.filter((_, i) => i % all.length === k), false));
    }
    const reeds = patchItems(16, P.reedsPerBogTile, [0.7, 1.4], SEED, 1, -1).filter((it) => it.x > 4.3);
    tuftVariants(SEED, DECOR.tufts.reed).forEach((geo, k, all) => instanced(geo, g.material, reeds.filter((_, i) => i % all.length === k), false));
  },
  Stones() {
    preview.add(ground(14, '#8a8274', 32, () => [0.3, 0, 0, 0.7, 0]));
    const P = DECOR.placement;
    const rows: [number, boolean, THREE.Material][] = [[P.rockVariants, false, stoneMat.material], [P.mossyRockVariants, true, mossMat.material]];
    rows.forEach(([n, mossy, mat], row) => {
      for (let k = 0; k < n; k++) {
        const geo = rockGeometry(SEED, k, undefined, mossy);
        const x = (k - (n - 1) / 2) * 1.6;
        instanced(geo, mat, [{ x, z: -4 + row * 1.8, s: 0.6, rot: k, y: -0.1 }]); // the variants: bare row, mossy row
        // a scatter using the chances, like on a rock tile / meadow
        const items: { x: number; z: number; s: number; rot: number; y: number }[] = [];
        for (let i = 0; i < 40; i++) {
          const h = Math.sin((k + 1 + row * 9) * 97.1 + i * 13.7) * 43758.5453, r = h - Math.floor(h);
          const h2 = Math.sin((k + 1 + row * 9) * 31.3 + i * 7.9) * 43758.5453, r2 = h2 - Math.floor(h2);
          const share = mossy ? P.mossyShare : 1 - P.mossyShare;
          const big = r < P.rockChance / Math.max(1, n) * 2 * share, small = r2 < P.pebbleChance * 4 * share;
          if (big || small) items.push({ x: (r - 0.5) * 12, z: 2 + (r2 - 0.5) * 5, s: big ? 0.25 + r2 * 0.3 : 0.05 + r * 0.07, rot: r * 6, y: -0.04 });
        }
        instanced(geo, mat, items);
      }
    });
  },
  Cliffs: () => { templates.preview(TEMPLATE_TABS.Cliffs); camera.position.set(0, 30, 30); controls.target.set(0, 0, 0); },
  Quarries() {
    // columns: mud, stone, iron ore, copper ore – rows: the variants
    preview.add(ground(24, '#7aa34a', 32, () => [0.6, 0, 0, 0.4, 0]));
    const kinds = ['mud', 'stone', 'iron', 'copper', 'salt'] as const, n = Math.max(1, DECOR.quarries.variants);
    const mats = { mud: mudMaterial(), stone: stoneMat.material, iron: ironMat.material, copper: copperMat.material, salt: saltMat.material };
    kinds.forEach((k, col) => {
      for (let v = 0; v < n; v++) instanced(quarryGeometry(SEED, k, v), mats[k], [{ x: (col - 2) * 4, z: (v - (n - 1) / 2) * 4.5, s: 1, rot: 0, y: 0 }]);
    });
    // `boulders`: random bare stones around every quarry (in a location they are spread over the deposit)
    const Q = DECOR.quarries, nb = Math.max(1, DECOR.placement.rockVariants), r = rngFor(SEED, 'quarry-boulders');
    const items: { x: number; z: number; s: number; rot: number; y: number; v: number }[] = [];
    kinds.forEach((_, col) => { for (let v = 0; v < n; v++) for (let i = 0; i < Q.boulders; i++) {
      const a = r.next() * Math.PI * 2, d = 1.8 + r.next() * 0.6;
      items.push({ x: (col - 2) * 4 + Math.cos(a) * d, z: (v - (n - 1) / 2) * 4.5 + Math.sin(a) * d, s: (Q.boulderSize[0] + r.next() * (Q.boulderSize[1] - Q.boulderSize[0])) * 0.5, rot: r.next() * 6, y: -0.04, v: r.int(0, nb - 1) });
    } });
    for (let k = 0; k < nb; k++) instanced(rockGeometry(SEED, k), stoneMat.material, items.filter((i) => i.v === k));
    camera.position.set(0, 15, 17);
  },
  Fields() {
    const R = 13;
    preview.add(ground(2 * R + 4, (x, z, out) => fieldGroundColor(SEED, x, z, 0, 0, out), 150, (x, z) => { // ground matches each plot
      const inside = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, z), R - 1, R);
      const onPath = 1 - THREE.MathUtils.smoothstep(fieldPlotAt(SEED, x, z, 0, 0).edge, DECOR.fields.pathWidth * 0.5, DECOR.fields.pathWidth * 0.5 + 0.3);
      return [1 - inside, inside * (1 - onPath), 0, 0, inside * onPath];
    }));
    const crops: [CropItem[], CropItem[], CropItem[]] = [[], [], []];
    for (let tz = -R; tz < R; tz++) for (let tx = -R; tx < R; tx++) {
      if (Math.hypot(tx + 0.5, tz + 0.5) < R) cropItemsForTile(SEED, tx, tz, 0, 0, crops);
    }
    const g = grassMaterial();
    grassUniforms = g.uniforms;
    const cg = cropGeometries(SEED);
    cg.unripe.forEach((geo, k) => instanced(geo, g.material, crops[0].filter((c) => c.v === k), false));
    cg.ripe.forEach((geo, k) => instanced(geo, g.material, crops[1].filter((c) => c.v === k), false));
  },
  Ground() {
    // the five terrain textures side by side, softly blended: grass | tilled field | sand | rock | path
    // (terrain colours underneath as in a location, so `tint` shows its effect)
    const kinds = ['#7aa34a', '#6b573a', '#c9b27a', '#8f887c', '#8a7350'].map((c) => new THREE.Color(c));
    const band = (x: number) => Math.min(3.999, Math.max(0, (x + 8) / 16 * 5 - 0.5));
    preview.add(ground(16, (x, _z, out) => {
      const t = band(x), i = Math.floor(t), f = THREE.MathUtils.smoothstep(t - i, 0.35, 0.65);
      return out.copy(kinds[i]).lerp(kinds[Math.min(4, i + 1)], f);
    }, 128, (x) => {
      const t = band(x), i = Math.floor(t), f = THREE.MathUtils.smoothstep(t - i, 0.35, 0.65);
      const w: Weights = [0, 0, 0, 0, 0];
      w[i] += 1 - f;
      w[Math.min(4, i + 1)] += f;
      return w;
    }));
    camera.position.set(0, 7, 9);
  },
  'Custom model'() {
    preview.add(ground(16, '#7aa34a'));
    const def = scatterDraft;
    if (!def.url) return;
    loadScatterParts(def).then((parts) => {
      const items = patchItems(16, def.perTile, def.scale, SEED + 7, def.patchScale, def.patchThreshold).map((it) => ({ ...it, y: def.yOffset }));
      for (const p of parts) instanced(p.geometry, p.material, items);
      scatterMessage = `${items.length} instances`;
      status();
    }).catch((e) => {
      scatterMessage = `⚠️ could not load ${def.url}: ${e?.message ?? e}`;
      status();
    });
  },
};

function rebuild(): void {
  templates.dispose(); // reflector render target of the template preview
  preview.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  preview.clear();
  grassUniforms = undefined;
  shellUniforms = undefined;
  // camera: builders may set a default view – it only applies to a tab never viewed before;
  // otherwise the view stays (rebuilds) or comes back as it was left (tab switch, reload)
  const keepP = camera.position.clone(), keepT = controls.target.clone();
  builders[tab]();
  const saved = views[tab];
  if (viewTab !== tab) {
    if (saved) { camera.position.fromArray(saved.p); controls.target.fromArray(saved.t); }
    viewTab = tab;
  } else {
    camera.position.copy(keepP);
    controls.target.copy(keepT);
  }
  controls.update();
}

// ---- UI ----
const tabsEl = document.getElementById('tabs')!;
const knobsEl = document.getElementById('knobs')!;
const statusEl = document.getElementById('status')!;
// last tab and the camera view per tab survive reloads
const TAB_KEY = 'qre.editor.tab', VIEWS_KEY = 'qre.editor.views';
const readJson = <T>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } };
const views: Record<string, { p: number[]; t: number[] }> = readJson(VIEWS_KEY, {});
let viewTab = '';
let tab: string = readJson<string>(TAB_KEY, 'Trees');
let viewTimer: ReturnType<typeof setTimeout> | undefined;
controls.addEventListener('change', () => { // also while damping settles after you let go
  views[tab] = { p: camera.position.toArray(), t: controls.target.toArray() };
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch { /* ignore */ } }, 300);
});
const selectTab = (name: string) => {
  tab = name;
  try { localStorage.setItem(TAB_KEY, JSON.stringify(name)); } catch { /* ignore */ }
};

// Terrain templates (= location traits): tabs Water, High spot, Forest, Traits. Loaded from the server.
const TEMPLATE_TABS: Record<string, TemplateKind[]> = {
  Water: ['lake', 'pond', 'river'], 'High spot': ['highspot'], Forest: ['forest'], Cliffs: ['cliff'],
  Traits: ['rocky', 'quarry', 'climate', 'valley', 'fields', 'perimeter'],
};
try {
  setTemplates(await (await fetch('/api/templates')).json() as TerrainTemplate[]);
} catch {
  // server not reachable: built-in defaults
}
const templates = createTemplateEditor({
  preview, camera, controls, canvas, sun, terrainMaterial: terrainMat.material, knobsEl,
  rebuild: () => rebuild(), renderPanel: () => renderPanel(), activeKinds: () => TEMPLATE_TABS[tab] ?? null,
  status: (text) => { statusEl.textContent = text; },
});

const get = (path: string): any => path.split('.').reduce((o: any, k) => o[k], DECOR);
const set = (path: string, value: unknown) => {
  const keys = path.split('.');
  const last = keys.pop()!;
  keys.reduce((o: any, k) => o[k], DECOR)[last] = value;
};

function save(): void {
  try {
    localStorage.setItem(DECOR_STORAGE_KEY, JSON.stringify(DECOR));
  } catch {
    // ignore
  }
  status();
}

function status(): void {
  statusEl.textContent = `${tab === 'Custom model' ? scatterMessage + ' · ' : ''}saved – reload a location page to see it there`;
}

let timer: ReturnType<typeof setTimeout> | undefined;
const changed = () => {
  save();
  clearTimeout(timer);
  timer = setTimeout(rebuild, 120);
};

function label(path: string): string {
  return path.split('.').pop()!.replace(/([A-Z])/g, ' $1').toLowerCase();
}

function slider(container: HTMLElement, name: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): void {
  const row = document.createElement('label');
  row.className = 'knob';
  const num = document.createElement('input');
  num.type = 'number';
  Object.assign(num, { min, max, step, value: String(value) });
  const range = document.createElement('input');
  range.type = 'range';
  Object.assign(range, { min, max, step, value: String(value) });
  range.oninput = () => { num.value = range.value; onInput(Number(range.value)); };
  num.onchange = () => { range.value = num.value; onInput(Number(num.value)); };
  row.append(Object.assign(document.createElement('span'), { textContent: name }), num, range);
  container.append(row);
}

function knobsPanel(): void {
  for (const [path, min = 0, max = 1, step = 0.01] of TABS[tab]) {
    if (path.startsWith('#')) { knobsEl.append(Object.assign(document.createElement('h3'), { textContent: path.slice(1) })); continue; }
    const value = get(path);
    if (typeof value === 'boolean') {
      const row = document.createElement('label');
      row.className = 'knob check';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
      box.onchange = () => { set(path, box.checked); changed(); };
      row.append(Object.assign(document.createElement('span'), { textContent: label(path) }), box);
      knobsEl.append(row);
    } else if (typeof value === 'string' && /\.(shoreTexture|bedTexture)$/.test(path)) { // texture choice
      const row = document.createElement('label');
      row.className = 'knob check';
      const s = document.createElement('select');
      for (const o of SURFACES) s.append(Object.assign(document.createElement('option'), { value: o, textContent: o, selected: o === value }));
      s.onchange = () => { set(path, s.value); changed(); };
      row.append(Object.assign(document.createElement('span'), { textContent: label(path) }), s);
      knobsEl.append(row);
    } else if (typeof value === 'string') {
      const row = document.createElement('label');
      row.className = 'knob check';
      const input = Object.assign(document.createElement('input'), { type: 'color', value });
      input.oninput = () => { set(path, input.value); changed(); };
      row.append(Object.assign(document.createElement('span'), { textContent: label(path) }), input);
      knobsEl.append(row);
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      const row = document.createElement('div');
      row.className = 'knob check';
      row.append(Object.assign(document.createElement('span'), { textContent: label(path) }));
      const list = document.createElement('div');
      list.className = 'colors';
      value.forEach((c: string, i: number) => {
        const input = Object.assign(document.createElement('input'), { type: 'color', value: c });
        input.oninput = () => { value[i] = input.value; changed(); };
        list.append(input);
      });
      row.append(list);
      knobsEl.append(row);
    } else if (Array.isArray(value) && value.length !== 2) {
      const names = ITEM_LABELS[path] ?? value.map((_: number, i: number) => `#${i + 1}`);
      value.forEach((v: number, i: number) => slider(knobsEl, `${label(path)}: ${names[i]}`, v, min, max, step, (nv) => { value[i] = nv; changed(); }));
    } else if (Array.isArray(value)) {
      slider(knobsEl, `${label(path)} (min)`, value[0], min, max, step, (v) => { value[0] = Math.min(v, value[1]); changed(); });
      slider(knobsEl, `${label(path)} (max)`, value[1], min, max, step, (v) => { value[1] = Math.max(v, value[0]); changed(); });
    } else {
      slider(knobsEl, label(path), value, min, max, step, (v) => { set(path, v); changed(); });
    }
  }
}

function scatterPanel(): void {
  const d = scatterDraft;
  const text = (name: string, value: string, onChange: (v: string) => void) => {
    const row = document.createElement('label');
    row.className = 'knob';
    const input = Object.assign(document.createElement('input'), { type: 'text', value });
    input.onchange = () => onChange(input.value.trim());
    row.append(Object.assign(document.createElement('span'), { textContent: name }), input);
    knobsEl.append(row);
  };
  knobsEl.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: 'Put an <b>.stl / .glb / .gltf</b> into <code>assets/</code> and enter its URL, e.g. <code>/assets/bush.glb</code>. It is instanced in patches like grass.',
  }));
  text('name', d.name, (v) => { d.name = v; });
  text('url', d.url, (v) => { d.url = v; rebuild(); });
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.stl,.glb,.gltf' });
  file.onchange = () => {
    const f = file.files?.[0];
    if (!f) return;
    // preview only: blob URLs don't survive a reload – copy the file to assets/ for locations
    d.url = `${URL.createObjectURL(f)}#${f.name.toLowerCase().endsWith('.stl') ? 'x.stl' : 'x.glb'}`;
    scatterMessage = `previewing ${f.name} (copy it to assets/ and set the url to use it in locations)`;
    rebuild();
  };
  const fileRow = document.createElement('label');
  fileRow.className = 'knob';
  fileRow.append(Object.assign(document.createElement('span'), { textContent: 'preview a file' }), file);
  knobsEl.append(fileRow);

  const tiles = document.createElement('div');
  tiles.className = 'knob check';
  tiles.append(Object.assign(document.createElement('span'), { textContent: 'grows on' }));
  for (const kind of TILE_KINDS) {
    const l = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: d.tiles.includes(kind) });
    box.onchange = () => { d.tiles = box.checked ? [...new Set([...d.tiles, kind])] : d.tiles.filter((k) => k !== kind); };
    l.append(box, ` ${kind} `);
    tiles.append(l);
  }
  knobsEl.append(tiles);
  slider(knobsEl, 'per tile', d.perTile, 1, 20, 1, (v) => { d.perTile = v; rebuild(); });
  // scale sliders are logarithmic (10^-5 … 10): models come in mm, cm, m…
  const logSlider = (name: string, value: number, onInput: (v: number) => void) => slider(knobsEl, `${name} (log10)`, Math.log10(value), -5, 1, 0.01, (v) => onInput(10 ** v));
  logSlider('scale min', d.scale[0], (v) => { d.scale[0] = Math.min(v, d.scale[1]); rebuild(); });
  logSlider('scale max', d.scale[1], (v) => { d.scale[1] = Math.max(v, d.scale[0]); rebuild(); });
  knobsEl.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'scale = model units → tiles (1 tile ≈ 1 m). An STL in millimetres needs ~0.0001.' }));
  slider(knobsEl, 'patch scale', d.patchScale, 0.05, 0.6, 0.01, (v) => { d.patchScale = v; rebuild(); });
  slider(knobsEl, 'patch threshold', d.patchThreshold, 0, 0.95, 0.01, (v) => { d.patchThreshold = v; rebuild(); });
  slider(knobsEl, 'y offset', d.yOffset, -1, 1, 0.01, (v) => { d.yOffset = v; rebuild(); });
  const color = document.createElement('label');
  color.className = 'knob check';
  const ci = Object.assign(document.createElement('input'), { type: 'color', value: d.color });
  ci.oninput = () => { d.color = ci.value; rebuild(); };
  color.append(Object.assign(document.createElement('span'), { textContent: 'colour (STL only)' }), ci);
  knobsEl.append(color);

  const add = Object.assign(document.createElement('button'), { className: 'btn', textContent: '➕ Add to locations' });
  add.onclick = () => {
    if (d.url.startsWith('blob:')) { scatterMessage = '⚠️ copy the file to assets/ and use its /assets/… url first'; status(); return; }
    DECOR.scatters.push(JSON.parse(JSON.stringify(d)));
    save();
    renderPanel();
  };
  knobsEl.append(add);

  const list = document.createElement('div');
  list.className = 'scatters';
  DECOR.scatters.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'scatter';
    row.append(Object.assign(document.createElement('span'), { textContent: `${s.name} – ${s.url} on ${s.tiles.join(', ')}` }));
    const edit = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'edit' });
    edit.onclick = () => { scatterDraft = JSON.parse(JSON.stringify(s)); DECOR.scatters.splice(i, 1); save(); renderPanel(); rebuild(); };
    const del = Object.assign(document.createElement('button'), { className: 'btn', textContent: '✕' });
    del.onclick = () => { DECOR.scatters.splice(i, 1); save(); renderPanel(); };
    row.append(edit, del);
    list.append(row);
  });
  if (DECOR.scatters.length) knobsEl.append(Object.assign(document.createElement('h3'), { textContent: 'In locations' }), list);
}

function renderPanel(): void {
  tabsEl.innerHTML = '';
  for (const name of Object.keys(TABS)) {
    const b = Object.assign(document.createElement('button'), { className: `tab${name === tab ? ' active' : ''}`, textContent: name });
    b.onclick = () => { selectTab(name); renderPanel(); rebuild(); };
    tabsEl.append(b);
  }
  knobsEl.innerHTML = '';
  if (tab === 'Custom model') scatterPanel();
  else {
    if (TEMPLATE_TABS[tab]) templates.panel(TEMPLATE_TABS[tab]); // named terrain templates (= traits)
    knobsPanel();
  }
  status();
}

document.getElementById('reset')!.onclick = () => {
  if (!confirm(`Reset all ${tab === 'Custom model' ? 'custom models' : tab.toLowerCase()} settings to the defaults?`)) return;
  const defaults = decorDefaults() as any;
  if (tab === 'Custom model') DECOR.scatters = [];
  else for (const [path] of TABS[tab]) if (!path.startsWith('#')) set(path, JSON.parse(JSON.stringify(path.split('.').reduce((o: any, k) => o[k], defaults))));
  save();
  renderPanel();
  rebuild();
};
document.getElementById('copy')!.onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(DECOR, null, 2));
  statusEl.textContent = 'copied DECOR as JSON – paste into location-decor.ts to make it the default';
};
if (!TABS[tab]) selectTab('Trees'); // a stored tab that no longer exists
renderPanel();
rebuild();
renderer.setAnimationLoop(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  terrainMat.sync(); // live texture knobs
  stoneMat.sync();
  ironMat.sync();
  copperMat.sync();
  saltMat.sync();
  cliffMat.sync();
  mossMat.sync();
  updateTreeWind(performance.now() / 1000);
  templates.update(performance.now() / 1000);
  if (shellUniforms) { shellUniforms.uTime.value = performance.now() / 1000; shellUniforms.uSway.value = DECOR.grassSway; }
  if (grassUniforms) {
    grassUniforms.uTime.value = performance.now() / 1000;
    grassUniforms.uSway.value = DECOR.grassSway;
  }
  controls.update();
  renderer.render(scene, camera);
});
