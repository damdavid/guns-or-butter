/**
 * The turn loop (§1.2), and the couplings between subsystems that only exist here.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  Game, balanceAllocation, reallocate, subsistenceAllocation, workersFor,
  type Allocation,
} from "../src/game.ts";
import { Economy } from "../src/economy.ts";
import { nationState } from "../src/worldgen.ts";

const playTurn = (game: Game) => {
  game.advance(); // production resolves
  const report = game.advance(); // orders resolve, and execution begins with the report
  game.advance(); // execution -> rankings
  return report!;
};

describe("phase sequence (§1.2)", () => {
  it("runs production, orders, execution, rankings, and back", () => {
    const game = Game.create("Kittycat", "beginner");
    assert.equal(game.phase, "production");
    game.advance();
    assert.equal(game.phase, "military-orders");

    // Combat resolves on the way into execution, so the report is in hand for the whole
    // of the phase the player watches it in (§1.2.1).
    const report = game.advance();
    assert.equal(game.phase, "military-execution");
    assert.ok(report, "entering execution should produce a turn report");
    assert.equal(report.turn, 1);

    assert.equal(game.advance(), null, "leaving execution resolves nothing further");
    assert.equal(game.phase, "rankings");
    game.advance();
    assert.equal(game.phase, "production");
    assert.equal(game.turn, 2);
  });

  it("refuses input that belongs to another phase", () => {
    const game = Game.create("Kittycat", "beginner");
    assert.throws(() => game.setOrder(0, { marchFraction: 1, target: 1 }), /military-orders/);
    game.advance();
    assert.throws(() => game.setAllocation(0, { lumber: 1 }), /production/);
  });

  it("rejects an order once the turn has moved past the orders phase", () => {
    const game = Game.create("Kittycat", "beginner");
    game.advance();
    game.setOrder(0, { marchFraction: 0.5, target: game.world.provinces[0]!.neighbours[0]!.province });
    game.advance();
    assert.throws(() => game.setOrder(0, { marchFraction: 1, target: null }), /military-orders/);
  });
});

describe("undo (§1.2)", () => {
  it("restores the turn exactly, and only from the rankings phase", () => {
    const game = Game.create("Kittycat", "beginner");
    const before = JSON.stringify(game.world);
    assert.throws(() => game.undoTurn(), /rankings/);
    playTurn(game);
    assert.notEqual(JSON.stringify(game.world), before, "the turn should have changed something");
    game.undoTurn();
    assert.equal(JSON.stringify(game.world), before);
    assert.equal(game.turn, 1);
    assert.equal(game.phase, "production");
  });

  it("only reaches back to the start of the current turn", () => {
    const game = Game.create("Kittycat", "beginner");
    playTurn(game);
    game.advance(); // into turn 2
    const startOfTwo = JSON.stringify(game.world);
    playTurn(game);
    game.undoTurn();
    assert.equal(JSON.stringify(game.world), startOfTwo);
    assert.equal(game.turn, 2);
  });
});

describe("couplings between the subsystems", () => {
  it("turns food surplus into population, province by province", () => {
    const game = Game.create("Kublai", "intermediate");
    const before = nationState(game.world, 0).population;
    game.advance();
    const after = nationState(game.world, 0).population;
    assert.notEqual(after, before, "population should have moved");
    // Every province should have shifted the same way; growth is not concentrated.
    assert.ok(game.world.provinces.every((p) => p.population >= 0));
  });

  it("turns weapon output into firepower on the map", () => {
    const game = Game.create("Kublai", "intermediate");
    game.setAllocation(0, { lumber: 0.3, "iron-ore": 0.25, charcoal: 0.1, "pig-iron": 0.2, sword: 0.15 });
    assert.equal(game.world.provinces.filter((p) => p.nation === 0)[0]!.firepower, 0);
    game.advance();
    const firepower = game.world.provinces
      .filter((p) => p.nation === 0)
      .reduce((s, p) => s + p.firepower, 0);
    assert.ok(firepower > 0, "sword production should have armed the nation");
  });

  it("carries conquest through to the next turn's production", () => {
    // Taking a province adds its land, which changes what the economy can make.
    const game = Game.create("Kublai", "intermediate");
    for (let i = 0; i < 3; i++) {
      playTurn(game);
      game.advance();
    }
    game.setAllocation(0, { lumber: 0.25, "iron-ore": 0.2, charcoal: 0.1, "pig-iron": 0.2, sword: 0.25 });
    game.advance();

    const landBefore = nationState(game.world, 0).land.farmland;
    const attacker = game.world.provinces.find(
      (p) => p.nation === 0 && p.neighbours.some((n) => game.world.provinces[n.province]!.nation !== 0),
    );
    if (!attacker) return; // no frontier on this seed
    const target = attacker.neighbours.find(
      (n) => game.world.provinces[n.province]!.nation !== 0,
    )!.province;
    game.setOrder(attacker.id, { marchFraction: 1, target });
    game.advance();
    game.advance();

    if (game.world.provinces[target]!.nation === 0) {
      const landAfter = nationState(game.world, 0).land.farmland;
      assert.ok(landAfter > landBefore, "the captured province's farmland should count");
    }
  });

  it("applies scorched earth to the province taken", () => {
    const game = Game.create("Kublai", "intermediate");
    game.advance();
    const attacker = game.world.provinces.find(
      (p) => p.nation === 0 && p.neighbours.some((n) => game.world.provinces[n.province]!.nation !== 0),
    )!;
    const target = attacker.neighbours.find(
      (n) => game.world.provinces[n.province]!.nation !== 0,
    )!.province;
    // Arm the attacker so the assault actually lands.
    game.world = {
      ...game.world,
      provinces: game.world.provinces.map((p) =>
        p.id === attacker.id ? { ...p, firepower: 400 } : p,
      ),
    };
    const populationBefore = game.world.provinces[target]!.population;
    game.setOrder(attacker.id, { marchFraction: 1, target });
    const report = game.advance()!; // orders resolve on the way into execution
    assert.ok(report.battles.length > 0);
    assert.ok(
      game.world.provinces[target]!.population < populationBefore,
      "conquest should cost the province its people",
    );
  });
});

describe("rankings and victory (§1.3)", () => {
  it("ranks by population, not territory or firepower", () => {
    const game = Game.create("Kublai", "intermediate");
    const rankings = game.rankings();
    for (let i = 1; i < rankings.length; i++) {
      assert.ok(rankings[i - 1]!.population >= rankings[i]!.population);
    }
  });

  it("declares a winner only when one nation holds everything", () => {
    const game = Game.create("Kittycat", "beginner");
    assert.equal(game.winner, null);
    game.world = {
      ...game.world,
      provinces: game.world.provinces.map((p) => ({ ...p, nation: 1 })),
    };
    assert.equal(game.winner, 1);
  });
});

describe("saving (§1.2)", () => {
  it("keys the save on continent and level, as the original did", () => {
    assert.equal(Game.create("Kittycat", "beginner").saveKey, "KITTYCAT-beginner");
    assert.equal(Game.create("kittycat ", "expert").saveKey, "KITTYCAT-expert");
  });

  it("round-trips through a snapshot", () => {
    const game = Game.create("Kublai", "intermediate");
    playTurn(game);
    game.advance();
    const restored = Game.restore(game.snapshot());
    assert.equal(restored.turn, game.turn);
    assert.deepEqual(restored.world, game.world);
  });
});

describe("labour allocation", () => {
  it("spends only the workforce left after farming", () => {
    const workers = workersFor({ lumber: 0.5, "iron-ore": 0.5 }, 500, 300);
    assert.equal(workers["lumber"]! + workers["iron-ore"]!, 200);
  });

  it("gives out nothing when farmland already consumes the population", () => {
    assert.deepEqual(workersFor({ lumber: 1 }, 100, 300), {});
  });

  it("rescues an allocation that the priority rule would starve", () => {
    // The unbalanced opening leaves farm tools at zero: charcoal is shallower in the
    // graph so it takes every ton of lumber (§3.5). Balancing should fix it.
    const economy = new Economy();
    const game = Game.create("Kublai", "intermediate");
    const { land, population } = nationState(game.world, 0);
    const context = { level: "intermediate" as const, land, population };

    const naive = economy.resolve({
      ...context,
      workers: workersFor(subsistenceAllocation(), population, land.farmland),
    });
    assert.equal(naive.commodities["farm-tools"]!.output, 0, "expected the naive split to starve");

    const balanced = economy.resolve({
      ...context,
      workers: workersFor(balanceAllocation(economy, subsistenceAllocation(), context), population, land.farmland),
    });
    assert.ok(balanced.commodities["farm-tools"]!.output > 0);
    assert.ok(balanced.agriculture.surplus > naive.agriculture.surplus);
  });

  it("opens a factory nobody is staffing, rather than shuffling the running ones", () => {
    // Found in the browser. Muskets want iron, and iron had no share at all, so the
    // balancer — which only ever topped up factories already running — shuffled lumber
    // and charcoal for eighty passes and never touched iron.
    const economy = new Economy();
    const game = Game.create("Kublai", "intermediate");
    const { land, population } = nationState(game.world, 0);
    const context = { level: "intermediate" as const, land, population };
    const wanting: Allocation = { ...subsistenceAllocation(), musket: 0.35 };
    assert.equal(wanting["iron"], undefined, "the premise is that iron is unstaffed");

    const balanced = balanceAllocation(economy, wanting, context);
    assert.ok((balanced["iron"] ?? 0) > 0, "iron should have been opened");
    // Muskets also want gunpowder, and the greedy single-step search does not get that
    // far, so they stay at zero. Feeding a whole cold chain is the AI's job (§10).
  });

  it("does not drain the finished good it was asked to make", () => {
    // Nothing consumes a sword, so its entire output read as surplus and it looked like
    // the richest donor in the economy: the balancer took 0.35 down to 0.07 and output
    // fell from a peak of 59 tons to 35.
    const economy = new Economy();
    const game = Game.create("Kublai", "intermediate");
    const { land, population } = nationState(game.world, 0);
    const context = { level: "intermediate" as const, land, population };
    const wanting: Allocation = { ...subsistenceAllocation(), sword: 0.35 };

    const balanced = balanceAllocation(economy, wanting, context);
    const before = economy.resolve({
      ...context,
      workers: workersFor(wanting, population, land.farmland),
    });
    const after = economy.resolve({
      ...context,
      workers: workersFor(balanced, population, land.farmland),
    });

    assert.ok(after.commodities["sword"]!.output > before.commodities["sword"]!.output,
      "balancing should raise sword output, not lower it");
    assert.ok(balanced["sword"]! > 0.1, `swords were drained to ${balanced["sword"]}`);
    assert.ok(after.firepower > before.firepower);
  });
});

describe("worker redistribution and locks (§3.6)", () => {
  const sum = (a: Record<string, number>) => Object.values(a).reduce((s, v) => s + v, 0);

  it("takes from the other factories pro rata", () => {
    const before = { lumber: 0.4, "iron-ore": 0.2, "farm-tools": 0.4 };
    const after = reallocate(before, "lumber", 0.7);
    assert.ok(Math.abs(after["lumber"]! - 0.7) < 1e-9);
    // The two donors had 0.2 and 0.4 and must keep that 1:2 ratio.
    assert.ok(Math.abs(after["farm-tools"]! / after["iron-ore"]! - 2) < 1e-9);
  });

  it("gives back pro rata when a factory is cut", () => {
    const after = reallocate({ lumber: 0.6, "iron-ore": 0.2, "farm-tools": 0.2 }, "lumber", 0.2);
    assert.ok(after["iron-ore"]! > 0.2 && after["farm-tools"]! > 0.2);
    assert.ok(Math.abs(after["iron-ore"]! - after["farm-tools"]!) < 1e-9);
  });

  it("preserves the size of the workforce", () => {
    const before = { lumber: 0.3, "iron-ore": 0.3, charcoal: 0.2, "farm-tools": 0.2 };
    for (const share of [0, 0.1, 0.55, 1]) {
      assert.ok(Math.abs(sum(reallocate(before, "charcoal", share)) - sum(before)) < 1e-9);
    }
  });

  it("wipes every other allocation if one factory takes the lot", () => {
    // The manual calls this out as a trap: "you can completely obliterate your
    // carefully considered worker allocations by simply putting all of your workers
    // into a single factory."
    const after = reallocate({ lumber: 0.3, "iron-ore": 0.3, "farm-tools": 0.4 }, "lumber", 1);
    assert.ok(Math.abs(after["lumber"]! - 1) < 1e-9);
    assert.ok(Math.abs(after["iron-ore"]!) < 1e-9);
    assert.ok(Math.abs(after["farm-tools"]!) < 1e-9);
  });

  it("leaves a locked factory alone when another is dragged", () => {
    const after = reallocate(
      { lumber: 0.3, "iron-ore": 0.3, "farm-tools": 0.4 },
      "lumber",
      0.9,
      ["farm-tools"],
    );
    assert.equal(after["farm-tools"], 0.4, "the lock should have held");
    assert.ok(Math.abs(after["iron-ore"]!) < 1e-9, "the unlocked donor takes the whole hit");
  });

  it("will not let a locked factory be changed by the player either", () => {
    const before = { lumber: 0.5, "farm-tools": 0.5 };
    assert.deepEqual(reallocate(before, "farm-tools", 0.9, ["farm-tools"]), before);
  });

  it("cannot draw more labour than the unlocked factories hold", () => {
    const after = reallocate({ lumber: 0.2, "farm-tools": 0.8 }, "lumber", 1, ["farm-tools"]);
    assert.ok(Math.abs(after["lumber"]! - 0.2) < 1e-9, "nothing unlocked to take from");
    assert.equal(after["farm-tools"], 0.8);
  });

  it("keeps the balancer off locked factories", () => {
    const economy = new Economy();
    const game = Game.create("Kublai", "intermediate");
    const { land, population } = nationState(game.world, 0);
    const base = subsistenceAllocation();
    const balanced = balanceAllocation(
      economy, base, { level: "intermediate", land, population }, 80, ["charcoal"],
    );
    assert.equal(balanced["charcoal"], base["charcoal"]);
  });

  it("reports each nation's land alongside its standing", () => {
    // The nation list in the UI is built straight from rankings, and it shows terrain.
    const game = Game.create("Kublai", "intermediate");
    for (const r of game.rankings()) {
      const { land } = nationState(game.world, r.nation);
      assert.deepEqual(r.land, land, `nation ${r.nation} land`);
      assert.equal(r.acres, land.farmland + land.forest + land.mountains + land.desert);
      assert.ok(r.acres > 0, `nation ${r.nation} holds no land`);
    }
    // Every acre of the map belongs to exactly one nation.
    const total = game.rankings().reduce((s, r) => s + r.acres, 0);
    const mapped = game.world.provinces.reduce(
      (s, p) => s + p.land.farmland + p.land.forest + p.land.mountains + p.land.desert, 0);
    assert.ok(Math.abs(total - mapped) < 1e-9, `${total} vs ${mapped}`);
  });

  it("tracks locks on the game, through undo and a save", () => {
    const game = Game.create("Kublai", "intermediate");
    assert.equal(game.isLocked(0, "farm-tools"), false);
    assert.equal(game.toggleLock(0, "farm-tools"), true);
    game.setWorkerShare(0, "lumber", 0.9);
    assert.equal(game.allocations[0]!["farm-tools"], subsistenceAllocation()["farm-tools"]);

    assert.deepEqual(Game.restore(game.snapshot()).locked[0], ["farm-tools"]);

    // Locks are a standing instruction, not a move, so an undo leaves them in place.
    playTurn(game);
    game.undoTurn();
    assert.equal(game.isLocked(0, "farm-tools"), true, "undo should not drop the locks");
  });

  it("recruits idle labour before raiding any other factory", () => {
    // Reported from play: with four factories locked and 16 workers idle, asking farm
    // tools for more was refused outright, because the only source considered was the
    // other factories and all of them were pinned.
    const before = { lumber: 0.22, "iron-ore": 0.22, charcoal: 0.045, "pig-iron": 0.2, "farm-tools": 0.24 };
    const locked = ["lumber", "iron-ore", "charcoal", "pig-iron"];
    const after = reallocate(before, "farm-tools", 0.3, locked);
    assert.ok(Math.abs(after["farm-tools"]! - 0.3) < 1e-9, "should have taken the idle labour");
    for (const id of locked) assert.equal(after[id], before[id as keyof typeof before], `${id} moved`);
  });

  it("spends idle labour first, and only then takes from the unlocked", () => {
    const before = { lumber: 0.3, "farm-tools": 0.5 }; // 0.2 idle
    const after = reallocate(before, "farm-tools", 0.65);
    assert.ok(Math.abs(after["farm-tools"]! - 0.65) < 1e-9);
    assert.equal(after["lumber"], 0.3, "lumber should be untouched while idle remains");
  });

  it("still refuses to exceed idle plus the unlocked pool", () => {
    const before = { lumber: 0.2, "farm-tools": 0.7 }; // 0.1 idle
    const after = reallocate(before, "farm-tools", 0.95, ["lumber"]);
    assert.ok(Math.abs(after["farm-tools"]! - 0.8) < 1e-9, "idle only, lumber is pinned");
    assert.equal(after["lumber"], 0.2);
  });

  it("lets freed labour fall idle when nothing unlocked can take it", () => {
    const after = reallocate({ lumber: 0.4, "farm-tools": 0.6 }, "farm-tools", 0.3, ["lumber"]);
    assert.equal(after["lumber"], 0.4);
    assert.ok(Math.abs(after["farm-tools"]! - 0.3) < 1e-9);
  });

  it("locks every factory, unstaffed ones included", () => {
    // Pinning only the staffed ones was tried first and is the wrong default: it leaves
    // every idle factory free to be raised, and raising one drains the economy behind
    // your back. "All" means all, so releasing what you mean to tune is the whole of
    // what can move.
    const game = Game.create("Kublai", "intermediate");
    game.setAllocation(0, { lumber: 0.4, "pig-iron": 0.4, "farm-tools": 0.2 });
    const pinned = game.lockAll(0);
    assert.equal(pinned.length, 33, "every commodity in the graph");
    assert.equal(game.isLocked(0, "sword"), true, "an unstaffed factory is pinned too");
    assert.equal(game.isLocked(0, "tractor"), true);
  });

  it("stops an unstaffed factory being started once everything is locked", () => {
    const game = Game.create("Kublai", "intermediate");
    game.setAllocation(0, { lumber: 0.5, "pig-iron": 0.3, "farm-tools": 0.2 });
    game.lockAll(0);
    game.setWorkerShare(0, "sword", 0.3);
    assert.ok((game.allocations[0]!["sword"] ?? 0) === 0, "sword is pinned at nothing");
  });

  it("locking everything freezes the economy", () => {
    const game = Game.create("Kublai", "intermediate");
    game.setAllocation(0, { lumber: 0.5, "pig-iron": 0.3, "farm-tools": 0.2 });
    game.lockAll(0);
    const before = { ...game.allocations[0] };
    game.setWorkerShare(0, "lumber", 1);
    assert.deepEqual(game.allocations[0], before, "nothing unlocked to draw on");
  });

  it("releases everything at once", () => {
    const game = Game.create("Kublai", "intermediate");
    game.setAllocation(0, { lumber: 0.5, "pig-iron": 0.3, "farm-tools": 0.2 });
    game.lockAll(0);
    game.unlockAll(0);
    assert.deepEqual(game.locked[0], []);
    game.setWorkerShare(0, "lumber", 0.8);
    assert.ok(Math.abs(game.allocations[0]!["lumber"]! - 0.8) < 1e-9);
  });

  it("makes a single unlocked factory the sole donor", () => {
    // Unlocking one commodity out of a locked economy narrows the pool to it alone,
    // which drains it fast — visible in the terminal game and worth pinning down.
    const before = { lumber: 0.3, charcoal: 0.3, "farm-tools": 0.4 };
    const after = reallocate(before, "lumber", 0.6, ["farm-tools"]);
    assert.equal(after["farm-tools"], 0.4);
    assert.ok(Math.abs(after["charcoal"]!) < 1e-9, "the lone donor is emptied");
  });

  it("rejects a share change outside the production phase", () => {
    const game = Game.create("Kublai", "intermediate");
    game.advance();
    assert.throws(() => game.setWorkerShare(0, "lumber", 0.5), /production/);
  });
});

describe("playing on", () => {
  it("runs twenty turns without breaking an invariant", () => {
    const game = Game.create("Trebolokhan", "expert");
    for (let turn = 0; turn < 20; turn++) {
      const report = playTurn(game);
      assert.equal(report.turn, turn + 1);
      for (const p of game.world.provinces) {
        assert.ok(p.population >= 0, `${p.name} population went negative`);
        assert.ok(p.firepower >= 0, `${p.name} firepower went negative`);
        assert.ok(Number.isFinite(p.population) && Number.isFinite(p.firepower));
      }
      for (const nation of game.world.nations) {
        for (const id of nation.provinces) {
          assert.equal(game.world.provinces[id]!.nation, nation.id, "roster disagrees");
        }
      }
      game.advance();
    }
  });

  it("lets a nation grow when its economy is balanced", () => {
    const game = Game.create("Kublai", "intermediate");
    const before = nationState(game.world, 0).population;
    for (let turn = 0; turn < 10; turn++) {
      playTurn(game);
      game.advance();
    }
    assert.ok(
      nationState(game.world, 0).population > before,
      "a fed nation should be growing, not starving",
    );
  });
});
