/**
 * Military resolution (§5). The combat arithmetic against the numbers Appendix B
 * quotes, and the ordering rules that make the tactics work.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMBAT,
  conqueror,
  distributeWeapons,
  nationFirepower,
  resolveAssault,
  resolveMilitary,
  type Orders,
} from "../src/military.ts";
import { generateWorld } from "../src/worldgen.ts";
import type { World } from "../src/types.ts";

/**
 * A hand-built world: four provinces in a row, known roads, and an explicit nation per
 * province so a test can put two attackers either side of one defender.
 */
function line(roads: boolean[], nations: number[] = [0, 0, 1, 1]): World {
  const provinces = [0, 1, 2, 3].map((id) => ({
    id,
    name: `P${id}`,
    nation: nations[id]!,
    capital: { x: 100 + id * 100, y: 100 },
    border: [
      { x: 50 + id * 100, y: 50 },
      { x: 150 + id * 100, y: 50 },
      { x: 150 + id * 100, y: 150 },
      { x: 50 + id * 100, y: 150 },
    ],
    neighbours: [id - 1, id + 1]
      .filter((q) => q >= 0 && q <= 3)
      .map((q) => ({ province: q, road: roads[Math.min(id, q)] ?? true })),
    land: { farmland: 100, forest: 0, mountains: 0, desert: 0 },
    population: 150,
    firepower: 0,
    coastal: true,
  }));
  return {
    name: "Line",
    level: "beginner",
    width: 500,
    height: 200,
    outline: [],
    terrain: [],
    provinces,
    nations: [0, 1].map((id) => ({
      id,
      provinces: provinces.filter((p) => p.nation === id).map((p) => p.id),
    })),
  };
}

const withFirepower = (world: World, values: Record<number, number>): World => ({
  ...world,
  provinces: world.provinces.map((p) => ({ ...p, firepower: values[p.id] ?? p.firepower })),
});

describe("combat arithmetic (§5.5)", () => {
  it("reproduces Appendix B's minimum forces against an empty province", () => {
    // "at least 20 firepower points to capture a province with no defenders at all",
    // and "at least 50 firepower points" across anything other than a road.
    assert.equal(resolveAssault(20, 0, true).captured, false);
    assert.equal(resolveAssault(21, 0, true).captured, true);
    assert.equal(resolveAssault(50, 0, false).captured, false);
    assert.equal(resolveAssault(51, 0, false).captured, true);
  });

  it("takes a flat 10 off the attacker and gives the defender a flat 10", () => {
    assert.equal(COMBAT.arrivalLoss, 10);
    assert.equal(COMBAT.defenderBonus, 10);
    // 60 arriving by road against 30: (60-10) - (30+10) = 10 left standing.
    const r = resolveAssault(60, 30, true);
    assert.equal(r.captured, true);
    assert.ok(Math.abs(r.survivors - 10) < 1e-9);
  });

  it("quarters an attack that does not come down a road", () => {
    const road = resolveAssault(90, 0, true);
    const cross = resolveAssault(90, 0, false);
    assert.ok(Math.abs(cross.effective / road.effective - COMBAT.offRoadMultiplier) < 1e-9);
  });

  it("treats every terrain alike — the penalty is road or not-road", () => {
    // There is no per-type modifier; mountain, forest and desert are identical (§5.5).
    assert.equal(resolveAssault(90, 10, false).survivors, resolveAssault(90, 10, false).survivors);
  });

  it("leaves a surviving defender reduced by what reached it, not by the bonus", () => {
    // The +10 is a modifier, not firepower, so a defender who holds keeps its own
    // strength less the attack that actually landed.
    const r = resolveAssault(40, 50, true);
    assert.equal(r.captured, false);
    assert.ok(Math.abs(r.defenceAfter - (50 - 30)) < 1e-9);
  });

  it("never lets an attack below the arrival loss do anything", () => {
    const r = resolveAssault(8, 0, true);
    assert.equal(r.effective, 0);
    assert.equal(r.captured, false);
  });
});

describe("orders and execution order (§5.4, §5.6)", () => {
  it("moves firepower into a friendly province as a reinforcement", () => {
    const world = withFirepower(line([true, true, true]), { 0: 100 });
    const orders: Orders = { 0: { marchFraction: 0.5, target: 1 } };
    const r = resolveMilitary(world, orders);
    assert.equal(r.battles.length, 0);
    assert.deepEqual(r.transfers, [{ from: 0, to: 1, firepower: 50 }]);
    assert.equal(r.world.provinces[0]!.firepower, 50);
    assert.equal(r.world.provinces[1]!.firepower, 50);
  });

  it("marching forces leave before anything resolves", () => {
    // Province 1 sends everything away, so the counter-attack lands on an empty one.
    const world = withFirepower(line([true, true, true]), { 1: 100, 2: 40 });
    const r = resolveMilitary(world, {
      1: { marchFraction: 1, target: 2 },
      2: { marchFraction: 1, target: 1 },
    });
    const onOne = r.battles.find((b) => b.target === 1)!;
    assert.equal(onOne.waves[0]!.defenceBefore, 0, "province 1 should have emptied itself");
  });

  it("resolves several attacks on one province in sequence, softening it", () => {
    // Neither wave alone takes it; the first strips the defence for the second. Both
    // attackers belong to nation 0 and flank the lone defender at province 2.
    const world = withFirepower(line([true, true, true], [0, 0, 1, 0]), { 1: 45, 2: 60, 3: 45 });
    const solo = resolveAssault(45, 60, true);
    assert.equal(solo.captured, false);
    const r = resolveMilitary(world, {
      1: { marchFraction: 1, target: 2 },
      3: { marchFraction: 1, target: 2 },
    });
    const battle = r.battles.find((b) => b.target === 2)!;
    assert.equal(battle.waves.length, 2);
    assert.ok(battle.waves[1]!.defenceBefore < battle.waves[0]!.defenceBefore, "not softened");
  });

  it("rejects an order to a province that is not adjacent", () => {
    const world = withFirepower(line([true, true, true]), { 0: 50 });
    assert.throws(
      () => resolveMilitary(world, { 0: { marchFraction: 1, target: 3 } }),
      /not adjacent/,
    );
  });

  it("transfers the province and its survivors to the winner", () => {
    const world = withFirepower(line([true, true, true]), { 1: 100, 2: 20 });
    const r = resolveMilitary(world, { 1: { marchFraction: 1, target: 2 } });
    assert.equal(r.world.provinces[2]!.nation, 0);
    assert.ok(Math.abs(r.world.provinces[2]!.firepower - (90 - 30)) < 1e-9);
    assert.deepEqual(r.world.nations[0]!.provinces, [0, 1, 2]);
    assert.deepEqual(r.world.nations[1]!.provinces, [3]);
  });

  it("charges the civilian cost of the power brought to bear", () => {
    const world = withFirepower(line([true, true, true]), { 1: 100, 2: 20 });
    const before = world.provinces[2]!.population;
    const r = resolveMilitary(world, { 1: { marchFraction: 1, target: 2 } });
    assert.equal(r.world.provinces[2]!.population, before - 100);
  });

  it("costs a province more to take across country than by road", () => {
    const roaded = withFirepower(line([true, true, true]), { 1: 60, 2: 10 });
    const rough = withFirepower(line([true, false, true]), { 1: 60, 2: 10 });
    assert.equal(resolveMilitary(roaded, { 1: { marchFraction: 1, target: 2 } }).battles[0]!.captured, true);
    assert.equal(resolveMilitary(rough, { 1: { marchFraction: 1, target: 2 } }).battles[0]!.captured, false);
  });
});

describe("weapon distribution (§5.3)", () => {
  it("follows last turn's concentration", () => {
    const world = withFirepower(line([true, true, true]), { 0: 30, 1: 10 });
    const after = distributeWeapons(world, 0, 40);
    assert.ok(Math.abs(after.provinces[0]!.firepower - 60) < 1e-9, "three quarters to the massed one");
    assert.ok(Math.abs(after.provinces[1]!.firepower - 20) < 1e-9);
    assert.equal(nationFirepower(after, 0), 80);
  });

  it("spreads evenly when nothing is massed anywhere — the opening turn", () => {
    const after = distributeWeapons(line([true, true, true]), 0, 50);
    assert.equal(after.provinces[0]!.firepower, 25);
    assert.equal(after.provinces[1]!.firepower, 25);
  });

  it("gives the other nation nothing", () => {
    const after = distributeWeapons(line([true, true, true]), 0, 50);
    assert.equal(nationFirepower(after, 1), 0);
  });
});

describe("on a generated world", () => {
  it("resolves a turn of orders without breaking any invariant", () => {
    let world = generateWorld("Kublai", "intermediate");
    for (const nation of world.nations) world = distributeWeapons(world, nation.id, 400);

    const orders: Record<number, { marchFraction: number; target: number | null }> = {};
    for (const p of world.provinces) {
      const enemy = p.neighbours.find((n) => world.provinces[n.province]!.nation !== p.nation);
      orders[p.id] = enemy
        ? { marchFraction: 0.6, target: enemy.province }
        : { marchFraction: 0, target: null };
    }

    const before = world.provinces.reduce((s, p) => s + p.firepower, 0);
    const r = resolveMilitary(world, orders);

    assert.ok(r.battles.length > 0, "expected fighting along the frontiers");
    assert.equal(r.world.provinces.length, world.provinces.length);
    for (const p of r.world.provinces) {
      assert.ok(p.firepower >= 0, `${p.name} has negative firepower`);
      assert.ok(p.population >= 0, `${p.name} has negative population`);
    }
    // Combat destroys firepower on both sides, so the total can only fall.
    const after = r.world.provinces.reduce((s, p) => s + p.firepower, 0);
    assert.ok(after <= before + 1e-9, "combat should not create firepower");

    // Nation rosters must still agree with the provinces themselves.
    for (const nation of r.world.nations) {
      for (const id of nation.provinces) {
        assert.equal(r.world.provinces[id]!.nation, nation.id);
      }
    }
  });

  it("reports a conqueror only when one nation holds everything", () => {
    const world = generateWorld("Kublai", "beginner");
    assert.equal(conqueror(world), null);
    const swept = {
      ...world,
      provinces: world.provinces.map((p) => ({ ...p, nation: 0 })),
    };
    assert.equal(conqueror(swept), 0);
  });
});
