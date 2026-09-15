/**
 * Seeded pseudo-random numbers.
 *
 * The continent name is the seed (§2) — Crawford's own device, so that a world can be
 * regenerated from the name alone. Keep it: it makes worlds shareable and bug reports
 * reproducible for free.
 */

/** FNV-1a, so a continent name maps to a stable 32-bit seed across runs and platforms. */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toUpperCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates, returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 — small, fast, and good enough for terrain. Not for anything adversarial. */
export function makeRng(seed: number | string): Rng {
  let s = (typeof seed === "string" ? hashName(seed) : seed) >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
  return rng;
}
