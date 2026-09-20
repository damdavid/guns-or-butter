/**
 * Economic unions (§6.1), and the diplomatic consequences §6.4 attaches to them.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  canAttack, enemiesOf, formUnions, poolOf, recordFormation, recordSurvival, willJoin,
  type Union,
} from "../src/union.ts";
import { seedAffinity, type Affinity, type Standing } from "../src/affinity.ts";
import { Game } from "../src/game.ts";
import { generateWorld, nationState } from "../src/worldgen.ts";

const flat = (n: number): Affinity => ({
  liking: Array.from({ length: n }, () => Array.from({ length: n }, () => 0)),
  trust: Array.from({ length: n }, () => Array.from({ length: n }, () => 0)),
  grudge: Array.from({ length: n }, () => Array.from({ length: n }, () => -Infinity)),
});
const standings = (pops: number[]): Standing[] =>
  pops.map((population, nation) => ({ nation, population, firepower: 10 }));

describe("who joins whom", () => {
  it("will not join a mob against someone it regards better than the founder", () => {
    const affinity = flat(3);
    affinity.trust[2]![0] = 0.1;   // joiner 2 tolerates founder 0
    affinity.trust[2]![1] = 0.8;   // but is devoted to the target
    assert.equal(willJoin(affinity, 2, 0, 1, standings([10, 10, 10]), 1), false);
  });

  it("joins a tolerated founder against someone it likes less", () => {
    const affinity = flat(3);
    affinity.trust[2]![0] = 0.5;
    affinity.trust[2]![1] = -0.2;
    assert.equal(willJoin(affinity, 2, 0, 1, standings([10, 10, 10]), 1), true);
  });

  it("never enlists the target against itself", () => {
    const affinity = flat(3);
    affinity.trust[1]![0] = 0.9;
    assert.equal(willJoin(affinity, 1, 0, 1, standings([10, 10, 10]), 1), false);
  });

  it("ranks enemies worst first", () => {
    const affinity = flat(3);
    affinity.trust[0]![1] = 0.5;
    affinity.trust[0]![2] = -0.5;
    assert.deepEqual(enemiesOf(affinity, 0, standings([10, 10, 10]), 1), [2, 1]);
  });
});

describe("forming a union (§6.1)", () => {
  it("is declared by the weakest, against its worst enemy", () => {
    const affinity = flat(3);
    affinity.trust[0]![2] = -0.6;  // 0 detests 2
    affinity.trust[1]![0] = 0.5;   // 1 will follow 0
    const unions = formUnions(affinity, standings([5, 50, 90]), 1);
    assert.equal(unions.length, 1);
    assert.equal(unions[0]!.founder, 0, "the weakest declares");
    assert.equal(unions[0]!.target, 2);
    assert.deepEqual(unions[0]!.members, [0, 1]);
  });

  it("drops a declaration nobody joins, rather than leaving a union of one", () => {
    const affinity = flat(3);
    for (const a of [1, 2]) for (const b of [0, 1, 2]) affinity.trust[a]![b] = -0.9;
    const unions = formUnions(affinity, standings([5, 50, 90]), 1);
    assert.deepEqual(unions, []);
  });

  it("never puts a nation in two unions at once", () => {
    const affinity = seedAffinity(generateWorld("Thule", "expert"));
    const unions = formUnions(affinity, standings([1, 2, 3, 4, 5, 6, 7, 8]), 1);
    const seen = new Set<number>();
    for (const union of unions) {
      for (const member of union.members) {
        assert.ok(!seen.has(member), `nation ${member} is in two unions`);
        seen.add(member);
      }
    }
  });

  it("keeps the three roles disjoint", () => {
    // The map paints leader, members and target in three colours, which only reads if
    // no nation is two of them at once.
    const affinity = seedAffinity(generateWorld("Nineveh", "expert"));
    for (const union of formUnions(affinity, standings([1, 2, 3, 4, 5, 6, 7, 8]), 1)) {
      assert.ok(union.members.includes(union.founder), "the founder is a member");
      assert.ok(!union.members.includes(union.target), "the target is never a member");
      assert.equal(new Set(union.members).size, union.members.length, "no duplicates");
    }
  });

  it("lets the player decline, and lets them declare their own", () => {
    const affinity = flat(4);
    affinity.trust[1]![0] = 0.5;
    affinity.trust[1]![3] = 0.5;
    const pops = standings([5, 20, 40, 90]);
    const aloof = formUnions(affinity, pops, 1, { nation: 1, joins: null, declareAgainst: null });
    assert.ok(aloof.every((u) => !u.members.includes(1)), "standing aloof should keep you out");
    const own = formUnions(affinity, pops, 1, { nation: 1, joins: null, declareAgainst: 2 });
    const mine = own.find((u) => u.founder === 1);
    assert.ok(mine, "declaring should found a union when somebody joins");
    assert.equal(mine!.target, 2);
  });
});

describe("the attack restriction (§6.1)", () => {
  const unions: Union[] = [{ founder: 0, target: 3, members: [0, 1], formedOn: 1 }];

  it("lets a member attack the target and nobody else", () => {
    assert.equal(canAttack(unions, 1, 3), true);
    assert.equal(canAttack(unions, 1, 2), false);
  });

  it("does not let members attack each other", () => {
    assert.equal(canAttack(unions, 0, 1), false);
  });

  it("lets the target hit back at anyone in the union against it", () => {
    assert.equal(canAttack(unions, 3, 0), true);
    assert.equal(canAttack(unions, 3, 1), true);
  });

  it("leaves an unattached nation unrestricted", () => {
    assert.equal(canAttack(unions, 2, 0), true);
    assert.equal(canAttack(unions, 2, 3), true);
  });
});

describe("pooling", () => {
  it("adds the members' land and people together", () => {
    const world = generateWorld("Thule", "expert");
    const pooled = poolOf(world, [0, 1]);
    const a = nationState(world, 0);
    const b = nationState(world, 1);
    assert.equal(pooled.land.farmland, a.land.farmland + b.land.farmland);
    assert.ok(Math.abs(pooled.population - (a.population + b.population)) < 1e-9);
  });
});

describe("the diplomatic bill (§6.4)", () => {
  it("splits the target's grievance between founder and joiners", () => {
    const affinity = flat(3);
    recordFormation(affinity, [{ founder: 0, target: 2, members: [0, 1], formedOn: 1 }], []);
    const againstFounder = affinity.liking[2]![0]!;
    const againstJoiner = affinity.liking[2]![1]!;
    assert.ok(againstFounder < againstJoiner,
      "founding should cost more than merely joining");
    assert.ok(againstJoiner < 0, "joining against someone should still cost something");
  });

  it("warms the founder toward whoever signed up", () => {
    const affinity = flat(3);
    recordFormation(affinity, [{ founder: 0, target: 2, members: [0, 1], formedOn: 1 }], []);
    assert.ok(affinity.liking[0]![1]! > 0);
  });

  it("treats turning on last turn's partner as betrayal", () => {
    const together: Union[] = [{ founder: 0, target: 9, members: [0, 1], formedOn: 1 }];
    const ordinary = flat(3);
    recordFormation(ordinary, [{ founder: 0, target: 1, members: [0, 2], formedOn: 2 }], []);
    const betrayal = flat(3);
    recordFormation(betrayal, [{ founder: 0, target: 1, members: [0, 2], formedOn: 2 }], together);
    // Betrayal costs trust an order of magnitude more than ordinary hostility.
    assert.ok(betrayal.trust[1]![0]! < ordinary.trust[1]![0]! - 0.3,
      `${betrayal.trust[1]![0]} should be far below ${ordinary.trust[1]![0]}`);
  });

  it("pays the cooperation dividend to every pair that held together", () => {
    const affinity = flat(3);
    recordSurvival(affinity, [{ founder: 0, target: 2, members: [0, 1], formedOn: 1 }]);
    assert.ok(affinity.liking[0]![1]! > 0 && affinity.liking[1]![0]! > 0, "it is mutual");
    assert.equal(affinity.liking[0]![2], 0, "and only for members");
  });
});

describe("unions in the game loop", () => {
  it("runs the phase at Expert and nowhere else (§1.1)", () => {
    assert.equal(Game.create("Thule", "expert").phase, "union");
    assert.equal(Game.create("Thule", "intermediate").phase, "production");
    assert.equal(Game.create("Thule", "beginner").phase, "production");
  });

  it("forms unions once the phase is settled", () => {
    const game = Game.create("Thule", "expert");
    game.human = -1;
    game.advance();
    assert.equal(game.phase, "production");
    assert.ok(game.unions.length > 0, "expert nations cannot feed themselves alone (§10.3)");
  });

  it("hands the founder control of every member's economy", () => {
    const game = Game.create("Thule", "expert");
    game.human = -1;
    game.advance();
    const union = game.unions[0]!;
    assert.equal(game.controlsEconomy(union.founder), true);
    for (const member of union.members) {
      if (member === union.founder) continue;
      assert.equal(game.controlsEconomy(member), false);
      assert.equal(game.unionFor(member)?.founder, union.founder);
    }
  });

  it("runs a member's production on the pooled land and population", () => {
    const game = Game.create("Thule", "expert");
    game.human = -1;
    game.advance();
    const union = game.unions[0]!;
    const pooled = poolOf(game.world, union.members);
    for (const member of union.members) {
      const ctx = game.productionContext(member);
      assert.equal(ctx.land.farmland, pooled.land.farmland);
      assert.ok(ctx.population > nationState(game.world, member).population,
        "a member's economy should be bigger than the member");
    }
  });

  it("refuses an order that §6.1 forbids", () => {
    const game = Game.create("Thule", "expert");
    game.human = -1;
    game.advance();
    game.advance();
    const union = game.unions[0]!;
    const member = union.members[0]!;
    const from = game.world.provinces.find((p) => p.nation === member);
    const illegal = from?.neighbours
      .map((n) => game.world.provinces[n.province]!)
      .find((p) => p.nation !== null && p.nation !== member && !union.members.includes(p.nation)
        && p.nation !== union.target);
    if (!from || !illegal) return;    // no forbidden neighbour on this seed
    assert.throws(() => game.setOrder(from.id, { marchFraction: 1, target: illegal.id }),
      /union/);
    assert.equal(game.mayAttack(member, illegal.nation!), false);
  });

  it("keeps a nation's own union out of its own way at lower levels", () => {
    const game = Game.create("Thule", "intermediate");
    game.human = -1;
    game.advance();
    assert.deepEqual(game.unions, []);
    assert.equal(game.controlsEconomy(0), true);
  });
});
