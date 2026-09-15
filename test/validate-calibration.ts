/**
 * Scores the sim against every measurement in the two CSVs. `npm run validate`
 *
 * This is the honest accuracy report for the calibration: one fitted exponent per
 * commodity has to serve every level and continent, so per-point error is the price of
 * that consistency. Run it after any recalibration.
 */
import { readFileSync } from "node:fs";
import { Economy } from "../src/economy.ts";
import type { EconomyState, Level } from "../src/types.ts";

const ID: Record<string, string> = {
  Lumber: "lumber", Sulfur: "sulfur", "Iron Ore": "iron-ore", Coal: "coal",
  "Light Metal": "light-metal", Nitrate: "nitrate", "Heavy Metal": "heavy-metal",
  Petroleum: "petroleum", Charcoal: "charcoal", "Pig Iron": "pig-iron",
  Gunpowder: "gunpowder", Iron: "iron", "Low-Grade Steel": "low-grade-steel",
  Explosives: "explosives", "High-Grade Steel": "high-grade-steel",
  "High Explosives": "high-explosives", "Steam Engine": "steam-engine", Wire: "wire",
  Pipe: "pipe", Electrics: "electrics", "Ball Bearing": "ball-bearing",
  "Diesel Engine": "diesel-engine", Instruments: "instruments",
  "Farm Tools": "farm-tools", "Iron Plow": "iron-plow", Combine: "combine",
  Irrigation: "irrigation", Tractor: "tractor", Sword: "sword", Musket: "musket",
  Rifle: "rifle", Cannon: "cannon", Tank: "tank",
};
const LEVEL: Record<string, Level> = {
  Beginner: "beginner", Intermediate: "intermediate", Expert: "expert",
};

const cells = (line: string) => line.split(",").map((s) => s.trim());
const economy = new Economy();

interface Point { id: string; level: Level; acres: Record<string, number>; L: number; obs: number; continent: string }
const points: Point[] = [];

/** Mirrors EXCLUDE in docs/calibrate.py. Empty since Seven's Iron Ore was re-read. */
const EXCLUDED = new Set<string>();

{
  const rows = readFileSync("docs/raw-outputs-by-worker-and-terrain.csv", "utf8")
    .split("\n").filter((l) => l.trim()).map(cells);
  const hdr = rows[1]!;
  for (const v of rows.slice(2)) {
    if (!v[0]) continue;
    const acres = {
      farmland: +v[4]!, mountains: +v[5]!, forest: +v[6]!, desert: +v[7]!,
    };
    for (let i = 9; i < hdr.length; i++) {
      const raw = v[i];
      if (!raw || +raw <= 0) continue;
      const id = ID[hdr[i]!]!;
      const level = LEVEL[v[0]!]!;
      if (EXCLUDED.has(`${id}|${level}|${v[1]}`)) continue;
      points.push({ id, level, acres, L: +v[8]!, obs: +raw, continent: v[1]! });
    }
  }
}
{
  const rows = readFileSync("docs/intermediate-outputs-by-worker.csv", "utf8")
    .split("\n").filter((l) => l.trim()).map(cells);
  const hdr = rows[1]!;
  for (const v of rows.slice(2)) {
    if (!v[0]) continue;
    for (let i = 2; i < hdr.length; i++) {
      const raw = v[i];
      if (!raw || +raw <= 0) continue;
      points.push({
        id: ID[hdr[i]!]!, level: LEVEL[v[0]!]!,
        acres: { farmland: 0, mountains: 0, forest: 0, desert: 0 },
        L: +v[1]!, obs: +raw, continent: "pooled",
      });
    }
  }
}

const byCommodity = new Map<string, { n: number; sse: number; worst: number; rel: number[] }>();
for (const p of points) {
  const state: EconomyState = {
    level: p.level,
    land: p.acres as unknown as EconomyState["land"],
    population: 100_000,
    workers: { [p.id]: p.L },
  };
  const pred = economy.capacity(state, p.id);
  const err = pred - p.obs;
  const rel = Math.abs(err) / p.obs;
  const e = byCommodity.get(p.id) ?? { n: 0, sse: 0, worst: 0, rel: [] };
  e.n++;
  e.sse += err * err;
  e.worst = Math.max(e.worst, rel);
  e.rel.push(rel);
  byCommodity.set(p.id, e);
}

console.log(`${points.length} measurements\n`);
console.log("commodity            n   rmse   median%   worst%");
const all: number[] = [];
for (const [id, e] of [...byCommodity].sort((a, b) => b[1].worst - a[1].worst)) {
  const med = e.rel.slice().sort((x, y) => x - y)[Math.floor(e.rel.length / 2)]!;
  all.push(...e.rel);
  console.log(
    `${id.padEnd(20)}${String(e.n).padStart(2)}  ${Math.sqrt(e.sse / e.n).toFixed(2).padStart(6)}` +
    `  ${(med * 100).toFixed(1).padStart(7)}  ${(e.worst * 100).toFixed(1).padStart(7)}`,
  );
}
const summarise = (label: string, rel: number[]) => {
  if (!rel.length) return;
  const s = rel.slice().sort((a, b) => a - b);
  const q = (p: number) => (s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100).toFixed(1);
  console.log(`${label.padEnd(26)} n=${String(rel.length).padStart(3)}  median ${q(0.5).padStart(5)}%  p90 ${q(0.9).padStart(6)}%  worst ${q(1).padStart(6)}%`);
};

// Outputs are displayed as integers, so a reading of 3 carries +-17% of rounding on its
// own. Stratifying separates model error from the precision of the measurement.
console.log("\nby observed magnitude:");
const buckets: [string, (o: number) => boolean][] = [
  ["obs < 10 (rounding-bound)", (o) => o < 10],
  ["10 <= obs < 50", (o) => o >= 10 && o < 50],
  ["50 <= obs < 200", (o) => o >= 50 && o < 200],
  ["obs >= 200", (o) => o >= 200],
];
for (const [label, test] of buckets) {
  summarise(label, points.filter((p) => test(p.obs)).map((p) => {
    const st: EconomyState = {
      level: p.level, land: p.acres as unknown as EconomyState["land"],
      population: 100_000, workers: { [p.id]: p.L },
    };
    return Math.abs(economy.capacity(st, p.id) - p.obs) / p.obs;
  }));
}
console.log("");
summarise("ALL", all);
