import { hash32 } from './rng.ts';

const lattice = (seed: number, x: number, y: number) => hash32(seed, x, y) / 4294967296;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2D value noise in [0, 1). */
export function valueNoise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const top = lerp(lattice(seed, xi, yi), lattice(seed, xi + 1, yi), tx);
  const bottom = lerp(lattice(seed, xi, yi + 1), lattice(seed, xi + 1, yi + 1), tx);
  return lerp(top, bottom, ty);
}

/** Fractal noise: several octaves of value noise, normalised to [0, 1). */
export function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(seed + o * 1013, x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
