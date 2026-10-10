// Map symbols for location types. Every type gets a MapLibre image named `loc-<type>`:
//   - if LOCATION_TYPES[type].icon is set, that image file is used
//   - otherwise the type's emoji is drawn onto a canvas
// Images are created on demand (styleimagemissing), so new types/assets need no code here.
import { LOCATION_TYPES, type LocationType } from '../engine/index.ts';

// ======================= KNOBS =======================
/** Symbol size per star tier (1 = the image's natural size, see ICON_PX). */
export const TIER_ICON_SCALE: Record<number, number> = { 1: 0.55, 2: 0.8, 3: 1.1 };
/** Extra scaling by zoom: symbols shrink when zoomed out. */
export const ZOOM_ICON_SCALE = { zoomOut: 10, scaleOut: 0.6, zoomIn: 16, scaleIn: 1 };
const ICON_PX = 48; // on-screen size at scale 1
// =====================================================

const PIXEL_RATIO = 2; // draw at 2× for crisp symbols on hi-dpi screens
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const PREFIX = 'loc-';

export const locationIconId = (type: string) => PREFIX + type;

/** MapLibre `icon-size` expression: tier scale × zoom scale (needs a numeric `tier` property). */
export function iconSizeExpression(): unknown[] {
  const tier = ['match', ['get', 'tier'], ...Object.entries(TIER_ICON_SCALE).flatMap(([t, s]) => [Number(t), s]), 1];
  const z = ZOOM_ICON_SCALE;
  return ['interpolate', ['linear'], ['zoom'], z.zoomOut, ['*', z.scaleOut, tier], z.zoomIn, ['*', z.scaleIn, tier]];
}

function emojiImage(emoji: string): ImageData {
  const size = ICON_PX * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${Math.round(size * 0.82)}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'; // small drop shadow so symbols lift off the map
  ctx.shadowBlur = size * 0.06;
  ctx.shadowOffsetY = size * 0.03;
  ctx.fillText(emoji, size / 2, size * 0.54);
  return ctx.getImageData(0, 0, size, size);
}

/** Register the on-demand image provider. Call once, right after creating the map. */
export function registerLocationIcons(map: any): void {
  map.on('styleimagemissing', (e: { id: string }) => {
    if (!e.id.startsWith(PREFIX)) return;
    const def = LOCATION_TYPES[e.id.slice(PREFIX.length) as LocationType];
    if (!def || map.hasImage(e.id)) return;
    // Emoji right away (styleimagemissing must be answered synchronously)…
    map.addImage(e.id, emojiImage(def.emoji), { pixelRatio: PIXEL_RATIO });
    // …then swap in the graphical asset once it has loaded.
    if (def.icon) {
      map.loadImage(def.icon)
        .then((img: { data: HTMLImageElement | ImageBitmap }) => {
          const ratio = img.data.width / ICON_PX; // scale any asset size to ICON_PX on screen
          map.removeImage(e.id);
          map.addImage(e.id, img.data, { pixelRatio: ratio });
        })
        .catch((err: unknown) => console.warn(`icon for ${e.id} failed, keeping emoji`, err));
    }
  });
}
