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

/**
 * Polities that existed before 600 BCE, for the nations the player is not.
 *
 * The period is the setting's own: the tech tree starts at charcoal and swords, and
 * Crawford's tiers run out around the steam engine, so the opposition should read as
 * bronze and early iron age rather than as modern states.
 */
export const ANCIENT_NATIONS: readonly string[] = [
  "Akkad", "Assyria", "Babylon", "Sumer", "Elam", "Ur", "Larsa", "Mari", "Ebla",
  "Hatti", "Mitanni", "Urartu", "Phrygia", "Lydia", "Arzawa", "Luwia", "Troy",
  "Egypt", "Kush", "Kerma", "Nubia", "Punt", "Saba", "Dilmun", "Magan",
  "Phoenicia", "Tyre", "Sidon", "Byblos", "Ugarit", "Carthage", "Aram", "Moab",
  "Edom", "Israel", "Judah", "Philistia", "Amurru", "Qatna", "Alalakh",
  "Mycenae", "Minoa", "Sparta", "Athens", "Argos", "Thebes", "Corinth", "Miletus",
  "Media", "Parsua", "Scythia", "Cimmeria", "Colchis", "Bactria", "Sogdia",
  "Shang", "Zhou", "Chu", "Qi", "Jin", "Yan", "Wu", "Yue",
  "Kuru", "Panchala", "Magadha", "Kosala", "Videha", "Gandhara", "Avanti",
  "Olmec", "Chavin", "Nok", "Tartessos", "Nuragic", "Villanova", "Etruria",
];

/**
 * Pick names for the nations, seeded so a continent always has the same opposition.
 *
 * `taken` is the player's own choice, kept out of the draw: two nations answering to the
 * same name would make the standings unreadable.
 */
export function nationNames(
  rng: Rng,
  count: number,
  taken: readonly string[] = [],
): string[] {
  const claimed = new Set(taken.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const pool = rng.shuffle(ANCIENT_NATIONS.filter((n) => !claimed.has(n.toLowerCase())));
  return Array.from({ length: count }, (_, i) => pool[i % pool.length] ?? `Nation ${i}`);
}
