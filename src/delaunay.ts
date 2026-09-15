/**
 * Delaunay triangulation (Bowyer-Watson), and the centroid dual used to turn it into
 * provinces.
 *
 * Crawford's spoke graph needed to "minimize the total lengths of all spokes" — he
 * found the exact solve intractable at 64 cities and used a heuristic (§2). Delaunay is
 * the natural stand-in: it is planar, contains the Euclidean minimum spanning tree, and
 * its dual tiles the plane, which is what lets provinces be built as the spec describes
 * — "connect the midpoints of the spokes".
 */
import type { Point } from "./types.ts";

export interface Triangle {
  /** Indices into the point array, counter-clockwise. */
  a: number;
  b: number;
  c: number;
}

const EPS = 1e-9;

function circumcircleContains(p: Point, a: Point, b: Point, c: Point): boolean {
  // Standard in-circle determinant. Assumes (a, b, c) counter-clockwise.
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  return det > EPS;
}

function counterClockwise(p: Point[], t: Triangle): Triangle {
  const [a, b, c] = [p[t.a]!, p[t.b]!, p[t.c]!];
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return cross < 0 ? { a: t.a, b: t.c, c: t.b } : t;
}

export function centroid(p: Point[], t: Triangle): Point {
  const [a, b, c] = [p[t.a]!, p[t.b]!, p[t.c]!];
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
}

/** Triangulate. Returns triangles indexing into `points`. */
export function triangulate(points: Point[]): Triangle[] {
  if (points.length < 3) return [];

  // A super-triangle comfortably enclosing every point; its vertices are appended to a
  // working copy and every triangle still touching them is dropped at the end.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const dMax = Math.max(maxX - minX, maxY - minY) * 10 + 10;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

  const pts = [
    ...points,
    { x: midX - dMax, y: midY - dMax },
    { x: midX + dMax, y: midY - dMax },
    { x: midX, y: midY + dMax },
  ];
  const s0 = points.length, s1 = s0 + 1, s2 = s0 + 2;
  let triangles: Triangle[] = [counterClockwise(pts, { a: s0, b: s1, c: s2 })];

  for (let i = 0; i < points.length; i++) {
    const p = pts[i]!;
    const bad: Triangle[] = [];
    const good: Triangle[] = [];
    for (const t of triangles) {
      if (circumcircleContains(p, pts[t.a]!, pts[t.b]!, pts[t.c]!)) bad.push(t);
      else good.push(t);
    }

    // The hole's boundary is every edge belonging to exactly one bad triangle.
    const counts = new Map<string, [number, number, number]>();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        const seen = counts.get(key);
        counts.set(key, [u, v, (seen?.[2] ?? 0) + 1]);
      }
    }
    triangles = good;
    for (const [u, v, n] of counts.values()) {
      if (n === 1) triangles.push(counterClockwise(pts, { a: u, b: v, c: i }));
    }
  }

  return triangles.filter((t) => t.a < s0 && t.b < s0 && t.c < s0);
}

export const edgeKey = (u: number, v: number): string =>
  u < v ? `${u},${v}` : `${v},${u}`;

/** Every Delaunay edge, deduplicated. These are the spokes. */
export function edges(triangles: Triangle[]): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const t of triangles) {
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      seen.set(edgeKey(u, v), u < v ? [u, v] : [v, u]);
    }
  }
  return [...seen.values()];
}

/**
 * The centroid dual: one polygon per point, built by walking its incident triangles in
 * angular order and stepping midpoint-of-spoke → triangle-centroid → midpoint-of-spoke.
 *
 * This honours the spec's "connect the midpoints of the spokes" while still tiling the
 * plane — a polygon through midpoints alone would leave a gap at every triangle. Points
 * Hull vertices have an open fan and an unbounded cell, and return an empty polygon.
 * Ring the point set in ghost points (`ringOfGhosts`) so that every point you care
 * about is interior.
 */
export function dualPolygons(points: Point[], triangles: Triangle[]): Point[][] {
  const fans = new Map<number, Triangle[]>();
  for (const t of triangles) {
    for (const v of [t.a, t.b, t.c]) {
      const list = fans.get(v);
      if (list) list.push(t);
      else fans.set(v, [t]);
    }
  }

  return points.map((p, i) => {
    const fan = fans.get(i);
    if (!fan || fan.length === 0) return [];
    const other = (t: Triangle) => [t.a, t.b, t.c].filter((v) => v !== i) as [number, number];

    // Index the fan by the spoke each triangle sits on. An interior vertex has every
    // spoke shared by two triangles; a hull vertex has exactly two used once, and those
    // are where its cell opens onto the coast.
    const bySpoke = new Map<number, Triangle[]>();
    for (const t of fan) {
      for (const v of other(t)) {
        const list = bySpoke.get(v);
        if (list) list.push(t);
        else bySpoke.set(v, [t]);
      }
    }
    const open = [...bySpoke.entries()].filter(([, ts]) => ts.length === 1).map(([v]) => v);

    // Walk the fan by connectivity rather than by angle. Sorting by angle looks
    // equivalent but degenerates on hull vertices, where the fan is an arc rather than
    // a full turn, and produces polygons that cross the map.
    const mid = (v: number) => ({ x: (p.x + points[v]!.x) / 2, y: (p.y + points[v]!.y) / 2 });
    const startSpoke = open[0] ?? other(fan[0]!)[0];
    let currentSpoke = startSpoke;
    let currentTri = bySpoke.get(currentSpoke)![0]!;
    const poly: Point[] = [mid(currentSpoke)];
    const walked = new Set<Triangle>();

    while (currentTri && !walked.has(currentTri)) {
      walked.add(currentTri);
      poly.push(centroid(points, currentTri));
      const nextSpoke = other(currentTri).find((v) => v !== currentSpoke)!;
      poly.push(mid(nextSpoke));
      currentSpoke = nextSpoke;
      currentTri = bySpoke.get(nextSpoke)!.find((t) => !walked.has(t))!;
    }

    // A hull vertex's cell is unbounded and cannot be closed sensibly. Callers avoid
    // producing one by ringing the map in ghost points (see `ringOfGhosts`), which makes
    // every real capital an interior vertex.
    if (open.length > 0) return [];

    return dedupe(poly);
  });
}

/**
 * A ring of points outside the map. Triangulating the real capitals together with these
 * leaves every real capital interior, so its dual cell is bounded — far simpler than
 * special-casing the coast, and the clip to the map rectangle then gives the continent
 * the "boxy and simple" outline Crawford says his own generator produced.
 */
export function ringOfGhosts(width: number, height: number, margin = 140): Point[] {
  // A rectangle standing off the map, not a circle: the map is a rectangle, and a
  // circle leaves the corners least protected, which is exactly where the gap showed.
  //
  // The offset has to exceed how far inside the edge a capital can sit. The centroid
  // dual only reaches halfway to a neighbour, so a capital `d` inside the edge with a
  // ghost `g` outside covers out to `(d + g) / 2` — which clears the edge only when
  // `g >= d`. Too small an offset and the discarded ghost cells eat into the map.
  const step = 120;
  const x0 = -margin, y0 = -margin, x1 = width + margin, y1 = height + margin;
  const out: Point[] = [];
  for (let x = x0; x <= x1; x += step) out.push({ x, y: y0 }, { x, y: y1 });
  for (let y = y0 + step; y < y1; y += step) out.push({ x: x0, y }, { x: x1, y });
  return out;
}

function dedupe(poly: Point[]): Point[] {
  const out: Point[] = [];
  for (const q of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - q.x, last.y - q.y) > 1e-6) out.push(q);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 1e-6
  ) {
    out.pop();
  }
  return out;
}

/** Shoelace area, used to size a province's acreage from its drawn extent. */
export function polygonArea(poly: Point[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function clipToRect(poly: Point[], width: number, height: number): Point[] {
  const inside = (p: Point, edge: number): boolean =>
    edge === 0 ? p.x >= 0 : edge === 1 ? p.x <= width : edge === 2 ? p.y >= 0 : p.y <= height;
  const cross = (a: Point, b: Point, edge: number): Point => {
    const t =
      edge === 0 ? (0 - a.x) / (b.x - a.x)
      : edge === 1 ? (width - a.x) / (b.x - a.x)
      : edge === 2 ? (0 - a.y) / (b.y - a.y)
      : (height - a.y) / (b.y - a.y);
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };

  let out = poly;
  for (let edge = 0; edge < 4 && out.length > 0; edge++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      const curIn = inside(cur, edge);
      const prevIn = inside(prev, edge);
      if (curIn) {
        if (!prevIn) out.push(cross(prev, cur, edge));
        out.push(cur);
      } else if (prevIn) {
        out.push(cross(prev, cur, edge));
      }
    }
  }
  return dedupe(out);
}
