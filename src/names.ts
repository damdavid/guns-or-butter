/**
 * Province names.
 *
 * Crawford: "I worked long and hard on a clever little algorithm to create province
 * names ... they all seem to have a certain flavor to them. But how many people will
 * notice?" The shipped game also carries a `MONGOL.NAM` word list, which is not
 * redistributable, so this is a syllable generator in the same Central Asian register
 * rather than a copy of his data.
 */
import type { Rng } from "./rng.ts";

const ONSET = [
  "b", "ch", "d", "g", "gh", "j", "k", "kh", "l", "m", "n", "q", "s", "sh", "t", "ts",
  "y", "z", "",
];
const VOWEL = ["a", "a", "e", "i", "o", "u", "ai", "au", "ua", "ii"];
const CODA = ["", "", "", "n", "n", "r", "l", "g", "q", "s", "kh", "ng", "t"];

/** Two or three syllables, which is the shape most of the originals take. */
function syllable(rng: Rng, final: boolean): string {
  const coda = final ? rng.pick(CODA) : rng.pick(CODA.slice(0, 8));
  return rng.pick(ONSET) + rng.pick(VOWEL) + coda;
}

export function provinceName(rng: Rng): string {
  const count = rng.next() < 0.35 ? 3 : 2;
  let out = "";
  for (let i = 0; i < count; i++) out += syllable(rng, i === count - 1);
  // Reject the occasional unpronounceable run of consonants.
  if (/[bcdfghjklmnpqrstvwxyz]{4}/.test(out)) return provinceName(rng);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Distinct names, so no two provinces collide on one continent. */
export function uniqueNames(rng: Rng, count: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 200) {
    const name = provinceName(rng);
    if (seen.has(name) || name.length < 4) continue;
    seen.add(name);
    out.push(name);
  }
  while (out.length < count) out.push(`Province ${out.length + 1}`);
  return out;
}
