/**
 * Unit tests for the mechanics that make this economy unusual: superlinear labour,
 * capacity-proportional demand, input hoarding, depth-ordered priority, the terrain
 * floor, tool waste, and square-root population response.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AGRICULTURE, POPULATION, tierYield } from "../src/data.ts";
import { rawCoefficient, rawParams } from "../src/terrain.ts";
import { PARAMS } from "../src/calibration.ts";
import { Economy, nextPopulation } from "../src/economy.ts";

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
    const a = rawParams(economy.graph.table.get("lumber")!, "beginner")!.a;
    assert.ok(Math.abs(two / one - 2 ** a) < 1e-6);
  });

  it("returns zero for an unstaffed factory", () => {
    assert.equal(economy.capacity(state({ workers: { lumber: 0 } }), "lumber"), 0);
  });

  it("gives advanced tiers a larger exponent and smaller coefficient", () => {
    // Crawford's stated rule, now measurable: "smaller proportionality constants and
    // larger exponents so that they are less efficient at smaller scales and more
    // efficient at larger scales." Expert is the only level with all five tiers.
    for (const tiers of [
      ["farm-tools", "iron-plow", "combine", "irrigation", "tractor"],
      ["sword", "musket", "rifle", "cannon", "tank"],
    ]) {
      for (let i = 1; i < tiers.length; i++) {
        const lo = PARAMS[tiers[i - 1]!]?.expert!;
        const hi = PARAMS[tiers[i]!]?.expert!;
        assert.ok(hi.a > lo.a, `${tiers[i]} exponent should exceed ${tiers[i - 1]}`);
        assert.ok(hi.k < lo.k, `${tiers[i]} coefficient should be below ${tiers[i - 1]}`);
      }
    }
  });

  it("measures exponents spanning 1.13 to 2.53, not one shared value", () => {
    const all = Object.values(PARAMS).flatMap((per) => Object.values(per ?? {}).map((p) => p.a));
    assert.ok(Math.min(...all) < 1.15, "tier-1 industries are barely superlinear");
    assert.ok(Math.max(...all) > 2.4, "the most advanced are steeply superlinear");
    assert.ok(all.every((a) => a > 1), "every industry has economies of scale");
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

describe("calibration coverage", () => {
  const economy = new Economy();
  const LEVELS = ["beginner", "intermediate", "expert"] as const;

  // Petroleum was silently absent from calibration.ts for one commit: its longest
  // measured series has 3 points and the exponent fitter required 4, so it was dropped
  // and then skipped by the emitter. Capacity fell to zero, which killed High
  // Explosives and Diesel Engine and with them Cannon, Tank and Tractor. These two
  // tests make that class of gap impossible to ship again.
  it("gives every commodity non-zero capacity at every level", () => {
    const generous = { farmland: 500, forest: 80, mountains: 80, desert: 80 };
    for (const level of LEVELS) {
      for (const id of economy.graph.table.keys()) {
        const cap = economy.capacity(
          { level, land: generous, population: 100_000, workers: { [id]: 100 } },
          id,
        );
        assert.ok(cap > 0, `${id} has no capacity at ${level}`);
      }
    }
  });

  it("lets every commodity produce when its own chain is staffed", () => {
    // Staffing every factory at once instead would starve most of them, and correctly
    // so: demand is capacity-proportional and the steep-exponent industries outbid the
    // rest for shared inputs (§3.5). So each commodity is tested with only its own
    // transitive inputs staffed.
    const { table } = economy.graph;
    const chain = (id: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const input of Object.keys(table.get(id)!.inputs)) chain(input, seen);
      return seen;
    };
    // Raws get far more labour than the factories downstream of them. With uniform
    // staffing a chain can starve itself: Combine needs both Iron and, via Steam
    // Engine, Low-Grade Steel, and those two compete for the same Iron Ore with Iron
    // winning on table order. That is the allocation rule working, not a bad parameter.
    const dead: string[] = [];
    for (const id of table.keys()) {
      const workers = Object.fromEntries(
        [...chain(id)].map((c) => [c, table.get(c)!.kind === "raw" ? 4000 : 400]),
      );
      const result = economy.resolve({
        level: "expert",
        land: { farmland: 400, forest: 80, mountains: 80, desert: 80 },
        population: 1_000_000,
        workers,
      });
      if (result.commodities[id]!.output <= 0) dead.push(id);
    }
    assert.deepEqual(dead, [], `no output: ${dead.join(", ")}`);
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
  const economy = new Economy();
  const lumberK = (level: "beginner" | "intermediate" | "expert", acres: number) =>
    rawCoefficient(economy.graph.table.get("lumber")!, level, acres);

  it("is linear in acreage with a positive intercept, and no floor", () => {
    const step = (a: number) => lumberK("intermediate", a + 10) - lumberK("intermediate", a);
    assert.ok(Math.abs(step(0) - step(40)) < 1e-9, "slope constant from zero acres up");
    assert.ok(lumberK("intermediate", 0) > 0, "the intercept is the design's 'modicum'");
  });

  it("penalises Expert relative to Intermediate at equal acreage", () => {
    assert.ok(lumberK("expert", 20) < lumberK("intermediate", 20));
  });

  it("gives each raw its own response, not a shared multiplier", () => {
    const table = economy.graph.table;
    const gain = (id: string) => {
      const c = table.get(id)!;
      const at0 = rawCoefficient(c, "intermediate", 0);
      return (rawCoefficient(c, "intermediate", 55) - at0) / at0;
    };
    // Both draw on mountains, but Coal gains far more per acre relative to its base.
    assert.ok(gain("coal") > gain("iron-ore") * 1.5);
  });

  it("leaves every raw a small positive intercept — the design's 'modicum'", () => {
    // An earlier revision reported advanced raws as having a zero intercept, but that
    // was an artifact of least squares driving `base` negative and the emitter clamping
    // it. Petroleum's zero-desert reading — 4 tons at 160 workers — proves otherwise.
    // Relative-error fitting keeps these small and positive, which matches the manual:
    // "you can still get these things ... but it will cost you a lot more workers."
    for (const id of ["lumber", "sulfur", "iron-ore", "coal", "light-metal", "nitrate", "heavy-metal", "petroleum"]) {
      const c = economy.graph.table.get(id)!;
      const bare = rawCoefficient(c, "expert", 0);
      assert.ok(bare > 0, `${id} should produce something with no terrain`);
      assert.ok(
        bare < rawCoefficient(c, "expert", 60),
        `${id} should still gain from terrain`,
      );
    }
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

  // The 29 population readings taken from the DOS build (§4.4.1). Every parameter in
  // POPULATION is fitted to these, so they are the oracle: population, surplus, expected
  // next population, farmland.
  const READINGS: [number, number, number, number][] = [
    [628, 481, 787, 421], [628, 214, 719, 421], [628, 103, 676, 421], [628, 51, 649, 421],
    [628, -53, 628, 421], [628, -122, 628, 421], [628, -172, 628, 421], [628, -207, 628, 421],
    [787, 476, 959, 421], [959, 304, 1092, 421], [1161, 240, 1273, 421],
    [1316, 172, 1400, 467], [1316, -104, 1244, 467], [1316, -200, 1174, 467],
    [1316, -304, 1089, 467],
    [647, 189, 730, 433], [647, 63, 675, 433], [647, -49, 647, 433], [647, -214, 647, 433],
    [647, 196, 732, 433], [732, 349, 868, 433], [868, 431, 1035, 433], [1035, 686, 1278, 433],
    [1278, 264, 1381, 433], [1278, 55, 1302, 433], [1278, -1, 1277, 433],
    [1278, -53, 1241, 433], [1278, -97, 1210, 433], [1278, -149, 1175, 433],
  ];

  it("reproduces all 29 population readings within 10%", () => {
    const errors = READINGS.map(([pop, surplus, expected, farmland]) => {
      const got = Math.round(nextPopulation(pop, surplus, farmland));
      const change = Math.abs(expected - pop);
      // A reading with no change at all is the famine floor; it has to be exact.
      if (change === 0) {
        assert.equal(got, expected,
          `pop ${pop} on ${surplus} should not move off the floor, got ${got}`);
        return 0;
      }
      return (Math.abs(got - expected) / change) * 100;
    });
    const sorted = [...errors].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    assert.ok(Math.max(...errors) < 10, `worst error ${Math.max(...errors).toFixed(1)}%`);
    assert.ok(median < 5, `median error ${median.toFixed(1)}%`);
  });

  it("is linear in surplus but saturating, not a square root", () => {
    // The manual asks for a diminishing return — "we can't have them doubling their
    // population merely by doubling their food surplus" — but the shipped game gets it
    // from the saturating denominator, not from a square root. Doubling the surplus
    // multiplies the gain by less than 2 and by more than the 1.41 a square root gives.
    const one = nextPopulation(628, 214, 421) - 628;
    const two = nextPopulation(628, 428, 421) - 628;
    assert.ok(two / one < 2, `doubling surplus gave ${(two / one).toFixed(3)}x`);
    assert.ok(two / one > 1.6, `a square root would give 1.41x, got ${(two / one).toFixed(3)}x`);

    // Linear in the small-surplus limit, where the saturation term is negligible.
    const tiny = nextPopulation(100_000, 1, 0) - 100_000;
    assert.ok(Math.abs(tiny - POPULATION.growth) < 1e-4, `got ${tiny}`);
  });

  it("stops famine at the farmland floor, and does not push a nation up to it", () => {
    const floor = POPULATION.floorPerAcre * 421;
    assert.ok(Math.abs(floor - 628.7) < 0.5, `floor for 421 acres is ${floor.toFixed(1)}`);

    // Six readings sat on this floor and lost nobody to deficits as deep as 207 tons.
    assert.equal(Math.round(nextPopulation(628, -207, 421)), 628);
    // Well above the floor, famine bites normally.
    assert.ok(nextPopulation(1316, -304, 467) < 1316 - 200);
    // The floor is a carrying capacity that the farmland guarantees, so a nation already
    // below it — stripped by conquest, say — has nothing left for famine to take. It is
    // not pushed back up to the floor either.
    assert.equal(nextPopulation(300, -100, 421), 300);
    // Losing the farmland is what lowers the floor, and then famine can bite again.
    assert.ok(nextPopulation(300, -100, 100) < 300);
  });

  it("moves the famine floor with territory, in both directions", () => {
    // The floor is farmland, not a remembered starting size, because a turn is a
    // generation and nothing carries over (§3.1.1). So conquest is worth more than it
    // looks: taking farmland lowers how far the victim can be starved.
    const starve = (pop: number, farmland: number) => {
      let p = pop;
      // Long enough for a steady deficit to drive any of these down to the floor.
      for (let turn = 0; turn < 60; turn++) p = nextPopulation(p, -400, farmland);
      return Math.round(p);
    };
    const floorFor = (farmland: number) => Math.round(POPULATION.floorPerAcre * farmland);

    assert.equal(starve(1316, 467), floorFor(467));
    assert.equal(starve(4000, 934), floorFor(934), "twice the land, twice the floor");
    assert.equal(starve(1316, 200), floorFor(200));
    assert.ok(starve(1316, 200) < starve(1316, 467), "less land must mean a lower floor");
  });

  it("never drives population below zero", () => {
    assert.equal(nextPopulation(5, -1_000_000, 0), 0);
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
