/**
 * Economic unions (§6.1), and the diplomatic consequences §6.4 attaches to them.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  canAttack, enemiesOf, formUnions, poolOf, recordFormation, recordSurvival, runRound,
  startRound, willJoin, type Union,
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

  it("refuses a declaration against a nation that has been conquered away", () => {
    // The player's answer arrives from a UI, so it is not trusted to have checked.
    const affinity = flat(4);
    affinity.trust[1]![0] = 0.5;
    const live = standings([5, 20, 40]);          // nation 3 is gone: no standing at all
    const unions = formUnions(affinity, live, 1, { nation: 0, joins: null, declareAgainst: 3 });
    assert.ok(unions.every((u) => u.target !== 3), "a dead nation cannot be a target");
    assert.ok(unions.every((u) => u.founder !== 0), "and the declaration is dropped");
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

  it("asks one declaration at a time, weakest first", () => {
    const affinity = flat(4);
    for (const a of [0, 1, 2, 3]) for (const b of [0, 1, 2, 3]) affinity.trust[a]![b] = -0.9;
    const pops = standings([5, 20, 40, 90]);   // player is 2; 0 and 1 are weaker
    const asked: string[] = [];
    let state = startRound(pops);
    state = runRound(state, affinity, pops, 1, 2);
    for (let i = 0; i < 8 && !state.done; i++) {
      asked.push(`${state.ask!.kind}:${state.ask!.kind === "join" ? state.ask!.founder : "-"}`);
      state = runRound(state, affinity, pops, 1, 2, null);
    }
    // Nobody likes anybody, so the player is asked to follow 0, then 1, then to declare.
    assert.deepEqual(asked, ["join:0", "join:1", "declare:-"]);
  });

  it("does not reveal who else is following", () => {
    // The declaration is public and the answers are not: a round paused on a join asks
    // about the founder and the target, and carries no roster to read.
    const affinity = flat(4);
    const pops = standings([5, 20, 40, 90]);
    const state = runRound(startRound(pops), affinity, pops, 1, 2);
    assert.equal(state.ask?.kind, "join");
    assert.deepEqual(Object.keys(state.ask!).sort(), ["founder", "kind", "nation", "target"]);
  });

  it("lets the player declare against any nation, not only an enemy", () => {
    const affinity = flat(4);
    affinity.trust[0]![3] = 0.9;   // 0 is devoted to 3 and would never pick it itself
    affinity.trust[1]![2] = 0.5;   // but 1 will follow the player
    const pops = standings([5, 20, 40, 90]);
    // Player is 0, the weakest, so it declares first — against its own favourite.
    const unions = formUnions(affinity, pops, 1, { nation: 0, joins: null, declareAgainst: 3 });
    assert.equal(unions.find((u) => u.founder === 0)?.target, 3);
  });

  it("treats leaving the question unanswered as declining", () => {
    const affinity = flat(4);
    const pops = standings([5, 20, 40, 90]);
    let state = runRound(startRound(pops), affinity, pops, 1, 2);
    while (!state.done) state = runRound(state, affinity, pops, 1, 2, null);
    assert.ok(state.unions.every((u) => !u.members.includes(2)), "declining keeps you out");
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

describe("the attack restriction (§6.1, relaxed [F])", () => {
  // 0 founds a union with 1 against 3; 2 and 4 stand outside everything.
  const unions: Union[] = [{ founder: 0, target: 3, members: [0, 1], formedOn: 1 }];
  // A second bloc, to check unions are still exclusive toward each other.
  const two: Union[] = [
    { founder: 0, target: 3, members: [0, 1], formedOn: 1 },
    { founder: 5, target: 6, members: [5, 4], formedOn: 1 },
  ];

  it("lets a member attack its union's target", () => {
    assert.equal(canAttack(unions, 1, 3), true);
  });

  it("lets a member attack anyone standing outside every union", () => {
    // §6.1 says "only the target", neutrals included. Taken literally, a member whose
    // target lay across the continent could not answer a hostile neighbour on its own
    // border, and with almost everyone joining something (§10.4) the wars stopped.
    assert.equal(canAttack(unions, 1, 2), true);
    assert.equal(canAttack(unions, 0, 4), true);
  });

  it("still does not let members attack each other", () => {
    assert.equal(canAttack(unions, 0, 1), false);
    assert.equal(canAttack(unions, 1, 0), false);
  });

  it("still does not let one bloc raid another", () => {
    assert.equal(canAttack(two, 0, 5), false, "5 is in a union, and not ours to take");
    assert.equal(canAttack(two, 1, 4), false);
    assert.equal(canAttack(two, 0, 3), true, "our own target is always fair game");
  });

  it("lets the target hit back at anyone in the union against it", () => {
    assert.equal(canAttack(two, 3, 0), true);
    assert.equal(canAttack(two, 3, 1), true);
    assert.equal(canAttack(two, 6, 5), true, "even across blocs, if they came for you");
  });

  it("leaves an unattached nation unrestricted", () => {
    assert.equal(canAttack(unions, 2, 0), true);
    assert.equal(canAttack(unions, 2, 3), true);
    assert.equal(canAttack(two, 2, 5), true);
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
    assert.equal(
      pooled.provinces,
      world.provinces.filter((p) => p.nation === 0 || p.nation === 1).length,
    );
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

  it("leaves a conquered nation out of the round entirely", () => {
    const game = Game.create("Thule", "expert");
    game.human = -1;
    // Hand every one of nation 1's provinces to nation 0, so 1 is out of the game.
    game.world = {
      ...game.world,
      provinces: game.world.provinces.map((p) => (p.nation === 1 ? { ...p, nation: 0 } : p)),
      nations: game.world.nations.map((n) =>
        n.id === 1 ? { ...n, provinces: [] }
        : n.id === 0 ? { ...n, provinces: game.world.provinces
            .filter((p) => p.nation === 0 || p.nation === 1).map((p) => p.id) }
        : n),
    };
    // The round is built from the standings as they are when the phase opens, so play
    // on to the next one — which is how an elimination reaches it in a real game.
    while (!(game.turn === 2 && game.phase === "production")) game.advance();

    for (const union of game.unions) {
      assert.notEqual(union.founder, 1, "a nation with no provinces cannot declare");
      assert.notEqual(union.target, 1, "nor be declared against");
      assert.ok(!union.members.includes(1), "nor join");
    }
    assert.ok(game.willingnessFrom(0).every((w) => w.nation !== 1),
      "and it is not offered as a target");
  });

  it("keeps a nation's own union out of its own way at lower levels", () => {
    const game = Game.create("Thule", "intermediate");
    game.human = -1;
    game.advance();
    assert.deepEqual(game.unions, []);
    assert.equal(game.controlsEconomy(0), true);
  });
});
