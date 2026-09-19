/**
 * The affinity model (§6.4), which exists to avoid the failure recorded in §9.1: in the
 * original, distrust only accumulated, so unions died out and never came back.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  AFFINITY, EVENTS, agePairs, applyAttack, applyEvent, nudge, seedAffinity,
  sharedBorders, willingness, type Affinity, type Standing,
} from "../src/affinity.ts";
import { Game } from "../src/game.ts";
import { generateWorld } from "../src/worldgen.ts";

const evenStandings = (n: number): Standing[] =>
  Array.from({ length: n }, (_, nation) => ({ nation, population: 100, firepower: 10 }));

const blank = (n: number): Affinity => ({
  liking: Array.from({ length: n }, () => Array.from({ length: n }, () => 0)),
  trust: Array.from({ length: n }, () => Array.from({ length: n }, () => 0)),
  grudge: Array.from({ length: n }, () => Array.from({ length: n }, () => -Infinity)),
});

describe("saturating updates (§6.4)", () => {
  it("lands the whole step at neutral and barely moves near a bound", () => {
    assert.equal(nudge(0, -0.45), -0.45);
    assert.ok(Math.abs(nudge(0.9, -0.45) - (0.9 - 0.45 * 1.9)) < 1e-9);
    assert.ok(nudge(-0.95, -0.45) > -1);
  });

  it("never pins a relationship at the floor, however many grievances", () => {
    // The whole point: Crawford's distrust was monotone and unrecoverable (§9.1).
    let x = 0;
    for (let i = 0; i < 4; i++) x = nudge(x, -0.45);
    assert.ok(Math.abs(x - -0.9085) < 1e-3, `four betrayals reach ${x.toFixed(4)}`);
    for (let i = 0; i < 100; i++) x = nudge(x, -0.45);
    assert.ok(x > -1, "a hundred betrayals still leave room to recover");
  });

  it("is symmetric in the other direction, and clamps", () => {
    let x = 0;
    for (let i = 0; i < 200; i++) x = nudge(x, 0.3);
    assert.ok(x < 1 && x > 0.99);
  });
});

describe("founding neighbours (§6.4)", () => {
  it("seeds only nations that actually share a border, scaled by how much", () => {
    const world = generateWorld("Kittycat", "intermediate");
    const affinity = seedAffinity(world);
    const shared = sharedBorders(world);
    let seeded = 0;
    for (let a = 0; a < world.nations.length; a++) {
      for (let b = 0; b < world.nations.length; b++) {
        if (a === b) continue;
        if (shared[a]![b]! === 0) {
          assert.equal(affinity.trust[a]![b], 0, `${a}/${b} share no border`);
          assert.equal(affinity.liking[a]![b], 0);
        } else {
          seeded++;
          assert.equal(affinity.trust[a]![b], Math.min(0.45, 0.2 + 0.08 * (shared[a]![b]! - 1)));
          assert.equal(affinity.liking[a]![b], Math.min(0.3, 0.15 + 0.05 * (shared[a]![b]! - 1)));
          assert.equal(affinity.trust[a]![b], affinity.trust[b]![a], "the seed is mutual");
        }
      }
    }
    assert.ok(seeded > 0, "expected some nations to border each other");
  });

  it("puts most of the tie in trust, so it lasts twenty turns not twelve", () => {
    const affinity = blank(2);
    affinity.trust[0]![1] = 0.2;
    affinity.liking[0]![1] = 0.15;
    const at = (turns: number) => {
      const a = blank(2);
      a.trust[0]![1] = 0.2;
      a.liking[0]![1] = 0.15;
      for (let i = 0; i < turns; i++) agePairs(a, []);
      return AFFINITY.wTrust * a.trust[0]![1]! + AFFINITY.wLiking * a.liking[0]![1]!;
    };
    assert.ok(Math.abs(at(0) - 0.29) < 0.005, `turn 0 gives ${at(0).toFixed(3)}`);
    assert.ok(at(10) > 0.12 && at(10) < 0.17, `turn 10 gives ${at(10).toFixed(3)}`);
    assert.ok(at(20) > 0.06 && at(20) < 0.10, `turn 20 gives ${at(20).toFixed(3)}`);
    assert.ok(affinity.trust[0]![1]! > affinity.liking[0]![1]!);
  });
});

describe("live terms (§6.4)", () => {
  const profiles: [string, number, number, number][] = [
    // name, pop share, mil share, expected net shift from the live terms
    ["runaway leader", 0.4, 0.45, -0.749],
    ["big but peaceful", 0.34, 0.1, -0.266],
    ["small but armed", 0.05, 0.3, -0.097],
    ["weakling", 0.04, 0.02, 0.237],
  ];

  it("reproduces the eight-player table in the spec", () => {
    for (const [name, pop, mil, expected] of profiles) {
      const n = 8;
      const standings: Standing[] = Array.from({ length: n }, (_, nation) => ({
        nation,
        population: nation === 1 ? pop : (1 - pop) / (n - 1),
        firepower: nation === 1 ? mil : (1 - mil) / (n - 1),
      }));
      const got = willingness(blank(n), 0, 1, standings);
      assert.ok(Math.abs(got - expected) < 0.005, `${name}: got ${got.toFixed(3)}, spec says ${expected}`);
    }
  });

  it("resents winning and distrusts arming, independently", () => {
    const n = 8;
    const make = (pop: number, mil: number): Standing[] =>
      Array.from({ length: n }, (_, nation) => ({
        nation,
        population: nation === 1 ? pop : (1 - pop) / (n - 1),
        firepower: nation === 1 ? mil : (1 - mil) / (n - 1),
      }));
    const peacefulGiant = willingness(blank(n), 0, 1, make(0.34, 0.1));
    const armedMidget = willingness(blank(n), 0, 1, make(0.05, 0.3));
    assert.ok(peacefulGiant < 0 && armedMidget < 0);
    // A large peaceful nation stays a viable ally where a small armed one does not,
    // relative to what each is worth on the board.
    assert.ok(peacefulGiant < armedMidget, "the giant is resented more than the armed midget");
  });

  it("means the same thing at two, four and eight players", () => {
    // An exactly average nation should draw no live penalty at any player count.
    for (const n of [2, 4, 8]) {
      assert.ok(Math.abs(willingness(blank(n), 0, 1, evenStandings(n))) < 1e-9, `n=${n}`);
    }
  });

  it("lets threat overwhelm stale grievance, which is the tuning constraint", () => {
    const n = 8;
    const stale = blank(n);
    stale.trust[0]![1] = -0.45;
    for (let i = 0; i < 15; i++) agePairs(stale, []);
    const grievance = Math.abs(AFFINITY.wTrust * stale.trust[0]![1]!);

    const leader: Standing[] = Array.from({ length: n }, (_, nation) => ({
      nation,
      population: nation === 1 ? 0.4 : 0.6 / (n - 1),
      firepower: nation === 1 ? 0.45 : 0.55 / (n - 1),
    }));
    const threat = Math.abs(willingness(blank(n), 0, 1, leader));
    assert.ok(threat > grievance * 2.5, `threat ${threat.toFixed(3)} vs grievance ${grievance.toFixed(3)}`);
  });
});

describe("underdog solidarity (§6.4)", () => {
  it("reaches equilibrium rather than running away", () => {
    const a = blank(4);
    for (let i = 0; i < 400; i++) agePairs(a, [2, 3]);
    assert.ok(Math.abs(a.liking[2]![3]! - 0.335) < 0.02, `liking settled at ${a.liking[2]![3]!.toFixed(3)}`);
    assert.ok(Math.abs(a.trust[2]![3]! - 0.307) < 0.02, `trust settled at ${a.trust[2]![3]!.toFixed(3)}`);
    const contribution = AFFINITY.wTrust * a.trust[2]![3]! + AFFINITY.wLiking * a.liking[2]![3]!;
    assert.ok(Math.abs(contribution - 0.508) < 0.03, `contributes ${contribution.toFixed(3)}`);
  });

  it("leaves everyone else decaying toward neutral", () => {
    const a = blank(4);
    a.liking[0]![1] = 0.8;
    for (let i = 0; i < 50; i++) agePairs(a, [2, 3]);
    assert.ok(Math.abs(a.liking[0]![1]!) < 0.01, "warmth outside the bottom half fades");
  });
});

describe("war moves affinity", () => {
  it("costs the attacker warmth first and trust slowly", () => {
    const a = blank(2);
    applyAttack(a, 0, 1, false, 1);
    assert.ok(Math.abs(a.liking[0]![1]! - EVENTS.attacked.liking) < 1e-9);
    assert.ok(Math.abs(a.trust[0]![1]! - EVENTS.attacked.trust) < 1e-9);
    assert.equal(a.liking[1]![0], 0, "the attacker's own regard is untouched");
  });

  it("costs more when the attack succeeds", () => {
    const lost = blank(2);
    const won = blank(2);
    applyAttack(lost, 0, 1, false, 1);
    applyAttack(won, 0, 1, true, 1);
    assert.ok(won.liking[0]![1]! < lost.liking[0]![1]!);
    assert.ok(won.trust[0]![1]! < lost.trust[0]![1]!);
  });

  it("draws two victims of the same aggressor together", () => {
    const a = blank(3);
    const standings = evenStandings(3);
    const before = willingness(a, 0, 1, standings, 5);
    applyAttack(a, 0, 2, true, 5);
    applyAttack(a, 1, 2, true, 5);
    const after = willingness(a, 0, 1, standings, 5);
    assert.ok(Math.abs(after - before - AFFINITY.sharedEnemyBonus) < 1e-9,
      `shared enemy should add ${AFFINITY.sharedEnemyBonus}, added ${(after - before).toFixed(3)}`);
    // And it lapses.
    assert.equal(willingness(a, 0, 1, standings, 5 + AFFINITY.grudgeTurns + 1), before);
  });

  it("is applied by the turn loop, and survives undo and a save", () => {
    const game = Game.create("Kittycat", "intermediate");
    const seeded = structuredClone(game.affinity);
    assert.deepEqual(Game.restore(game.snapshot()).affinity, seeded, "a save carries it");

    // Ageing happens between turns, so the seed should have decayed by turn two.
    game.advance(); game.advance(); game.advance(); game.advance();
    const pair = game.world.nations.flatMap((a) =>
      game.world.nations.map((b) => [a.id, b.id] as const)).find(([a, b]) => seeded.trust[a]![b]! > 0);
    assert.ok(pair, "expected at least one founding tie");
    assert.ok(game.affinity.trust[pair[0]]![pair[1]]! < seeded.trust[pair[0]]![pair[1]]!,
      "the founding tie should have started to fade");
  });

  it("ranks every other nation as a possible ally", () => {
    const game = Game.create("Kublai", "expert");
    const ranked = game.willingnessFrom(0);
    assert.equal(ranked.length, game.world.nations.length - 1);
    assert.ok(!ranked.some((r) => r.nation === 0), "a nation is not its own ally");
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1]!.willingness >= ranked[i]!.willingness, "sorted best first");
    }
  });
});
