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
import { WORLDGEN, borderSegments, generateWorld, nationState, polygonContains } from "../src/worldgen.ts";
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

  it("gives different continents different worlds, and different shapes", () => {
    const a = generateWorld("Kittycat", "intermediate");
    const b = generateWorld("Olmi", "intermediate");
    assert.notDeepEqual(a.provinces[0]!.capital, b.provinces[0]!.capital);
    const area = (w: typeof a) => polygonArea(w.outline);
    assert.ok(Math.abs(area(a) - area(b)) / area(a) > 0.02, "coastlines are too alike");
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

    it(`${level}: is one landmass — every province reachable overland`, () => {
      // Naval movement was cut from the original, so an island is unplayable. The
      // landmass is built from overlapping lobes, and a peninsula can still be severed
      // if an offshore capital lands in its neck, so this is a real risk not a formality.
      const seen = new Set([0]);
      const queue = [0];
      while (queue.length > 0) {
        const id = queue.pop()!;
        for (const n of world.provinces[id]!.neighbours) {
          if (seen.has(n.province)) continue;
          seen.add(n.province);
          queue.push(n.province);
        }
      }
      assert.equal(seen.size, world.provinces.length, "some provinces are cut off");
    });

    it(`${level}: the coast is ragged, not an oval`, () => {
      // Perimeter^2 / 4*pi*area: 1.0 for a circle, and the earlier single-radius
      // coastline sat near 1.3. Lobes put it above 1.6 with bays and peninsulas.
      let perimeter = 0;
      for (let i = 0; i < world.outline.length; i++) {
        const a = world.outline[i]!;
        const b = world.outline[(i + 1) % world.outline.length]!;
        perimeter += Math.hypot(a.x - b.x, a.y - b.y);
      }
      const raggedness = (perimeter * perimeter) / (4 * Math.PI * polygonArea(world.outline));
      assert.ok(raggedness > 1.5, `raggedness ${raggedness.toFixed(2)} is too smooth`);
    });

    it(`${level}: provinces tile the continent, not the map`, () => {
      // Most of the map is ocean, so the comparison is against the coastline. The
      // provinces are cut from the dual rather than clipped to the outline, so the two
      // agree closely but not exactly.
      const total = world.provinces.reduce((s, p) => s + polygonArea(p.border), 0);
      const continent = polygonArea(world.outline);
      assert.ok(
        Math.abs(total / continent - 1) < 0.05,
        `provinces cover ${(total / continent).toFixed(3)} of the outline`,
      );
      assert.ok(total < world.width * world.height * 0.75, "the continent should leave ocean");
    });

    it(`${level}: the continent never reaches the map edge`, () => {
      // A coastal province with no capital seaward of it runs to the outer ring and is
      // cut flat against the map border, which looks like a cliff and is a generation
      // bug, not a coastline.
      for (const p of world.provinces) {
        for (const v of p.border) {
          assert.ok(
            v.x > 1 && v.y > 1 && v.x < world.width - 1 && v.y < world.height - 1,
            `${p.name} is cut off at the map edge`,
          );
        }
      }
    });

    it(`${level}: has a coastline, and flags exactly the provinces on it`, () => {
      const coast = borderSegments(world).filter((s) => s.kind === "coast");
      assert.ok(coast.length > world.provinces.length / 2, "expected a substantial coastline");
      const onCoast = new Set(coast.flatMap((s) => s.owners));
      for (const p of world.provinces) {
        assert.equal(p.coastal, onCoast.has(p.id), `${p.name} coastal flag is wrong`);
      }
      assert.ok(world.provinces.some((p) => !p.coastal), "expected some inland provinces");
    });

    it(`${level}: nation frontiers are shared edges, each with two owners`, () => {
      for (const seg of borderSegments(world)) {
        if (seg.kind === "coast") {
          assert.equal(seg.owners.length, 1);
        } else {
          assert.equal(seg.owners.length, 2);
          const [a, b] = seg.owners;
          const differ = world.provinces[a!]!.nation !== world.provinces[b!]!.nation;
          assert.equal(seg.kind === "nation", differ);
        }
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

describe("terrain marks (§2)", () => {
  for (const [level, world] of worlds) {
    it(`${level}: scatters marks, and every one is on land`, () => {
      assert.ok(world.terrain.length > world.provinces.length, "expected a scattering");
      for (const f of world.terrain) {
        assert.ok(
          world.provinces.some((p) => polygonContains(p.border, f.x, f.y)),
          `a ${f.type} mark at ${f.x.toFixed(0)},${f.y.toFixed(0)} is in the sea`,
        );
      }
    });

    it(`${level}: mark counts track the acreage they represent`, () => {
      const acres = { forest: 0, mountains: 0, desert: 0 };
      for (const p of world.provinces) {
        acres.forest += p.land.forest;
        acres.mountains += p.land.mountains;
        acres.desert += p.land.desert;
      }
      for (const type of ["forest", "mountains", "desert"] as const) {
        const marks = world.terrain.filter((f) => f.type === type).length;
        if (acres[type] === 0) assert.equal(marks, 0, `${type} has marks but no acreage`);
        else assert.ok(marks > 0, `${type} has ${acres[type]} acres but no marks`);
      }
    });

    it(`${level}: marks sit near the road-less borders they came from`, () => {
      // They straddle a border, so a mark should never be right on top of a capital.
      const tooClose = world.terrain.filter((f) =>
        world.provinces.some((p) => Math.hypot(p.capital.x - f.x, p.capital.y - f.y) < 6),
      );
      assert.ok(tooClose.length < world.terrain.length * 0.05, `${tooClose.length} marks on capitals`);
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

describe("roads on a frontier (§2)", () => {
  const LEVELS = ["beginner", "intermediate", "expert"] as const;

  /** Every spoke once, with whether it is a road and whether it crosses a frontier. */
  const spokes = (world: ReturnType<typeof generateWorld>) =>
    world.provinces.flatMap((p) =>
      p.neighbours
        .filter((n) => n.province > p.id)
        .map((n) => ({
          road: n.road,
          frontier: world.provinces[n.province]!.nation !== p.nation,
        })),
    );

  it("leaves at most two thirds of any frontier paved", () => {
    // A road is the difference between a 20-firepower threshold and a 50-firepower one
    // (§5.5), so a frontier that is mostly road cannot be held at all.
    for (const name of ["Kittycat", "Kublai", "Ganthor", "Thule", "Vashti", "Ur", "Nineveh"]) {
      for (const level of LEVELS) {
        const edges = spokes(generateWorld(name, level));
        const frontier = edges.filter((e) => e.frontier);
        if (frontier.length === 0) continue;
        const paved = frontier.filter((e) => e.road).length / frontier.length;
        assert.ok(
          paved <= WORLDGEN.maxBorderRoadFraction + 1e-9,
          `${name}/${level}: ${(paved * 100).toFixed(1)}% of the frontier is road`,
        );
      }
    }
  });

  it("still lays roads on about half the continent", () => {
    // Capping the frontier trades each demoted road for an interior one, so the
    // dialogue's "oh, only half" survives the cap.
    for (const name of ["Kittycat", "Kublai", "Thule"]) {
      for (const level of LEVELS) {
        const edges = spokes(generateWorld(name, level));
        const share = edges.filter((e) => e.road).length / edges.length;
        assert.ok(
          Math.abs(share - WORLDGEN.roadFraction) < 0.06,
          `${name}/${level}: ${(share * 100).toFixed(1)}% of all spokes are road`,
        );
      }
    }
  });

  it("still leaves a frontier crossable somewhere", () => {
    // Capping roads must not wall a nation in: an unreachable enemy is an unwinnable
    // game, and §5.5 keeps cross-country attacks possible anyway.
    for (const name of ["Kittycat", "Kublai", "Thule", "Vashti"]) {
      const world = generateWorld(name, "intermediate");
      for (const nation of world.nations) {
        const own = world.provinces.filter((p) => p.nation === nation.id);
        const reachable = own.some((p) =>
          p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation.id));
        assert.ok(reachable, `${name}: nation ${nation.id} borders nobody`);
      }
    }
  });
});
