// Deterministic hashing + PRNG. Everything procedural derives from these, so the
// same inputs always reproduce the same world and nothing generated is ever stored.

export function hash32(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x1f; // part separator so ("ab","c") != ("a","bc")
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Rng {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

export const rngFor = (...parts: (string | number)[]): Rng => rng(hash32(...parts));

/** Weighted pick; entries need a `weight` field. */
export function weighted<T extends { weight: number }>(r: Rng, entries: readonly T[]): T {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let roll = r.next() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll < 0) return e;
  }
  return entries[entries.length - 1];
}
