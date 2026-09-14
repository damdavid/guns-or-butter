/**
 * The §8.1 reference state: nation GANTHOR, continent "trebolokhan", Beginner level,
 * from the Production Summary screenshot on manual p.12. A complete, internally
 * consistent snapshot of a real game — the acceptance test for the economy sim.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Economy } from "../src/economy.ts";
import type { EconomyState } from "../src/types.ts";

/** Observed output, surplus and limiting factor, exactly as displayed. */
const OBSERVED = {
  lumber: { output: 268, surplus: -1, limiting: "Labor", workers: 27 },
  sulfur: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  "iron-ore": { output: 218, surplus: 0, limiting: "Labor", workers: 30 },
  coal: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  charcoal: { output: 49, surplus: -8, limiting: "Labor", workers: 6 },
  "pig-iron": { output: 199, surplus: -21, limiting: "charcoal", workers: 30 },
  gunpowder: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  iron: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  "farm-tools": { output: 399, surplus: 90, limiting: "pig-iron", workers: 56 },
  "iron-plow": { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  sword: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
  musket: { output: 0, surplus: 0, limiting: "Labor", workers: 0 },
} as const;

const FIXTURE: EconomyState = {
  level: "beginner",
  land: { farmland: 309, forest: 0, mountains: 0, desert: 0 },
  population: 461,
  workers: Object.fromEntries(
    Object.entries(OBSERVED).map(([id, o]) => [id, o.workers]),
  ),
};

/**
 * Displayed values are integers, and Lumber carries a known calibration conflict: the
 * Beginner readings want `a = 1.1098` while the 20 Intermediate/Expert readings want
 * ~1.128 (§2.2). The shipped default is the joint fit, which over-predicts this
 * screenshot's Lumber row by ~2.4 tons. The suite below shows the allocation logic
 * itself closes exactly once Lumber is calibrated to Beginner alone.
 */
const TOL = 2.5;

describe("§8.1 reference state", () => {
  const economy = new Economy();
  const result = economy.resolve(FIXTURE);

  it("locks 309 workers into farming, one per acre", () => {
    assert.equal(result.agriculture.workers, 309);
  });

  it("food requirement is 1 ton per person", () => {
    assert.equal(result.agriculture.required, 461);
  });

  it("produces 618 tons of food: 309 from land, 309 from tools", () => {
    assert.ok(
      Math.abs(result.agriculture.food - 618) <= TOL,
      `food ${result.agriculture.food.toFixed(2)} != 618`,
    );
    assert.ok(Math.abs(result.agriculture.surplus - 157) <= TOL);
  });

  it("caps tool use at one ton per acre, wasting the rest", () => {
    assert.equal(result.agriculture.toolsUsed["farm-tools"], 309);
  });

  for (const [id, expected] of Object.entries(OBSERVED)) {
    it(`${id}: output ${expected.output}, surplus ${expected.surplus}, limited by ${expected.limiting}`, () => {
      const actual = result.commodities[id]!;
      assert.ok(
        Math.abs(actual.output - expected.output) <= TOL,
        `output ${actual.output.toFixed(2)} != ${expected.output}`,
      );
      assert.ok(
        Math.abs(actual.surplus - expected.surplus) <= TOL,
        `surplus ${actual.surplus.toFixed(2)} != ${expected.surplus}`,
      );
      assert.equal(actual.limitingFactor, expected.limiting);
    });
  }
});

describe("§8.1 closes exactly under a Beginner-only Lumber calibration", () => {
  // Two Beginner points, (L=27, 268) and (L=10, 89), determine (k, a) exactly. Using
  // them isolates the allocation logic from the cross-level exponent disagreement.
  const economy = new Economy({ overrides: { lumber: { k: 6.9111, a: 1.1098 } } });
  const result = economy.resolve(FIXTURE);
  // Every observed figure is an integer rounding of an unknown real, and outputs chain
  // (farm tools is derived from pig iron, itself derived from charcoal), so ~1 ton of
  // accumulated rounding is expected and is not model error.
  const EXACT = 1.0;

  for (const [id, expected] of Object.entries(OBSERVED)) {
    it(`${id} matches to within ${EXACT} tons`, () => {
      const actual = result.commodities[id]!;
      assert.ok(
        Math.abs(actual.output - expected.output) <= EXACT,
        `output ${actual.output.toFixed(2)} != ${expected.output}`,
      );
      assert.ok(
        Math.abs(actual.surplus - expected.surplus) <= EXACT,
        `surplus ${actual.surplus.toFixed(2)} != ${expected.surplus}`,
      );
      assert.equal(actual.limitingFactor, expected.limiting);
    });
  }
});

describe("§2.2 measured terrain readings (forest -> Lumber)", () => {
  const economy = new Economy();
  const READINGS = [
    { level: "beginner", forest: 0, workers: 10, output: 89 },
    { level: "intermediate", forest: 0, workers: 10, output: 29 },
    { level: "intermediate", forest: 9, workers: 10, output: 39 },
    { level: "intermediate", forest: 17, workers: 10, output: 51 },
    { level: "intermediate", forest: 17, workers: 25, output: 144 },
    { level: "intermediate", forest: 26, workers: 10, output: 65 },
    { level: "intermediate", forest: 50, workers: 10, output: 101 },
    { level: "intermediate", forest: 50, workers: 25, output: 288 },
    { level: "expert", forest: 0, workers: 10, output: 10 },
    { level: "expert", forest: 8, workers: 10, output: 21 },
    { level: "expert", forest: 20, workers: 10, output: 37 },
    { level: "expert", forest: 20, workers: 25, output: 103 },
    { level: "expert", forest: 35, workers: 10, output: 56 },
    { level: "expert", forest: 44, workers: 10, output: 72 },
    { level: "expert", forest: 44, workers: 25, output: 201 },
  ] as const;

  // Acreage is read off province closeups and looks good to about +-1 acre (§2.2),
  // which at ~0.11 per acre is a couple of tons of output.
  const TERRAIN_TOL = 3.0;

  for (const r of READINGS) {
    it(`${r.level} ${r.forest} acres, ${r.workers} workers -> ${r.output}`, () => {
      const got = new Economy().capacity(
        {
          level: r.level,
          land: { farmland: 0, forest: r.forest, mountains: 0, desert: 0 },
          population: 1000,
          workers: { lumber: r.workers },
        },
        "lumber",
      );
      assert.ok(
        Math.abs(got - r.output) <= TERRAIN_TOL,
        `${got.toFixed(2)} != ${r.output} (delta ${(got - r.output).toFixed(2)})`,
      );
    });
  }

  it("Beginner ignores terrain entirely", () => {
    const at = (forest: number) =>
      economy.capacity(
        {
          level: "beginner",
          land: { farmland: 0, forest, mountains: 0, desert: 0 },
          population: 1000,
          workers: { lumber: 10 },
        },
        "lumber",
      );
    assert.equal(at(0), at(50));
  });
});
