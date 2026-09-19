/**
 * Exact chain staffing (§3.5). These pin the arithmetic the balancer and the AI both
 * now rest on, and one measured outcome: at expert, a two-nation union can feed itself.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  affordableTons, bestFoodChain, chainDemand, chainWorkers, staffChain, workersForTons,
} from "../src/planner.ts";
import { Economy } from "../src/economy.ts";
import { commoditiesFor } from "../src/data.ts";
import { balanceAllocation, subsistenceAllocation, workersFor } from "../src/game.ts";
import { generateWorld, nationState } from "../src/worldgen.ts";
import type { Land } from "../src/types.ts";

const economy = new Economy();
const context = (name: string, level: "beginner" | "intermediate" | "expert", nation = 0) => {
  const world = generateWorld(name, level);
  const { land, population } = nationState(world, nation);
  return { level, land, population };
};

describe("chain demand", () => {
  it("adds a shared input up across its consumers rather than overwriting it", () => {
    // Iron ore feeds both pig iron and iron. Ordering enough for one of them leaves the
    // plan short at exactly the moment both chains run.
    const demand = chainDemand(economy, "musket", 10);
    const direct = chainDemand(economy, "iron", 10).get("iron-ore") ?? 0;
    assert.ok((demand.get("iron-ore") ?? 0) > 0, "muskets need ore");
    assert.ok(demand.get("iron-ore")! >= direct * ((demand.get("iron") ?? 0) / 10) - 1e-9);
  });

  it("includes the good itself", () => {
    assert.equal(chainDemand(economy, "farm-tools", 25).get("farm-tools"), 25);
  });
});

describe("inverting the output curve", () => {
  it("returns the labour that produces exactly that tonnage", () => {
    const ctx = context("Thule", "intermediate");
    for (const id of ["lumber", "iron-ore", "farm-tools", "pig-iron"]) {
      for (const tons of [5, 40, 200]) {
        const workers = workersForTons(economy, ctx, id, tons);
        const made = economy.capacity({ ...ctx, workers: { [id]: workers } }, id);
        assert.ok(Math.abs(made - tons) < tons * 1e-6, `${id} at ${tons}t: got ${made}`);
      }
    }
  });

  it("reports an impossible commodity as unaffordable rather than free", () => {
    const ctx = context("Thule", "beginner");
    assert.equal(workersForTons(economy, ctx, "farm-tools", 0), 0);
    assert.ok(chainWorkers(economy, ctx, "tractor", 1000) > 0);
  });
});

describe("affordable tonnage", () => {
  it("is the most the workforce can staff, and no more", () => {
    const ctx = context("Kublai", "intermediate");
    const budget = 120;
    const tons = affordableTons(economy, ctx, "farm-tools", budget);
    assert.ok(tons > 0);
    assert.ok(chainWorkers(economy, ctx, "farm-tools", tons) <= budget + 1e-6);
    assert.ok(chainWorkers(economy, ctx, "farm-tools", tons * 1.02) > budget,
      "should not have left labour unspent");
  });

  it("rises with the workforce", () => {
    const ctx = context("Kublai", "intermediate");
    const small = affordableTons(economy, ctx, "sword", 40);
    const large = affordableTons(economy, ctx, "sword", 160);
    assert.ok(large > small, `${large} should beat ${small}`);
  });

  it("credits output that already exists", () => {
    const ctx = context("Kublai", "intermediate");
    const bare = affordableTons(economy, ctx, "farm-tools", 60);
    const helped = affordableTons(economy, ctx, "farm-tools", 60, new Map([["pig-iron", 40]]));
    assert.ok(helped > bare, "a stocked input should buy more, not the same");
  });
});

describe("staffing a chain", () => {
  it("delivers the tonnage it planned for, through the real economy", () => {
    const ctx = context("Nineveh", "intermediate");
    const spare = Math.floor(ctx.population - ctx.land.farmland);
    const tons = affordableTons(economy, ctx, "farm-tools", spare);
    const workers = staffChain(economy, ctx, "farm-tools", tons);
    const result = economy.resolve({ ...ctx, workers });
    // Rounding every stage up overshoots the budget slightly; what matters is that the
    // chain runs end to end rather than stalling on a starved input.
    assert.ok(result.commodities["farm-tools"]!.output >= tons * 0.98,
      `planned ${tons.toFixed(1)}t, made ${result.commodities["farm-tools"]!.output.toFixed(1)}t`);
  });

  it("rounds up, because flooring five stages starves the chain", () => {
    const ctx = context("Nineveh", "intermediate");
    const workers = staffChain(economy, ctx, "farm-tools", 50);
    for (const count of Object.values(workers)) assert.equal(count, Math.floor(count));
    assert.ok(Object.keys(workers).length > 1, "a chain is more than its last link");
  });
});

describe("choosing what to farm with", () => {
  it("picks the tool the ground favours, not a fixed one", () => {
    // Forest makes the farm-tools chain cheap through lumber and charcoal; mountains and
    // coal favour iron plows, whose tier-2 ton is worth two of food. Both were right on
    // two of the four measured continents, so this cannot be a constant.
    const picks = new Set<string>();
    for (const name of ["Thule", "Kublai", "Vashti", "Nineveh"]) {
      const ctx = context(name, "expert");
      const spare = Math.floor(ctx.population - ctx.land.farmland);
      const plan = bestFoodChain(economy, ctx, spare);
      assert.ok(plan, `${name}: no food plan at all`);
      picks.add(plan!.good);
    }
    assert.ok(picks.size > 1, `every continent chose ${[...picks]}`);
  });

  it("never plans past one ton of tools per acre (§4.2)", () => {
    const ctx = context("Vashti", "beginner");
    const plan = bestFoodChain(economy, ctx, 10_000);
    assert.ok(plan!.tons <= ctx.land.farmland + 1e-6);
  });
});

describe("the balancer, rebuilt on the planner", () => {
  it("opens a whole cold chain from a finished good on its own", () => {
    // The old nudge could not start here at all: nothing consumes a sword, so with only
    // swords staffed no factory had a surplus to move labour from and it gave up on the
    // first pass.
    const ctx = context("Kublai", "intermediate");
    const balanced = balanceAllocation(economy, { sword: 1 }, ctx);
    const result = economy.resolve({
      ...ctx,
      workers: workersFor(balanced, ctx.population, ctx.land.farmland),
    });
    assert.ok(result.commodities["sword"]!.output > 0, "swords should actually be made");
    for (const input of ["iron-ore", "pig-iron", "charcoal"]) {
      assert.ok((balanced[input] ?? 0) > 0, `${input} should have been opened`);
    }
  });

  it("staffs only what the difficulty offers, even with nothing to aim at (§1.1)", () => {
    // With no finished good staffed the balancer falls back to feeding people, and that
    // path went shopping in the whole table: a *beginner* economy large enough to afford
    // one was handed tractors, diesel engines, petroleum and high-grade steel.
    const land = { farmland: 4000, forest: 900, mountains: 900, desert: 300 };
    const ctx = { level: "beginner" as const, land, population: 12000 };
    const offered = new Set(commoditiesFor("beginner", economy.graph.table.keys()));
    const balanced = balanceAllocation(economy, { lumber: 1 }, ctx);
    for (const [id, share] of Object.entries(balanced)) {
      if (share > 0) assert.ok(offered.has(id), `${id} is not offered at beginner`);
    }
  });

  it("feeds a finished good that is locked", () => {
    // A lock says "keep these workers here", not "stop supplying this". Locking the one
    // factory you cared about excluded it from the goals, so the balancer built a food
    // chain instead and the locked factory produced nothing at all.
    const ctx = context("Kublai", "intermediate");
    const balanced = balanceAllocation(economy, { sword: 0.4 }, ctx, ["sword"]);
    const result = economy.resolve({
      ...ctx,
      workers: workersFor(balanced, ctx.population, ctx.land.farmland),
    });
    assert.ok(result.commodities["sword"]!.output > 0,
      "a locked sword factory should still be supplied");
  });

  it("keeps the workforce whole however odd the request", () => {
    const ctx = context("Kublai", "intermediate");
    const cases: [Record<string, number>, string[]][] = [
      [{ sword: 0.8, "farm-tools": 0.8 }, ["sword"]],   // over-committed and pinned
      [{ "farm-tools": 0.5, musket: 0.5 }, []],         // one goal nobody can afford
      [{ "farm-tools": -0.5, lumber: 0.5 }, []],        // a negative share
      [{}, []],
    ];
    for (const [base, locked] of cases) {
      const balanced = balanceAllocation(economy, base, ctx, locked);
      const sum = Object.values(balanced).reduce((s, v) => s + Math.max(0, v), 0);
      assert.ok(sum <= 1 + 1e-6, `shares sum to ${sum} for ${JSON.stringify(base)}`);
      for (const [id, share] of Object.entries(balanced)) {
        assert.ok(Number.isFinite(share) && share >= 0, `${id} is ${share}`);
      }
    }
  });

  it("lets a two-nation union feed itself at expert", () => {
    // The question this whole module came out of. A single expert nation sits at its
    // famine floor — the floor is its starting population — and cannot grow by farming.
    // Pooling two of them can, on ground that suits it.
    const zero: Land = { farmland: 0, forest: 0, mountains: 0, desert: 0 };
    const grew: string[] = [];
    for (const name of ["Thule", "Kublai", "Vashti", "Nineveh"]) {
      const world = generateWorld(name, "expert");
      const members = world.nations
        .map((n) => nationState(world, n.id))
        .sort((a, b) => a.population - b.population)
        .slice(0, 2);
      const land = members.reduce<Land>((a, m) => ({
        farmland: a.farmland + m.land.farmland, forest: a.forest + m.land.forest,
        mountains: a.mountains + m.land.mountains, desert: a.desert + m.land.desert,
      }), zero);
      const population = Math.round(members.reduce((s, m) => s + m.population, 0));
      const ctx = { level: "expert" as const, land, population };
      const balanced = balanceAllocation(economy, subsistenceAllocation(), ctx);
      const result = economy.resolve({ ...ctx, workers: workersFor(balanced, population, land.farmland) });
      if (result.agriculture.surplus > 0) grew.push(name);
    }
    assert.ok(grew.length >= 2, `only ${grew.length} of 4 two-unions could grow: ${grew}`);
  });
});
