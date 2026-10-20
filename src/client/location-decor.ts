// Procedural vegetation and rocks for the 3D location view. Each generator builds a few
// variants ONCE (merged BufferGeometries); the view then places them as InstancedMeshes,
// so thousands of trees/tufts cost a handful of draw calls.
//   - broadleaf trees: recursive branching (each branch splits into 2–3 shorter, thinner,
//     angled branches) with leaf clusters at the tips
//   - conifers: tapered trunk with whorls of drooping branches, needle masses along them
//   - rocks: icosphere displaced by noise, flattened base, lichen on top
//   - grass tufts: blades with a dark→light gradient, swaying in the wind (vertex shader)
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { hash32, KIND_DEFAULTS, rngFor, type Rng, type WaterLooks } from '../engine/index.ts';
import { valueNoise } from '../engine/noise.ts';

// ======================= KNOBS =======================
export const DECOR = {
  broadleafDepth: 3, // recursion depth (branches = 1 + 3 + 9 + 27 at depth 3)
  broadleafSpread: [0.45, 0.8], // radians: how far child branches tilt from their parent
  leafSize: 0.1, // length of one leaf
  leavesPerTip: 100  , // leaves around each branch tip
  leafSpread: 0.22, // radius of the leaf cluster at a tip

  /**
   * Foliage as textured "cards" (flat patches with a leaf / needle texture, cut out by alpha)
   * instead of modelled leaves and needle clumps: ~30–50× fewer triangles per tree.
   * false = the modelled foliage (leavesPerTip / conifer clumps) – kept for comparison.
   */
  /**
   * Foliage as stacked "skirts" around one trunk: every tree species (DECOR.species) is a trunk
   * wrapped in drooping sheets – toothed needle texture for conifers, scalloped leafy one for
   * broadleaf trees. No individual branches/leaves – cheapest and most stylised. Takes precedence
   * over cards. These knobs are shared by all species; the shapes are per species.
   */
  foliageSkirts: true,
  skirts: {
    teeth: 22, // jagged teeth around a needle skirt's rim (texture)
    toothDepth: 0.35, // how deep the teeth cut into the skirt (0..0.8)
    rimWobble: 0.18, // irregularity of the rim radius
    segments: 10, // around the trunk (smoothness; triangles per skirt = segments × 4)
    alphaTest: 0.4,
  },

  /**
   * Tree species (skirt style). Each tier = one skirt; its size and shape blend from the lowest
   * tier (…Bottom) to the highest (…Top), the radius bulging to radiusWidest at widestAt (0..1 up
   * the crown). Heights are fractions of the tree height, other sizes in tiles.
   * share: how common within its kind (DECOR.placement.coniferShare splits conifers / broadleaf).
   * palette: each tree picks one colour (repeat a colour to make it more common).
   */
  species: {
    oak: {
      kind: 'broadleaf', foliage: 'leaf', share: 1, height: [1.5, 2.0],
      trunkWidth: 0.09, trunkTop: 0.8, barkColor: '#4f3a28', barkMarks: '#2a1f15', barkMarkAmount: 0.35,
      tiers: 4, crownStart: 0.42, crownTop: 0.85, radiusBottom: 0.55, radiusWidest: 0.8, radiusTop: 0.4, widestAt: 0.35,
      dropBottom: 0.22, dropTop: 0.18, droopBottom: 2.4, droopTop: 1.8, tilt: 0.12, cap: 'dome', lightenUp: 0.1,
      palette: ['#4f7a2e', '#5d8433', '#6b8a35', '#7a8f3a'], paletteJitter: 0.04,
    },
    birch: {
      kind: 'broadleaf', foliage: 'leaf', share: 1, height: [1.7, 2.3],
      trunkWidth: 0.05, trunkTop: 0.92, barkColor: '#e6e2d6', barkMarks: '#2b2723', barkMarkAmount: 0.3,
      tiers: 6, crownStart: 0.38, crownTop: 0.9, radiusBottom: 0.38, radiusWidest: 0.45, radiusTop: 0.18, widestAt: 0.3,
      dropBottom: 0.3, dropTop: 0.18, droopBottom: 1.4, droopTop: 1.6, tilt: 0.08, cap: 'dome', lightenUp: 0.1,
      palette: ['#8aa83f', '#9cb24a', '#7f9e3c', '#c9b648'], paletteJitter: 0.04,
    },
    aspen: {
      kind: 'broadleaf', foliage: 'leaf', share: 1, height: [1.8, 2.4],
      trunkWidth: 0.055, trunkTop: 0.9, barkColor: '#b9bba4', barkMarks: '#3b3c33', barkMarkAmount: 0.22,
      tiers: 5, crownStart: 0.45, crownTop: 0.9, radiusBottom: 0.32, radiusWidest: 0.42, radiusTop: 0.22, widestAt: 0.5,
      dropBottom: 0.22, dropTop: 0.18, droopBottom: 2, droopTop: 2, tilt: 0.1, cap: 'dome', lightenUp: 0.1,
      palette: ['#6e9a3a', '#7fa843', '#d1a83a', '#c8742c'], paletteJitter: 0.04,
    },
    spruce: {
      kind: 'conifer', foliage: 'needle', share: 1, height: [1.5, 2.1],
      trunkWidth: 0.06, trunkTop: 0.95, barkColor: '#5b3f26', barkMarks: '#36261a', barkMarkAmount: 0.2,
      tiers: 5, crownStart: 0.39, crownTop: 0.83, radiusBottom: 0.75, radiusWidest: 0.75, radiusTop: 0.21, widestAt: 0,
      dropBottom: 0.42, dropTop: 0.27, droopBottom: 1.6, droopTop: 1.6, tilt: 0, cap: 'point', lightenUp: 0.08,
      palette: ['#3f6e33', '#527d36', '#73823a', '#a19a45', '#c9702f', '#4f8b86'], paletteJitter: 0.04,
    },
    pine: {
      kind: 'conifer', foliage: 'needle', share: 1, height: [1.9, 2.5],
      trunkWidth: 0.06, trunkTop: 0.85, barkColor: '#8a5232', barkMarks: '#4a2c1b', barkMarkAmount: 0.3,
      tiers: 4, crownStart: 0.58, crownTop: 0.88, radiusBottom: 0.5, radiusWidest: 0.6, radiusTop: 0.35, widestAt: 0.35,
      dropBottom: 0.2, dropTop: 0.16, droopBottom: 2.4, droopTop: 2.2, tilt: 0.12, cap: 'dome', lightenUp: 0.08,
      palette: ['#3f6a3c', '#4b7044', '#5a7a3e', '#486e58'], paletteJitter: 0.04,
    },
  } satisfies Record<string, TreeSpecies>,
  foliageCards: true,
  cards: {
    leafCardsPerTip: 3, // crossed patches per branch tip
    leafCardSize: 0.55, // patch size (tiles)
    leavesInTexture: 70, // leaves drawn into the leaf texture
    leafSize: 30, // leaf size in the texture (px of 256)
    coniferCardsPerBranch: 2, // 1 = flat spray, 2 = flat + vertical (fuller)
    coniferCardWidth: 0.5, // spray width (tiles)
    needleDensity: 46, // needle pairs per spray in the texture
    alphaTest: 0.45, // cut-out threshold (higher = thinner foliage)
  },

  conifer: {
    height: [1.5, 2.1], // tree height range (before per-tree scaling)
    whorls: 8, // rings of branches up the trunk
    branches: 7, // branches per ring
    massesPerBranch: 2, // soft needle clumps along each branch (more = fluffier, more triangles)
    massDetail: 1, // 0 = faceted 20-face clumps, 1 = rounder 80-face clumps
    thickness: 0.1, // clump thickness
    width: 0.6, // length of the lowest branches (crown width)
    droop: 0.35, // how much branches hang down
    fluff: 0.35, // randomness of clump size/position (0 = neat)
    crownStart: 0.28, // height where the lowest branches start
    core: true, // dark filler around the trunk (no see-through gaps)
    color: '#2f5527',
    lightenUp: 0.08, // upper whorls get this much lighter
    colorJitter: 0.05,
  },
  /**
   * Shell grass: meadow patches drawn as stacked see-through layers (fur technique) instead of
   * individual blade tufts. Reeds and crops stay tufts. Costs fill rate (layers × patch area).
   */
  shells: {
    enabled: true,
    layers: 10, // stacked layers (more = smoother strands, slower)
    height: 0.2, // tiles: grass height in the middle of a patch
    density: 22, // strands per tile (along one side)
    thickness: 0.4, // strand radius at the root (fraction of its cell)
    lean: 0.35, // how far strands curve over towards the tip (fraction of a cell)
    cellSize: 0.5, // tiles: mesh resolution (follows the terrain)
    base: '#4a6b2c', // colour at the root…
    tip: '#b9d36e', // …and at the tip
    dry: '#d8c67a', // tip colour of dry strands
    dryAmount: 0.15, // fraction of dry strands
    forestAmount: 0.6, // grass amount in forest patches (meadow = 1)
  },
  rockChamfer: 0.15, // bevel on every edge of a stone (in stone size units; 0 = sharp block)
  rockRoughness: 0.45, // how irregular the stone blocks are
  grassSway: 0.08, // wind sway at the blade tip (all tufts)
  treeSway: 0.05, // tiles the crown of a ~2-tile tree leans in the wind (whole tree bends from the ground)
  treeSwaySpeed: 0.8, // gust speed
  leafFlutter: 0.015, // fast small shimmer of the skirt rims (leaves / needles)

  /**
   * Tuft styles – one per grass type, same knobs for all. A seed head on a blade can be a grain
   * ear (long, narrow, many kernels, maybe drooping) or a weed/flower head (short, wide, few).
   * groundTint: how much the ground beneath takes on this style's colours.
   */
  tufts: {
    meadow: {
      blades: 3, height: [0.18, 0.34], width: 0.012, lean: 0.35, base: '#5f8336', tip: '#c2d97a',
      headChance: 0.15, headLength: 0.05, headWidth: 0.03, headKernels: 4, headDroop: 0.2, headColor: '#e2d9a6', groundTint: 0.45,
    },
    reed: {
      blades: 4, height: [0.4, 0.7], width: 0.014, lean: 0.1, base: '#4d5a2e', tip: '#a89a5c',
      headChance: 0.45, headLength: 0.1, headWidth: 0.022, headKernels: 7, headDroop: 0, headColor: '#5a3e26', groundTint: 0.4,
    },
    unripe: {
      blades: 5, height: [0.26, 0.42], width: 0.012, lean: 0.08, base: '#476f2a', tip: '#9cc558',
      headChance: 0.8, headLength: 0.07, headWidth: 0.02, headKernels: 7, headDroop: 0.1, headColor: '#a9c96a', groundTint: 0.6,
    },
    ripe: {
      blades: 5, height: [0.26, 0.42], width: 0.012, lean: 0.12, base: '#8a7432', tip: '#e6c868',
      headChance: 0.9, headLength: 0.085, headWidth: 0.022, headKernels: 8, headDroop: 0.45, headColor: '#e8c35a', groundTint: 0.6,
    },
  } satisfies Record<string, TuftStyle>,
  barkColor: '#5b3f26',
  leafColors: ['#3f6f2c', '#4d7f33', '#5c8c3a'], // per-cluster shades (tree tint multiplies these)
  rockColor: '#80868d', // slate grey-blue
  /** Stones & cliffs: faceted rock colour (vertex colours) + the rock texture projected in 3D + moss on top. */
  rockTexture: {
    scale: 3, // texture features per tile
    bump: 0.6, // fake relief from the texture
    tint: 0.75, // how much the rock / cliff colour shows (0 = texture colours only)
    cracks: 0.25, // crack lines of the texture (0 = clean faces)
    moss: 0.75, // grass / moss growing on the up-facing faces
    mossColor: '#7d9c43',
    mossHeight: 0.78, // how flat a face must be for moss (normal.y)
  },
  /**
   * Quarries (location traits mud-quarry / stone-quarry / iron-ore / copper-ore): one quarry model
   * on the deposit (variants: distinct models per kind, all locations use only these). Ore: boulders
   * and rocky ground on the deposit get coloured veins.
   */
  quarries: {
    variants: 2, // distinct models per quarry kind
    boulders: 9, // random bare boulders around every quarry (all kinds)
    boulderSize: [0.3, 0.6],
    mud: {
      width: 2.6, // tiles
      mounds: 7, // rounded heaps of dug-out mud around the pit
      moundSize: [0.3, 0.55],
      brickStacks: 2, // stacks of drying mud bricks
      color: '#6b4f33', wetColor: '#4a3624', puddleColor: '#4d473a', brickColor: '#9a6b45',
    },
    stone: {
      width: 3.4, // tiles: size of the stone patch
      stones: 18, // stones in the patch (shapes: Stones tab)
      stoneSize: [0.18, 0.5], // at the edge / in the middle
      terraces: 3, // steps of the quarried face at the back
      faceWidth: 1.8, // tiles
      missing: 0.35, // share of front blocks already taken out
      blocks: 5, // finished cut blocks lying around
      blockSize: 0.32,
      color: '#9a9488', // rough stone
      blockColor: '#c2b8a3', // cut / finished blocks
    },
    salt: {
      width: 3, stones: 22, stoneSize: [0.18, 0.5], saltShare: 0.4, // share of pure white salt stones
      color: '#8f8a82', saltColor: '#ffffff',
    },
    iron: {
      width: 3, stones: 24, stoneSize: [0.18, 0.55], oreShare: 0.4, // share of ore stones
      color: '#7d756d', oreColor: '#8a4a32', veinColor: '#9c4f33', veinAmount: 0.35, veinScale: 7, // rusty red stripes (scale: per tile)
    },
    copper: {
      width: 3, stones: 24, stoneSize: [0.18, 0.55], oreShare: 0.4,
      color: '#7a7a72', oreColor: '#3f8a70', veinColor: '#4a9a82', veinAmount: 0.35, veinScale: 7, // verdigris green stripes
    },
  },

  /**
   * Terrain textures (per pixel, procedural). Each surface has its own colours and pattern;
   * scale = features per tile, bump = fake relief, tint = how much the underlying terrain colour
   * (grass patches, crop plots, forest floor, bog…) colours the texture (0 = own colours only).
   */
  terrain: {
    grass: { dark: '#5d8536', light: '#8fb356', dry: '#b9b064', scale: 1.6, dryAmount: 0.25, speckle: 0.35, bump: 0.6, tint: 0.6 },
    field: { dark: '#4f3d27', light: '#7a6142', furrowSpacing: 0.35, furrowDepth: 0.7, clodScale: 5, bump: 1.4, tint: 0.35 },
    sand: { dark: '#b9a06c', light: '#ddc995', scale: 1.2, grain: 22, rippleSpacing: 0.45, rippleStrength: 0.35, bump: 0.6, tint: 0.3 },
    rock: { dark: '#6f6a62', light: '#a49d90', crackColor: '#3e3a35', lichenColor: '#7d8a4a', scale: 1.3, crackWidth: 0.05, lichenAmount: 0.3, bump: 1.2, tint: 0.3 },
    path: { dark: '#7a6447', light: '#a08660', pebbleColor: '#b8b0a2', pebbleScale: 7, pebbleAmount: 0.35, bump: 0.8, tint: 0.15 },
  },

  /** How much of everything is placed (per 1×1 tile). */
  /**
   * Ground detail shader (all terrain: grass, soil, sand, rock, bog). Per-pixel noise at grass
   * scale on top of the terrain colours, plus fake bumps so bare ground looks uneven too.
   * Scales are features per tile (1 tile ≈ 1 m).
   */
  ground: {
    enabled: false, // ground detail shader off for now (plain terrain colours); flip on to bring it back
    detailScale: 6, // grass-scale mottling
    detailContrast: 0.2, // light/dark strength of the mottling
    blotchScale: 1.1, // larger warm/cool patches
    blotchStrength: 0.35,
    warmTint: '#fff0b0', // dry / yellowish patches
    coolTint: '#c4dcbc', // fresh / greener patches
    speckleScale: 24, // fine flecks (soil crumbs, pebbles, flowers)
    speckleAmount: 0.3,
    speckleTint: '#fff4d8',
    bump: 0.45, // how much the noise bends the lighting (unevenness)
  },

  placement: {
    treesPerForestTile: 3,
    coniferShare: 0.5, // fraction of forest trees that are conifers
    treeVariants: 3, // distinct generated shapes per tree species (all locations use only these)
    grassTreeChance: 0.06, // lone trees in meadows
    grassPatchDensity: 24, // grass tufts per tile INSIDE a patch (none outside)
    grassPatchScale: 0.22, // patch size: smaller = bigger patches
    grassPatchThreshold: 0.64, // higher = fewer, smaller patches
    forestGrassPerTile: 3, // (also only inside patches)
    reedsPerBogTile: 10,
    rockChance: 0.5, // boulders on rock tiles
    rockVariants: 4, // distinct bare stone models (all locations use only these)
    mossyRockVariants: 2, // distinct mossy stone models
    mossyShare: 0.35, // share of placed stones that are mossy
    tuftVariants: 3, // distinct models per grass / reed / grain tuft style
    pebbleChance: 0.06, // small stones in meadows
  },

  /** Crop fields: plots fan out from a centre, split by randomly curved lines. */
  fields: {
    sectors: [9, 14], // number of wedges around the centre (min, max)
    sectorCurve: 0.16, // radians: how far the dividing lines bend
    sectorWaviness: 0.3, // how often they bend (per tile of distance)
    ringSpacing: 5, // tiles between the curved rings that cut wedges into plots
    ringWobble: 0.9, // tiles: how wavy the rings are
    pathWidth: 0.25, // tiles left unplanted along every dividing line
    kindWeights: [1, 1, 1], // how common: unripe grain, ripe grain, tilled field
    soilColor: '#6b573a', // bare soil (paths between plots); plots tint it with their crop colours
    grainPerTile: 26, // grain tufts per tile in unripe/ripe plots (tilled plots: just the field texture)
  },

  /**
   * Custom 3D models scattered in patches like grass (instanced). Add entries here or with the
   * asset editor (/editor). url: an .stl/.glb/.gltf in /assets; tiles: where it may grow.
   */
  scatters: [] as ScatterDef[],

  /**
   * Roads: 1–3 enter from the map edge and lead to the centre (stone-laid where the place is
   * important, else dusty), foot paths branch off to the quarry and the water. Dusty road texture
   * = Ground tab → path; stone road and foot path have their own below.
   */
  roads: {
    count: [1, 3], // main roads per location (min, max)
    stoneRoadMinTier: 2, // locations with at least this many stars get stone-laid roads
    hubRadius: 2.5, // tiles: roads end this close to the centre
    slopeCost: 8, // how much roads avoid steep ground (they never cross water)
    pathToQuarry: true,
    pathToWater: true,
    dusty: { width: 1.1, edge: 0.5 },
    stone: { width: 1.3, edge: 0.25, stone: '#a29c90', grout: '#5d574c', cobbleSize: 4.5, bump: 1.4, tint: 0.1 },
    path: { width: 0.55, edge: 0.45, dark: '#8b7856', light: '#ad9a72', bump: 0.5, tint: 0.2 },
  },

};
// =====================================================

export interface ScatterDef {
  name: string;
  url: string;
  tiles: string[]; // tile kinds: grass, forest, sand, rock, bog, field
  perTile: number; // instances per tile inside a patch
  scale: [number, number]; // asset units -> tiles (min, max)
  patchScale: number; // patch size (smaller = bigger patches)
  patchThreshold: number; // 0 = everywhere, higher = rarer patches
  color: string; // STL only (STLs carry no material)
  yOffset: number;
}

export interface TreeSpecies {
  kind: 'broadleaf' | 'conifer';
  foliage: 'leaf' | 'needle'; // skirt texture: scalloped leaves / toothed needles
  share: number;
  height: [number, number]; // tree height range (before per-tree scaling)
  trunkWidth: number; // trunk radius at the base
  trunkTop: number; // the trunk reaches this fraction of the height
  barkColor: string;
  barkMarks: string; // colour of bark patches (birch: dark dashes)
  barkMarkAmount: number; // 0 = plain bark, 1 = mostly marks
  tiers: number; // stacked skirts
  crownStart: number; // rim height of the lowest skirt (fraction of the tree height)
  crownTop: number; // rim height of the highest skirt
  radiusBottom: number;
  radiusWidest: number;
  radiusTop: number;
  widestAt: number; // 0..1 up the crown
  dropBottom: number; // skirt height (trunk -> rim) of the lowest tier…
  dropTop: number; // …and of the highest
  droopBottom: number; // >1: flat near the trunk, bending down at the rim (1 = straight cone)
  droopTop: number;
  tilt: number; // radians of random tilt per skirt (0 = all level)
  cap: 'point' | 'dome' | 'none'; // what sits on top
  lightenUp: number; // upper skirts get this much lighter
  palette: string[];
  paletteJitter: number; // per-tree hue/lightness variation around the picked colour
}

export const DEFAULT_SCATTER: ScatterDef = {
  name: 'my model', url: '', tiles: ['grass'], perTile: 2, scale: [0.2, 0.35],
  patchScale: 0.2, patchThreshold: 0.65, color: '#a0a080', yOffset: 0,
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Seed of the pregenerated asset pool: every model (tree, stone, cliff, tuft, quarry…) is built
 * from this seed + its variant index, so all locations share exactly the variants the editor shows.
 * Locations only decide where things go and which variant each one uses.
 */
export const ASSET_SEED = 12345;

/** A cylinder from `start` along `dir` (open-ended, low-poly). */
function limb(start: THREE.Vector3, dir: THREE.Vector3, length: number, r0: number, r1: number, sides = 5): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, length, sides, 1, true);
  g.translate(0, length / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
  g.translate(start.x, start.y, start.z);
  return g;
}

/** Flat triangles with one colour and one shared normal (non-indexed: position/normal/color only). */
function flatTris(points: THREE.Vector3[], normal: THREE.Vector3, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((p) => [p.x, p.y, p.z]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(points.flatMap(() => [normal.x, normal.y, normal.z]), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(points.flatMap(() => [color.r, color.g, color.b]), 3));
  return g;
}

/**
 * One leaf: a pointed blade folded slightly along its midrib, pointing roughly away from the
 * cluster centre. Its normal also points away from the cluster (+ a little up), so a crown of
 * many small leaves shades like a rounded mass of foliage instead of flickering facets.
 */
function leaf(at: THREE.Vector3, clusterCentre: THREE.Vector3, size: number, color: THREE.Color, r: Rng): THREE.BufferGeometry {
  const out = at.clone().sub(clusterCentre).normalize();
  const dir = out.clone().add(new THREE.Vector3(r.next() - 0.5, r.next() - 0.5, r.next() - 0.5).multiplyScalar(1.2)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, r.next() * Math.PI * 2)); // random roll
  const w = size * 0.32, fold = w * 0.35;
  const p = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(w, size * 0.45, fold), new THREE.Vector3(0, size, 0), new THREE.Vector3(-w, size * 0.45, fold),
  ].map((v) => v.applyQuaternion(q).add(at));
  const normal = out.add(new THREE.Vector3(0, 0.4, 0)).normalize();
  return flatTris([p[0], p[1], p[2], p[0], p[2], p[3]], normal, color);
}

/**
 * A soft needle mass: an icosphere squashed into an ellipsoid (scale along x = along the branch),
 * oriented by `orient`, with one vertex colour. Same attributes as leaves (no uv) for merging.
 */
function mass(at: THREE.Vector3, scale: THREE.Vector3, orient: THREE.Quaternion, color: THREE.Color, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.scale(scale.x, scale.y, scale.z);
  g.applyQuaternion(orient);
  g.translate(at.x, at.y, at.z);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Random direction tilted `angle` away from `dir` at a random azimuth. */
function tilt(dir: THREE.Vector3, angle: number, r: Rng): THREE.Vector3 {
  const ortho = new THREE.Vector3(1, 0, 0).cross(dir);
  if (ortho.lengthSq() < 1e-4) ortho.set(0, 0, 1).cross(dir);
  ortho.normalize().applyAxisAngle(dir, r.next() * Math.PI * 2);
  return dir.clone().applyAxisAngle(ortho, angle).normalize();
}

export interface TreeGeometry {
  wood: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
}

// ---------------------------------------------------------------------------------------------
// Foliage cards: flat patches with a procedurally drawn leaf / needle texture (alpha cut-out)
// ---------------------------------------------------------------------------------------------

/**
 * One card: a quad centred on `centre`, `length` along uAxis (texture u) and `width` along vAxis.
 * Normals come from `normalAt` (e.g. pointing out of the crown) so cards shade like a rounded
 * mass of foliage instead of flat planes. Attributes: position, normal, color, uv.
 */
function card(centre: THREE.Vector3, uAxis: THREE.Vector3, vAxis: THREE.Vector3, length: number, width: number,
  color: THREE.Color, normalAt: (p: THREE.Vector3) => THREE.Vector3, flipU = false): THREE.BufferGeometry {
  const corner = (su: number, sv: number) => centre.clone().addScaledVector(uAxis, su * length / 2).addScaledVector(vAxis, sv * width / 2);
  const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const uv = flipU ? [[1, 0], [0, 0], [0, 1], [1, 1]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
  const order = [0, 1, 2, 0, 2, 3];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(order.flatMap((i) => [p[i].x, p[i].y, p[i].z]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(order.flatMap((i) => { const n = normalAt(p[i]); return [n.x, n.y, n.z]; }), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(order.flatMap(() => [color.r, color.g, color.b]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(order.flatMap((i) => uv[i]), 2));
  return g;
}

/** Leaf-cluster texture: many small veined leaves in pale tones (vertex/instance colours tint them). */
function drawLeafTexture(): HTMLCanvasElement {
  const C = DECOR.cards;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = rngFor(1, 'leaf-texture');
  for (let i = 0; i < C.leavesInTexture; i++) {
    const rad = 108 * Math.sqrt(r.next()), a = r.next() * Math.PI * 2;
    const L = C.leafSize * (0.7 + r.next() * 0.6), W = L * 0.42, light = 62 + r.next() * 28;
    g.save();
    g.translate(128 + Math.cos(a) * rad, 128 + Math.sin(a) * rad);
    g.rotate(r.next() * Math.PI * 2);
    g.fillStyle = `hsl(${80 + r.next() * 35}, 42%, ${light}%)`;
    g.beginPath();
    g.moveTo(0, -L / 2);
    g.quadraticCurveTo(W, -L * 0.1, 0, L / 2);
    g.quadraticCurveTo(-W, -L * 0.1, 0, -L / 2);
    g.fill();
    g.strokeStyle = `hsla(90, 35%, ${light - 28}%, 0.75)`; // midrib
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(0, -L / 2);
    g.lineTo(0, L / 2);
    g.stroke();
    g.restore();
  }
  return c;
}

/** Conifer spray texture: a twig along u with pairs of needles angled forward, pale tones. */
function drawNeedleTexture(): HTMLCanvasElement {
  const C = DECOR.cards;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const r = rngFor(1, 'needle-texture');
  g.lineCap = 'round';
  // soft spray silhouette behind the needles, tapering towards the tip (gives the card body)
  g.fillStyle = 'hsl(110, 30%, 52%)';
  g.beginPath();
  g.moveTo(2, 64);
  g.quadraticCurveTo(70, 8, 250, 54);
  g.lineTo(250, 74);
  g.quadraticCurveTo(70, 120, 2, 64);
  g.fill();
  const N = C.needleDensity;
  for (let i = 0; i < N; i++) {
    const t = i / N, x = 4 + t * 240;
    for (const side of [-1, 1]) {
      for (let j = 0; j < 2; j++) { // two needles per side at each step: denser fringe
        const len = (58 - t * 26) * (0.75 + r.next() * 0.5), ang = (30 + r.next() * 25) * Math.PI / 180;
        g.strokeStyle = `hsl(${100 + r.next() * 30}, 40%, ${58 + r.next() * 28}%)`;
        g.lineWidth = 3.4;
        g.beginPath();
        g.moveTo(x + j * 3, 64);
        g.lineTo(x + j * 3 + Math.cos(ang) * len * 0.55, 64 + side * Math.sin(ang) * len);
        g.stroke();
      }
    }
  }
  g.strokeStyle = 'hsl(60, 25%, 40%)'; // thin twig
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(2, 64);
  g.lineTo(240, 64);
  g.stroke();
  return c;
}

const cardMaterials = new Map<string, THREE.MeshLambertMaterial>();
function cardMaterial(kind: 'leaf' | 'needle'): THREE.MeshLambertMaterial {
  const key = `${kind}:${JSON.stringify(DECOR.cards)}`;
  let m = cardMaterials.get(key);
  if (!m) {
    const tex = new THREE.CanvasTexture(kind === 'leaf' ? drawLeafTexture() : drawNeedleTexture());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = new THREE.MeshLambertMaterial({
      map: tex, vertexColors: true, side: THREE.DoubleSide,
      alphaTest: DECOR.cards.alphaTest, alphaToCoverage: true, // soft cut-out edges with MSAA
    });
    cardMaterials.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Foliage skirts: stacked sheets wrapped around the trunk (conifer) / layered pads (broadleaf)
// ---------------------------------------------------------------------------------------------

/**
 * A skirt: an open ring-shaped sheet around (cx, cz) from radius rTop at height yTop out to a
 * wobbly rim at radius rBottom, height yBottom. `curve` > 1 keeps it flat near the centre and
 * bends it down towards the rim. Texture u wraps around (uRepeat times), v runs centre → rim.
 */
function skirtGeometry(cx: number, cz: number, yTop: number, yBottom: number, rTop: number, rBottom: number,
  curve: number, color: THREE.Color, seed: number, uRepeat: number, tilt?: THREE.Quaternion): THREE.BufferGeometry {
  const S = DECOR.skirts;
  const seg = Math.max(6, Math.round(S.segments)), rings = 2; // 2 rings: enough droop at RTS distance, a third fewer triangles
  const wob = (a: number) => 1 + (valueNoise(seed, Math.cos(a) * 1.7 + 5, Math.sin(a) * 1.7 + 5) - 0.5) * 2 * S.rimWobble;
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const rr = rTop + (rBottom - rTop) * t * (j === rings ? wob(a) : 1 + (wob(a) - 1) * t);
      const p = new THREE.Vector3(Math.cos(a) * rr, yTop - (yTop - yBottom) * Math.pow(t, curve), Math.sin(a) * rr);
      if (tilt) p.applyQuaternion(tilt);
      pos.push(cx + p.x, p.y, cz + p.z);
      // soft normals: mostly up, a bit outward (tops lit, undersides shade via double-sided flip)
      const n = new THREE.Vector3(Math.cos(a) * 0.45, 0.9, Math.sin(a) * 0.45).normalize();
      if (tilt) n.applyQuaternion(tilt);
      nrm.push(n.x, n.y, n.z);
      col.push(color.r, color.g, color.b);
      uv.push((i / seg) * uRepeat, 1 - t); // canvas top = trunk, canvas bottom (teeth / scallops) = rim
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, b, c, b, d, c); // front faces point UP (tops get the light; undersides shade)
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Seamless (u-wrapping) skirt texture: needle strokes on a body with a toothed lower edge. */
function drawNeedleSkirtTexture(): HTMLCanvasElement {
  const S = DECOR.skirts;
  const W = 512, H = 128, c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rngFor(1, 'needle-skirt');
  const teeth = Math.max(4, Math.round(S.teeth / 2)) * 2; // even count per texture repeat
  const bodyEnd = H * (1 - S.toothDepth);
  // body + teeth outline (periodic in x so the texture tiles around the tree)
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W, 0);
  const tw = W / teeth;
  for (let i = teeth - 1; i >= 0; i--) { // right to left: valley, tooth tip, valley
    g.lineTo((i + 1) * tw, bodyEnd);
    g.lineTo((i + 0.5) * tw, H - r.next() * (H - bodyEnd) * 0.35);
    g.lineTo(i * tw, bodyEnd);
  }
  g.closePath();
  g.save();
  g.clip();
  g.fillStyle = 'hsl(70, 8%, 80%)'; // near-neutral: the tree's palette colour tints it
  g.fillRect(0, 0, W, H);
  // needle strokes running down/outward (drawn twice at ±W near the edges for seamless wrap)
  g.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = r.next() * W, y = r.next() * H, len = 10 + r.next() * 18, dx = (r.next() - 0.5) * 6;
    g.strokeStyle = `hsl(${50 + r.next() * 60}, ${6 + r.next() * 10}%, ${58 + r.next() * 42}%)`;
    g.lineWidth = 2;
    for (const ox of [0, -W, W]) {
      g.beginPath();
      g.moveTo(x + ox, y);
      g.lineTo(x + ox + dx, y + len);
      g.stroke();
    }
  }
  g.restore();
  return c;
}

/** Seamless leafy pad texture: leaves on a body with a scalloped rim (v = 1 at the rim). */
function drawLeafPadTexture(): HTMLCanvasElement {
  const W = 512, H = 128, c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rngFor(1, 'leaf-pad');
  const scallops = 16, bodyEnd = H * 0.78, rad = W / scallops / 2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W, 0);
  g.lineTo(W, bodyEnd);
  for (let i = scallops - 1; i >= 0; i--) g.arc((i + 0.5) * (W / scallops), bodyEnd, rad * (0.9 + r.next() * 0.4), 0, Math.PI, false);
  g.closePath();
  g.save();
  g.clip();
  g.fillStyle = 'hsl(70, 8%, 80%)'; // near-neutral: the tree's palette colour tints it
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = r.next() * W, y = r.next() * H, L = 12 + r.next() * 12, ang = r.next() * Math.PI;
    g.fillStyle = `hsl(${50 + r.next() * 60}, ${6 + r.next() * 10}%, ${56 + r.next() * 44}%)`;
    for (const ox of [0, -W, W]) {
      g.save();
      g.translate(x + ox, y);
      g.rotate(ang);
      g.beginPath();
      g.ellipse(0, 0, L / 2, L / 4.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  g.restore();
  return c;
}

/** Shared wind clock for all trees: call updateTreeWind(seconds) every frame. */
const treeWind = { uTime: { value: 0 }, uSway: { value: 0 }, uSpeed: { value: 1 }, uFlutter: { value: 0 } };
export function updateTreeWind(time: number): void {
  treeWind.uTime.value = time;
  treeWind.uSway.value = DECOR.treeSway;
  treeWind.uSpeed.value = DECOR.treeSwaySpeed;
  treeWind.uFlutter.value = DECOR.leafFlutter;
}

/**
 * Wind in the vertex shader: the whole tree bends (more the higher up – quadratic, so the trunk
 * base stays put), in two overlapping gusts with a per-tree phase; foliage rims also flutter.
 * (Shadows stay still – the shadow pass uses the unbent shape; not noticeable at this scale.)
 */
function addTreeWind(material: THREE.Material, foliage: boolean): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeWind);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uSway, uSpeed, uFlutter;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 ip = vec2(0.0);
        #endif
        float ph = ip.x * 0.37 + ip.y * 0.29;
        float tt = uTime * uSpeed;
        float gust = sin(tt + ph) * 0.65 + sin(tt * 2.3 + ph * 1.7) * 0.35;
        float bend = gust * uSway * pow(max(position.y, 0.0) * 0.5, 2.0);
        transformed.x += bend;
        transformed.z += bend * 0.5;
        ${foliage ? `float rim = length(position.xz);
        transformed.y += sin(uTime * 5.0 + position.x * 9.0 + position.z * 7.0 + ph) * uFlutter * rim;` : 'vBark = vec3(atan(position.z, position.x), position.y, aSeed); vMark = aMark;'}`);
    if (!foliage) { // bark: short horizontal dashes of the mark colour (birch) – per pixel, so the trunk can stay low poly
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aMark;\nattribute float aSeed;\nvarying vec3 vBark;\nvarying vec4 vMark;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vBark; varying vec4 vMark;
          float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float bNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(bHash(i), bHash(i + vec2(1, 0)), f.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float bn = bNoise(vec2(vBark.x * 2.2 + vBark.z, vBark.y * 11.0 + vBark.z * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vMark.rgb, smoothstep(1.0 - vMark.a, 1.0 - vMark.a + 0.08, bn) * 0.85);`);
    }
  };
  material.customProgramCacheKey = () => `tree-wind-${foliage}`;
}

const skirtMaterials = new Map<string, THREE.MeshLambertMaterial>();
function skirtMaterial(kind: 'needle' | 'leaf'): THREE.MeshLambertMaterial {
  const key = `${kind}:${JSON.stringify(DECOR.skirts)}`;
  let m = skirtMaterials.get(key);
  if (!m) {
    const tex = new THREE.CanvasTexture(kind === 'needle' ? drawNeedleSkirtTexture() : drawLeafPadTexture());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    m = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide, alphaTest: DECOR.skirts.alphaTest, alphaToCoverage: true });
    addTreeWind(m, true);
    skirtMaterials.set(key, m);
  }
  return m;
}

let modelledFoliage: THREE.MeshLambertMaterial | undefined;
/** Material for a tree's foliage geometry (skirts and cards need their textured materials). */
export function foliageMaterial(kind: 'broadleaf' | 'conifer'): THREE.Material {
  if (DECOR.foliageSkirts) return skirtMaterial(kind === 'broadleaf' ? 'leaf' : 'needle');
  if (DECOR.foliageCards) return cardMaterial(kind === 'broadleaf' ? 'leaf' : 'needle');
  return (modelledFoliage ??= new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

export function broadleafTree(seed: number, variant: number): TreeGeometry {
  const r = rngFor(seed, 'broadleaf', variant);
  const wood: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  const shades = DECOR.leafColors.map((c) => new THREE.Color(c));
  const [minA, maxA] = DECOR.broadleafSpread;
  const tips: { at: THREE.Vector3; color: THREE.Color }[] = [];

  const grow = (start: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, depth: number) => {
    const end = start.clone().addScaledVector(dir, length);
    wood.push(limb(start, dir, length, radius, radius * 0.68));
    if (depth === 0 && DECOR.foliageCards) {
      tips.push({ at: end, color: shades[r.int(0, shades.length - 1)].clone().offsetHSL(0, 0, 0.12 + (end.y - 0.8) * 0.08) });
      return;
    }
    if (depth === 0) {
      // a cluster of individual leaves around the tip; higher clusters are a little lighter
      const base = shades[r.int(0, shades.length - 1)].clone().offsetHSL(0, 0, (end.y - 0.8) * 0.08);
      for (let i = 0; i < DECOR.leavesPerTip; i++) {
        const at = end.clone().add(new THREE.Vector3(r.next() - 0.5, r.next() - 0.35, r.next() - 0.5).multiplyScalar(DECOR.leafSpread * 2));
        const shade = base.clone().offsetHSL(0, 0, (r.next() - 0.5) * 0.08);
        leaves.push(leaf(at, end, DECOR.leafSize * (0.75 + r.next() * 0.5), shade, r));
      }
      return;
    }
    const children = r.int(2, 3);
    for (let i = 0; i < children; i++) {
      // one child keeps roughly the parent's direction, the others spread out; slight upward pull
      const angle = i === 0 ? r.next() * 0.25 : minA + r.next() * (maxA - minA);
      const d = tilt(dir, angle, r).add(new THREE.Vector3(0, 0.15, 0)).normalize();
      grow(end, d, length * (0.66 + r.next() * 0.16), radius * 0.62, depth - 1);
    }
  };
  const lean = tilt(UP, r.next() * 0.12, r);
  grow(new THREE.Vector3(0, -0.05, 0), lean, 0.45 + r.next() * 0.12, 0.065, DECOR.broadleafDepth);


  if (DECOR.foliageCards) {
    // a few crossed leaf cards per tip; normals point out of the crown (+ a bit up)
    const crown = tips.reduce((s, t) => s.add(t.at), new THREE.Vector3()).divideScalar(Math.max(1, tips.length)).add(new THREE.Vector3(0, -0.1, 0));
    const normalAt = (p: THREE.Vector3) => p.clone().sub(crown).normalize().multiplyScalar(0.75).add(new THREE.Vector3(0, 0.35, 0)).normalize();
    const C = DECOR.cards;
    for (const tip of tips) {
      for (let k = 0; k < C.leafCardsPerTip; k++) {
        const u = new THREE.Vector3(r.next() - 0.5, r.next() - 0.5, r.next() - 0.5).normalize();
        const v = tilt(u, Math.PI / 2, r);
        const at = tip.at.clone().add(new THREE.Vector3(r.next() - 0.5, r.next() - 0.5, r.next() - 0.5).multiplyScalar(0.12));
        const size = C.leafCardSize * (0.8 + r.next() * 0.4);
        leaves.push(card(at, u, v, size, size, tip.color.clone().offsetHSL(0, 0, (r.next() - 0.5) * 0.06), normalAt, r.chance(0.5)));
      }
    }
  }
  return { wood: mergeGeometries(wood)!, foliage: mergeGeometries(leaves)! };
}

export type SpeciesName = keyof typeof DECOR.species;
export const speciesNames = (): SpeciesName[] => Object.keys(DECOR.species) as SpeciesName[];

/** Pick a species of the given kind, weighted by share (undefined if none has a share). */
export function pickSpecies(kind: TreeSpecies['kind'], r: Rng): SpeciesName | undefined {
  const names = speciesNames().filter((n) => DECOR.species[n].kind === kind && DECOR.species[n].share > 0);
  let x = r.next() * names.reduce((sum, n) => sum + DECOR.species[n].share, 0);
  for (const n of names) if ((x -= DECOR.species[n].share) <= 0) return n;
  return names[names.length - 1];
}

/** Per-tree foliage colour (instance tint) from the species palette. `pick` forces an entry. */
export function speciesTint(name: SpeciesName, r: Rng, pick?: number): THREE.Color {
  const sp: TreeSpecies = DECOR.species[name];
  if (!sp.palette.length) return new THREE.Color('#ffffff');
  const c = new THREE.Color(sp.palette[(pick ?? r.int(0, sp.palette.length - 1)) % sp.palette.length]);
  return c.offsetHSL((r.next() - 0.5) * sp.paletteJitter, 0, (r.next() - 0.5) * sp.paletteJitter * 2);
}

/** Tapered trunk with bark colour + patches of barkMarks (vertex colours). */
function trunkGeometry(sp: TreeSpecies, height: number, seed: number): THREE.BufferGeometry {
  // low poly (6 sides, 2 rows = 24 triangles); the bark marks are drawn per pixel by the bark material
  const g = new THREE.CylinderGeometry(sp.trunkWidth * 0.25, sp.trunkWidth, height, 6, 2, true);
  g.translate(0, height / 2 - 0.05, 0);
  const n = g.attributes.position.count, base = new THREE.Color(sp.barkColor), mark = new THREE.Color(sp.barkMarks);
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [base.r, base.g, base.b]), 3));
  g.setAttribute('aMark', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [mark.r, mark.g, mark.b, sp.barkMarkAmount]), 4));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Array(n).fill((seed % 997) / 97), 1));
  return g;
}

let barkMat: THREE.MeshLambertMaterial | undefined;
/** Material for species trunks (bark colours are in the geometry). */
export function barkMaterial(): THREE.MeshLambertMaterial {
  if (!barkMat) {
    barkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    addTreeWind(barkMat, false);
  }
  return barkMat;
}

/** Foliage material of a species (needle / leaf skirts). */
export function speciesFoliageMaterial(name: SpeciesName): THREE.Material {
  return skirtMaterial((DECOR.species[name] as TreeSpecies).foliage);
}

/**
 * A tree of the given species: one trunk wrapped in stacked skirts. Each tier blends its radius,
 * height and droop from the lowest tier to the highest (see TreeSpecies). Foliage vertex colours
 * are neutral – the hue comes from the per-tree palette tint (speciesTint).
 */
export function speciesTree(name: SpeciesName, seed: number, variant: number): TreeGeometry {
  const sp: TreeSpecies = DECOR.species[name];
  const r = rngFor(seed, 'species', name, variant);
  const height = sp.height[0] + r.next() * (sp.height[1] - sp.height[0]);
  const fseed = hash32(seed, name, variant);
  const wood = trunkGeometry(sp, height * sp.trunkTop, fseed);
  const lerp = THREE.MathUtils.lerp;
  const radiusAt = (t: number) => (t < sp.widestAt
    ? lerp(sp.radiusBottom, sp.radiusWidest, THREE.MathUtils.smoothstep(t / sp.widestAt, 0, 1))
    : lerp(sp.radiusWidest, sp.radiusTop, (t - sp.widestAt) / Math.max(1e-3, 1 - sp.widestAt)));
  const shade = (t: number) => new THREE.Color(1, 1, 1).multiplyScalar(0.82 + t * sp.lightenUp * 2 + (r.next() - 0.5) * 0.06);
  const tiltQ = () => (sp.tilt > 0
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler((r.next() - 0.5) * 2 * sp.tilt, 0, (r.next() - 0.5) * 2 * sp.tilt))
    : undefined);
  const repeatFor = (radius: number) => Math.max(2, Math.round((Math.PI * 2 * radius) / (sp.foliage === 'needle' ? 0.9 : 0.7)));
  const parts: THREE.BufferGeometry[] = [];
  const n = Math.max(1, Math.round(sp.tiers));
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1); // 0 = lowest skirt
    const yRim = height * lerp(sp.crownStart, sp.crownTop, t);
    const radius = Math.max(0.05, radiusAt(t) * (0.92 + r.next() * 0.16));
    const drop = lerp(sp.dropBottom, sp.dropTop, t);
    parts.push(skirtGeometry(0, 0, yRim + drop, yRim, sp.trunkWidth * 0.5, radius, lerp(sp.droopBottom, sp.droopTop, t), shade(t), fseed + k, repeatFor(radius), tiltQ()));
  }
  const yTopRim = height * sp.crownTop;
  if (sp.cap === 'point') {
    parts.push(skirtGeometry(0, 0, height + 0.12, yTopRim + sp.dropTop * 0.4, 0, Math.max(0.12, sp.radiusTop * 0.6), 1.1, shade(1), fseed + 99, 2));
  } else if (sp.cap === 'dome') {
    const rad = Math.max(0.08, sp.radiusTop * 0.7);
    parts.push(skirtGeometry(0, 0, yTopRim + sp.dropTop * 1.3, yTopRim + sp.dropTop * 0.45, 0, rad, 2.2, shade(1), fseed + 99, repeatFor(rad), tiltQ()));
  }
  return { wood, foliage: mergeGeometries(parts)! };
}

/**
 * Fluffy conifer: tapered trunk with whorls of drooping branches; each branch carries a few soft
 * needle masses that shrink towards its tip, a dark core around the trunk keeps the tree from
 * looking see-through, and a tapering spire of masses tops it off. Tune with DECOR.conifer*.
 */
export function coniferTree(seed: number, variant: number): TreeGeometry {
  const C = DECOR.conifer;
  const r = rngFor(seed, 'conifer', variant);
  const height = C.height[0] + r.next() * (C.height[1] - C.height[0]);
  const wood: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, -0.05, 0), UP, height, 0.06, 0.01, 6)];
  const foliage: THREE.BufferGeometry[] = [];
  const base = new THREE.Color(C.color);
  const shade = (t: number) => base.clone().offsetHSL((r.next() - 0.5) * 0.02, 0, t * C.lightenUp + (r.next() - 0.5) * C.colorJitter);
  const X = new THREE.Vector3(1, 0, 0);
  const crownBottom = C.crownStart, crownTop = height - 0.25;

  for (let k = 0; k < C.whorls; k++) {
    const t = k / C.whorls; // 0 = bottom whorl
    const y = crownBottom + t * (crownTop - crownBottom);
    const len = C.width * (1 - t) + 0.12;
    const offset = r.next() * Math.PI * 2;
    for (let b = 0; b < C.branches; b++) {
      const a = offset + (b / C.branches) * Math.PI * 2 + (r.next() - 0.5) * 0.5;
      const dir = new THREE.Vector3(Math.cos(a), -C.droop - r.next() * 0.15, Math.sin(a)).normalize();
      const start = new THREE.Vector3(0, y, 0);
      wood.push(limb(start, dir, len, 0.018, 0.006, 4));
      if (DECOR.foliageCards) {
        // needle spray cards along the branch: one lying flat, optionally one standing (fuller look)
        const K = DECOR.cards;
        const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
        const up = new THREE.Vector3().crossVectors(side, dir).normalize();
        const normalAt = (p: THREE.Vector3) => new THREE.Vector3(p.x, 0, p.z).normalize().multiplyScalar(0.7).add(new THREE.Vector3(0, 0.6, 0)).normalize();
        const centre = start.clone().addScaledVector(dir, len * 0.55);
        const w = K.coniferCardWidth * (1 - t * 0.35);
        foliage.push(card(centre, dir, side, len * 1.2, w, shade(t).offsetHSL(0, 0, 0.22), normalAt));
        if (K.coniferCardsPerBranch > 1) foliage.push(card(centre, dir, up, len * 1.1, w * 0.7, shade(t).offsetHSL(0, 0, 0.16), normalAt));
        continue;
      }
      const orient = new THREE.Quaternion().setFromUnitVectors(X, dir);
      for (let m = 0; m < C.massesPerBranch; m++) {
        const f = (m + 0.6) / C.massesPerBranch; // position along the branch
        const at = start.clone().addScaledVector(dir, len * f * 0.9)
          .add(new THREE.Vector3(r.next() - 0.5, r.next() - 0.5, r.next() - 0.5).multiplyScalar(C.fluff * len * 0.3));
        const shrink = 1 - f * 0.45; // smaller towards the branch tip
        const size = new THREE.Vector3(len * 0.75 / C.massesPerBranch + 0.04, C.thickness * shrink, C.thickness * 1.5 * shrink)
          .multiplyScalar(1 + (r.next() - 0.5) * C.fluff);
        foliage.push(mass(at, size, orient, shade(t), C.massDetail));
      }
    }
    if (C.core && !DECOR.foliageCards) { // dark filler around the trunk at this whorl
      foliage.push(mass(new THREE.Vector3(0, y - 0.04, 0), new THREE.Vector3(len * 0.45, C.thickness * 1.6, len * 0.45), new THREE.Quaternion(), shade(t - 0.4), C.massDetail));
    }
  }
  if (DECOR.foliageCards) {
    // spire: two crossed upright spray cards
    const normalAt = () => new THREE.Vector3(0, 1, 0);
    const top = new THREE.Vector3(0, crownTop + 0.18, 0);
    for (const a of [0, Math.PI / 2]) foliage.push(card(top, UP, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.45, 0.2, shade(1).offsetHSL(0, 0, 0.12), normalAt));
    return { wood: mergeGeometries(wood)!, foliage: mergeGeometries(foliage)! };
  }
  // spire: a few stacked, ever slimmer masses
  for (let i = 0; i < 3; i++) {
    const s = 1 - i * 0.3;
    foliage.push(mass(new THREE.Vector3(0, crownTop + 0.05 + i * 0.13, 0), new THREE.Vector3(0.1 * s, 0.14 * s, 0.1 * s), new THREE.Quaternion(), shade(1), C.massDetail));
  }
  return { wood: mergeGeometries(wood)!, foliage: mergeGeometries(foliage)! };
}

/**
 * Rough boulder: displaced icosphere with a flat base and lichen on upward faces (vertex colours).
 * `colors` overrides stone/lichen (e.g. brown clods for tilled fields: lichen = stone = earth).
 */
/**
 * Boulder / stone / pebble: a blocky rock like the cliff rocks – a jittered box (plus a few extra
 * points for irregular faces) wrapped in a convex hull with chamfered edges, flat base at y = -0.25,
 * one shade per facet. mossy = the mossy pool (different variants).
 */
export function rockGeometry(seed: number, variant: number, colors?: { stone: string }, mossy = false): THREE.BufferGeometry {
  const s = hash32(seed, mossy ? 'mossy-rock' : 'rock', variant);
  const r = rngFor(s, 'block');
  const hx = 0.75 + r.next() * 0.35, hz = 0.65 + r.next() * 0.35, top = 0.45 + r.next() * 0.45, rough = DECOR.rockRoughness * 0.35;
  const j = () => (r.next() - 0.5) * 2 * rough;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push(new THREE.Vector3(sx * hx * (1 + j()), -0.25, sz * hz * (1 + j()))); // base corners
    pts.push(new THREE.Vector3(sx * hx * (0.8 + j()), top * (1 + j()), sz * hz * (0.8 + j()))); // top corners, a bit narrower
  }
  for (let i = 0; i < 4; i++) { // extra points: break up the box faces
    const a = r.next() * Math.PI * 2, y = -0.25 + r.next() * (top + 0.25);
    pts.push(new THREE.Vector3(Math.cos(a) * hx * (0.95 + j()), y, Math.sin(a) * hz * (0.95 + j())));
  }
  const g = chamferedHull(pts, DECOR.rockChamfer);
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), col = new Float32Array(pos.count * 3);
  const stone = new THREE.Color(colors?.stone ?? DECOR.rockColor), c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const f = valueNoise(s + 5, nrm.getX(i) * 2.3 + nrm.getY(i) * 1.1 + 3, nrm.getZ(i) * 2.3 + 7); // one shade per facet
    c.copy(stone).offsetHSL(0, 0, (f - 0.5) * 0.14 + nrm.getY(i) * 0.04);
    for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (i + v) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Shape + colours of one grass type (see DECOR.tufts). */
export interface TuftStyle {
  blades: number; // blades per tuft
  height: number[]; // [min, max] blade length
  width: number; // blade width at the root
  lean: number; // 0 = dead straight up, 1 = bent far over
  base: string; // colour at the root
  tip: string; // colour at the tip
  headChance: number; // 0..1 chance that a blade carries a seed head
  headLength: number; // long + narrow + many kernels = grain ear; short + wide + few = weed head
  headWidth: number;
  headKernels: number;
  headDroop: number; // 0 = head continues upward, 1 = hangs down (ripe ears bow)
  headColor: string;
  groundTint: number; // 0..1 how much the ground beneath takes this style's colours
}

/**
 * One tuft: a few thin blades around the origin, dark at the root and light at the tip, leaning
 * by `lean`; some blades end in a seed head built from small kernels (alternating left/right
 * along the head's axis). Normals point up, so thin double-sided blades light evenly.
 */
export function grassTuftGeometry(seed: number, style: TuftStyle): THREE.BufferGeometry {
  const o = style;
  const r = rngFor(seed, 'grass', o.blades, o.height[1], o.lean, o.headKernels);
  const pos: number[] = [], col: number[] = [];
  const base = new THREE.Color(o.base), tip = new THREE.Color(o.tip), headBase = new THREE.Color(o.headColor);
  const push = (p: THREE.Vector3, c: THREE.Color) => { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); };
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  for (let b = 0; b < o.blades; b++) {
    const a = (b / o.blades) * Math.PI * 2 + r.next(), d = r.next() * 0.05;
    const root = V(Math.cos(a) * d, 0, Math.sin(a) * d);
    const h = o.height[0] + r.next() * (o.height[1] - o.height[0]), w = o.width;
    // lean: tilt the blade (length kept) by up to `lean`, in a random direction
    const leanDir = r.next() * Math.PI * 2, L = Math.min(0.97, o.lean * (0.6 + r.next() * 0.8));
    const dir = V(Math.cos(leanDir) * L, Math.sqrt(1 - L * L), Math.sin(leanDir) * L);
    const tipP = root.clone().addScaledVector(dir, h);
    const across = V(-Math.sin(a) * w, 0, Math.cos(a) * w);
    push(root.clone().sub(across), base); push(root.clone().add(across), base); push(tipP, tip);

    if (o.headChance > 0 && r.chance(o.headChance)) {
      // head axis: continues the blade, bending down with droop
      const axis = dir.clone().multiplyScalar(1 - o.headDroop).add(V(dir.x * 0.6, -1, dir.z * 0.6).multiplyScalar(o.headDroop)).normalize();
      const side = V().crossVectors(axis, V(0, 1, 0));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const K = Math.max(1, Math.round(o.headKernels));
      const kl = (o.headLength / K) * 1.9; // kernels overlap a little
      for (let k = 0; k <= K; k++) {
        const at = tipP.clone().addScaledVector(axis, (o.headLength * k) / K);
        const s = k === K ? 0 : k % 2 ? 1 : -1; // last kernel points straight along the axis
        const out = axis.clone().multiplyScalar(1.2).addScaledVector(side, s * 0.7).normalize();
        const perp = V().crossVectors(out, side).normalize().multiplyScalar(o.headWidth * 0.5);
        const mid = at.clone().addScaledVector(out, kl * 0.5);
        const end = at.clone().addScaledVector(out, kl);
        const c = headBase.clone().offsetHSL(0, 0, (r.next() - 0.5) * 0.08);
        push(at, c); push(mid.clone().add(perp), c); push(end, c);
        push(at, c); push(end, c); push(mid.clone().sub(perp), c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // Normals straight up: thin double-sided blades otherwise light as dark spikes from behind.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
  return g;
}

/** Grass material with wind sway in the vertex shader. Update `uniforms.uTime.value` each frame. */
/**
 * Terrain material: vertex colours (the coarse terrain colouring) × per-pixel multicolour noise
 * at grass scale, with fake bump lighting from the same noise. No textures – nothing pixelates.
 * Call `sync()` each frame (or after editing DECOR.ground) to apply knob changes live.
 */
export function groundMaterial(): { material: THREE.MeshLambertMaterial; sync: () => void } {
  const G = DECOR.ground;
  // switched off (DECOR.ground.enabled = false): plain terrain colours, detail shader unused
  if (!G.enabled) return { material: new THREE.MeshLambertMaterial({ vertexColors: true }), sync: () => {} };
  const u = {
    uDetailScale: { value: 0 }, uDetailContrast: { value: 0 }, uBlotchScale: { value: 0 }, uBlotchStrength: { value: 0 },
    uWarm: { value: new THREE.Color() }, uCool: { value: new THREE.Color() }, uSpeckleScale: { value: 0 }, uSpeckleAmount: { value: 0 },
    uSpeckleTint: { value: new THREE.Color() }, uBump: { value: 0 },
  };
  const sync = () => {
    u.uDetailScale.value = G.detailScale; u.uDetailContrast.value = G.detailContrast;
    u.uBlotchScale.value = G.blotchScale; u.uBlotchStrength.value = G.blotchStrength;
    u.uWarm.value.set(G.warmTint); u.uCool.value.set(G.coolTint);
    u.uSpeckleScale.value = G.speckleScale; u.uSpeckleAmount.value = G.speckleAmount; u.uSpeckleTint.value.set(G.speckleTint);
    u.uBump.value = G.bump;
  };
  sync();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vGroundXZ;
        uniform float uDetailScale, uDetailContrast, uBlotchScale, uBlotchStrength, uSpeckleScale, uSpeckleAmount, uBump;
        uniform vec3 uWarm, uCool, uSpeckleTint;
        float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float gNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p), w = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), w.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), w.x), w.y);
        }
        // grass-scale height-ish field used for both colour and bumps
        float gDetail(vec2 p) { return 0.65 * gNoise(p * uDetailScale) + 0.35 * gNoise(p * uDetailScale * 2.3 + 17.0); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float d = gDetail(vGroundXZ);
          float b = gNoise(vGroundXZ * uBlotchScale + 41.0);
          vec3 c = diffuseColor.rgb * (1.0 + (d - 0.5) * 2.0 * uDetailContrast);            // mottling
          c = mix(c, c * uWarm * 1.15, smoothstep(0.55, 0.85, b) * uBlotchStrength);        // dry patches
          c = mix(c, c * uCool * 1.1, smoothstep(0.55, 0.85, 1.0 - b) * uBlotchStrength);   // fresh patches
          float s = gNoise(vGroundXZ * uSpeckleScale + 7.0);
          c = mix(c, c * uSpeckleTint * 1.35, smoothstep(0.8, 0.9, s) * uSpeckleAmount);    // light flecks
          c *= 1.0 - smoothstep(0.8, 0.92, 1.0 - s) * uSpeckleAmount * 0.5;                  // dark crumbs
          diffuseColor.rgb = c;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float e = 0.5 / uDetailScale;
          float gx = gDetail(vGroundXZ + vec2(e, 0.0)) - gDetail(vGroundXZ - vec2(e, 0.0));
          float gz = gDetail(vGroundXZ + vec2(0.0, e)) - gDetail(vGroundXZ - vec2(0.0, e));
          normal = normalize(normal - mat3(viewMatrix) * vec3(gx, 0.0, gz) * uBump);  // fake bumps
        }`);
  };
  return { material, sync };
}

/**
 * Shell grass ("fur" technique): the grass patches are covered by DECOR.shells.layers stacked copies
 * of a ground-hugging mesh, each lifted a bit higher. A fragment shader cuts every layer down to
 * the cross-sections of thin strands (one per cell of a fine grid, random height), which shrink
 * towards the top – together they read as a dense lawn. One draw call (instanced: instance = layer).
 * `heightAt` gives the ground height, `maskAt` the grass amount 0..1 (0 = no grass, no triangles).
 */
export function shellGrass(
  x0: number, z0: number, x1: number, z1: number,
  heightAt: (x: number, z: number) => number, maskAt: (x: number, z: number) => number,
): { mesh: THREE.InstancedMesh; uniforms: { uTime: { value: number }; uSway: { value: number } } } | undefined {
  const S = DECOR.shells;
  const step = S.cellSize;
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const pos: number[] = [], mask: number[] = [], idx: number[] = [];
  const vid = new Map<number, number>();
  const vertex = (i: number, j: number) => {
    const key = j * (nx + 1) + i;
    let v = vid.get(key);
    if (v === undefined) {
      const x = x0 + i * step, z = z0 + j * step;
      v = pos.length / 3;
      pos.push(x, heightAt(x, z) + 0.01, z);
      mask.push(maskAt(x, z));
      vid.set(key, v);
    }
    return v;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * step, cz = z0 + (j + 0.5) * step;
      // only cells with grass somewhere (corners or centre)
      if (Math.max(maskAt(cx, cz), maskAt(cx - step / 2, cz - step / 2), maskAt(cx + step / 2, cz - step / 2),
        maskAt(cx - step / 2, cz + step / 2), maskAt(cx + step / 2, cz + step / 2)) <= 0.01) continue;
      const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (!idx.length) return undefined;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aMask', new THREE.Float32BufferAttribute(mask, 1));
  g.setIndex(idx);

  const layers = Math.max(2, Math.round(S.layers));
  const uniforms = { uTime: { value: 0 }, uSway: { value: DECOR.grassSway } };
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uLayers: { value: layers }, uHeight: { value: S.height }, uDensity: { value: S.density }, uThickness: { value: S.thickness },
      uBase: { value: new THREE.Color(S.base) }, uTip: { value: new THREE.Color(S.tip) }, uDry: { value: new THREE.Color(S.dry) },
      uDryAmount: { value: S.dryAmount }, uLean: { value: S.lean },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uSway, uLayers, uHeight;
        attribute float aMask;
        varying float vLayer, vMask;
        varying vec2 vXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLayer = float(gl_InstanceID) / (uLayers - 1.0);
        vMask = aMask;
        vXZ = position.xz;
        transformed.y += vLayer * uHeight;
        float sway = sin(uTime * 1.7 + position.x * 0.8 + position.z * 0.6) * uSway * 0.6 * vLayer * vLayer;
        transformed.x += sway;
        transformed.z += sway * 0.6;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uDensity, uThickness, uDryAmount, uLean;
        uniform vec3 uBase, uTip, uDry;
        varying float vLayer, vMask;
        varying vec2 vXZ;
        float shellHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 cellP = vXZ * uDensity;
        vec2 cell = floor(cellP);
        float h = shellHash(cell);                    // this strand's height 0..1
        vec2 off = vec2(shellHash(cell + 7.1), shellHash(cell + 3.7)) - 0.5;
        float ang = shellHash(cell + 9.7) * 6.2832;
        vec2 lean = vec2(cos(ang), sin(ang)) * uLean * vLayer * vLayer; // strands curve outwards towards the tip
        float d = length(fract(cellP) - 0.5 - off * 0.5 - lean);
        if (shellHash(cell + 5.3) > vMask * 1.25) discard;              // fewer strands towards the patch edge
        float strandH = mix(0.35, 1.0, h) * mix(0.35, 1.0, vMask);      // and shorter
        if (vLayer > strandH || d > uThickness * (1.0 - vLayer / max(strandH, 0.001))) discard; // tapering strand
        float dry = step(1.0 - uDryAmount, shellHash(cell + 11.3));
        vec3 tip = mix(uTip, uDry, dry);
        diffuseColor.rgb = mix(uBase, tip, vLayer / max(strandH, 0.001)) * (0.85 + 0.3 * shellHash(cell + 1.9));`);
  };
  material.customProgramCacheKey = () => 'shell-grass';
  const mesh = new THREE.InstancedMesh(g, material, layers);
  for (let i = 0; i < layers; i++) mesh.setMatrixAt(i, new THREE.Matrix4());
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // instances share the base mesh bounds; shells rise above them
  return { mesh, uniforms };
}

// ---- procedural surface textures (terrain types, rocks, cliffs) ----

/** GLSL helpers + one function per surface type: returns the colour, writes a bump height to h. */
const SURFACE_GLSL = /* glsl */ `
  uniform vec3 gDark, gLight, gDry; uniform float gScale, gDryAmt, gSpeckle;
  uniform vec3 fDark, fLight; uniform float fSpacing, fDepth, fClod; uniform vec2 fCenter;
  uniform vec3 sA, sB; uniform float sScale, sGrain, sRipple, sRippleStr;
  uniform vec3 rA, rB, rCrack, rLichen; uniform float rScale, rCrackW, rLichenAmt;
  uniform vec3 pA, pB, pPebble; uniform float pScale, pPebbleAmt;
  uniform vec3 cStone, cGrout, fpA, fpB; uniform float cScale;
  uniform vec3 uVein; uniform float uVeinAmt, uVeinScale;
  float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 tHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
  float tNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
  }
  float tFbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * tNoise(p); p = p * 2.03 + 1.7; a *= 0.5; } return v / 0.9375; }
  // x = distance to the nearest cell point, y = gap to the second nearest (cracks where small), z = cell id
  vec3 tVoronoi(vec2 p) {
    vec2 n = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0, id = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j)), r = g + tHash2(n + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = tHash(n + g); } else if (d < d2) d2 = d;
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), id);
  }
  vec3 texGrass(vec2 p, out float h) {
    float m = tFbm(p * gScale);
    vec3 c = mix(gDark, gLight, smoothstep(0.2, 0.8, m));
    float dry = smoothstep(1.0 - gDryAmt, 1.0 - gDryAmt + 0.15, tFbm(p * gScale * 0.3 + 17.0));
    c = mix(c, gDry, dry * 0.8);
    float s = smoothstep(1.0 - gSpeckle * 0.3, 1.0 - gSpeckle * 0.3 + 0.06, tNoise(p * gScale * 6.0 + 3.1)); // soft round flecks
    c = mix(c, gLight * 1.15, s * 0.5);
    h = m + s * 0.3;
    return c;
  }
  vec3 texField(vec2 p, out float h) {
    float furrow = 0.5 + 0.5 * sin(length(p - fCenter) / fSpacing * 6.2832 + tNoise(p * 0.7) * 1.5); // rings around the farm
    float clod = tFbm(p * fClod);
    h = furrow * fDepth + clod * 0.5;
    return mix(fDark, fLight, clamp(furrow * fDepth * 1.2 + clod * 0.7 - 0.15, 0.0, 1.0));
  }
  vec3 texSand(vec2 p, out float h) {
    float g = tNoise(p * sGrain);
    float rip = 0.5 + 0.5 * sin((p.x * 0.8 + p.y * 0.6 + tNoise(p * 0.5) * 2.0) / sRipple * 6.2832);
    float m = tFbm(p * sScale);
    h = rip * sRippleStr + g * 0.3;
    return mix(sA, sB, clamp(m * 0.7 + rip * sRippleStr * 0.5, 0.0, 1.0)) * (0.92 + 0.16 * g);
  }
  float tCrackMul = 1.0;
  vec3 texRock(vec2 p, float scale, float up, out float h) {
    vec2 q = p * scale;
    q += (vec2(tNoise(q * 0.9), tNoise(q * 0.9 + 7.3)) - 0.5) * 0.9; // warp: irregular slabs, not paving
    vec3 v = tVoronoi(q);
    float crack = (1.0 - smoothstep(0.0, rCrackW, v.y)) * smoothstep(0.3, 0.6, tFbm(q * 0.35 + 3.0)) * tCrackMul; // cracks come and go
    float m = tFbm(p * scale * 1.7);
    vec3 c = mix(rA, rB, clamp(m * 0.75 + v.z * 0.35 - 0.05, 0.0, 1.0));
    float lich = smoothstep(1.0 - rLichenAmt, 1.0 - rLichenAmt + 0.12, tFbm(p * scale * 0.6 + 5.0)) * up;
    c = mix(c, rLichen, lich * 0.75);
    h = (1.0 - crack) * 0.6 + m * 0.4 + v.z * 0.2;
    return mix(c, rCrack, crack * 0.85);
  }
  vec3 texPath(vec2 p, out float h) {
    float m = tFbm(p * pScale * 0.5);
    vec3 c = mix(pA, pB, smoothstep(0.25, 0.75, m));
    vec3 v = tVoronoi(p * pScale);
    float peb = (1.0 - smoothstep(0.2, 0.32, v.x)) * step(1.0 - pPebbleAmt, v.z);
    c = mix(c, pPebble * (0.85 + 0.3 * fract(v.z * 17.0)), peb);
    h = m * 0.4 + peb * 0.6;
    return c;
  }
  vec3 texCobble(vec2 p, out float h) { // stone-laid road: cobbles with dark joints
    vec3 v = tVoronoi(p * cScale);
    float stone = smoothstep(0.03, 0.09, v.y);
    h = stone * (0.6 + 0.2 * v.z) - (1.0 - stone) * 0.3;
    return mix(cGrout, cStone * (0.82 + 0.3 * v.z) * (0.9 + 0.2 * tNoise(p * 9.0)), stone);
  }
  vec3 texFoot(vec2 p, out float h) { // trodden foot path
    float m = tFbm(p * 1.8);
    h = m * 0.5;
    return mix(fpA, fpB, smoothstep(0.25, 0.75, m)) * (0.94 + 0.12 * tNoise(p * 14.0));
  }
  float tLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)) + 1e-3; }
  // ore veins: wavy, slightly tilted stripes through the rock (3D, so they run across faces)
  vec3 tVeins(vec3 c, vec3 p, float amount) {
    if (amount <= 0.0) return c;
    float w = sin(dot(p, vec3(0.35, 1.0, 0.2)) * uVeinScale * 6.2832 + (tNoise(p.xz * 1.7) + tNoise(p.xy * 1.3)) * 3.0);
    float m = smoothstep(1.0 - amount * 0.3, 1.0 - amount * 0.3 + 0.05, 0.5 + 0.5 * w) * smoothstep(0.2, 0.5, tNoise(p.zy * 2.3 + 4.0)); // thin stripes
    return mix(c, uVein * (0.75 + 0.5 * tNoise(p.xz * 14.0)), m * 0.85);
  }
  // bump from a height computed per pixel (three.js perturbNormalArb with screen derivatives)
  vec3 tBump(vec3 n, float hb, vec3 viewPos) {
    vec3 dpdx = dFdx(-viewPos), dpdy = dFdy(-viewPos);
    float hx = dFdx(hb), hy = dFdy(hb);
    vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (hx * r1 + hy * r2);
    return normalize(abs(det) * n - grad);
  }
`;

type SurfaceUniforms = Record<string, { value: unknown }>;
/** Uniform objects for SURFACE_GLSL, kept in sync with DECOR.terrain by syncSurface(). */
function surfaceUniforms(): SurfaceUniforms {
  const u: SurfaceUniforms = {};
  for (const k of ['gDark', 'gLight', 'gDry', 'fDark', 'fLight', 'sA', 'sB', 'rA', 'rB', 'rCrack', 'rLichen', 'pA', 'pB', 'pPebble']) u[k] = { value: new THREE.Color() };
  for (const k of ['gScale', 'gDryAmt', 'gSpeckle', 'fSpacing', 'fDepth', 'fClod', 'sScale', 'sGrain', 'sRipple', 'sRippleStr', 'rScale', 'rCrackW', 'rLichenAmt', 'pScale', 'pPebbleAmt',
    'gBump', 'fBump', 'sBump', 'rBump', 'pBump', 'gTint', 'fTint', 'sTint', 'rTint', 'pTint', 'oScale', 'oBump', 'oTint', 'oCrack', 'oMoss', 'oMossH']) u[k] = { value: 0 };
  u.oMossColor = { value: new THREE.Color() };
  u.fCenter = { value: new THREE.Vector2() };
  u.uVein = { value: new THREE.Color() };
  u.uVeinAmt = { value: 0 };
  u.uVeinScale = { value: 1 };
  u.uDepC = { value: new THREE.Vector2() };
  u.uDepR = { value: 0 };
  u.uCliffColor = { value: new THREE.Color() };
  for (const k of ['cStone', 'cGrout', 'fpA', 'fpB']) u[k] = { value: new THREE.Color() };
  for (const k of ['cScale', 'cBump', 'cTint', 'fpBump', 'fpTint']) u[k] = { value: 0 };
  return u;
}
export type OreKind = 'iron' | 'copper';
function syncSurface(u: SurfaceUniforms, ore?: OreKind): void {
  const T = DECOR.terrain;
  const O = ore && DECOR.quarries[ore];
  (u.uVein.value as THREE.Color).set(O ? O.veinColor : '#000000');
  u.uVeinAmt.value = O ? O.veinAmount : 0;
  u.uVeinScale.value = O ? O.veinScale : 1;
  const col = (k: string, c: string) => (u[k].value as THREE.Color).set(c);
  const num = (k: string, v: number) => { u[k].value = v; };
  col('gDark', T.grass.dark); col('gLight', T.grass.light); col('gDry', T.grass.dry);
  num('gScale', T.grass.scale); num('gDryAmt', T.grass.dryAmount); num('gSpeckle', T.grass.speckle); num('gBump', T.grass.bump); num('gTint', T.grass.tint);
  col('fDark', T.field.dark); col('fLight', T.field.light);
  num('fSpacing', T.field.furrowSpacing); num('fDepth', T.field.furrowDepth); num('fClod', T.field.clodScale); num('fBump', T.field.bump); num('fTint', T.field.tint);
  col('sA', T.sand.dark); col('sB', T.sand.light);
  num('sScale', T.sand.scale); num('sGrain', T.sand.grain); num('sRipple', T.sand.rippleSpacing); num('sRippleStr', T.sand.rippleStrength); num('sBump', T.sand.bump); num('sTint', T.sand.tint);
  col('rA', T.rock.dark); col('rB', T.rock.light); col('rCrack', T.rock.crackColor); col('rLichen', T.rock.lichenColor);
  num('rScale', T.rock.scale); num('rCrackW', T.rock.crackWidth); num('rLichenAmt', T.rock.lichenAmount); num('rBump', T.rock.bump); num('rTint', T.rock.tint);
  col('pA', T.path.dark); col('pB', T.path.light); col('pPebble', T.path.pebbleColor);
  num('pScale', T.path.pebbleScale); num('pPebbleAmt', T.path.pebbleAmount); num('pBump', T.path.bump); num('pTint', T.path.tint);
  (u.uCliffColor.value as THREE.Color).set(CLIFF.color);
  const RS = DECOR.roads.stone, RP = DECOR.roads.path;
  col('cStone', RS.stone); col('cGrout', RS.grout); num('cScale', RS.cobbleSize); num('cBump', RS.bump); num('cTint', RS.tint);
  col('fpA', RP.dark); col('fpB', RP.light); num('fpBump', RP.bump); num('fpTint', RP.tint);
  const RT = DECOR.rockTexture;
  num('oScale', RT.scale); num('oBump', RT.bump); num('oTint', RT.tint); num('oCrack', RT.cracks); num('oMoss', RT.moss); num('oMossH', RT.mossHeight);
  (u.oMossColor.value as THREE.Color).set(RT.mossColor);
}

/**
 * Terrain material: per-pixel procedural textures (grass, tilled field, sand, rock, path) blended
 * by per-vertex weights – attributes aW (grass, field, sand, rock) and aPath. Each texture mixes its
 * own colours with the vertex colour by its `tint` (keeps the ground matching grass / crops above).
 * `fieldCenter` = centre of the farm (furrows run in rings around it). Call sync() after knob changes.
 */
export function terrainMaterial(fieldCenter = new THREE.Vector2(), deposit?: { ore: OreKind; x: number; z: number; radius: number }): { material: THREE.MeshLambertMaterial; sync: () => void } {
  const u = surfaceUniforms();
  (u.fCenter.value as THREE.Vector2).copy(fieldCenter);
  if (deposit) { (u.uDepC.value as THREE.Vector2).set(deposit.x, deposit.z); u.uDepR.value = deposit.radius; }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aW;\nattribute float aPath;\nattribute float aCliff;\nattribute vec2 aRoad;\nvarying vec4 vW;\nvarying float vPath;\nvarying float vCliff;\nvarying vec2 vRoad;\nvarying vec3 vWP;\nvarying vec2 vXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = aW; vPath = aPath; vCliff = aCliff; vRoad = aRoad; vWP = (modelMatrix * vec4(position, 1.0)).xyz; vXZ = vWP.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vW; varying float vPath; varying float vCliff; varying vec2 vRoad; varying vec3 vWP; varying vec2 vXZ;
        uniform float cBump, cTint, fpBump, fpTint;
        uniform vec3 uCliffColor;
        uniform float gBump, fBump, sBump, rBump, pBump, gTint, fTint, sTint, rTint, pTint;
        uniform vec2 uDepC; uniform float uDepR;
        float surfH;
        ${SURFACE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 vc = diffuseColor.rgb;
          float wsum = vW.x + vW.y + vW.z + vW.w + vPath + vRoad.x + vRoad.y + 1e-4;
          vec3 c = vec3(0.0); float h; surfH = 0.0;
          vec3 t;
          if (vW.x > 0.01) { t = texGrass(vXZ, h); c += vW.x * mix(t, vc * tLum(t) / tLum(mix(gDark, gLight, 0.5)), gTint); surfH += vW.x * h * gBump; }
          if (vW.y > 0.01) { t = texField(vXZ, h); c += vW.y * mix(t, vc * tLum(t) / tLum(mix(fDark, fLight, 0.5)), fTint); surfH += vW.y * h * fBump; }
          if (vW.z > 0.01) { t = texSand(vXZ, h); c += vW.z * mix(t, vc * tLum(t) / tLum(mix(sA, sB, 0.5)), sTint); surfH += vW.z * h * sBump; }
          if (vW.w > 0.01) {
            t = texRock(vXZ, rScale, 1.0, h);
            if (uDepR > 0.0) t = tVeins(t, vec3(vXZ.x, 0.0, vXZ.y) * 0.35, uVeinAmt * (1.0 - smoothstep(uDepR * 0.6, uDepR * 1.1, distance(vXZ, uDepC))));
            c += vW.w * mix(t, vc * tLum(t) / tLum(mix(rA, rB, 0.5)), rTint); surfH += vW.w * h * rBump; }
          if (vPath > 0.01) { t = texPath(vXZ, h); c += vPath * mix(t, vc * tLum(t) / tLum(mix(pA, pB, 0.5)), pTint); surfH += vPath * h * pBump; }
          if (vRoad.x > 0.01) { t = texCobble(vXZ, h); c += vRoad.x * mix(t, vc * tLum(t) / tLum(cStone), cTint); surfH += vRoad.x * h * cBump; }
          if (vRoad.y > 0.01) { t = texFoot(vXZ, h); c += vRoad.y * mix(t, vc * tLum(t) / tLum(mix(fpA, fpB, 0.5)), fpTint); surfH += vRoad.y * h * fpBump; }
          diffuseColor.rgb = c / wsum;
          surfH /= wsum;
          // steep slopes: painted in the cliff colour (soft mottling that also runs vertically – no stretching)
          if (vCliff > 0.01) {
            float m = tFbm(vec2(vWP.x + vWP.z, vWP.y * 1.6) * 1.1);
            diffuseColor.rgb = mix(diffuseColor.rgb, uCliffColor * (0.82 + 0.36 * m), vCliff);
            surfH = mix(surfH, m * 0.5, vCliff);
          }
        }`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = tBump(normal, surfH * 0.05, vViewPosition);');
  };
  material.customProgramCacheKey = () => 'terrain-surfaces';
  const sync = () => syncSurface(u, deposit?.ore);
  sync();
  return { material, sync };
}

/**
 * Material for rocks and cliffs: the rock texture (DECOR.terrain.rock colours, DECOR.rockTexture
 * scale) projected from three sides (triplanar, so it needs no UVs), lichen only on top, mixed
 * with the vertex colours by rockTexture.tint. Smooth shading – no visible polygons.
 */
export function rockMaterial(ore?: OreKind, moss = false, tint?: number): { material: THREE.MeshLambertMaterial; sync: () => void } {
  const u = surfaceUniforms();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW;\nvarying vec3 vTN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 tw = vec4(transformed, 1.0);
        vec3 tn = objectNormal;
        #ifdef USE_INSTANCING
          tw = instanceMatrix * tw;
          tn = mat3(instanceMatrix) * tn;
        #endif
        vTW = (modelMatrix * tw).xyz;
        vTN = normalize(mat3(modelMatrix) * tn);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTW; varying vec3 vTN;
        uniform float oScale, oBump, oTint, oCrack, oMoss, oMossH;
        uniform vec3 oMossColor;
        float surfH;
        ${SURFACE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 w = pow(abs(vTN), vec3(4.0)); w /= w.x + w.y + w.z;
          float up = smoothstep(0.35, 0.8, vTN.y);
          tCrackMul = oCrack;
          float hx, hy, hz;
          vec3 t = texRock(vTW.zy, oScale, 0.0, hx) * w.x + texRock(vTW.xz, oScale, up, hy) * w.y + texRock(vTW.xy, oScale, 0.0, hz) * w.z;
          surfH = (hx * w.x + hy * w.y + hz * w.z) * oBump;
          vec3 rc = tVeins(mix(t, diffuseColor.rgb * tLum(t) / tLum(mix(rA, rB, 0.5)), oTint), vTW, uVeinAmt);
          // grass / moss on the flat tops, with a ragged edge
          float moss = smoothstep(oMossH, oMossH + 0.12, vTN.y + (tFbm(vTW.xz * 3.0) - 0.5) * 0.35) * oMoss;
          vec3 mc = oMossColor * (0.8 + 0.4 * tFbm(vTW.xz * 6.0 + 2.0));
          diffuseColor.rgb = mix(rc, mc, moss);
          surfH = mix(surfH, tFbm(vTW.xz * 8.0) * 0.5, moss);
        }`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = tBump(normal, surfH * 0.03, vViewPosition);');
  };
  material.customProgramCacheKey = () => 'rock-surface';
  const sync = () => { syncSurface(u, ore); if (!moss) u.oMoss.value = 0; if (tint !== undefined) u.oTint.value = tint; };
  sync();
  return { material, sync };
}

export type QuarryKind = 'mud' | 'stone' | 'iron' | 'copper' | 'salt';

/** A rough rock chunk (chamfered hull of a jittered box), one shade per facet, non-indexed. */
function roughChunk(r: Rng, w: number, h: number, d: number, rough: number, color: THREE.Color, chamfer = 0.06): THREE.BufferGeometry {
  const j = () => 1 + (r.next() - 0.5) * 2 * rough * 0.3;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) pts.push(new THREE.Vector3(sx * w * j(), sy * h * j(), sz * d * j()));
  for (let i = 0; i < 3; i++) pts.push(new THREE.Vector3((r.next() - 0.5) * w * 1.05, (r.next() - 0.5) * h, (r.next() - 0.5) * d * 1.05));
  const g = chamferedHull(pts, chamfer);
  g.deleteAttribute('uv');
  const nrm = g.getAttribute('normal'), col = new Float32Array(nrm.count * 3), c = new THREE.Color();
  const base = (r.next() - 0.5) * 0.08;
  for (let i = 0; i < nrm.count; i += 3) {
    c.copy(color).offsetHSL(0, 0, base + (valueNoise(7, nrm.getX(i) * 2.3 + nrm.getY(i) + 3, nrm.getZ(i) * 2.3 + 7) - 0.5) * 0.12 + nrm.getY(i) * 0.04);
    for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (i + v) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g.index ? g.toNonIndexed() : g;
}
/** A box with one flat colour (non-indexed, crisp normals). */
function colorBox(w: number, h: number, d: number, color: THREE.Color, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.deleteAttribute('uv');
  g.rotateY(rotY);
  g.translate(x, y, z);
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count).fill(0).flatMap(() => [color.r, color.g, color.b]), 3));
  return g;
}

/**
 * Quarry model (front = +z), one of DECOR.quarries.variants per kind (all locations use only these):
 *  stone  – stepped face cut into crisp blocks, some taken out, cut blocks lying in front
 *  iron / copper – an open pit of rough benches stepping down towards the front, heaps of ore
 *           chunks in front; drawn with the ore-veined rock material
 *  mud    – a shallow pit: a muddy puddle ringed by rounded mud mounds, stacks of drying bricks
 */
export function quarryGeometry(seed: number, kind: QuarryKind = 'stone', variant = 0): THREE.BufferGeometry {
  const r = rngFor(seed, 'quarry', kind, variant);
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  if (kind !== 'mud') {
    // stone / ore / salt: an organic, roughly round patch of stones – the bare stone shapes from the
    // Stones pool (same variants), bigger in the middle, smaller towards the wobbly edge; a share of
    // them are ore / salt stones. The stone quarry also has a stepped, quarried face at the back
    // and finished blocks lying around.
    const Q = DECOR.quarries[kind];
    const special = 'oreColor' in Q ? Q.oreColor : 'saltColor' in Q ? Q.saltColor : Q.color;
    const share = 'oreShare' in Q ? Q.oreShare : 'saltShare' in Q ? Q.saltShare : 0;
    const R = (Q.width / 2) * (0.85 + r.next() * 0.3), wob = r.next() * 10;
    const edge = (a: number) => R * (0.8 + 0.35 * valueNoise(seed + variant, Math.cos(a) * 1.3 + wob, Math.sin(a) * 1.3 + wob));
    const nShapes = Math.max(1, DECOR.placement.rockVariants);
    const faceZ = -R * 0.55; // stone quarry: the quarried face sits at the back of the patch
    for (let i = 0; i < Q.stones; i++) {
      const a = r.next() * Math.PI * 2, t = Math.sqrt(r.next()), d = t * edge(a);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (kind === 'stone' && z < faceZ + 0.3 && Math.abs(x) < DECOR.quarries.stone.faceWidth / 2 + 0.2) continue; // leave room for the face
      const s = (Q.stoneSize[1] + (Q.stoneSize[0] - Q.stoneSize[1]) * t * (0.7 + r.next() * 0.3)) * 0.55; // stone shapes are ~2 wide
      const g = rockGeometry(seed, r.int(0, nShapes - 1), { stone: r.chance(share) ? special : Q.color });
      g.scale(s * (0.9 + r.next() * 0.3), s * (0.8 + r.next() * 0.4), s * (0.9 + r.next() * 0.3));
      g.rotateY(r.next() * Math.PI * 2);
      g.translate(x, s * 0.12, z);
      parts.push(g);
    }
    if (kind === 'stone') {
      const S = DECOR.quarries.stone, bc = new THREE.Color(S.blockColor), B = S.blockSize, H = B * 0.7, gap = 0.025;
      // stepped quarried face: terraces of cut blocks, the front one partly taken out
      const T = Math.max(1, Math.round(S.terraces + (r.next() - 0.5) * 1.2));
      const cols = Math.max(2, Math.round(S.faceWidth * (0.85 + r.next() * 0.3) / B));
      for (let k = 0; k < T; k++) {
        const layers = T - k, z = faceZ - (T - 1 - k) * B; // the tallest step at the back
        for (let i = 0; i < cols; i++) {
          const x = (i - (cols - 1) / 2) * B;
          for (let l = 0; l < layers; l++) {
            const top = l === layers - 1;
            if (top && k === T - 1 && r.chance(S.missing)) continue;
            parts.push(colorBox(B - gap, H - gap, B - gap, c.copy(bc).offsetHSL(0, 0, (r.next() - 0.5) * 0.06 + (top ? 0.04 : -0.02)), x, l * H + H / 2 - 0.12, z));
          }
        }
      }
      // finished blocks lying around the patch, some stacked
      for (let i = 0; i < S.blocks; i++) {
        const a = r.next() * Math.PI * 2, d = edge(a) * (0.9 + r.next() * 0.4), rot = r.next() * Math.PI;
        const x = Math.cos(a) * d, z = Math.sin(a) * d, layers = r.chance(0.35) ? 2 : 1;
        for (let l = 0; l < layers; l++) {
          parts.push(colorBox(B * 1.4, H, B, c.copy(bc).offsetHSL(0, 0, (r.next() - 0.5) * 0.06), x, H / 2 + l * (H + 0.01), z, rot + l * (r.next() - 0.5) * 0.3));
        }
      }
    }
  } else {
    const Q = DECOR.quarries.mud;
    const mud = new THREE.Color(Q.color), wet = new THREE.Color(Q.wetColor), clay = new THREE.Color(Q.brickColor);
    const R = Q.width / 2 * (0.85 + r.next() * 0.3);
    const puddle = new THREE.CircleGeometry(R * 0.55, 18).toNonIndexed(); // muddy water in the middle
    puddle.rotateX(-Math.PI / 2);
    puddle.scale(1, 1, 0.7 + r.next() * 0.3);
    puddle.translate(0, 0.03, 0);
    puddle.deleteAttribute('uv');
    const pc = new THREE.Color(Q.puddleColor);
    puddle.setAttribute('color', new THREE.Float32BufferAttribute(new Array(puddle.getAttribute('position').count).fill(0).flatMap(() => [pc.r, pc.g, pc.b]), 3));
    parts.push(puddle);
    for (let i = 0; i < Q.mounds; i++) { // rounded mounds of dug-out mud around it
      const a = (i / Q.mounds) * Math.PI * 2 + (r.next() - 0.5) * 0.5, s = Q.moundSize[0] + r.next() * (Q.moundSize[1] - Q.moundSize[0]);
      const g = roughChunk(r, s * 1.6, s * 0.7, s * 1.3, 0.9, c.copy(mud).lerp(wet, r.next() * 0.6), s * 0.35);
      g.rotateY(-a);
      g.translate(Math.cos(a) * R * (0.75 + r.next() * 0.25), s * 0.12, Math.sin(a) * R * (0.75 + r.next() * 0.25));
      parts.push(g);
    }
    for (let i = 0; i < Q.brickStacks; i++) { // drying bricks, stacked
      const bx = (r.next() - 0.5) * R * 1.4, bz = R * (0.9 + r.next() * 0.5), rot = r.next() * Math.PI;
      const layers = 2 + r.int(0, 2);
      for (let l = 0; l < layers; l++) for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) {
        const lx = (a - 1) * 0.13, lz = (b - 0.5) * 0.08, ca = Math.cos(rot), sa = Math.sin(rot);
        parts.push(colorBox(0.12, 0.05, 0.07, c.copy(clay).offsetHSL(0, 0, (r.next() - 0.5) * 0.08), bx + lx * ca - lz * sa, 0.025 + l * 0.052, bz + lx * sa + lz * ca, rot + (l % 2) * Math.PI / 2));
      }
    }
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

let mudMat: THREE.MeshLambertMaterial | undefined;
/** Material for mud quarries (vertex colours, flat facets). */
export function mudMaterial(): THREE.MeshLambertMaterial {
  return (mudMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

/**
 * Cliff settings in effect: the cliff template of the location being built (setCliff, from
 * cliffOf(traits)). Defaults: the cliff kind defaults.
 */
export const CLIFF: Record<string, any> = { ...KIND_DEFAULTS.cliff };
export function setCliff(params: Record<string, any>): void { Object.assign(CLIFF, params); }

/** How much of a cliff the ground at (x, z) is: 0 = gentle, 1 = steep (CLIFF min/fullSlope). */
export function cliffWeight(heightAt: (x: number, z: number) => number, x: number, z: number): number {
  const C = CLIFF, d = Math.max(0.05, C.p1);
  const gx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d), gz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
  return THREE.MathUtils.smoothstep(Math.hypot(gx, gz), C.minSlope, C.fullSlope);
}

/**
 * Convex hull with chamfered edges: every hull corner is replaced by copies pulled a little into
 * each face that meets there (towards the face centre), and the hull of those is taken – so every
 * edge (vertical ones included) becomes a narrow bevel and every corner a small facet.
 */
function chamferedHull(pts: THREE.Vector3[], chamfer: number): THREE.BufferGeometry {
  const hull = new ConvexGeometry(pts);
  if (chamfer <= 0) return hull;
  const pos = hull.getAttribute('position');
  const out: THREE.Vector3[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), mid = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    mid.copy(a).add(b).add(c).divideScalar(3);
    for (const v of [a, b, c]) {
      const d = v.distanceTo(mid);
      out.push(v.clone().lerp(mid, Math.min(2, chamfer / Math.max(d, 1e-6))));
    }
  }
  hull.dispose();
  return new ConvexGeometry(out);
}

export interface CliffStone { x: number; z: number; y: number; s: number; sy: number; rot: number; v: number }
/**
 * Cliff rocks built from the slope itself. The map is walked on a grid (CLIFF.gridSize);
 * at every steep grid point the slope is crossed at two points a grid step apart (along the
 * slope): walking uphill finds two guide points on its top edge, walking downhill two on its foot.
 * A closed low-poly rock (convex hull) is wrapped around those guides: front face from the top
 * edge to the foot with a bulge, back hidden inside the hill, base below the ground. Grid points
 * whose guides an existing rock already covers are skipped, so the rocks line the slope once,
 * side by side. Rubble: small stones (bare stone variants) at each rock's foot.
 */
export function cliffRocks(
  x0: number, z0: number, x1: number, z1: number, heightAt: (x: number, z: number) => number,
  inside: (x: number, z: number) => boolean = () => true, seed = ASSET_SEED,
): { rocks: THREE.BufferGeometry | undefined; rubble: CliffStone[] } {
  const C = CLIFF, g = Math.max(0.3, C.gridSize), nRock = Math.max(1, DECOR.placement.rockVariants);
  const parts: THREE.BufferGeometry[] = [], rubble: CliffStone[] = [];
  const done: { tx: number; tz: number; bx: number; bz: number }[] = [];
  const stone = new THREE.Color(C.color), c = new THREE.Color();
  const w = (x: number, z: number) => cliffWeight(heightAt, x, z);
  /** walk from (x, z) along (dx, dz) while the ground is steep: the edge of the slope */
  const walk = (x: number, z: number, dx: number, dz: number) => {
    for (let k = 0; k < 40 && w(x, z) > 0.25; k++) { x += dx * 0.12; z += dz * 0.12; }
    return new THREE.Vector3(x, heightAt(x, z), z);
  };
  for (let gz = z0 + g / 2; gz < z1; gz += g) {
    for (let gx = x0 + g / 2; gx < x1; gx += g) {
      if (!inside(gx, gz) || w(gx, gz) < 0.5) continue;
      const ex = heightAt(gx + 0.3, gz) - heightAt(gx - 0.3, gz), ez = heightAt(gx, gz + 0.3) - heightAt(gx, gz - 0.3);
      const l = Math.hypot(ex, ez) || 1, ux = ex / l, uz = ez / l; // uphill
      const tx = -uz, tz = ux; // along the slope
      const r = rngFor(seed, 'cliff-rock', Math.round(gx * 10), Math.round(gz * 10));
      // grid jitter: rocks of different widths, centres shifted along the slope (irregular seams, never gaps)
      const half = g * 0.55 * (1 + r.next() * C.gridJitter);
      const shift = (r.next() - 0.5) * C.gridJitter * g * 0.5;
      const cx = gx + tx * shift, cz = gz + tz * shift;
      const T = [walk(cx - tx * half, cz - tz * half, ux, uz), walk(cx + tx * half, cz + tz * half, ux, uz)];
      const B = [walk(cx - tx * half, cz - tz * half, -ux, -uz), walk(cx + tx * half, cz + tz * half, -ux, -uz)];
      const tm = T[0].clone().add(T[1]).multiplyScalar(0.5), bm = B[0].clone().add(B[1]).multiplyScalar(0.5);
      if (tm.y - bm.y < 0.25 || !inside(tm.x, tm.z)) continue;
      if (done.some((d) => Math.hypot(d.tx - tm.x, d.tz - tm.z) < g * 0.6 && Math.hypot(d.bx - bm.x, d.bz - bm.z) < g * 0.6)) continue; // already lined (neighbours ~1 grid step apart stay)
      done.push({ tx: tm.x, tz: tm.z, bx: bm.x, bz: bm.z });
      const H = tm.y - bm.y, pts: THREE.Vector3[] = [];
      const P = (x: number, y: number, z: number) => pts.push(new THREE.Vector3(x, y, z));
      const ox = -ux * C.protrude, oz = -uz * C.protrude; // protrude: shifts the whole face out of (+) / into (−) the slope
      // jitter: each rock reaches its own way up – some stop below the rim, some run over the edge
      const reach = 1 + (r.next() - 0.5) * 2 * C.reachJitter;
      for (let s = 0; s < 2; s++) {
        const b = B[s], t0 = T[s];
        const tx2 = b.x + (t0.x - b.x) * reach, tz2 = b.z + (t0.z - b.z) * reach;
        const t = new THREE.Vector3(tx2, heightAt(tx2, tz2), tz2);
        P(t.x + ox, t.y + 0.04, t.z + oz); // top edge
        P(t.x + ux * C.depth, Math.min(t.y, t0.y) - 0.08, t.z + uz * C.depth); // top, running back into the ground
        P(b.x - ux * 0.05 + ox, b.y - C.sink, b.z - uz * 0.05 + oz); // foot, below the ground
        P(b.x + ux * C.depth, b.y - C.sink, b.z + uz * C.depth); // base, inside the hill
        // the real slope profile, denser towards the top where the ground bulges out over a straight face
        for (const f of [0.5, 0.7, 0.82, 0.92]) {
          const px = b.x + (t0.x - b.x) * f * Math.min(1, reach), pz = b.z + (t0.z - b.z) * f * Math.min(1, reach);
          P(px + ox, heightAt(px, pz) + 0.02, pz + oz);
        }
        // bulges of the face: middle (random height), and optional extra points near the top and the foot
        const bulgeAt = (fromTop: number, amount: number) => {
          if (!amount) return;
          const m = t.clone().lerp(b, fromTop);
          P(m.x - ux * amount * H + ox, m.y, m.z - uz * amount * H + oz);
        };
        bulgeAt(1 - (0.3 + r.next() * 0.25), C.bulge);
        bulgeAt(C.topBulgeAt ?? 0.15, C.topBulge ?? 0);
        bulgeAt(C.bottomBulgeAt ?? 0.85, C.bottomBulge ?? 0);
      }
      let geo: THREE.BufferGeometry = chamferedHull(pts, C.chamfer);
      geo.deleteAttribute('uv');
      // one shade per facet + a per-rock shade
      const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), col = new Float32Array(pos.count * 3);
      const rockShade = (r.next() - 0.5) * 0.08;
      for (let i = 0; i < pos.count; i += 3) {
        const f = valueNoise(seed + 5, nrm.getX(i) * 2.3 + nrm.getY(i) * 1.1 + 3, nrm.getZ(i) * 2.3 + 7);
        c.copy(stone).offsetHSL(0, 0, rockShade + (f - 0.5) * 0.12 + nrm.getY(i) * 0.04);
        for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (i + v) * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (geo.index) geo = geo.toNonIndexed();
      parts.push(geo);
      // rubble right at the bottom guide points
      for (let i = 0; i < C.rubblePerRock; i++) {
        const b = B[i % 2];
        const rx = b.x - ux * (C.protrude + r.next() * 0.15) + (r.next() - 0.5) * 0.2, rz = b.z - uz * (C.protrude + r.next() * 0.15) + (r.next() - 0.5) * 0.2;
        if (!inside(rx, rz) || heightAt(rx, rz) < 0.02) continue;
        const rs = C.rubbleSize[0] + r.next() * (C.rubbleSize[1] - C.rubbleSize[0]);
        rubble.push({ x: rx, z: rz, y: heightAt(rx, rz) - rs * 0.15, s: rs, sy: rs, rot: r.next() * 6.28, v: r.int(0, nRock - 1) });
      }
    }
  }
  return { rocks: parts.length ? mergeGeometries(parts)! : undefined, rubble };
}

export function grassMaterial(): { material: THREE.MeshLambertMaterial; uniforms: { uTime: { value: number }; uSway: { value: number } } } {
  const uniforms = { uTime: { value: 0 }, uSway: { value: DECOR.grassSway } };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uSway = uniforms.uSway;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSway;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 ip = vec2(0.0);
        #endif
        float sway = sin(uTime * 1.7 + ip.x * 0.8 + ip.y * 0.6) * uSway * (position.y / 0.3);
        transformed.x += sway;
        transformed.z += sway * 0.6;`);
  };
  return { material, uniforms };
}

// ---------------------------------------------------------------------------------------------
// Fields: plots fanning out from a centre
// ---------------------------------------------------------------------------------------------

interface FanLayout {
  sectors: { a0: number; amp: number; freq: number; phase: number }[]; // dividing lines (curved rays)
  rings: { r0: number; amp: number; freq: number; phase: number }[]; // wavy rings
}
const fanCache = new Map<string, FanLayout>();

function fanLayout(seed: number): FanLayout {
  const F = DECOR.fields;
  const key = `${seed}:${JSON.stringify(F)}`;
  let fan = fanCache.get(key);
  if (!fan) {
    const r = rngFor(seed, 'fields-fan');
    const n = r.int(F.sectors[0], F.sectors[1]);
    const step = (Math.PI * 2) / n;
    const start = r.next() * Math.PI * 2;
    fan = {
      sectors: Array.from({ length: n }, (_, i) => ({
        a0: start + i * step + (r.next() - 0.5) * step * 0.5,
        amp: F.sectorCurve * (0.4 + r.next() * 0.6), freq: F.sectorWaviness * (0.6 + r.next() * 0.8), phase: r.next() * Math.PI * 2,
      })),
      rings: Array.from({ length: 12 }, (_, i) => ({
        r0: (i + 1) * F.ringSpacing * (0.85 + r.next() * 0.3),
        amp: F.ringWobble * r.next(), freq: 2 + r.int(0, 3), phase: r.next() * Math.PI * 2,
      })),
    };
    if (fanCache.size > 50) fanCache.clear();
    fanCache.set(key, fan);
  }
  return fan;
}

/** 0 = unripe grain (green), 1 = ripe grain (yellow), 2 = tilled field (brown clods). */
export type CropKind = 0 | 1 | 2;

/**
 * Which plot (x, z) belongs to, for plots fanning out from (cx, cz): wedges split by randomly
 * curved dividing lines, cut into plots by wavy rings. Returns the plot's crop kind and the
 * distance to the nearest dividing line (used to leave paths unplanted).
 */
export function fieldPlotAt(seed: number, x: number, z: number, cx: number, cz: number): { kind: CropKind; edge: number } {
  const F = DECOR.fields;
  const fan = fanLayout(seed);
  const dx = x - cx, dz = z - cz;
  const rho = Math.hypot(dx, dz), theta = Math.atan2(dz, dx);
  // which wedge: the dividing line just "before" theta (lines bend with distance)
  let sector = 0, best = Infinity, nearest = Infinity;
  fan.sectors.forEach((s, i) => {
    const a = s.a0 + s.amp * Math.sin(rho * s.freq + s.phase);
    const rel = (((theta - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (rel < best) [best, sector] = [rel, i];
    nearest = Math.min(nearest, Math.min(rel, Math.PI * 2 - rel) * rho);
  });
  // which ring
  let ring = 0;
  for (const g of fan.rings) {
    const rr = g.r0 + g.amp * Math.sin(theta * g.freq + g.phase);
    if (rho > rr) ring++;
    nearest = Math.min(nearest, Math.abs(rho - rr));
  }
  // weighted pick of the plot's crop kind
  const w = F.kindWeights, total = w[0] + w[1] + w[2] || 1;
  let roll = rngFor(seed, 'plot', sector, ring).next() * total, kind: CropKind = 2;
  for (const k of [0, 1, 2] as CropKind[]) {
    if (roll < w[k]) { kind = k; break; }
    roll -= w[k];
  }
  return { kind, edge: nearest };
}

export interface CropItem { x: number; z: number; s: number; rot: number; v: number }

/**
 * Crop instances for the 1×1 tile at (tx, tz): grain tufts in unripe/ripe plots, small clods in
 * tilled ones, nothing on the paths along the dividing lines. Appends to `out[kind]`.
 */
export function cropItemsForTile(seed: number, tx: number, tz: number, cx: number, cz: number, out: [CropItem[], CropItem[], CropItem[]]): void {
  const F = DECOR.fields;
  const r = rngFor(seed, 'crops', tx, tz);
  const centre = fieldPlotAt(seed, tx + 0.5, tz + 0.5, cx, cz);
  if (centre.kind === 2) return; // tilled plot: bare soil (field texture), nothing on it
  for (let i = 0; i < F.grainPerTile; i++) {
    const x = tx + r.next(), z = tz + r.next();
    const plot = fieldPlotAt(seed, x, z, cx, cz);
    if (plot.edge < F.pathWidth || plot.kind === 2) continue;
    out[plot.kind].push({ x, z, s: 0.8 + r.next() * 0.4, rot: r.next() * Math.PI * 2, v: r.int(0, Math.max(1, DECOR.placement.tuftVariants) - 1) });
  }
}

/** Geometries for the three crop kinds (built from the current DECOR.fields settings). */
/** The tuft variants of one style (DECOR.placement.tuftVariants, built from the asset seed). */
export function tuftVariants(seed: number, style: TuftStyle): THREE.BufferGeometry[] {
  return Array.from({ length: Math.max(1, DECOR.placement.tuftVariants) }, (_, k) => grassTuftGeometry(hash32(seed, 'tuft', k), style));
}
export function cropGeometries(seed: number): { unripe: THREE.BufferGeometry[]; ripe: THREE.BufferGeometry[] } {
  return { unripe: tuftVariants(seed, DECOR.tufts.unripe), ripe: tuftVariants(seed, DECOR.tufts.ripe) };
}

// ---------------------------------------------------------------------------------------------
// Ground colours that match what grows on them
// ---------------------------------------------------------------------------------------------

const _soil = new THREE.Color(), _kind = new THREE.Color();

/**
 * Ground colour in a crop field at (x, z): each plot tints the soil with its crop's colours
 * (green / golden / earthy), fading back to bare soil along the dividing lines. The fade follows
 * the continuous distance to the line, so there are no stair-stepped plot edges.
 */
export function fieldGroundColor(seed: number, x: number, z: number, cx: number, cz: number, out: THREE.Color): THREE.Color {
  const F = DECOR.fields, T = DECOR.tufts;
  const plot = fieldPlotAt(seed, x, z, cx, cz);
  _soil.set(F.soilColor);
  if (plot.kind === 2) _kind.copy(_soil);
  else {
    const style = plot.kind === 0 ? T.unripe : T.ripe;
    _kind.copy(_soil).lerp(new THREE.Color(style.base), style.groundTint);
  }
  const t = Math.min(1, Math.max(0, (plot.edge - F.pathWidth * 0.5) / (F.pathWidth * 0.5 + 0.35)));
  return out.copy(_soil).lerp(_kind, t * t * (3 - 2 * t));
}

/** Tint `ground` towards a tuft style's colours by `amount` (0..1, e.g. a patch mask). */
export function tuftGroundTint(style: TuftStyle, ground: THREE.Color, amount: number): THREE.Color {
  return ground.lerp(_kind.set(style.base), style.groundTint * Math.min(1, Math.max(0, amount)));
}

/** Smooth patch value 0..1 (1 = inside a patch), for tinting the ground under grass patches. */
export function patchAmount(seed: number, x: number, z: number, scale: number, threshold: number): number {
  const v = valueNoise(seed, x * scale, z * scale);
  const t = Math.min(1, Math.max(0, (v - (threshold - 0.06)) / 0.12));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// Patches (grass + custom scatters)
// ---------------------------------------------------------------------------------------------

/** Smooth noise mask: true where a patch grows (organic edges when tested per instance). */
export function inPatch(seed: number, x: number, z: number, scale: number, threshold: number): boolean {
  return valueNoise(seed, x * scale, z * scale) > threshold;
}

/** Load a custom model as one or more (geometry, material) parts, centred and standing on y = 0. */
const scatterCache = new Map<string, Promise<{ geometry: THREE.BufferGeometry; material: THREE.Material }[]>>();
export async function loadScatterParts(def: ScatterDef): Promise<{ geometry: THREE.BufferGeometry; material: THREE.Material }[]> {
  const key = `${def.url}|${def.color}`;
  let p = scatterCache.get(key);
  if (!p) {
    p = (async () => {
      const [{ STLLoader }, { GLTFLoader }] = await Promise.all([
        import('three/addons/loaders/STLLoader.js'), import('three/addons/loaders/GLTFLoader.js'),
      ]);
      let parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
      if (def.url.toLowerCase().split('?')[0].endsWith('.stl')) {
        const g = await new STLLoader().loadAsync(def.url);
        g.rotateX(-Math.PI / 2); // STL is usually Z-up
        parts = [{ geometry: g, material: new THREE.MeshLambertMaterial({ color: def.color, flatShading: true }) }];
      } else {
        const gltf = await new GLTFLoader().loadAsync(def.url);
        gltf.scene.updateMatrixWorld(true);
        parts = [];
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) parts.push({ geometry: m.geometry.clone().applyMatrix4(m.matrixWorld), material: m.material as THREE.Material });
        });
      }
      // centre on x/z, base at y = 0 (over all parts)
      const box = new THREE.Box3();
      for (const part of parts) { part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!); }
      for (const part of parts) part.geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      return parts;
    })();
    scatterCache.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Settings saved by the asset editor (/editor) – merged into DECOR when this module loads.
// ---------------------------------------------------------------------------------------------

export const DECOR_STORAGE_KEY = 'qre.decor';
const DECOR_DEFAULTS = JSON.parse(JSON.stringify(DECOR));

function deepAssign(target: any, source: any): void {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (!(k in target)) continue; // ignore stale keys
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && !Array.isArray(target[k])) deepAssign(target[k], v);
    else target[k] = v;
  }
}

export function decorDefaults(): typeof DECOR {
  return JSON.parse(JSON.stringify(DECOR_DEFAULTS));
}

export function applyDecor(values: unknown): void {
  deepAssign(DECOR, values);
}

try {
  applyDecor(JSON.parse(localStorage.getItem(DECOR_STORAGE_KEY) ?? 'null'));
} catch {
  // no saved settings / storage unavailable
}

// ---- roads ----

export type RoadKind = 'dusty' | 'stone' | 'path';
export interface Road { kind: RoadKind; pts: THREE.Vector2[] }
export interface RoadNetwork {
  roads: Road[];
  /** Road weights at (x, z): dusty road, stone road, foot path (0..1 each, soft edges). */
  at: (x: number, z: number) => { dusty: number; stone: number; path: number };
}

/** Cheapest walkable route between two tiles (8-neighbour A*): avoids water, steep ground costs extra. */
function routeTiles(W: number, H: number, cost: (x: number, y: number) => number, from: [number, number], to: (x: number, y: number) => boolean, goal: [number, number]): [number, number][] | null {
  const n = W * H, g = new Float32Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const open: number[] = [];
  const idx = (x: number, y: number) => y * W + x;
  const hcost = (i: number) => Math.hypot((i % W) - goal[0], Math.floor(i / W) - goal[1]);
  const s = idx(from[0], from[1]);
  g[s] = 0;
  open.push(s);
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (g[open[k]] + hcost(open[k]) < g[open[bi]] + hcost(open[bi])) bi = k;
    const cur = open.splice(bi, 1)[0];
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W, cy = Math.floor(cur / W);
    if (to(cx, cy)) {
      const path: [number, number][] = [];
      for (let i = cur; i >= 0; i = came[i]) path.unshift([i % W, Math.floor(i / W)]);
      return path;
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const c = cost(nx, ny);
      if (!isFinite(c)) continue;
      const ni = idx(nx, ny), ng = g[cur] + Math.hypot(dx, dy) * c;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push(ni); }
    }
  }
  return null;
}

/** Chaikin smoothing (keeps the end points). */
function smoothLine(pts: THREE.Vector2[], passes = 3): THREE.Vector2[] {
  let p = pts;
  for (let k = 0; k < passes && p.length > 2; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      q.push(p[i].clone().lerp(p[i + 1], 0.25), p[i].clone().lerp(p[i + 1], 0.75));
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Road weights from polylines, rasterised once into a grid (res samples per tile) and sampled bilinearly. */
export function roadField(roads: Road[], x0: number, z0: number, w: number, h: number, res = 4): RoadNetwork['at'] {
  const R = DECOR.roads, nx = Math.ceil(w * res) + 1, nz = Math.ceil(h * res) + 1;
  const grids = { dusty: new Float32Array(nx * nz), stone: new Float32Array(nx * nz), path: new Float32Array(nx * nz) };
  for (const road of roads) {
    const cfg = R[road.kind], half = cfg.width / 2, soft = Math.max(0.01, cfg.edge), grid = grids[road.kind];
    for (let s = 0; s < road.pts.length - 1; s++) {
      const a = road.pts[s], b = road.pts[s + 1];
      const minX = Math.max(0, Math.floor((Math.min(a.x, b.x) - half - soft - x0) * res)), maxX = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + half + soft - x0) * res));
      const minZ = Math.max(0, Math.floor((Math.min(a.y, b.y) - half - soft - z0) * res)), maxZ = Math.min(nz - 1, Math.ceil((Math.max(a.y, b.y) + half + soft - z0) * res));
      const dx = b.x - a.x, dz = b.y - a.y, len2 = dx * dx + dz * dz || 1e-9;
      for (let j = minZ; j <= maxZ; j++) for (let i = minX; i <= maxX; i++) {
        const px = x0 + i / res, pz = z0 + j / res;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.y) * dz) / len2));
        const d = Math.hypot(px - a.x - dx * t, pz - a.y - dz * t);
        const v = 1 - THREE.MathUtils.smoothstep(d, half - soft * 0.5, half + soft * 0.5);
        const k = j * nx + i;
        if (v > grid[k]) grid[k] = v;
      }
    }
  }
  const sample = (grid: Float32Array, x: number, z: number) => {
    const fx = Math.max(0, Math.min(nx - 1.001, (x - x0) * res)), fz = Math.max(0, Math.min(nz - 1.001, (z - z0) * res));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * nx + i;
    return (grid[k] * (1 - u) + grid[k + 1] * u) * (1 - v) + (grid[k + nx] * (1 - u) + grid[k + nx + 1] * u) * v;
  };
  return (x, z) => {
    const stone = sample(grids.stone, x, z), dusty = sample(grids.dusty, x, z) * (1 - stone), path = sample(grids.path, x, z) * (1 - Math.max(stone, dusty));
    return { dusty, stone, path };
  };
}

/**
 * Road network of a location (DECOR.roads): 1–3 roads enter from the map edge and lead to the
 * centre (stone-laid for important places, else dusty); foot paths branch off to the quarry and
 * the water. Routes follow the terrain – around water, avoiding steep ground – then get smoothed.
 * heightAt / isWater / inside describe the location; targets: optional path destinations.
 */
export function buildRoads(o: {
  seed: number; W: number; H: number; heightAt: (x: number, z: number) => number; isWater: (x: number, z: number) => boolean;
  inside: (x: number, z: number) => boolean; important: boolean; targets: { x: number; z: number; water?: boolean }[];
}): RoadNetwork {
  const R = DECOR.roads, r = rngFor(o.seed, 'roads');
  const cost = (x: number, y: number) => {
    const cx = x + 0.5, cz = y + 0.5;
    if (o.isWater(cx, cz)) return Infinity;
    const gx = o.heightAt(cx + 0.5, cz) - o.heightAt(cx - 0.5, cz), gz = o.heightAt(cx, cz + 0.5) - o.heightAt(cx, cz - 0.5);
    return 1 + R.slopeCost * (gx * gx + gz * gz);
  };
  const roads: Road[] = [];
  const centre: [number, number] = [Math.floor(o.W / 2), Math.floor(o.H / 2)];
  const toLine = (tiles: [number, number][]) => smoothLine(tiles.map(([x, y]) => new THREE.Vector2(x + 0.5, y + 0.5)));
  const mainKind: RoadKind = o.important ? 'stone' : 'dusty';
  const n = R.count[0] + r.int(0, Math.max(0, R.count[1] - R.count[0]));
  const base = r.next() * Math.PI * 2;
  const roadTiles = new Set<number>();
  for (let k = 0; k < n; k++) {
    const a = base + (k / n) * Math.PI * 2 + (r.next() - 0.5) * 0.8;
    // entry: walk in from beyond the edge to the first dry tile inside the map
    let entry: [number, number] | null = null;
    for (let d = Math.min(o.W, o.H) / 2 - 1; d > 3 && !entry; d -= 0.5) {
      const x = Math.floor(o.W / 2 + Math.cos(a) * d), y = Math.floor(o.H / 2 + Math.sin(a) * d);
      if (o.inside(x + 0.5, y + 0.5) && isFinite(cost(x, y))) entry = [x, y];
    }
    if (!entry) continue;
    const hub = R.hubRadius;
    const tiles = routeTiles(o.W, o.H, cost, entry, (x, y) => Math.hypot(x - centre[0], y - centre[1]) <= hub || roadTiles.has(y * o.W + x), centre);
    if (!tiles) continue;
    tiles.forEach(([x, y]) => roadTiles.add(y * o.W + x));
    // extend the road beyond the map edge so it doesn't start abruptly
    const line = toLine(tiles);
    line.unshift(new THREE.Vector2(o.W / 2 + Math.cos(a) * (Math.min(o.W, o.H) / 2 + 3), o.H / 2 + Math.sin(a) * (Math.min(o.W, o.H) / 2 + 3)));
    roads.push({ kind: mainKind, pts: line });
  }
  // foot paths from the nearest road tile to each target
  if (roadTiles.size) {
    for (const t of o.targets) {
      let best = -1, bd = Infinity;
      for (const i of roadTiles) { const d = Math.hypot((i % o.W) + 0.5 - t.x, Math.floor(i / o.W) + 0.5 - t.z); if (d < bd) { bd = d; best = i; } }
      if (best < 0 || bd < 2) continue;
      const tx = Math.floor(t.x), tz = Math.floor(t.z);
      const goal = (x: number, y: number) => Math.hypot(x - tx, y - tz) <= (t.water ? 1.5 : 1.2);
      const tiles = routeTiles(o.W, o.H, (x, y) => (t.water && Math.hypot(x - tx, y - tz) <= 1.5 ? 1 : cost(x, y)), [best % o.W, Math.floor(best / o.W)], goal, [tx, tz]);
      if (tiles && tiles.length > 1) roads.push({ kind: 'path', pts: toLine(tiles) });
    }
  }
  return { roads, at: roadField(roads, -2, -2, o.W + 4, o.H + 4) };
}

// ---- water helpers (terrain shore / bed, surface environment mask) ----

export type WaterEnv = { lake: number; pond: number; river: number };
export const SURFACES = ['grass', 'field', 'sand', 'rock', 'path'] as const;
const towardsW = (w: number[], k: number, a: number) => { for (let q = 0; q < w.length; q++) w[q] = w[q] * (1 - a) + (q === k ? a : 0); };
/**
 * Shore and bed of the water environment(s) at a terrain point: the band just above the water line
 * takes the environment's shore texture, everything below it the bed texture (texture weights `w`
 * = [grass, field, sand, rock, path], colour `c` towards `colors[texture]`). No water nearby -> lake.
 */
export function applyShore(env: WaterEnv, h: number, waterLevel: number, c: THREE.Color, w: number[], colors: Record<string, string>, looks: WaterLooks): void {
  const sum = env.lake + env.pond + env.river;
  for (const k of ['lake', 'pond', 'river'] as const) {
    const share = sum > 0.01 ? env[k] / sum : k === 'lake' ? 1 : 0;
    if (share <= 0) continue;
    const cfg = looks[k];
    const shore = (1 - THREE.MathUtils.smoothstep(h, waterLevel, waterLevel + cfg.shoreWidth)) * share;
    const bed = (1 - THREE.MathUtils.smoothstep(h, waterLevel - 0.006, waterLevel + 0.004)) * share;
    const si = SURFACES.indexOf(cfg.shoreTexture as (typeof SURFACES)[number]), bi = SURFACES.indexOf(cfg.bedTexture as (typeof SURFACES)[number]);
    if (si >= 0) { towardsW(w, si, shore); c.lerp(_shoreColor.set(colors[cfg.shoreTexture] ?? '#c9b27a'), shore); }
    if (bi >= 0) { towardsW(w, bi, bed); c.lerp(_shoreColor.set(colors[cfg.bedTexture] ?? '#c9b27a'), bed); }
  }
}
const _shoreColor = new THREE.Color();

/** Environment mask for the water surface: R = lake, G = pond, B = river (px samples per tile). */
export function waterMaskTexture(sample: (x: number, z: number) => WaterEnv, x0: number, z0: number, size: number, px = 2): THREE.DataTexture {
  const n = Math.max(2, Math.round(size * px)), data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const e = sample(x0 + ((i + 0.5) / n) * size, z0 + ((j + 0.5) / n) * size), k = (j * n + i) * 4;
      data[k] = e.lake * 255; data[k + 1] = e.pond * 255; data[k + 2] = e.river * 255; data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
