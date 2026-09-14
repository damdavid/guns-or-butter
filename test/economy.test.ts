/**
 * Unit tests for the mechanics that make this economy unusual: superlinear labour,
 * capacity-proportional demand, input hoarding, depth-ordered priority, the terrain
 * floor, tool waste, and square-root population response.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AGRICULTURE, POPULATION, tierYield } from "../src/data.ts";
import { Economy, nextPopulation } from "../src/economy.ts";
import { terrainMultiplier } from "../src/terrain.ts";
import type { EconomyState } from "../src/types.ts";

const state = (over: Partial<EconomyState> = {}): EconomyState => ({
  level: "beginner",
  land: { farmland: 0, forest: 0, mountains: 0, desert: 0 },
  population: 1000,
  workers: {},
  ...over,
});

describe("productivity function (§3.4)", () => {
  const economy = new Economy();

  it("is superlinear: doubling labour more than doubles capacity", () => {
    const one = economy.capacity(state({ workers: { lumber: 50 } }), "lumber");
    const two = economy.capacity(state({ workers: { lumber: 100 } }), "lumber");
    assert.ok(two / one > 2, `ratio ${(two / one).toFixed(3)} should exceed 2`);
    const a = economy.graph.table.get("lumber")!.a;
    assert.ok(Math.abs(two / one - 2 ** a) < 1e-6);
  });

  it("returns zero for an unstaffed factory", () => {
    assert.equal(economy.capacity(state({ workers: { lumber: 0 } }), "lumber"), 0);
  });

  it("gives advanced tiers a larger exponent and smaller coefficient", () => {
    const tools = ["farm-tools", "iron-plow", "combine", "irrigation", "tractor"];
    for (let i = 1; i < tools.length; i++) {
      const lo = economy.graph.table.get(tools[i - 1]!)!;
      const hi = economy.graph.table.get(tools[i]!)!;
      assert.ok(hi.a > lo.a, `${hi.id} exponent should exceed ${lo.id}`);
      assert.ok(hi.k < lo.k, `${hi.id} coefficient should be below ${lo.id}`);
    }
  });

  it("makes a tier-5 tool worse at small scale and better at large", () => {
    // Compared in FOOD delivered, not tonnage: a ton of tractor is worth 16 tons of
    // farm tools (§4.3), so tractors never out-tonne farm tools — they out-feed them.
    const food = (id: string, tier: number, L: number) =>
      economy.capacity(state({ workers: { [id]: L } }), id) * tierYield(tier);
    assert.ok(food("tractor", 5, 10) < food("farm-tools", 1, 10), "tier 5 loses at 10 workers");
    assert.ok(food("tractor", 5, 1000) > food("farm-tools", 1, 1000), "tier 5 wins at 1000");
  });
});

describe("graph structure (§8.4)", () => {
  const { depth, consumers } = new Economy().graph;

  it("is acyclic with raws at depth 0", () => {
    assert.equal(depth.get("lumber"), 0);
    assert.equal(depth.get("charcoal"), 1);
    assert.equal(depth.get("pig-iron"), 2);
    assert.equal(depth.get("farm-tools"), 3);
  });

  it("puts Cannon shallower than Rifle despite being a higher tier", () => {
    assert.ok(depth.get("cannon")! < depth.get("rifle")!);
  });

  it("orders consumers shallowest-first, so charcoal outranks farm tools for lumber", () => {
    const order = consumers.get("lumber")!;
    assert.ok(order.indexOf("charcoal") < order.indexOf("farm-tools"));
  });
});

describe("demand-driven allocation (§3.5)", () => {
  it("gives the simpler factory priority when supply is short", () => {
    // Appendix A's worked example: lumber short, charcoal beats farm tools to it.
    const economy = new Economy();
    const result = economy.resolve(
      state({ workers: { lumber: 5, charcoal: 6, "pig-iron": 30, "farm-tools": 56 } }),
    );
    const lumber = result.commodities["lumber"]!;
    assert.ok(lumber.surplus < 0, "expected a lumber shortfall for this test to mean anything");
    const charcoal = result.commodities["charcoal"]!;
    const farmTools = result.commodities["farm-tools"]!;
    assert.ok(
      Math.abs(charcoal.received["lumber"]! - lumber.output) < 1e-9,
      "charcoal, being shallower, should take the entire lumber supply",
    );
    assert.equal(farmTools.received["lumber"], 0, "farm tools should be left with none");
  });

  it("hoards inputs it cannot use, rather than releasing them", () => {
    // Farm tools needs lumber and pig iron. Starve lumber only; the pig iron it
    // reserved must still be consumed from the pool, showing up as a shortfall.
    const economy = new Economy();
    const result = economy.resolve(
      state({ workers: { lumber: 1, "iron-ore": 30, charcoal: 6, "pig-iron": 30, "farm-tools": 56 } }),
    );
    const farmTools = result.commodities["farm-tools"]!;
    const pigIron = result.commodities["pig-iron"]!;
    assert.ok(farmTools.output < farmTools.capacity, "farm tools should be lumber-starved");
    assert.ok(
      farmTools.received["pig-iron"]! > farmTools.output * 0.5 + 1,
      "reserved pig iron should exceed what the realised output needed",
    );
    assert.ok(pigIron.demand > pigIron.output);
  });

  it("reports the binding input as the limiting factor, else Labor", () => {
    const economy = new Economy();
    const result = economy.resolve(
      state({ workers: { lumber: 27, "iron-ore": 30, charcoal: 6, "pig-iron": 30, "farm-tools": 56 } }),
    );
    assert.equal(result.commodities["lumber"]!.limitingFactor, "Labor");
    assert.equal(result.commodities["pig-iron"]!.limitingFactor, "charcoal");
    assert.equal(result.commodities["farm-tools"]!.limitingFactor, "pig-iron");
  });

  it("keeps raws Labor-limited at every allocation (§2.2)", () => {
    const economy = new Economy();
    for (const L of [1, 10, 100, 1000, 100_000]) {
      const result = economy.resolve(
        state({ level: "intermediate", land: { farmland: 0, forest: 5, mountains: 0, desert: 0 }, workers: { lumber: L } }),
      );
      assert.equal(result.commodities["lumber"]!.limitingFactor, "Labor", `at L=${L}`);
    }
  });

  it("discards surplus rather than carrying it — resolve is stateless", () => {
    const economy = new Economy();
    const s = state({ workers: { lumber: 27 } });
    const a = economy.resolve(s);
    const b = economy.resolve(s);
    assert.equal(a.commodities["lumber"]!.surplus, b.commodities["lumber"]!.surplus);
  });
});

describe("terrain response (§2.2)", () => {
  it("applies a floor below roughly two acres", () => {
    const zero = terrainMultiplier("intermediate", 0);
    assert.equal(terrainMultiplier("intermediate", 1), zero, "1 acre should still be floored");
    assert.ok(terrainMultiplier("intermediate", 10) > zero);
  });

  it("is monotonic in acreage and linear above the floor", () => {
    const step = (a: number) =>
      terrainMultiplier("intermediate", a + 10) - terrainMultiplier("intermediate", a);
    assert.ok(Math.abs(step(10) - step(40)) < 1e-9, "slope should be constant");
  });

  it("penalises Expert relative to Intermediate at equal acreage", () => {
    assert.ok(terrainMultiplier("expert", 20) < terrainMultiplier("intermediate", 20));
  });

  it("only multiplies raws whose own terrain the nation holds", () => {
    const economy = new Economy();
    const forested = state({ level: "intermediate", land: { farmland: 0, forest: 50, mountains: 0, desert: 0 }, workers: { lumber: 20, "iron-ore": 20 } });
    const bare = state({ level: "intermediate", land: { farmland: 0, forest: 0, mountains: 0, desert: 0 }, workers: { lumber: 20, "iron-ore": 20 } });
    assert.ok(economy.capacity(forested, "lumber") > economy.capacity(bare, "lumber"));
    assert.equal(economy.capacity(forested, "iron-ore"), economy.capacity(bare, "iron-ore"));
  });
});

describe("agriculture and population (§4)", () => {
  const economy = new Economy();

  it("locks one worker per acre of farmland", () => {
    const s = state({ land: { farmland: 200, forest: 0, mountains: 0, desert: 0 } });
    assert.equal(economy.agriculturalWorkers(s), 200);
    assert.equal(economy.allocatableWorkers(s), 800);
  });

  it("yields one ton per acre with no tools", () => {
    const r = economy.resolve(state({ land: { farmland: 300, forest: 0, mountains: 0, desert: 0 } }));
    assert.equal(r.agriculture.food, 300);
  });

  it("wastes tools beyond one ton per acre", () => {
    const r = economy.resolve(
      state({ land: { farmland: 100, forest: 0, mountains: 0, desert: 0 }, workers: { lumber: 40, "iron-ore": 40, charcoal: 20, "pig-iron": 40, "farm-tools": 60 } }),
    );
    assert.equal(r.agriculture.toolsUsed["farm-tools"], 100, "capped at acreage");
    assert.ok(r.commodities["farm-tools"]!.surplus > 0, "the excess shows as surplus");
    assert.equal(r.agriculture.food, 200, "100 from land plus 100 from tier-1 tools");
  });

  it("consumes higher tiers first, since they yield more per ton", () => {
    assert.equal(tierYield(1), 1);
    assert.equal(tierYield(5), 16);
    const r = economy.resolve(
      state({
        land: { farmland: 100, forest: 0, mountains: 0, desert: 0 },
        // Enough of both tiers that only preference decides which gets used.
        workers: { lumber: 60, "iron-ore": 80, coal: 40, charcoal: 30, "pig-iron": 50, iron: 60, "farm-tools": 50, "iron-plow": 60 },
      }),
    );
    assert.ok((r.agriculture.toolsUsed["iron-plow"] ?? 0) > 0, "tier 2 should be used");
    assert.ok(
      (r.agriculture.toolsUsed["iron-plow"] ?? 0) >= (r.agriculture.toolsUsed["farm-tools"] ?? 0),
      "tier 2 should be preferred over tier 1",
    );
  });

  it("requires one ton of food per person", () => {
    const r = economy.resolve(state({ population: 250, land: { farmland: 300, forest: 0, mountains: 0, desert: 0 } }));
    assert.equal(r.agriculture.required, 250);
    assert.equal(r.agriculture.surplus, 50);
    assert.equal(AGRICULTURE.foodPerPerson, 1);
  });

  it("grows as the square root of surplus, and shrinks faster than it grows", () => {
    assert.equal(nextPopulation(100, 0), 100);
    assert.equal(nextPopulation(100, 100), 100 + POPULATION.growth * 10);
    assert.equal(nextPopulation(100, -100), 100 - POPULATION.decline * 10);
    // Quadrupling the surplus only doubles the gain.
    const a = nextPopulation(100, 25) - 100;
    const b = nextPopulation(100, 100) - 100;
    assert.ok(Math.abs(b / a - 2) < 1e-9);
  });

  it("never drives population below zero", () => {
    assert.equal(nextPopulation(5, -1_000_000), 0);
  });
});

describe("firepower (§5.2)", () => {
  it("sums weapon output weighted 2^(tier-1)", () => {
    const economy = new Economy();
    const r = economy.resolve(
      state({ workers: { lumber: 30, "iron-ore": 40, charcoal: 20, "pig-iron": 40, sword: 30 } }),
    );
    assert.ok(Math.abs(r.firepower - r.commodities["sword"]!.output) < 1e-9);
  });
});
