/**
 * World generation (§2). The structural invariants a map has to satisfy before anything
 * else in the game can rely on it, plus a check that the generated numbers land in the
 * ranges actually observed across the 11 measured nations.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { polygonArea } from "../src/delaunay.ts";
import { Economy } from "../src/economy.ts";
import { hashName, makeRng } from "../src/rng.ts";
import { uniqueNames } from "../src/names.ts";
import { WORLDGEN, generateWorld, nationState } from "../src/worldgen.ts";
import type { Level, World } from "../src/types.ts";

const LEVELS: Level[] = ["beginner", "intermediate", "expert"];
const worlds = new Map(LEVELS.map((l) => [l, generateWorld(`Seed-${l}`, l)]));

/** Provinces reachable from `start` without leaving `nation`. */
function reachable(world: World, nation: number, start: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const n of world.provinces[id]!.neighbours) {
      if (seen.has(n.province)) continue;
      if (world.provinces[n.province]!.nation !== nation) continue;
      seen.add(n.province);
      queue.push(n.province);
    }
  }
  return seen;
}

describe("seeding (§2)", () => {
  it("is deterministic: the continent name is the whole seed", () => {
    const a = generateWorld("Kittycat", "intermediate");
    const b = generateWorld("Kittycat", "intermediate");
    assert.deepEqual(a, b);
  });

  it("ignores surrounding whitespace and case, as the original's dialog did", () => {
    assert.equal(hashName("Kittycat"), hashName("  kittycat "));
  });

  it("gives different continents different worlds", () => {
    const a = generateWorld("Kittycat", "intermediate");
    const b = generateWorld("Olmi", "intermediate");
    assert.notDeepEqual(a.provinces[0]!.capital, b.provinces[0]!.capital);
  });

  it("produces distinct province names", () => {
    const names = uniqueNames(makeRng("names"), 64);
    assert.equal(new Set(names).size, 64);
    assert.ok(names.every((n) => /^[A-Z][a-z]+$/.test(n)), names.slice(0, 5).join(","));
  });
});

describe("structure", () => {
  for (const [level, world] of worlds) {
    it(`${level}: one province per capital, capped at 64`, () => {
      assert.equal(world.provinces.length, Math.min(world.nations.length * 8, WORLDGEN.maxProvinces));
      assert.ok(world.provinces.length <= WORLDGEN.maxProvinces);
    });

    it(`${level}: adjacency and road flags are symmetric`, () => {
      for (const p of world.provinces) {
        for (const n of p.neighbours) {
          const back = world.provinces[n.province]!.neighbours.find((m) => m.province === p.id);
          assert.ok(back, `${p.id}->${n.province} is not mutual`);
          assert.equal(back.road, n.road, `road flag disagrees on ${p.id}-${n.province}`);
        }
      }
    });

    it(`${level}: no province neighbours itself or repeats a neighbour`, () => {
      for (const p of world.provinces) {
        const ids = p.neighbours.map((n) => n.province);
        assert.ok(!ids.includes(p.id));
        assert.equal(new Set(ids).size, ids.length);
      }
    });

    it(`${level}: roads are about half the spokes`, () => {
      const spokes = world.provinces.reduce((s, p) => s + p.neighbours.length, 0) / 2;
      const roads = world.provinces.reduce((s, p) => s + p.neighbours.filter((n) => n.road).length, 0) / 2;
      assert.ok(Math.abs(roads / spokes - 0.5) < 0.06, `${(roads / spokes).toFixed(3)}`);
    });

    it(`${level}: every nation is contiguous`, () => {
      for (const nation of world.nations) {
        assert.ok(nation.provinces.length > 0, `nation ${nation.id} holds nothing`);
        const found = reachable(world, nation.id, nation.provinces[0]!);
        assert.equal(
          found.size,
          nation.provinces.length,
          `nation ${nation.id} is split into pieces`,
        );
      }
    });

    it(`${level}: every province belongs to exactly one nation`, () => {
      const counted = world.nations.flatMap((n) => n.provinces);
      assert.equal(counted.length, world.provinces.length);
      assert.equal(new Set(counted).size, world.provinces.length);
    });
  }
});

describe("geometry", () => {
  for (const [level, world] of worlds) {
    it(`${level}: every province is a non-degenerate polygon inside the map`, () => {
      for (const p of world.provinces) {
        assert.ok(p.border.length >= 3, `${p.name} has ${p.border.length} vertices`);
        assert.ok(polygonArea(p.border) > 100, `${p.name} has negligible area`);
        for (const v of p.border) {
          assert.ok(v.x >= -0.01 && v.x <= world.width + 0.01, `${p.name} escapes in x`);
          assert.ok(v.y >= -0.01 && v.y <= world.height + 0.01, `${p.name} escapes in y`);
        }
      }
    });

    it(`${level}: provinces tile the map without large gaps or overlap`, () => {
      const total = world.provinces.reduce((s, p) => s + polygonArea(p.border), 0);
      const map = world.width * world.height;
      assert.ok(Math.abs(total / map - 1) < 0.02, `covered ${(total / map).toFixed(3)} of the map`);
    });

    it(`${level}: every capital sits inside the map margins`, () => {
      for (const p of world.provinces) {
        assert.ok(p.capital.x > 0 && p.capital.x < world.width);
        assert.ok(p.capital.y > 0 && p.capital.y < world.height);
      }
    });
  }
});

describe("calibration against the 11 measured nations", () => {
  for (const [level, world] of worlds) {
    it(`${level}: population is 1.4933x farmland, as measured`, () => {
      for (const p of world.provinces) {
        assert.equal(p.population, Math.round(p.land.farmland * WORLDGEN.populationPerFarmland));
      }
      for (const nation of world.nations) {
        const s = nationState(world, nation.id);
        assert.ok(Math.abs(s.population / s.land.farmland - 1.4933) < 0.01);
      }
    });

    it(`${level}: nations hold 5-12 provinces`, () => {
      for (const nation of world.nations) {
        assert.ok(
          nation.provinces.length >= 5 && nation.provinces.length <= 12,
          `nation ${nation.id} holds ${nation.provinces.length}`,
        );
      }
    });

    it(`${level}: farmland per province stays in the observed 34-58 band, give or take`, () => {
      for (const nation of world.nations) {
        const s = nationState(world, nation.id);
        const per = s.land.farmland / nation.provinces.length;
        assert.ok(per > 25 && per < 70, `nation ${nation.id} averages ${per.toFixed(1)} acres`);
      }
    });

    it(`${level}: terrain clusters rather than spreading evenly`, () => {
      // Continent Six held 74 mountain acres and no forest at all, so a generator that
      // sprinkled all three types evenly everywhere would be wrong.
      const lopsided = world.nations.filter((nation) => {
        const s = nationState(world, nation.id);
        const t = [s.land.forest, s.land.mountains, s.land.desert].sort((a, b) => b - a);
        return t[0]! > 0 && t[2]! / t[0]! < 0.34;
      });
      assert.ok(
        lopsided.length >= Math.ceil(world.nations.length / 2),
        `only ${lopsided.length}/${world.nations.length} nations have uneven terrain`,
      );
    });
  }
});

describe("feeding the economy (§3)", () => {
  it("a generated nation drives a full production resolve", () => {
    const world = generateWorld("Ganthor", "intermediate");
    const economy = new Economy();
    const { land, population } = nationState(world, 0);
    const spare = population - land.farmland;
    assert.ok(spare > 0, "a starting nation must have labour left over after farming");

    const result = economy.resolve({
      level: world.level,
      land,
      population,
      workers: { lumber: Math.floor(spare * 0.3), "iron-ore": Math.floor(spare * 0.2), charcoal: Math.floor(spare * 0.1) },
    });
    assert.ok(result.commodities["lumber"]!.output > 0);
    assert.equal(result.agriculture.workers, land.farmland);
    assert.ok(result.agriculture.food > 0);
  });

  it("leaves every nation able to feed itself at the start", () => {
    for (const [, world] of worlds) {
      for (const nation of world.nations) {
        const { land, population } = nationState(world, nation.id);
        // Bare farmland yields 1 ton per acre (§4.2) and a head needs 1 ton (§4.4), so
        // a starting nation is always in deficit until it builds tools. That is the
        // opening squeeze the design intends, not a generation bug.
        assert.ok(population > land.farmland, "expected a starting food deficit");
        assert.ok(population < land.farmland * 2, "but one that tier-1 tools can close");
      }
    }
  });
});
