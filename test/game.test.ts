/**
 * The turn loop (§1.2), and the couplings between subsystems that only exist here.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Game, balanceAllocation, subsistenceAllocation, workersFor } from "../src/game.ts";
import { Economy } from "../src/economy.ts";
import { nationState } from "../src/worldgen.ts";

const playTurn = (game: Game) => {
  game.advance(); // production
  game.advance(); // orders frozen
  const report = game.advance(); // execution
  return report!;
};

describe("phase sequence (§1.2)", () => {
  it("runs production, orders, execution, rankings, and back", () => {
    const game = Game.create("Kittycat", "beginner");
    assert.equal(game.phase, "production");
    game.advance();
    assert.equal(game.phase, "military-orders");
    game.advance();
    assert.equal(game.phase, "military-execution");
    const report = game.advance();
    assert.equal(game.phase, "rankings");
    assert.ok(report, "execution should produce a turn report");
    assert.equal(report.turn, 1);
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
    game.advance();
    const report = game.advance()!;
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
