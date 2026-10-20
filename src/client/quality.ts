// Graphics quality for the 3D location view. Presets cap the expensive knobs ON TOP of the
// current settings (code defaults + asset-editor tweaks), so "high" = exactly your settings.
// Auto-picks "low" on phones/tablets; the choice is remembered per browser.
import { DECOR } from './location-decor.ts';
import { WATER_SURFACE } from './water-surface.ts';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const STORAGE_KEY = 'qre.quality';

/** What each preset changes. Numbers are caps (min with your value) unless noted. */
export const QUALITY_PRESETS = {
  low: {
    maxPixelRatio: 1, shadowMapSize: 1024, treeShadows: false, meshDetail: 2, edgeFogLayers: 3, mistLayers: 1,
    reflection: false, shellLayers: 5, leavesPerTip: 20, coniferMasses: 1, coniferDetail: 0, treeVariants: 2, density: 0.5,
  },
  medium: {
    maxPixelRatio: 1.5, shadowMapSize: 2048, treeShadows: true, meshDetail: 3, edgeFogLayers: 6, mistLayers: 2,
    reflection: true, reflectionResolution: 0.35, shellLayers: 8, leavesPerTip: 45, coniferMasses: 2, coniferDetail: 1, treeVariants: 3, density: 0.75,
  },
  high: null, // your settings, untouched
};

export function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
}

export const autoQuality = (): Quality => (isMobileDevice() ? 'low' : 'high');

export function storedQuality(): Quality | null {
  try {
    const q = localStorage.getItem(STORAGE_KEY);
    return QUALITIES.includes(q as Quality) ? (q as Quality) : null;
  } catch {
    return null;
  }
}

export const currentQuality = (): Quality => storedQuality() ?? autoQuality();

/** Save the choice ('auto' clears it) and reload – the scene is generated once at load. */
export function setQuality(q: Quality | 'auto'): void {
  try {
    if (q === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, q);
  } catch {
    // ignore
  }
  location.reload();
}

/** View settings the quality touches (VIEW in location-view.ts provides these). */
export interface QualityView {
  maxPixelRatio: number;
  shadowMapSize: number;
  treeShadows: boolean;
  meshDetail: number;
  edgeFogLayers: number;
  mistLayers: number;
}

/** Apply the current preset to DECOR, WATER_SURFACE and the given view settings. Call once, before building the scene. */
export function applyQuality(view: QualityView): Quality {
  const q = currentQuality();
  const p = QUALITY_PRESETS[q];
  if (!p) return q;
  view.maxPixelRatio = Math.min(view.maxPixelRatio, p.maxPixelRatio);
  view.shadowMapSize = Math.min(view.shadowMapSize, p.shadowMapSize);
  view.treeShadows = view.treeShadows && p.treeShadows;
  view.meshDetail = Math.min(view.meshDetail, p.meshDetail);
  view.edgeFogLayers = Math.min(view.edgeFogLayers, p.edgeFogLayers);
  view.mistLayers = Math.min(view.mistLayers, p.mistLayers);
  WATER_SURFACE.reflection = WATER_SURFACE.reflection && p.reflection;
  if ('reflectionResolution' in p) WATER_SURFACE.resolution = Math.min(WATER_SURFACE.resolution, p.reflectionResolution);
  DECOR.leavesPerTip = Math.min(DECOR.leavesPerTip, p.leavesPerTip);
  DECOR.conifer.massesPerBranch = Math.min(DECOR.conifer.massesPerBranch, p.coniferMasses);
  DECOR.conifer.massDetail = Math.min(DECOR.conifer.massDetail, p.coniferDetail);
  DECOR.shells.layers = Math.min(DECOR.shells.layers, p.shellLayers);
  const P = DECOR.placement, F = DECOR.fields;
  P.treeVariants = Math.min(P.treeVariants, p.treeVariants);
  P.grassPatchDensity = Math.round(P.grassPatchDensity * p.density);
  P.forestGrassPerTile = Math.round(P.forestGrassPerTile * p.density);
  P.reedsPerBogTile = Math.round(P.reedsPerBogTile * p.density);
  F.grainPerTile = Math.round(F.grainPerTile * p.density);
  return q;
}
