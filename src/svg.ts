/**
 * The map, as an SVG string. Shared by the terminal renderer and the browser app.
 *
 * Pure: it takes a world and returns markup, with no DOM dependency, so it stays
 * testable and usable from Node. Each province carries `data-province`, which is how
 * the browser does hit testing without the renderer knowing anything about events.
 */
import { borderSegments } from "./worldgen.ts";
import type { Point, World } from "./types.ts";

/**
 * Nation fills, deliberately warm and green. An earlier palette included two pale
 * blue-greys which against the sea read as water, so a solid province looked like a
 * hole in the continent.
 */
export const NATION_FILL = [
  "#d9c3a5", "#c9d8b4", "#e3c3bc", "#cfc4dd",
  "#e6d9a8", "#b5cdbe", "#dfb997", "#c8c3aa",
];
export const OCEAN = "#8fb0c7";
const SHALLOWS = ["#a4c0d3", "#b8d0de"] as const;

export interface MapOptions {
  /** Drawn with a bright outline — the province whose orders are being given. */
  selected?: number | null;
  /** Legal destinations for the selected province, keyed by province id to road flag. */
  targets?: Map<number, boolean>;
  /** Nation whose provinces are the player's. Others get no capital labels. */
  viewer?: number | null;
  labels?: boolean;
  /** Firepower captions beside each capital. */
  firepower?: boolean;
  /** Marches ordered this turn, drawn capital to capital. */
  marches?: { from: number; to: number; hostile: boolean }[];
  /** Region to show, for panning and zooming. Defaults to the whole world. */
  view?: Rect;
  /** Forces in transit, drawn wherever the animation has got to. */
  markers?: { at: Point; label: string; hostile: boolean }[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The continent's bounding box, padded by `margin`, clamped to the world.
 *
 * Worldgen draws into a fixed 1000x700 field and the land never fills it, so showing the
 * whole field wastes most of the pane on empty ocean.
 */
export function continentBounds(world: World, margin = 40): Rect {
  const xs = world.outline.map((p) => p.x);
  const ys = world.outline.map((p) => p.y);
  if (xs.length === 0) return { x: 0, y: 0, w: world.width, h: world.height };
  const x = Math.max(0, Math.min(...xs) - margin);
  const y = Math.max(0, Math.min(...ys) - margin);
  return {
    x,
    y,
    w: Math.min(world.width - x, Math.max(...xs) + margin - x),
    h: Math.min(world.height - y, Math.max(...ys) + margin - y),
  };
}

const fmt = (n: number) => n.toFixed(1);

export function renderMapSvg(world: World, options: MapOptions = {}): string {
  const {
    selected = null, targets, labels = true, firepower = false, marches = [], markers = [],
  } = options;
  const { width, height } = world;
  const v = options.view ?? { x: 0, y: 0, w: width, h: height };
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(v.x)} ${fmt(v.y)} ${fmt(v.w)} ${fmt(v.h)}" class="map">`,
    // The ocean covers the whole field, not the view, so panning never runs off it.
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${OCEAN}"/>`,
  ];

  // Shallows: the coastline stroked heavily under the land, so the halo follows the
  // bays. Scaling the outline from the map centre would push it off the peninsulas.
  const ring = world.outline.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
  for (const [w, colour] of [[26, SHALLOWS[0]], [13, SHALLOWS[1]]] as const) {
    out.push(
      `<polygon points="${ring}" fill="${colour}" stroke="${colour}" stroke-width="${w}" stroke-linejoin="round"/>`,
    );
  }

  // Fills carry the hit testing. The highlight is stroked again further down, because
  // the nation borders and terrain marks are drawn over this layer and were burying the
  // one outline the player actually needs to see.
  const highlighted: { id: number; points: string; kind: string }[] = [];
  for (const p of world.provinces) {
    const points = p.border.map((q) => `${fmt(q.x)},${fmt(q.y)}`).join(" ");
    const classes = ["province"];
    if (p.id === selected) classes.push("selected");
    if (targets?.has(p.id)) classes.push(targets.get(p.id) ? "target-road" : "target-rough");
    if (classes.length > 1) highlighted.push({ id: p.id, points, kind: classes[1]! });
    out.push(
      `<polygon class="${classes.join(" ")}" data-province="${p.id}" points="${points}" ` +
      `fill="${NATION_FILL[p.nation % NATION_FILL.length]}"/>`,
    );
  }

  for (const f of world.terrain) {
    const s = f.scale;
    const c = Math.cos(f.rotation), sn = Math.sin(f.rotation);
    const at = (dx: number, dy: number) =>
      `${fmt(f.x + (dx * c - dy * sn) * s)},${fmt(f.y + (dx * sn + dy * c) * s)}`;
    if (f.type === "mountains") {
      out.push(
        `<polygon points="${at(-5.4, 3)} ${at(-2, -3.4)} ${at(0.1, 0.4)} ${at(2.2, -4.4)} ${at(5.6, 3)}" ` +
        `fill="#6e7688" stroke="#3c4250" stroke-width="0.7" stroke-linejoin="round"/>`,
        `<polygon points="${at(2.2, -4.4)} ${at(0.9, -2.5)} ${at(3.4, -2.5)}" fill="#e8ecf2"/>`,
      );
    } else if (f.type === "forest") {
      out.push(
        `<line x1="${fmt(f.x)}" y1="${fmt(f.y + 1.4 * s)}" x2="${fmt(f.x)}" y2="${fmt(f.y + 4 * s)}" stroke="#4a3a24" stroke-width="1.1"/>`,
        `<polygon points="${at(-3.1, 2)} ${at(0, -4.2)} ${at(3.1, 2)}" fill="#3f7a3a" stroke="#27512a" stroke-width="0.6" stroke-linejoin="round"/>`,
      );
    } else {
      const mound = (w: number, h: number, dx: number, dy: number) => {
        const pts: string[] = [];
        for (let i = 0; i <= 8; i++) {
          const x = -w + (2 * w * i) / 8;
          pts.push(at(dx + x, dy + 1.6 - h * (1 - (x / w) ** 2)));
        }
        pts.push(at(dx + w, dy + 1.6), at(dx - w, dy + 1.6));
        return pts.join(" ");
      };
      out.push(
        `<polygon points="${mound(5.4, 3.2, 0, 0)}" fill="#c07b25"/>`,
        `<polygon points="${mound(3, 1.7, 3.4, 2.4)}" fill="#dc9a3e"/>`,
      );
    }
  }

  // Borders from the shared edges themselves, heaviest last: quiet lines between
  // provinces of one nation, then coast, then nation frontiers.
  const weights = {
    province: { stroke: "#6d6a63", width: 0.9 },
    coast: { stroke: "#2f2a24", width: 2.2 },
    nation: { stroke: "#2f2a24", width: 3.6 },
  } as const;
  const segments = borderSegments(world);
  for (const kind of ["province", "coast", "nation"] as const) {
    const { stroke, width: w } = weights[kind];
    for (const seg of segments) {
      if (seg.kind !== kind) continue;
      out.push(
        `<line x1="${fmt(seg.from.x)}" y1="${fmt(seg.from.y)}" x2="${fmt(seg.to.x)}" y2="${fmt(seg.to.y)}" ` +
        `stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`,
      );
    }
  }

  for (const p of world.provinces) {
    for (const n of p.neighbours) {
      if (!n.road || n.province < p.id) continue;
      const q = world.provinces[n.province]!;
      out.push(
        `<line class="road" x1="${fmt(p.capital.x)}" y1="${fmt(p.capital.y)}" x2="${fmt(q.capital.x)}" y2="${fmt(q.capital.y)}" ` +
        `stroke="#8a7a5e" stroke-width="1.5" opacity="0.85"/>`,
      );
    }
  }

  for (const h of highlighted) {
    out.push(
      `<polygon class="highlight ${h.kind}" points="${h.points}" fill="none" pointer-events="none"/>`,
    );
  }

  // Arrowheads are drawn rather than declared as a marker, so two maps on one page
  // cannot collide over the def's id.
  for (const m of marches) {
    const a = world.provinces[m.from]?.capital;
    const b = world.provinces[m.to]?.capital;
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const tip = { x: b.x - ux * 7, y: b.y - uy * 7 };
    const base = { x: tip.x - ux * 13, y: tip.y - uy * 13 };
    const kind = m.hostile ? "hostile" : "friendly";
    out.push(
      `<line class="march ${kind}" x1="${fmt(a.x + ux * 5)}" y1="${fmt(a.y + uy * 5)}" ` +
      `x2="${fmt(base.x)}" y2="${fmt(base.y)}" pointer-events="none"/>`,
      `<polygon class="march-head ${kind}" pointer-events="none" points="${fmt(tip.x)},${fmt(tip.y)} ` +
      `${fmt(base.x - uy * 5)},${fmt(base.y + ux * 5)} ${fmt(base.x + uy * 5)},${fmt(base.y - ux * 5)}"/>`,
    );
  }

  for (const p of world.provinces) {
    out.push(
      `<circle class="capital" data-province="${p.id}" cx="${fmt(p.capital.x)}" cy="${fmt(p.capital.y)}" r="3.6" ` +
      `fill="#fff" stroke="#111" stroke-width="1.3"/>`,
    );
    if (labels) {
      out.push(
        `<text class="label" x="${fmt(p.capital.x)}" y="${fmt(p.capital.y - 7)}" text-anchor="middle">${p.name}</text>`,
      );
    }
    if (firepower && p.firepower >= 1) {
      out.push(
        `<text class="fp" data-province="${p.id}" x="${fmt(p.capital.x)}" y="${fmt(p.capital.y + 13)}" ` +
        `text-anchor="middle">${p.firepower.toFixed(0)}</text>`,
      );
    }
  }

  // Forces in transit, drawn last so they ride over everything.
  for (const m of markers) {
    const kind = m.hostile ? "hostile" : "friendly";
    out.push(
      `<circle class="in-transit ${kind}" cx="${fmt(m.at.x)}" cy="${fmt(m.at.y)}" r="9" pointer-events="none"/>`,
      `<text class="in-transit-label" x="${fmt(m.at.x)}" y="${fmt(m.at.y + 3.2)}" ` +
      `text-anchor="middle" pointer-events="none">${m.label}</text>`,
    );
  }

  out.push("</svg>");
  return out.join("\n");
}
