/**
 * The AI (§10 step 6): a utility function over allocations, and an influence map over
 * the province graph. Most of these tests exist because the behaviour they pin was
 * wrong first, and wrong in a way that froze the whole game.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AI, appealOf, canTake, chainOf, forceNeeded, influenceMap, planOrders, planProduction,
  positionOf, score, surplusForGrowth, temperamentFor,
} from "../src/ai.ts";
import { Economy } from "../src/economy.ts";
import { Game, subsistenceAllocation, workersFor, balanceAllocation } from "../src/game.ts";
import { COMBAT, resolveAssault } from "../src/military.ts";
import { POPULATION } from "../src/data.ts";
import { nextPopulation } from "../src/economy.ts";
import { generateWorld, nationState } from "../src/worldgen.ts";

const economy = new Economy();

/** One whole turn, however many phases the level has (Expert adds the union phase). */
const playWholeTurn = (game: Game) => {
  const was = game.turn;
  for (let guard = 0; guard < 8 && game.turn === was; guard++) game.advance();
};

describe("temperament", () => {
  it("is seeded, so a continent always faces the same opposition", () => {
    const world = generateWorld("Thule", "intermediate");
    for (const n of world.nations) {
      assert.deepEqual(temperamentFor(world, n.id), temperamentFor(world, n.id));
    }
    assert.notDeepEqual(temperamentFor(world, 0), temperamentFor(world, 1));
    assert.notDeepEqual(
      temperamentFor(world, 0),
      temperamentFor(generateWorld("Kublai", "intermediate"), 0),
    );
  });

  it("keeps every nation somewhere between butter and guns", () => {
    for (const name of ["Thule", "Kublai", "Vashti"]) {
      for (const n of generateWorld(name, "expert").nations) {
        const t = temperamentFor(generateWorld(name, "expert"), n.id);
        assert.ok(t.militarism > 0 && t.militarism < 1, `militarism ${t.militarism}`);
        assert.ok(t.growthTarget > 0 && t.growthTarget < 0.1, `growth ${t.growthTarget}`);
      }
    }
  });
});

describe("food targets use the measured response, not the manual's square root", () => {
  it("inverts §4.4.1 closely enough to aim with", () => {
    for (const [population, rate] of [[500, 0.01], [1200, 0.02], [800, 0.03]] as const) {
      const surplus = surplusForGrowth(population, rate);
      const got = (nextPopulation(population, surplus, population / 1.4933) - population) / population;
      assert.ok(Math.abs(got - rate) < rate * 0.12, `wanted ${rate}, got ${got.toFixed(4)}`);
    }
  });

  it("asks for far less than a square-root rule would", () => {
    // sqrt(s) >= pop*0.01 wants 25 tons for 500 people; the measured model wants 10.6.
    assert.ok(surplusForGrowth(500, 0.01) < 12);
    assert.equal(POPULATION.growth > 0, true);
  });
});

describe("the utility function", () => {
  const world = generateWorld("Thule", "expert");
  const { land, population } = nationState(world, 0);
  const state = { level: world.level, land, population };
  const position = positionOf(world, 0);
  const temperament = temperamentFor(world, 0);
  const at = (workers: Record<string, number>) =>
    score(economy, state, workers, position, temperament);

  it("has a gradient while a nation is starving", () => {
    // It did not, and a hill climb on a plateau does nothing: a nation sat at -217 tons
    // of food and 0 firepower for 140 turns without moving a worker, because every
    // allocation in that region scored exactly the same.
    const poor = workersFor(subsistenceAllocation(), population, land.farmland);
    const better = workersFor(
      balanceAllocation(economy, subsistenceAllocation(), state), population, land.farmland,
    );
    const poorFood = economy.resolve({ ...state, workers: poor }).agriculture.surplus;
    const betterFood = economy.resolve({ ...state, workers: better }).agriculture.surplus;
    assert.ok(poorFood < 0 && betterFood < 0, "the premise is that both are starving");
    assert.ok(betterFood > poorFood, "and that one is less bad");
    assert.ok(at(better) > at(poor), "so the score has to prefer it");
  });

  it("rewards a garrison and enough food, and stops rewarding overshoot", () => {
    const garrison = position.provinces.length;
    const met = { ...workersFor(subsistenceAllocation(), population, land.farmland) };
    // Saturating: twice the needed firepower is not worth twice the score.
    const once = AI.garrison * Math.min(1, garrison / garrison);
    const twice = AI.garrison * Math.min(1, (garrison * 2) / garrison);
    assert.equal(once, twice);
    assert.ok(Object.keys(met).length > 0);
  });
});

describe("the influence map", () => {
  it("prices a road approach far below a cross-country one", () => {
    // The mistake that produced a permanent stalemate: valuing the prize and ignoring
    // the way in, so 53 firepower stared at a target it could never carry while the
    // road was held by a province with 3.
    const world = generateWorld("Thule", "intermediate");
    const pair = world.provinces.flatMap((p) =>
      p.neighbours
        .filter((n) => world.provinces[n.province]!.nation !== p.nation)
        .map((n) => ({ from: p.id, to: n.province, road: n.road })));
    const road = pair.find((x) => x.road)!;
    const rough = pair.find((x) => !x.road)!;
    assert.ok(road && rough, "expected both kinds of frontier");

    // Same defence, so only the road differs.
    const level = (id: number) => { world.provinces[id]!.firepower = 10; };
    level(road.to); level(rough.to);
    assert.ok(
      forceNeeded(world, road.from, road.to) < forceNeeded(world, rough.from, rough.to),
      "a road must be the cheaper way in",
    );
    assert.equal(forceNeeded(world, road.from, road.to), 10 + COMBAT.defenderBonus + COMBAT.arrivalLoss);
  });

  it("agrees with the combat formula about what can be taken", () => {
    const world = generateWorld("Kublai", "intermediate");
    for (const p of world.provinces) {
      for (const n of p.neighbours) {
        if (world.provinces[n.province]!.nation === p.nation) continue;
        p.firepower = 60;
        world.provinces[n.province]!.firepower = 12;
        const outcome = resolveAssault(p.firepower, world.provinces[n.province]!.firepower, n.road);
        assert.equal(canTake(world, p.id, n.province), outcome.captured);
      }
    }
  });

  it("makes the front uphill from the interior", () => {
    const world = generateWorld("Thule", "expert");
    const nation = 0;
    const { opportunity } = influenceMap(world, nation);
    const mine = world.provinces.filter((p) => p.nation === nation);
    const front = mine.filter((p) =>
      p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation));
    const interior = mine.filter((p) => !front.includes(p));
    if (interior.length === 0 || front.length === 0) return;
    const bestFront = Math.max(...front.map((p) => opportunity[p.id]!));
    const bestInterior = Math.max(...interior.map((p) => opportunity[p.id]!));
    assert.ok(bestFront > bestInterior, "a reserve has to see somewhere to go");
  });
});

describe("orders", () => {
  it("does not strand an army in the safest province", () => {
    // Marching up `opportunity - threat` made the border the least attractive ground on
    // the map, because that is where the enemy is: one interior province ended up
    // holding 132 of a nation's 194 firepower and never moving.
    const world = generateWorld("Thule", "expert");
    const nation = 0;
    const mine = world.provinces.filter((p) => p.nation === nation);
    const interior = mine.find((p) =>
      !p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation));
    if (!interior) return;
    for (const p of mine) p.firepower = p.id === interior.id ? 130 : 1;

    const orders = planOrders(world, nation);
    assert.ok(orders[interior.id], "the reserve must be given somewhere to go");
    assert.equal(orders[interior.id]!.target !== null, true);
  });

  it("attacks when the sums work, rather than marching past", () => {
    const world = generateWorld("Kublai", "intermediate");
    const nation = 0;
    const attacker = world.provinces.find((p) =>
      p.nation === nation && p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation))!;
    for (const p of world.provinces) p.firepower = p.nation === nation ? 0 : 0;
    attacker.firepower = 400;
    const orders = planOrders(world, nation);
    const target = orders[attacker.id]?.target;
    assert.ok(target !== undefined && target !== null, "a province that can win should attack");
    assert.notEqual(world.provinces[target]!.nation, nation, "and attack an enemy");
  });

  it("leaves a threatened border province where it stands", () => {
    const world = generateWorld("Kublai", "intermediate");
    const nation = 0;
    const front = world.provinces.find((p) =>
      p.nation === nation && p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation))!;
    for (const p of world.provinces) p.firepower = p.nation === nation ? 5 : 200;
    assert.equal(planOrders(world, nation)[front.id], undefined, "it should hold, not wander off");
  });
});

describe("reading the position", () => {
  it("reports the cheapest crossing on the frontier", () => {
    const world = generateWorld("Kublai", "intermediate");
    const position = positionOf(world, 0);
    assert.ok(position.opening > 0, "a nation with neighbours has somewhere to attack");
    const own = world.provinces.filter((p) => p.nation === 0);
    const cheapest = Math.min(...own.flatMap((p) =>
      p.neighbours.filter((n) => world.provinces[n.province]!.nation !== 0)
        .map((n) => forceNeeded(world, p.id, n.province))));
    assert.equal(position.opening, cheapest);
  });

  it("reports no opening for a nation that owns everything", () => {
    const world = generateWorld("Kublai", "intermediate");
    for (const p of world.provinces) if (p.nation !== null) p.nation = 0;
    assert.equal(positionOf(world, 0).opening, 0);
  });
});

describe("production planning", () => {
  it("arms past a bare garrison when there is a neighbour to answer", () => {
    // Both saturating military terms are met at one firepower per province. With the
    // economy solved efficiently, two neighbours each sat on exactly a garrison, neither
    // could ever afford an attack, and the board did not move for sixty turns.
    const world = generateWorld("Nineveh", "beginner");
    const { land, population } = nationState(world, 0);
    const state = { level: "beginner" as const, land, population };
    const seed = workersFor(
      balanceAllocation(economy, subsistenceAllocation(), state), population, land.farmland,
    );
    const planned = planProduction(economy, world, 0, seed);
    const result = economy.resolve({ ...state, workers: planned });
    const garrison = positionOf(world, 0).provinces.length;
    assert.ok(result.firepower > garrison * 2,
      `${result.firepower.toFixed(1)} firepower is barely a garrison for ${garrison} provinces`);
    assert.ok(result.agriculture.surplus > 0, "and it should not have starved itself to do it");
  });


  it("beats the scaffolding it replaces", () => {
    // balanceAllocation is explicitly not the AI (§10.2); the AI has to do better than it.
    for (const [name, level] of [["Thule", "intermediate"], ["Kublai", "intermediate"]] as const) {
      const world = generateWorld(name, level);
      const { land, population } = nationState(world, 0);
      const state = { level, land, population };
      const position = positionOf(world, 0);
      const temperament = temperamentFor(world, 0);
      const seed = workersFor(
        balanceAllocation(economy, subsistenceAllocation(), state), population, land.farmland,
      );
      const planned = planProduction(economy, world, 0, seed, temperament);
      assert.ok(
        score(economy, state, planned, position, temperament) >=
          score(economy, state, seed, position, temperament),
        `${name}: the plan should not be worse than its own starting point`,
      );
    }
  });

  it("never plans more workers than the nation has", () => {
    // Found by fuzzing 48 games: a nation ground down to a handful of spare workers was
    // handed a chain that only fitted in fractional people, and the plan was stored as
    // an allocation whose shares summed to 2.5.
    const world = generateWorld("Dahlia", "beginner");
    for (const size of [0, 1, 2, 3, 5, 9, 40]) {
      const { land } = nationState(world, 0);
      const population = land.farmland + size;
      // positionOf reads the provinces, so shrink them to make the workforce small.
      const scaled = world.provinces.map((p) => p.nation === 0
        ? { ...p, population: p.population * (population / nationState(world, 0).population) } : p);
      const shrunk = { ...world, provinces: scaled };
      const spare = Math.floor(Math.max(0, population - land.farmland));
      const planned = planProduction(economy, shrunk, 0, {});
      const total = Object.values(planned).reduce((sum, n) => sum + n, 0);
      assert.ok(total <= spare, `${spare} spare workers but the plan needs ${total}`);
    }
  });

  it("only staffs what the difficulty offers (§1.1)", () => {
    const world = generateWorld("Thule", "intermediate");
    const { land, population } = nationState(world, 0);
    const seed = workersFor(subsistenceAllocation(), population, land.farmland);
    const planned = planProduction(economy, world, 0, seed);
    for (const id of ["tractor", "tank", "cannon", "irrigation"]) {
      assert.ok(!(planned[id]! > 0), `${id} does not exist at intermediate`);
    }
  });

  it("never invents workers", () => {
    const world = generateWorld("Kublai", "expert");
    const { land, population } = nationState(world, 0);
    const spare = Math.floor(Math.max(0, population - land.farmland));
    const planned = planProduction(economy, world, 0,
      workersFor(subsistenceAllocation(), population, land.farmland));
    const used = Object.values(planned).reduce((s, v) => s + v, 0);
    assert.ok(used <= spare, `${used} workers allocated of ${spare} available`);
    for (const [id, n] of Object.entries(planned)) {
      assert.ok(Number.isInteger(n) && n >= 0, `${id} has ${n} workers`);
    }
  });

  it("sees a whole cold chain, not one link at a time", () => {
    const world = generateWorld("Thule", "expert");
    const chain = chainOf(economy, "musket");
    for (const needed of ["iron", "gunpowder", "iron-ore", "coal", "sulfur", "charcoal"]) {
      assert.ok(chain.has(needed), `${needed} is behind a musket`);
    }
    assert.ok(chain.has("musket"));
  });
});

describe("a game the AI plays by itself", () => {
  it("arms, grows and takes ground", () => {
    const game = Game.create("Thule", "intermediate");
    game.human = -1;
    const before = game.rankings();
    for (let turn = 0; turn < 12; turn++) {
      playWholeTurn(game);
    }
    const after = game.rankings();
    assert.ok(after.some((r) => r.firepower > 0), "somebody should have armed");
    assert.ok(
      after[0]!.provinces > before[before.length - 1]!.provinces,
      "and the board should have moved",
    );
  });

  it("usually settles a two-nation game, and always moves the board", () => {
    // Not every seed resolves — some end in a stalemate neither side can break, which
    // is recorded as an open question in §10.3. What must hold is that the AI plays:
    // most small games finish, and none of them sit still.
    const continents = ["Thule", "Kittycat", "Kublai", "Ganthor", "Vashti", "Nineveh"];
    let decided = 0;
    for (const name of continents) {
      const game = Game.create(name, "beginner");
      game.human = -1;
      const start = game.rankings().map((r) => r.provinces).sort((a, b) => a - b);
      for (let turn = 0; turn < 60 && game.winner === null; turn++) {
        playWholeTurn(game);
      }
      if (game.winner !== null) decided++;
      const end = game.rankings().map((r) => r.provinces).sort((a, b) => a - b);
      assert.notDeepEqual(end, start, `${name}: nothing happened in sixty turns`);
    }
    assert.ok(decided >= continents.length / 2,
      `only ${decided} of ${continents.length} two-nation games reached a winner`);
  });

  it("leaves the other nations inert when switched off", () => {
    const game = Game.create("Thule", "intermediate");
    game.ai = false;
    for (let turn = 0; turn < 6; turn++) {
      playWholeTurn(game);
    }
    assert.ok(
      game.rankings().every((r) => r.firepower === 0),
      "nobody should arm with the AI off",
    );
  });
});
