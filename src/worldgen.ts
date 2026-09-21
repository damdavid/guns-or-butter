/**
 * World generation (§2). `capitals -> spokes -> provinces -> roads -> terrain -> nations`.
 *
 * Crawford's algorithm, with the quantities calibrated against the 11 nations in the
 * measurement CSV.
 */
import { clipToRect, dualPolygons, edgeKey, edges, polygonArea, ringOfGhosts, triangulate } from "./delaunay.ts";
import { nationNames, uniqueNames } from "./names.ts";
import { makeRng, type Rng } from "./rng.ts";
import { PLAYERS } from "./data.ts";
import type { Land, Level, Point, Province, Terrain, TerrainFeature, World } from "./types.ts";

export const WORLDGEN = {
  width: 1000,
  height: 700,
  /** Provinces per nation. Observed 5-11 across 11 nations, mean 8.2. */
  provincesPerNation: 8,
  /** Hard ceiling from §1.1: "up to 64 provinces". */
  maxProvinces: 64,
  /** Keep the continent clear of the map border, leaving room for ocean. */
  edgeMargin: 40,
  /** Capitals are sown across the whole map; those outside the coastline become sea. */
  coastWobble: 0.22,
  /** Fraction of spokes that are roads. The dialogue says "oh, only half". */
  roadFraction: 0.5,
  /**
   * At most this share of a nation's frontier may be road. A road is the difference
   * between needing 20 firepower to take a province and needing 50 (§5.5), so a frontier
   * that is mostly road is a frontier that cannot be held.
   */
  maxBorderRoadFraction: 0.66,
  /** Mean farmland acres per province; observed 34-58. */
  farmlandPerProvince: 42,
  farmlandSpread: 0.28,
  /** Mean acres of non-farm terrain per province; observed ~7.2. */
  terrainPerProvince: 7.2,
  /** Starting population per acre of farmland. Observed 1.4933, sd 0.0021. */
  populationPerFarmland: 1.4933,
} as const;

const TERRAIN_TYPES = ["forest", "mountains", "desert"] as const satisfies readonly Exclude<Terrain, "farmland">[];

/**
 * The landmass, as a union of overlapping lobes — a single radius per bearing is
 * star-shaped and can only make a wobbly oval, never an isthmus or a peninsula.
 *
 * Each lobe overlaps the one before, which keeps the continent in one piece: naval
 * movement was cut, so an island would be unreachable.
 */
interface Lobe {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  /** Per-lobe edge wobble, so the silhouette is not visibly elliptical. */
  wobble: { k: number; phase: number; amp: number }[];
}

function makeLobes(rng: Rng): Lobe[] {
  const { width, height, edgeMargin } = WORLDGEN;
  const spanX = width / 2 - edgeMargin;
  const spanY = height / 2 - edgeMargin;
  const count = 3 + rng.int(3);
  const lobes: Lobe[] = [];

  for (let i = 0; i < count; i++) {
    const rx = spanX * rng.range(0.3, 0.52);
    const ry = spanY * rng.range(0.34, 0.62);
    let cx = width / 2;
    let cy = height / 2;
    if (i > 0) {
      // Hang each lobe off an existing one, close enough to stay joined. Push much past
      // 0.7 of the combined radii and the neck narrows to the point where a single
      // offshore capital can sit in it and sever the peninsula from the mainland.
      const anchor = lobes[rng.int(lobes.length)]!;
      const angle = rng.range(0, Math.PI * 2);
      const reach = rng.range(0.40, 0.70);
      cx = anchor.cx + Math.cos(angle) * (anchor.rx + rx) * reach;
      cy = anchor.cy + Math.sin(angle) * (anchor.ry + ry) * reach;
    }
    lobes.push({
      cx,
      cy,
      rx,
      ry,
      rotation: rng.range(0, Math.PI),
      wobble: [2, 3, 5].map((k) => ({ k, phase: rng.range(0, Math.PI * 2), amp: 0.16 / k })),
    });
  }
  return normalise(lobes);
}

/**
 * Recentre and shrink the lobes so the landmass sits inside the map with ocean around
 * it. Lobes are placed by hanging each off an earlier one, so the cluster wanders and
 * would otherwise run off an edge — which reads as the continent being cut, not as coast.
 */
function normalise(lobes: Lobe[]): Lobe[] {
  const { width, height, edgeMargin } = WORLDGEN;
  const reach = (l: Lobe) => Math.max(l.rx, l.ry) * 1.2;
  const minX = Math.min(...lobes.map((l) => l.cx - reach(l)));
  const maxX = Math.max(...lobes.map((l) => l.cx + reach(l)));
  const minY = Math.min(...lobes.map((l) => l.cy - reach(l)));
  const maxY = Math.max(...lobes.map((l) => l.cy + reach(l)));

  const fit = Math.min(
    (width - 2 * edgeMargin) / Math.max(maxX - minX, 1),
    (height - 2 * edgeMargin) / Math.max(maxY - minY, 1),
    1,
  );
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return lobes.map((l) => ({
    ...l,
    cx: width / 2 + (l.cx - midX) * fit,
    cy: height / 2 + (l.cy - midY) * fit,
    rx: l.rx * fit,
    ry: l.ry * fit,
  }));
}

function inLobe(lobe: Lobe, p: Point, scale: number, originX: number, originY: number): boolean {
  const cx = originX + (lobe.cx - originX) * scale;
  const cy = originY + (lobe.cy - originY) * scale;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const c = Math.cos(-lobe.rotation);
  const s = Math.sin(-lobe.rotation);
  const u = (dx * c - dy * s) / (lobe.rx * scale);
  const v = (dx * s + dy * c) / (lobe.ry * scale);
  let edge = 1;
  for (const w of lobe.wobble) edge += w.amp * Math.sin(w.k * Math.atan2(v, u) + w.phase);
  return u * u + v * v <= edge * edge;
}

interface Continent {
  /** Capitals on land, in generation order. */
  land: Point[];
  /** Capitals out at sea. They bound the coastal provinces and are then discarded. */
  sea: Point[];
  onLand: (p: Point) => boolean;
}

/**
 * Sow capitals across the whole map, then keep only those inside the coastline.
 *
 * The ones left out at sea are not wasted: they bound the dual cells of the coastal
 * provinces, which is what gives the continent an irregular edge rather than the
 * rectangle that clipping to the map produces.
 */
function placeContinent(rng: Rng, count: number): Continent {
  const { width, height } = WORLDGEN;
  const cx = width / 2, cy = height / 2;
  const lobes = makeLobes(rng);
  const onLand = (p: Point) => lobes.some((l) => inLobe(l, p, 1, cx, cy));

  // The mask is fixed at the size `normalise` gave it, and the capital count is met by
  // sampling more finely rather than by growing the coastline. An earlier version
  // searched for a mask scale that yielded the right count, which pushed the coast past
  // the map border on 13 worlds in 30 — the continent came out sliced rather than
  // surrounded by sea.
  const land: Point[] = [];
  let minDist = Math.sqrt(estimateLandArea(onLand, width, height) / count) * 0.92;
  for (let attempt = 0; attempt < 30 && land.length < count; attempt++) {
    land.length = 0;
    for (let i = 0; i < count * 900 && land.length < count; i++) {
      const p = { x: rng.range(6, width - 6), y: rng.range(6, height - 6) };
      if (!onLand(p)) continue;
      if (land.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) land.push(p);
    }
    if (land.length < count) minDist *= 0.9;
  }
  if (land.length !== count) throw new Error(`placed ${land.length} capitals, wanted ${count}`);

  // Offshore capitals hugging the coast, so no coastal province runs to the map edge for
  // want of a neighbour seaward of it. Sampled just outside the mask rather than on a
  // circle, which is what lets the bays keep their shape.
  // Ocean capitals over the whole sea, not a coastal band. Two failure modes bracket
  // the spacing: too fine and sea points sever the land adjacency graph; too sparse
  // and a coastal province runs to the map border and is cut flat there.
  const sea: Point[] = [];
  const step = Math.max(14, minDist * 0.8);
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const p = { x: x + rng.range(-step / 5, step / 5), y: y + rng.range(-step / 5, step / 5) };
      if (!onLand(p) && !onLand({ x, y })) sea.push(p);
    }
  }

  return { land, sea, onLand };
}

/** Monte Carlo, only accurate enough to seed the capital spacing. */
function estimateLandArea(onLand: (p: Point) => boolean, width: number, height: number): number {
  let hits = 0;
  const stride = 7;
  let total = 0;
  for (let y = stride / 2; y < height; y += stride) {
    for (let x = stride / 2; x < width; x += stride) {
      total++;
      if (onLand({ x, y })) hits++;
    }
  }
  return (hits / Math.max(total, 1)) * width * height;
}

/** Join any disconnected component of the land graph to its nearest neighbour. */
function connectStragglers(
  capitals: Point[],
  adjacency: number[][],
  spokes: [number, number][],
): void {
  const component = new Array<number>(capitals.length).fill(-1);
  let groups = 0;
  for (let i = 0; i < capitals.length; i++) {
    if (component[i] !== -1) continue;
    const queue = [i];
    component[i] = groups;
    while (queue.length > 0) {
      const p = queue.pop()!;
      for (const q of adjacency[p]!) {
        if (component[q] !== -1) continue;
        component[q] = groups;
        queue.push(q);
      }
    }
    groups++;
  }
  if (groups <= 1) return;

  for (let g = 1; g < groups; g++) {
    let best: [number, number] | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < capitals.length; i++) {
      if (component[i] !== g) continue;
      for (let j = 0; j < capitals.length; j++) {
        if (component[j] === g) continue;
        const d = Math.hypot(capitals[i]!.x - capitals[j]!.x, capitals[i]!.y - capitals[j]!.y);
        if (d < bestDist) {
          bestDist = d;
          best = [i, j];
        }
      }
    }
    if (!best) continue;
    const [i, j] = best;
    adjacency[i]!.push(j);
    adjacency[j]!.push(i);
    spokes.push(i < j ? [i, j] : [j, i]);
    const merged = component[j]!;
    for (let k = 0; k < component.length; k++) if (component[k] === g) component[k] = merged;
  }
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

  // Smallest nation picks first. Strict round-robin looks fair but is not: a nation
  // briefly boxed in by its neighbours loses its turn and never catches up, which on an
  // irregular continent left one nation with 4 provinces against another's 12.
  let placed = count;
  while (placed < n) {
    let grew = false;
    const order = frontiers
      .map((f, nation) => ({ nation, size: f.length }))
      .sort((a, b) => a.size - b.size || a.nation - b.nation);
    for (const { nation } of order) {
      if (placed >= n) break;
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
      break;
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
  rebalance(adjacency, owner, count, rng);
  return owner;
}

/** Is `nation`'s territory still one connected piece if `without` leaves it? */
function staysContiguous(
  adjacency: number[][],
  owner: number[],
  nation: number,
  without: number,
): boolean {
  const members = owner.map((o, i) => (o === nation && i !== without ? i : -1)).filter((i) => i >= 0);
  if (members.length <= 1) return true;
  const seen = new Set([members[0]!]);
  const queue = [members[0]!];
  while (queue.length > 0) {
    const p = queue.pop()!;
    for (const q of adjacency[p]!) {
      if (seen.has(q) || owner[q] !== nation || q === without) continue;
      seen.add(q);
      queue.push(q);
    }
  }
  return seen.size === members.length;
}

/**
 * Even out nation sizes after growth.
 *
 * Growing from seeds strands a nation boxed in early — 4 provinces against a
 * neighbour's 12 — and no growth order fixes it, because by then it has nowhere to
 * expand. Transfers are only taken where the donor stays in one piece.
 */
function rebalance(adjacency: number[][], owner: number[], count: number, rng: Rng): void {
  const sizes = () => {
    const s = new Array<number>(count).fill(0);
    for (const o of owner) s[o]!++;
    return s;
  };
  for (let guard = 0; guard < 400; guard++) {
    const s = sizes();
    const small = s.indexOf(Math.min(...s));
    if (Math.max(...s) - s[small]! <= 2) return;

    // Any neighbour big enough to spare a province will do, not just the biggest on the
    // map: the smallest nation is often not adjacent to the largest one at all.
    const candidates = rng
      .shuffle(owner.map((_, i) => i))
      .filter((i) => {
        const from = owner[i]!;
        return (
          from !== small &&
          s[from]! > s[small]! + 1 &&
          adjacency[i]!.some((q) => owner[q] === small)
        );
      })
      .sort((a, b) => s[owner[b]!]! - s[owner[a]!]!);

    const move = candidates.find((i) => staysContiguous(adjacency, owner, owner[i]!, i));
    if (move === undefined) return;
    owner[move] = small;
  }
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
  /** What the player calls their nation. Nation 0, and kept out of the AI draw. */
  playerNation?: string;
  /** Ceiling on a single factory's output, in tons (§3.7). Omit for no ceiling. */
  productionCap?: number;
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
  const { land: capitals, sea } = placeContinent(rng, count);
  // Sea capitals and a ring beyond the map both bound the coastal provinces' cells.
  // Neither takes part in adjacency; both are dropped once the polygons exist.
  const ghosts = [...sea, ...ringOfGhosts(WORLDGEN.width, WORLDGEN.height)];
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

  // Any province the triangulation leaves stranded — a peninsula tip with an offshore
  // capital sitting in its neck — is joined to its nearest land neighbour. Naval
  // movement was cut from the original, so an unreachable province is unplayable.
  connectStragglers(capitals, adjacency, spokes);

  // Nations are settled before the roads, because the roads have to know where the
  // frontiers are. Its own stream, so the layout does not shift the terrain that
  // follows it.
  const owner = assignNations(adjacency, players, makeRng(`${name}/owners`));

  // 5. Roads: about half the spokes. The remainder are the borders that carry the
  // terrain penalty in combat (§5.5).
  const shuffled = rng.shuffle(spokes);
  const roads = new Set<string>();
  for (const [u, v] of shuffled.slice(0, Math.round(spokes.length * WORLDGEN.roadFraction))) {
    roads.add(edgeKey(u, v));
  }
  capBorderRoads(shuffled, roads, owner);

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
  const terrain: TerrainFeature[] = [];
  for (const [u, v] of roadless) {
    const a = capitals[u]!;
    const b = capitals[v]!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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

    // Scatter the marks in an ellipse straddling the border: long across it, narrow
    // along the line joining the capitals, so the band follows the frontier. Marks are
    // kept only where they land in one of the two provinces, which keeps them ashore.
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const along = { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
    const across = { x: -along.y, y: along.x };
    // Deserts get fewer, broader marks. At equal density the dune shapes overlap into
    // an indistinct mass, where peaks and trees still read individually.
    const density = type === "desert" ? 0.55 : 1.5;
    const wanted = Math.max(2, Math.round(acres * density));
    for (let i = 0, tries = 0; i < wanted && tries < wanted * 12; tries++) {
      const s = rng.range(-span * 0.34, span * 0.34);
      const d = rng.range(-span * 0.15, span * 0.15);
      const x = mid.x + across.x * s + along.x * d;
      const y = mid.y + across.y * s + along.y * d;
      if (!polygonContains(polygons[u]!, x, y) && !polygonContains(polygons[v]!, x, y)) continue;
      const scale = type === "desert" ? rng.range(1.0, 1.6) : rng.range(0.75, 1.3);
      terrain.push({ type, x, y, rotation: rng.range(-0.25, 0.25), scale });
      i++;
    }
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

  const names = uniqueNames(rng, count);

  // Which polygon edges are shared with another province, and which face the sea.
  // Neighbouring provinces share their border vertices exactly, so an edge keyed on its
  // two endpoints appears twice inland and once on the coast.
  const edgeOwners = new Map<string, number[]>();
  polygons.forEach((poly, id) => {
    for (let i = 0; i < poly.length; i++) {
      const key = vertexPairKey(poly[i]!, poly[(i + 1) % poly.length]!);
      const owners = edgeOwners.get(key);
      if (owners) owners.push(id);
      else edgeOwners.set(key, [id]);
    }
  });
  const coastal = polygons.map((poly, id) =>
    poly.some((_, i) =>
      (edgeOwners.get(vertexPairKey(poly[i]!, poly[(i + 1) % poly.length]!)) ?? []).length < 2,
    ) && id >= 0,
  );

  // The coastline, chained from the border edges that have only one province on them.
  // This is the real coast rather than the mask it was cut from, so the shoreline a
  // renderer draws is exactly the one the provinces end at.
  const coastEdges: [Point, Point][] = [];
  polygons.forEach((poly, id) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if ((edgeOwners.get(vertexPairKey(a, b)) ?? []).length < 2) coastEdges.push([a, b]);
    }
  });
  const outline = traceRing(coastEdges);

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
    coastal: coastal[id]!,
  }));

  return {
    name,
    level,
    ...(options.productionCap === undefined ? {} : { productionCap: options.productionCap }),
    width: WORLDGEN.width,
    height: WORLDGEN.height,
    outline,
    terrain,
    provinces,
    nations: (() => {
      const player = options.playerNation?.trim();
      // A separate stream from the one that shaped the land, so naming the nations does
      // not change the map a given continent name produces.
      const names = nationNames(makeRng(`${name}/nations`), players, player ? [player] : []);
      return Array.from({ length: players }, (_, id) => ({
        id,
        name: id === 0 && player ? player : names[id]!,
        provinces: provinces.filter((p) => p.nation === id).map((p) => p.id),
      }));
    })(),
  };
}

/**
 * Chain undirected segments into the longest closed ring they form. Used for the
 * coastline; a continent in one piece yields a single ring.
 */
function traceRing(segments: [Point, Point][]): Point[] {
  const key = (p: Point) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  const links = new Map<string, Point[]>();
  const pointAt = new Map<string, Point>();
  for (const [a, b] of segments) {
    pointAt.set(key(a), a);
    pointAt.set(key(b), b);
    (links.get(key(a)) ?? links.set(key(a), []).get(key(a))!).push(b);
    (links.get(key(b)) ?? links.set(key(b), []).get(key(b))!).push(a);
  }

  let best: Point[] = [];
  const done = new Set<string>();
  for (const startKey of links.keys()) {
    if (done.has(startKey)) continue;
    const ring: Point[] = [pointAt.get(startKey)!];
    done.add(startKey);
    let current = startKey;
    let previous = "";
    for (let guard = 0; guard < segments.length + 2; guard++) {
      const next = (links.get(current) ?? []).map(key).find((k) => k !== previous && !done.has(k));
      if (next === undefined) break;
      ring.push(pointAt.get(next)!);
      done.add(next);
      previous = current;
      current = next;
    }
    if (ring.length > best.length) best = ring;
  }
  return best;
}

/** Even-odd ray cast. */
export function polygonContains(poly: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Canonical key for an undirected polygon edge, tolerant of vertex ordering. */
export function vertexPairKey(a: Point, b: Point): string {
  const ka = `${a.x.toFixed(3)},${a.y.toFixed(3)}`;
  const kb = `${b.x.toFixed(3)},${b.y.toFixed(3)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export interface BorderSegment {
  from: Point;
  to: Point;
  /** Province ids on each side; one entry means the far side is ocean. */
  owners: number[];
  kind: "coast" | "nation" | "province";
}

/**
 * Every border segment, classified. Nation frontiers and coastline are what a renderer
 * wants to draw heavily, and they can only be told apart by looking at both sides.
 */
export function borderSegments(world: World): BorderSegment[] {
  const byEdge = new Map<string, { from: Point; to: Point; owners: number[] }>();
  for (const p of world.provinces) {
    const poly = p.border;
    for (let i = 0; i < poly.length; i++) {
      const from = poly[i]!;
      const to = poly[(i + 1) % poly.length]!;
      const key = vertexPairKey(from, to);
      const seen = byEdge.get(key);
      if (seen) seen.owners.push(p.id);
      else byEdge.set(key, { from, to, owners: [p.id] });
    }
  }
  return [...byEdge.values()].map((e) => {
    const [a, b] = e.owners;
    const kind: BorderSegment["kind"] =
      b === undefined
        ? "coast"
        : world.provinces[a!]!.nation === world.provinces[b]!.nation
          ? "province"
          : "nation";
    return { ...e, kind };
  });
}

/**
 * Hold every nation's frontier below `maxBorderRoadFraction` road, trading each demoted
 * border road for an interior one so the continent keeps its half-of-everything.
 *
 * Two measures, because a nation can sit under a cap on paved *spokes* and still have
 * a road out of six of its seven border *provinces* — which is what a player sees, and
 * what prompted the rule. A road is a 20-firepower threshold against 50 (§5.5).
 */
function capBorderRoads(
  shuffled: readonly [number, number][],
  roads: Set<string>,
  owner: readonly number[],
): void {
  const key = (e: readonly [number, number]) => edgeKey(e[0], e[1]);
  const isFrontier = (e: readonly [number, number]) => owner[e[0]] !== owner[e[1]];
  const frontier = shuffled.filter(isFrontier);
  if (frontier.length === 0) return;

  // Promote interior spokes in the same shuffled order, so the swap stays seeded.
  const interior = shuffled.filter((e) => !isFrontier(e) && !roads.has(key(e)));
  let promoted = 0;
  const demote = (e: readonly [number, number]) => {
    roads.delete(key(e));
    const swap = interior[promoted++];
    if (swap) roads.add(key(swap));
  };

  // 1. At most two thirds of the frontier's spokes.
  const allowedSpokes = Math.floor(frontier.length * WORLDGEN.maxBorderRoadFraction);
  let paved = frontier.filter((e) => roads.has(key(e))).length;
  for (const e of frontier) {
    if (paved <= allowedSpokes) break;
    if (!roads.has(key(e))) continue;
    demote(e);
    paved--;
  }

  // 2. At most two thirds of any one nation's border provinces may have a road out.
  const facing = new Map<number, [number, number][]>();
  for (const e of frontier) {
    for (const province of e) {
      const list = facing.get(province);
      if (list) list.push([e[0], e[1]]);
      else facing.set(province, [[e[0], e[1]]]);
    }
  }
  const hasRoadOut = (province: number) =>
    (facing.get(province) ?? []).some((e) => roads.has(key(e)));

  for (const nation of [...new Set(owner)].sort((a, b) => a - b)) {
    const border = [...facing.keys()].filter((q) => owner[q] === nation).sort((a, b) => a - b);
    const allowed = Math.floor(border.length * WORLDGEN.maxBorderRoadFraction);
    // Strip the cheapest province each time — the one with fewest roads to take away —
    // so the continent loses as few roads as the rule allows.
    for (let guard = 0; guard < border.length; guard++) {
      const roaded = border.filter(hasRoadOut);
      if (roaded.length <= allowed) break;
      const victim = roaded.sort(
        (a, b) =>
          facing.get(a)!.filter((e) => roads.has(key(e))).length -
            facing.get(b)!.filter((e) => roads.has(key(e))).length || a - b,
      )[0]!;
      for (const e of facing.get(victim)!) if (roads.has(key(e))) demote(e);
    }
  }
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
