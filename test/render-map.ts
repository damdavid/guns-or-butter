/**
 * Writes a generated world to SVG so the geometry can be eyeballed. Map generation is
 * the one step where a passing test tells you much less than a glance does.
 *
 *   npm run map -- [continent] [beginner|intermediate|expert] [out.svg]
 */
import { writeFileSync } from "node:fs";
import { borderSegments, generateWorld } from "../src/worldgen.ts";
import type { Level, World } from "../src/types.ts";

const args = process.argv.slice(2).filter((a) => a !== "--ascii");
const ascii = process.argv.includes("--ascii");
const [name = "Kittycat", level = "expert", out = "/tmp/gb-map.svg"] = args;

/**
 * Nation fills, deliberately kept in warm and green families. An earlier palette
 * included two pale blue-greys, which against the ocean read as water rather than land
 * and made solid provinces look like holes in the continent.
 */
const NATION_FILL = [
  "#d9c3a5", "#c9d8b4", "#e3c3bc", "#cfc4dd",
  "#e6d9a8", "#b5cdbe", "#dfb997", "#c8c3aa",
];
const OCEAN = "#8fb0c7";
const SHALLOWS = ["#a4c0d3", "#b8d0de"] as const;

function render(world: World): string {
  const { width, height } = world;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="${OCEAN}"/>`,
  ];

  // Shallows: the coastline stroked heavily underneath the land. Scaling the outline
  // from the map centre worked for an oval but not for a lobed continent, where it
  // pushed the halo off the peninsulas and into the bays.
  const ring = world.outline.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  for (const [w, colour] of [[26, SHALLOWS[0]], [13, SHALLOWS[1]]] as const) {
    parts.push(
      `<polygon points="${ring}" fill="${colour}" stroke="${colour}" stroke-width="${w}" stroke-linejoin="round"/>`,
    );
  }

  for (const p of world.provinces) {
    const d = p.border.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    parts.push(`<polygon points="${d}" fill="${NATION_FILL[p.nation % NATION_FILL.length]}"/>`);
  }

  // Borders drawn from the shared edges themselves, heaviest first: coastline, then
  // nation frontiers, then the quiet lines between provinces of the same nation.
  const weights = {
    province: { stroke: "#6d6a63", width: 0.9 },
    nation: { stroke: "#2f2a24", width: 3.6 },
    coast: { stroke: "#2f2a24", width: 2.2 },
  } as const;
  for (const kind of ["province", "coast", "nation"] as const) {
    const { stroke, width: w } = weights[kind];
    for (const seg of borderSegments(world)) {
      if (seg.kind !== kind) continue;
      parts.push(
        `<line x1="${seg.from.x.toFixed(1)}" y1="${seg.from.y.toFixed(1)}" x2="${seg.to.x.toFixed(1)}" y2="${seg.to.y.toFixed(1)}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`,
      );
    }
  }

  for (const p of world.provinces) {
    for (const n of p.neighbours) {
      if (!n.road || n.province < p.id) continue;
      const q = world.provinces[n.province]!;
      parts.push(
        `<line x1="${p.capital.x.toFixed(1)}" y1="${p.capital.y.toFixed(1)}" x2="${q.capital.x.toFixed(1)}" y2="${q.capital.y.toFixed(1)}" stroke="#8a7a5e" stroke-width="1.5" opacity="0.85"/>`,
      );
    }
  }

  // Terrain, drawn as scattered marks the way the original spattered its mini-icons.
  // Each type differs in silhouette as well as hue: at this size shape carries more
  // than colour does, and a grey triangle beside a green one reads as the same thing.
  for (const f of world.terrain) {
    const s = f.scale;
    const c = Math.cos(f.rotation), sn = Math.sin(f.rotation);
    const at = (dx: number, dy: number) =>
      `${(f.x + (dx * c - dy * sn) * s).toFixed(1)},${(f.y + (dx * sn + dy * c) * s).toFixed(1)}`;

    if (f.type === "mountains") {
      // A twin-summit ridge in cold slate, against the forest's single warm-green tree.
      parts.push(
        `<polygon points="${at(-5.4, 3)} ${at(-2, -3.4)} ${at(0.1, 0.4)} ${at(2.2, -4.4)} ${at(5.6, 3)}" ` +
        `fill="#6e7688" stroke="#3c4250" stroke-width="0.7" stroke-linejoin="round"/>`,
      );
      parts.push(`<polygon points="${at(2.2, -4.4)} ${at(0.9, -2.5)} ${at(3.4, -2.5)}" fill="#e8ecf2"/>`);
    } else if (f.type === "forest") {
      parts.push(
        `<line x1="${at(0, 1.4).split(",")[0]}" y1="${at(0, 1.4).split(",")[1]}" ` +
        `x2="${at(0, 4).split(",")[0]}" y2="${at(0, 4).split(",")[1]}" stroke="#4a3a24" stroke-width="1.1"/>`,
      );
      parts.push(
        `<polygon points="${at(-3.1, 2)} ${at(0, -4.2)} ${at(3.1, 2)}" ` +
        `fill="#3f7a3a" stroke="#27512a" stroke-width="0.6" stroke-linejoin="round"/>`,
      );
    } else {
      // Dunes: two smooth mounds in a saturated ochre. An earlier version used a
      // hand-placed polygon with loose dots beside it, which at map scale read as a
      // bramble rather than sand, so the crest is sampled from a parabola instead.
      const mound = (w: number, h: number, dx: number, dy: number): string => {
        const pts: string[] = [];
        for (let i = 0; i <= 8; i++) {
          const x = -w + (2 * w * i) / 8;
          pts.push(at(dx + x, dy + 1.6 - h * (1 - (x / w) ** 2)));
        }
        pts.push(at(dx + w, dy + 1.6), at(dx - w, dy + 1.6));
        return pts.join(" ");
      };
      parts.push(
        `<polygon points="${mound(5.4, 3.2, 0, 0)}" fill="#c07b25"/>`,
      );
      parts.push(
        `<polygon points="${mound(3, 1.7, 3.4, 2.4)}" fill="#dc9a3e"/>`,
      );
    }
  }

  const glyph: Record<string, string> = { forest: "\u25b2", mountains: "\u25c6", desert: "\u00b7" };
  for (const p of world.provinces) {
    parts.push(
      `<circle cx="${p.capital.x.toFixed(1)}" cy="${p.capital.y.toFixed(1)}" r="3.6" fill="#fff" stroke="#111" stroke-width="1.3"/>`,
    );
    const dominant = (["mountains", "forest", "desert"] as const)
      .filter((t) => p.land[t] > 0)
      .sort((a, b) => p.land[b] - p.land[a])[0];
    const mark = dominant ? ` ${glyph[dominant]}` : "";
    parts.push(
      `<text x="${p.capital.x.toFixed(1)}" y="${(p.capital.y - 7).toFixed(1)}" font-family="Georgia,serif" font-size="9.5" text-anchor="middle" fill="#222">${p.name}${mark}</text>`,
    );
  }

  parts.push(
    `<text x="12" y="${height - 12}" font-family="Georgia,serif" font-size="13" fill="#31424f">` +
    `Continent ${world.name} — ${world.level}, ${world.nations.length} nations, ${world.provinces.length} provinces</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}

/** Even-odd ray cast, for the terminal renderer. */
function contains(poly: { x: number; y: number }[], x: number, y: number): boolean {
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

/**
 * A terminal view. Each nation gets a letter; a capital shows as a digit giving its
 * dominant terrain, or `o` for pure farmland. Crude, but it answers "are the nations
 * contiguous and do the provinces tile" at a glance, without leaving the shell.
 */
function renderAscii(world: World, cols = 108, rows = 44): string {
  const letters = "abcdefgh";
  const owner: number[][] = [];
  const prov: number[][] = [];
  for (let r = 0; r < rows; r++) {
    owner.push([]);
    prov.push([]);
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5) / cols) * world.width;
      const y = ((r + 0.5) / rows) * world.height;
      const p = world.provinces.find((q) => contains(q.border, x, y));
      owner[r]!.push(p ? p.nation : -1);
      prov[r]!.push(p ? p.id : -1);
    }
  }

  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const nat = owner[r]![c]!;
      if (nat < 0) {
        line += "~";
        continue;
      }
      const around = [[r, c - 1], [r, c + 1], [r - 1, c], [r + 1, c]] as const;
      const otherNation = around.some(([y, x]) => owner[y]?.[x] !== undefined && owner[y]![x] !== nat);
      const otherProvince = around.some(([y, x]) => prov[y]?.[x] !== undefined && prov[y]![x] !== prov[r]![c]);
      // Nation frontiers read heaviest, province borders next, interiors quietest —
      // the original drew countries with a double border for the same reason.
      line += otherNation ? "#" : otherProvince ? letters[nat % letters.length]!.toUpperCase() : letters[nat % letters.length]!;
    }
    out.push(line);
  }

  // Terrain marks land on top of the fill, so the clusters are visible in the shell too.
  const glyphOf = { mountains: "^", forest: "T", desert: ":" } as const;
  for (const f of world.terrain) {
    const c = Math.min(cols - 1, Math.floor((f.x / world.width) * cols));
    const r = Math.min(rows - 1, Math.floor((f.y / world.height) * rows));
    if (out[r]![c] === "#") continue;
    out[r] = out[r]!.slice(0, c) + glyphOf[f.type] + out[r]!.slice(c + 1);
  }
  for (const p of world.provinces) {
    const c = Math.min(cols - 1, Math.floor((p.capital.x / world.width) * cols));
    const r = Math.min(rows - 1, Math.floor((p.capital.y / world.height) * rows));
    out[r] = out[r]!.slice(0, c) + "o" + out[r]!.slice(c + 1);
  }
  return out.join("\n");
}

const world = generateWorld(name, level as Level);
const spokes = world.provinces.reduce((s, p) => s + p.neighbours.length, 0) / 2;
const roads = world.provinces.reduce((s, p) => s + p.neighbours.filter((n) => n.road).length, 0) / 2;

if (ascii) {
  console.log(renderAscii(world));
  console.log(
    `\nContinent ${world.name} — ${world.level}, ${world.nations.length} nations, ` +
    `${world.provinces.length} provinces, ${spokes} spokes (${roads} roads)`,
  );
  console.log(
    "~ ocean   # nation frontier   UPPERCASE province border   lowercase interior\n" +
    "terrain: ^ mountains   T forest   : desert      o capital",
  );
} else {
  writeFileSync(out, render(world));
  console.log(`${out}  —  ${world.provinces.length} provinces, ${world.nations.length} nations, ${spokes} spokes`);
}
