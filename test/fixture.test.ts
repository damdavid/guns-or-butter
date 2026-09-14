/**
 * The §8.1 reference state: nation GANTHOR, continent "trebolokhan", Beginner level,
 * from the Production Summary screenshot on manual p.12. A complete, internally
 * consistent snapshot of a real game — the acceptance test for the economy sim.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Economy } from "../src/economy.ts";
import { terrainMultiplier } from "../src/terrain.ts";
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
 * Every observed figure is an integer rounding of an unknown real, and outputs chain
 * (farm tools derives from pig iron, which derives from charcoal), so about a ton of
 * accumulated rounding is expected.
 */
const TOL = 1.5;

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

describe("§2.2 measured terrain readings (forest -> Lumber)", () => {
  const economy = new Economy();
  // 27 readings. Beginner One previously reported 89 at L=10; it was re-read as 87,
  // which is what dissolved the earlier cross-level exponent conflict.
  const READINGS = [
    { level: "beginner", forest: 0, workers: 10, output: 87 },
    { level: "beginner", forest: 0, workers: 25, output: 244 },
    { level: "beginner", forest: 0, workers: 27, output: 268 },
    { level: "intermediate", forest: 0, workers: 10, output: 29 },
    { level: "intermediate", forest: 0, workers: 25, output: 81 },
    { level: "intermediate", forest: 9, workers: 10, output: 39 },
    { level: "intermediate", forest: 9, workers: 25, output: 111 },
    { level: "intermediate", forest: 17, workers: 10, output: 51 },
    { level: "intermediate", forest: 17, workers: 25, output: 144 },
    { level: "intermediate", forest: 26, workers: 10, output: 65 },
    { level: "intermediate", forest: 26, workers: 25, output: 185 },
    { level: "intermediate", forest: 50, workers: 10, output: 101 },
    { level: "intermediate", forest: 50, workers: 25, output: 288 },
    { level: "expert", forest: 0, workers: 10, output: 10 },
    { level: "expert", forest: 0, workers: 25, output: 29 },
    { level: "expert", forest: 8, workers: 10, output: 21 },
    { level: "expert", forest: 8, workers: 25, output: 58 },
    { level: "expert", forest: 9, workers: 10, output: 21 },
    { level: "expert", forest: 9, workers: 25, output: 58 },
    { level: "expert", forest: 20, workers: 10, output: 37 },
    { level: "expert", forest: 20, workers: 25, output: 103 },
    { level: "expert", forest: 35, workers: 10, output: 56 },
    { level: "expert", forest: 35, workers: 25, output: 160 },
    { level: "expert", forest: 44, workers: 10, output: 72 },
    { level: "expert", forest: 44, workers: 25, output: 201 },
  ] as const;

  // Acreage is read off province closeups and looks good to about +-1 acre (§2.2),
  // which at ~0.11 per acre is a couple of tons of output.
  const TERRAIN_TOL = 3.5;

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

  it("gives two Intermediate nations the same lumber at zero forest, whatever their size", () => {
    // Continent One: 6 provinces, 208 farmland, 0 mountain, 19 desert.
    // Continent Six: 9 provinces, 523 farmland, 74 mountain, 14 desert.
    // Both returned 29 at L=10. This is what rules out nation size driving the base,
    // and it also shows mountain and desert acreage do not leak into Lumber.
    const lumberAt = (land: { farmland: number; mountains: number; desert: number }) =>
      economy.capacity(
        {
          level: "intermediate",
          land: { forest: 0, ...land },
          population: 2000,
          workers: { lumber: 10 },
        },
        "lumber",
      );
    const one = lumberAt({ farmland: 208, mountains: 0, desert: 19 });
    const six = lumberAt({ farmland: 523, mountains: 74, desert: 14 });
    assert.equal(one, six);
    assert.ok(Math.abs(one - 29) <= 1.0, `${one.toFixed(2)} != 29`);
  });

  it("scales the zero-acre floor with player count as N^-1.549", () => {
    const floors = (["beginner", "intermediate", "expert"] as const).map((level) =>
      terrainMultiplier(level, 0) * 6.3626,
    );
    // Two independent doublings of player count, both near a ratio of 2.9.
    assert.ok(Math.abs(floors[0]! / floors[1]! - 3.009) < 0.05);
    assert.ok(Math.abs(floors[1]! / floors[2]! - 2.846) < 0.05);
  });

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
