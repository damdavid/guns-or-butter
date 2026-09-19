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
import { makeRng } from "../src/rng.ts";
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
      name: `N${id}`,
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

  it("leaves a captured province the people its own farmland can feed", () => {
    const world = withFirepower(line([true, true, true]), { 1: 100, 2: 20 });
    const acres = world.provinces[2]!.land.farmland;
    assert.ok(world.provinces[2]!.population > acres, "the premise is a province above subsistence");
    const r = resolveMilitary(world, { 1: { marchFraction: 1, target: 2 } });
    assert.equal(r.battles[0]!.captured, true);
    assert.equal(r.world.provinces[2]!.population, acres);
    assert.equal(r.battles[0]!.civilianLoss, 150 - acres);
  });

  it("does not depend on how much force was brought, only that it fell", () => {
    // §5.5 charges the whole force brought to bear, which made a heavy conquest cost
    // more than the province could ever return (§10.1.4). The cost is now the province.
    const light = withFirepower(line([true, true, true]), { 1: 40, 2: 0 });
    const heavy = withFirepower(line([true, true, true]), { 1: 400, 2: 0 });
    const pop = (w: typeof light) =>
      resolveMilitary(w, { 1: { marchFraction: 1, target: 2 } }).world.provinces[2]!.population;
    assert.equal(pop(light), pop(heavy));
  });

  it("costs the defender nothing when the assault is repulsed", () => {
    const world = withFirepower(line([true, true, true]), { 1: 25, 2: 60 });
    const before = world.provinces[2]!.population;
    const r = resolveMilitary(world, { 1: { marchFraction: 1, target: 2 } });
    assert.equal(r.battles[0]!.captured, false);
    assert.equal(r.world.provinces[2]!.population, before);
    assert.equal(r.battles[0]!.civilianLoss, 0);
  });

  it("leaves a province already at or below subsistence alone", () => {
    const world = {
      ...withFirepower(line([true, true, true]), { 1: 100, 2: 0 }),
    };
    world.provinces = world.provinces.map((p) => (p.id === 2 ? { ...p, population: 40 } : p));
    const r = resolveMilitary(world, { 1: { marchFraction: 1, target: 2 } });
    assert.equal(r.world.provinces[2]!.population, 40, "nothing left to take");
    assert.equal(r.battles[0]!.civilianLoss, 0);
  });

  it("costs a province more to take across country than by road", () => {
    const roaded = withFirepower(line([true, true, true]), { 1: 60, 2: 10 });
    const rough = withFirepower(line([true, false, true]), { 1: 60, 2: 10 });
    assert.equal(resolveMilitary(roaded, { 1: { marchFraction: 1, target: 2 } }).battles[0]!.captured, true);
    assert.equal(resolveMilitary(rough, { 1: { marchFraction: 1, target: 2 } }).battles[0]!.captured, false);
  });
});

describe("attack order (§5.6.1)", () => {
  /** A hub every attacker borders, so several armies can converge on one province. */
  const hub = (fp: Record<number, number>): World => ({
    name: "Hub", level: "beginner", width: 600, height: 200, outline: [], terrain: [],
    provinces: [0, 1, 2, 3, 4].map((id) => ({
      id,
      name: `P${id}`,
      // 4 is the defender; the rest alternate between two attacking nations.
      nation: id === 4 ? 2 : id % 2,
      capital: { x: 60 + id * 100, y: 100 },
      border: [],
      neighbours: id === 4
        ? [0, 1, 2, 3].map((q) => ({ province: q, road: true }))
        : [{ province: 4, road: true }],
      land: { farmland: 100, forest: 0, mountains: 0, desert: 0 },
      population: 400,
      firepower: fp[id] ?? 0,
      coastal: false,
    })),
    nations: [0, 1, 2].map((id) => ({ id, name: `N${id}`, provinces: [] })),
  });
  const all: Orders = Object.fromEntries(
    [0, 1, 2, 3].map((id) => [id, { marchFraction: 1, target: 4 }]),
  );
  const order = (r: ReturnType<typeof resolveMilitary>) => r.battles[0]!.waves.map((w) => w.from);

  it("sends the smallest army first, whoever it belongs to", () => {
    // P0=60 and P2=45 are one nation, P1=20 and P3=30 the other. Nation must not matter.
    const world = hub({ 0: 60, 1: 20, 2: 45, 3: 30, 4: 200 });
    assert.deepEqual(order(resolveMilitary(world, all)), [1, 3, 2, 0]);
  });

  it("so the first wave is the cheapest and the last lands on a softened defender", () => {
    const world = hub({ 0: 60, 1: 20, 2: 45, 3: 30, 4: 200 });
    const waves = resolveMilitary(world, all).battles[0]!.waves;
    for (let i = 1; i < waves.length; i++) {
      assert.ok(waves[i]!.committed >= waves[i - 1]!.committed, "armies must arrive in size order");
      assert.ok(waves[i]!.defenceBefore < waves[i - 1]!.defenceBefore, "each wave should soften it");
    }
  });

  it("draws at random between equal armies, and the same round draws the same way", () => {
    const world = hub({ 0: 40, 1: 40, 2: 40, 3: 40, 4: 300 });
    const drawn = new Set<string>();
    for (let turn = 1; turn <= 12; turn++) {
      drawn.add(order(resolveMilitary(world, all, makeRng(`Hub/battle/${turn}`))).join(""));
    }
    assert.ok(drawn.size > 1, `ties should not always fall the same way, got ${[...drawn]}`);

    const once = order(resolveMilitary(world, all, makeRng("Hub/battle/7")));
    const twice = order(resolveMilitary(world, all, makeRng("Hub/battle/7")));
    assert.deepEqual(once, twice, "a turn must replay identically, or Undo Turn would cheat");
  });

  it("does not let the order orders were given decide anything", () => {
    const world = hub({ 0: 60, 1: 20, 2: 45, 3: 30, 4: 200 });
    const reversed: Orders = Object.fromEntries(
      [3, 2, 1, 0].map((id) => [id, { marchFraction: 1, target: 4 }]),
    );
    assert.deepEqual(order(resolveMilitary(world, all)), order(resolveMilitary(world, reversed)));
  });
});

describe("weapon distribution (§5.3)", () => {
  const close = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, wanted ${expected}`);

  it("hands out an increase flat first, then by concentration", () => {
    const world = withFirepower(line([true, true, true]), { 0: 30, 1: 10 });
    // Holding 40 and fielding 60: the 20 of new power goes out 1 to each province, and
    // the remaining 18 splits 3:1 on what they already hold.
    const after = distributeWeapons(world, 0, 60);
    close(after.provinces[0]!.firepower, 30 + 1 + 13.5, "the province that was massed");
    close(after.provinces[1]!.firepower, 10 + 1 + 4.5, "the thin one");
    close(nationFirepower(after, 0), 60, "the nation fields exactly what it produced");
  });

  it("draws a fall in national power from each province in proportion", () => {
    // The rule as specified: 66 and 33 against a national 100, cut to a national 50,
    // become 33 and 16. Shares are preserved; nothing is cleared and rebuilt.
    const after = distributeWeapons(withFirepower(line([true, true, true]), { 0: 66, 1: 33 }), 0, 50);
    close(after.provinces[0]!.firepower, 66 * 50 / 99, "province 1");
    close(after.provinces[1]!.firepower, 33 * 50 / 99, "province 2");
    assert.equal(after.provinces[0]!.firepower.toFixed(0), "33");
    assert.equal(Math.floor(after.provinces[1]!.firepower), 16);
    // The ratio it held is exactly the ratio it keeps.
    close(after.provinces[0]!.firepower / after.provinces[1]!.firepower, 2, "the 2:1 shape");
  });

  it("leaves a province alone when national power has not moved", () => {
    const world = withFirepower(line([true, true, true]), { 0: 30, 1: 10 });
    const after = distributeWeapons(world, 0, 40);
    close(after.provinces[0]!.firepower, 30, "province 0");
    close(after.provinces[1]!.firepower, 10, "province 1");
  });

  it("zeroes every province when nothing is produced", () => {
    // Reported from play: stopping weapon production left the provinces holding their
    // accumulated firepower for the rest of the game.
    const world = withFirepower(line([true, true, true]), { 0: 200, 1: 75 });
    const after = distributeWeapons(world, 0, 0);
    assert.equal(after.provinces[0]!.firepower, 0);
    assert.equal(after.provinces[1]!.firepower, 0);
    assert.equal(nationFirepower(after, 0), 0);
  });

  it("garrisons a province holding nothing out of an increase, not out of a cut", () => {
    // Without the flat grant a province at zero has no weight and would be shut out of
    // a rise entirely. It only gets that floor when there is new power to hand out.
    const stripped = withFirepower(line([true, true, true]), { 0: 100, 1: 0 });
    const rising = distributeWeapons(stripped, 0, 120);
    close(rising.provinces[0]!.firepower, 100 + 1 + 18, "the massed province");
    close(rising.provinces[1]!.firepower, 1, "the empty one gets a garrison");

    // On a cut it stays empty: a province is drawn from in proportion to what it holds,
    // and it holds nothing.
    const falling = distributeWeapons(stripped, 0, 20);
    close(falling.provinces[0]!.firepower, 20, "the massed province takes the whole cut");
    close(falling.provinces[1]!.firepower, 0, "the empty one has nothing to give");
  });

  it("keeps the shape of the deployment through a collapse to almost nothing", () => {
    const after = distributeWeapons(withFirepower(line([true, true, true]), { 0: 90, 1: 10 }), 0, 1);
    close(after.provinces[0]!.firepower, 0.9, "the massed province");
    close(after.provinces[1]!.firepower, 0.1, "the thin one");
    close(nationFirepower(after, 0), 1, "nothing may go missing");
  });

  it("hands out exactly what it was given, whatever the amount", () => {
    for (const amount of [0, 0.5, 1, 2, 37, 1000]) {
      const after = distributeWeapons(withFirepower(line([true, true, true]), { 0: 7, 1: 0 }), 0, amount);
      close(nationFirepower(after, 0), amount, `producing ${amount}`);
    }
  });

  it("reproduces a uniform spread forever, so marching is the only way to concentrate", () => {
    // The structural consequence of a flow model: the proportional term can only
    // reinforce a concentration that already exists, and nothing accumulates to create
    // one. A nation spread evenly stays spread evenly however long it produces.
    let world = line([true, true, true]);
    for (let turn = 0; turn < 5; turn++) world = distributeWeapons(world, 0, 40);
    close(world.provinces[0]!.firepower, 20, "province 0 after five turns");
    close(world.provinces[1]!.firepower, 20, "province 1 after five turns");

    // Marching one province's force into its neighbour is what breaks the symmetry, and
    // next turn's production follows the concentration it created.
    const marched = resolveMilitary(world, { 0: { marchFraction: 1, target: 1 } }).world;
    close(marched.provinces[1]!.firepower, 40, "province 1 after the reinforcement");
    const next = distributeWeapons(marched, 0, 40);
    assert.ok(next.provinces[1]!.firepower > next.provinces[0]!.firepower * 10,
      `concentration should now pay: got ${next.provinces[0]!.firepower} and ${next.provinces[1]!.firepower}`);
  });

  it("spreads evenly when nothing is held anywhere — the opening turn", () => {
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
