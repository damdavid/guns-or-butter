/**
 * Prints the §8.1 reference state as the game's own Production Summary, for eyeballing
 * against the manual p.12 screenshot. `npm run fixture`
 */
import { Economy } from "../src/economy.ts";
import type { EconomyState } from "../src/types.ts";

const WORKERS: Record<string, number> = {
  lumber: 27, sulfur: 0, "iron-ore": 30, coal: 0, charcoal: 6, "pig-iron": 30,
  gunpowder: 0, iron: 0, "farm-tools": 56, "iron-plow": 0, sword: 0, musket: 0,
};
const OBSERVED: Record<string, [number, number]> = {
  lumber: [268, -1], sulfur: [0, 0], "iron-ore": [218, 0], coal: [0, 0],
  charcoal: [49, -8], "pig-iron": [199, -21], gunpowder: [0, 0], iron: [0, 0],
  "farm-tools": [399, 90], "iron-plow": [0, 0], sword: [0, 0], musket: [0, 0],
};

const state: EconomyState = {
  level: "beginner",
  land: { farmland: 309, forest: 0, mountains: 0, desert: 0 },
  population: 461,
  workers: WORKERS,
};

for (const [label, economy] of [
  ["default calibration (joint fit)", new Economy()],
  ["Beginner-only Lumber calibration", new Economy({ overrides: { lumber: { k: 6.9111, a: 1.1098 } } })],
] as const) {
  const r = economy.resolve(state);
  console.log(`\n=== PRODUCTION SUMMARY FOR GANTHOR — ${label} ===`);
  console.log(
    "Commodity".padEnd(16) + "Output".padStart(9) + "Surplus".padStart(9) +
    "Limiting".padStart(12) + "Workers".padStart(9) + "   vs observed",
  );
  for (const id of Object.keys(WORKERS)) {
    const c = r.commodities[id]!;
    const [obsOut, obsSur] = OBSERVED[id]!;
    const dOut = c.output - obsOut;
    const dSur = c.surplus - obsSur;
    const flag = Math.abs(dOut) > 1 || Math.abs(dSur) > 1 ? " <-" : "";
    console.log(
      id.padEnd(16) +
      c.output.toFixed(1).padStart(9) +
      c.surplus.toFixed(1).padStart(9) +
      String(c.limitingFactor).padStart(12) +
      String(c.workers).padStart(9) +
      `   ${obsOut}/${obsSur}  Δ${dOut >= 0 ? "+" : ""}${dOut.toFixed(1)}/${dSur >= 0 ? "+" : ""}${dSur.toFixed(1)}${flag}`,
    );
  }
  const a = r.agriculture;
  console.log(
    `${"Food".padEnd(16)}${a.food.toFixed(1).padStart(9)}${a.surplus.toFixed(1).padStart(9)}` +
    `${"Labor".padStart(12)}${String(a.workers).padStart(9)}   618/157`,
  );
  console.log(
    `  required ${a.required}  population ${r.population} -> ${r.nextPopulation.toFixed(1)}` +
    `  firepower ${r.firepower.toFixed(1)}`,
  );
}
