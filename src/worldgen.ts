/**
 * World generation (§2). `capitals -> spokes -> provinces -> roads -> terrain -> nations`.
 *
 * The shape of the algorithm is Crawford's, from ch24 and the design dialogue. The
 * quantities are calibrated against the 11 nations recorded in the measurement CSV:
 * ~8.2 provinces per nation, ~42 acres of farmland per province, ~7 acres of other
 * terrain, and starting population at a strikingly tight 1.4933x farmland.
 */
import { clipToRect, dualPolygons, edgeKey, edges, polygonArea, ringOfGhosts, triangulate } from "./delaunay.ts";
import { uniqueNames } from "./names.ts";
import { makeRng, type Rng } from "./rng.ts";
import { PLAYERS } from "./data.ts";
import type { Land, Level, Point, Province, Terrain, World } from "./types.ts";

export const WORLDGEN = {
  width: 1000,
  height: 700,
  /** Provinces per nation. Observed 5-11 across 11 nations, mean 8.2. */
  provincesPerNation: 8,
  /** Hard ceiling from §1.1: "up to 64 provinces". */
  maxProvinces: 64,
  /** Keep capitals off the coastline and apart from each other. */
  edgeMargin: 55,
  /** Fraction of spokes that are roads. The dialogue says "oh, only half". */
  roadFraction: 0.5,
  /** Mean farmland acres per province; observed 34-58. */
  farmlandPerProvince: 42,
  farmlandSpread: 0.28,
  /** Mean acres of non-farm terrain per province; observed ~7.2. */
  terrainPerProvince: 7.2,
  /** Starting population per acre of farmland. Observed 1.4933, sd 0.0021. */
  populationPerFarmland: 1.4933,
} as const;

const TERRAIN_TYPES: Terrain[] = ["forest", "mountains", "desert"];

/** Rejection-sample capitals, relaxing the spacing until the target count fits. */
function placeCapitals(rng: Rng, count: number): Point[] {
  const { width, height, edgeMargin } = WORLDGEN;
  const area = (width - 2 * edgeMargin) * (height - 2 * edgeMargin);
  let minDist = Math.sqrt(area / count) * 0.8;

  for (let attempt = 0; attempt < 24; attempt++) {
    const pts: Point[] = [];
    for (let i = 0; i < count * 400 && pts.length < count; i++) {
      const p = {
        x: rng.range(edgeMargin, width - edgeMargin),
        y: rng.range(edgeMargin, height - edgeMargin),
      };
      if (pts.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) pts.push(p);
    }
    if (pts.length === count) return pts;
    minDist *= 0.88;
  }
  throw new Error(`could not place ${count} capitals`);
}

/**
 * Displace shared polygon vertices consistently, so neighbouring provinces stay glued.
 * Crawford wiggled "the lines as I drew them"; doing it per-polygon instead would open
 * a gap along every border.
 */
function wiggleBorders(polygons: Point[][], rng: Rng, amount: number): Point[][] {
  const moved = new Map<string, Point>();
  const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  return polygons.map((poly) =>
    poly.map((p) => {
      const k = key(p);
      let q = moved.get(k);
      if (!q) {
        q = { x: p.x + rng.range(-amount, amount), y: p.y + rng.range(-amount, amount) };
        moved.set(k, q);
      }
      return q;
    }),
  );
}

/** Contiguous nations, grown outward from seed provinces so no nation is scattered. */
function assignNations(
  adjacency: number[][],
  count: number,
  rng: Rng,
): number[] {
  const n = adjacency.length;
  const owner = new Array<number>(n).fill(-1);
  const frontiers: number[][] = [];

  // Seeds spread apart by graph distance, so nations do not start on top of each other.
  const seeds: number[] = [rng.int(n)];
  while (seeds.length < count) {
    let best = -1;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      if (seeds.includes(i)) continue;
      const d = Math.min(...seeds.map((s) => graphDistance(adjacency, s, i)));
      if (d > bestDist) {
        bestDist = d;
        best = i;
      }
    }
    seeds.push(best);
  }
  seeds.forEach((s, nation) => {
    owner[s] = nation;
    frontiers.push([s]);
  });

  // Round-robin growth keeps nations close to equal in size.
  let placed = count;
  while (placed < n) {
    let grew = false;
    for (let nation = 0; nation < count && placed < n; nation++) {
      const frontier = frontiers[nation]!;
      const options = rng.shuffle(
        frontier.flatMap((p) => adjacency[p]!).filter((q) => owner[q] === -1),
      );
      if (options.length === 0) continue;
      const claimed = options[0]!;
      owner[claimed] = nation;
      frontier.push(claimed);
      placed++;
      grew = true;
    }
    if (!grew) {
      // Any pocket the frontier cannot reach goes to whichever nation already borders it.
      for (let i = 0; i < n; i++) {
        if (owner[i] !== -1) continue;
        const near = adjacency[i]!.find((q) => owner[q] !== -1);
        owner[i] = near === undefined ? 0 : owner[near]!;
        placed++;
      }
    }
  }
  return owner;
}

function graphDistance(adjacency: number[][], from: number, to: number): number {
  if (from === to) return 0;
  const seen = new Set([from]);
  let layer = [from];
  for (let d = 1; d <= adjacency.length; d++) {
    const next: number[] = [];
    for (const p of layer) {
      for (const q of adjacency[p]!) {
        if (seen.has(q)) continue;
        if (q === to) return d;
        seen.add(q);
        next.push(q);
      }
    }
    if (next.length === 0) break;
    layer = next;
  }
  return adjacency.length;
}

export interface WorldgenOptions {
  /** Overrides the province count derived from the level. */
  provinces?: number;
}

export function generateWorld(
  name: string,
  level: Level,
  options: WorldgenOptions = {},
): World {
  const rng = makeRng(name);
  const players = PLAYERS[level];
  const count = Math.min(
    options.provinces ?? players * WORLDGEN.provincesPerNation,
    WORLDGEN.maxProvinces,
  );
  if (count < players) throw new Error(`${count} provinces cannot host ${players} players`);

  // 1-2. Capitals, then spokes. Delaunay stands in for Crawford's minimum-length
  // heuristic: planar, contains the minimum spanning tree, and its dual tiles.
  const capitals = placeCapitals(rng, count);
  // Ghost points ring the map so every real capital is an interior vertex with a bounded
  // dual cell. They take no part in adjacency and are dropped immediately after.
  const ghosts = ringOfGhosts(WORLDGEN.width, WORLDGEN.height);
  const triangles = triangulate([...capitals, ...ghosts]);
  const spokes = edges(triangles).filter(([u, v]) => u < count && v < count);

  // 3-4. Provinces as the dual, then wiggled so the borders are not visibly polygonal.
  // Wiggle first, then clip: clipping first would let the wiggle push vertices back
  // outside the map, which is what left stray borders running off the edge.
  const polygons = wiggleBorders(
    dualPolygons([...capitals, ...ghosts], triangles).slice(0, count),
    rng,
    7,
  ).map((poly) => clipToRect(poly, WORLDGEN.width, WORLDGEN.height));

  const adjacency: number[][] = capitals.map(() => []);
  for (const [u, v] of spokes) {
    adjacency[u]!.push(v);
    adjacency[v]!.push(u);
  }

  // 5. Roads: about half the spokes. The remainder are the borders that carry the
  // terrain penalty in combat (§5.5).
  const roads = new Set<string>();
  for (const [u, v] of rng.shuffle(spokes).slice(0, Math.round(spokes.length * WORLDGEN.roadFraction))) {
    roads.add(edgeKey(u, v));
  }

  // 6. Terrain sits on the road-less borders, and straddles them — so both provinces
  // share the acreage. Types come from regional seeds rather than per-edge coin flips,
  // because the measured nations cluster hard: continent Six holds 74 mountain acres
  // and no forest at all.
  const seedPoints = TERRAIN_TYPES.map(() => ({
    x: rng.range(0, WORLDGEN.width),
    y: rng.range(0, WORLDGEN.height),
  }));
  const land: Land[] = capitals.map(() => ({ farmland: 0, forest: 0, mountains: 0, desert: 0 }));
  const roadless = spokes.filter(([u, v]) => !roads.has(edgeKey(u, v)));
  const totalTerrain = count * WORLDGEN.terrainPerProvince;
  const perEdge = roadless.length > 0 ? totalTerrain / roadless.length : 0;
  for (const [u, v] of roadless) {
    const mid = {
      x: (capitals[u]!.x + capitals[v]!.x) / 2,
      y: (capitals[u]!.y + capitals[v]!.y) / 2,
    };
    let best = 0;
    let bestDist = Infinity;
    seedPoints.forEach((s, i) => {
      const d = Math.hypot(s.x - mid.x, s.y - mid.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    const type = TERRAIN_TYPES[best]!;
    const acres = perEdge * rng.range(0.4, 1.6);
    land[u]![type] += acres / 2;
    land[v]![type] += acres / 2;
  }

  // 7-8. Farmland scales with the province's drawn extent, so a visibly large province
  // really is a large one; jitter keeps it from being perfectly readable off the map.
  // Population then follows farmland, which the measurements pin at 1.4933x with a
  // standard deviation of 0.0021 across eleven nations.
  const areas = polygons.map(polygonArea);
  const meanArea = areas.reduce((s, a) => s + a, 0) / areas.length;
  land.forEach((l, i) => {
    const spread = WORLDGEN.farmlandSpread;
    const relative = meanArea > 0 ? areas[i]! / meanArea : 1;
    l.farmland = Math.max(
      8,
      Math.round(WORLDGEN.farmlandPerProvince * relative * rng.range(1 - spread, 1 + spread)),
    );
    for (const t of TERRAIN_TYPES) l[t] = Math.round(l[t]);
  });

  const owner = assignNations(adjacency, players, rng);
  const names = uniqueNames(rng, count);

  const provinces: Province[] = capitals.map((capital, id) => ({
    id,
    name: names[id]!,
    nation: owner[id]!,
    capital,
    border: polygons[id]!,
    neighbours: adjacency[id]!.map((q) => ({ province: q, road: roads.has(edgeKey(id, q)) })),
    land: land[id]!,
    population: Math.round(land[id]!.farmland * WORLDGEN.populationPerFarmland),
    firepower: 0,
  }));

  return {
    name,
    level,
    width: WORLDGEN.width,
    height: WORLDGEN.height,
    provinces,
    nations: Array.from({ length: players }, (_, id) => ({
      id,
      provinces: provinces.filter((p) => p.nation === id).map((p) => p.id),
    })),
  };
}

/** A nation's economy inputs, summed over the provinces it holds (§2.1, §3.1). */
export function nationState(world: World, nation: number): { land: Land; population: number } {
  const own = world.provinces.filter((p) => p.nation === nation);
  const land: Land = { farmland: 0, forest: 0, mountains: 0, desert: 0 };
  let population = 0;
  for (const p of own) {
    land.farmland += p.land.farmland;
    land.forest += p.land.forest;
    land.mountains += p.land.mountains;
    land.desert += p.land.desert;
    population += p.population;
  }
  return { land, population };
}
