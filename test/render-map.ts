/**
 * Writes a generated world to SVG so the geometry can be eyeballed. Map generation is
 * the one step where a passing test tells you much less than a glance does.
 *
 *   npm run map -- [continent] [beginner|intermediate|expert] [out.svg]
 */
import { writeFileSync } from "node:fs";
import { generateWorld } from "../src/worldgen.ts";
import { renderMapSvg } from "../src/svg.ts";
import type { Level, World } from "../src/types.ts";

const args = process.argv.slice(2).filter((a) => a !== "--ascii");
const ascii = process.argv.includes("--ascii");
const [name = "Kittycat", level = "expert", out = "/tmp/gb-map.svg"] = args;

/** The shared renderer emits a bare <svg>; give it the styling a standalone file needs. */
function wrapSvg(svg: string): string {
  return svg.replace(
    "<svg ",
    '<svg width="1000" height="700" ',
  ).replace(
    "</svg>",
    "<style>.label{font-family:Georgia,serif;font-size:9.5px;fill:#222}" +
    ".fp{font-family:Georgia,serif;font-size:9px;fill:#7a2d16}</style></svg>",
  );
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
  writeFileSync(out, wrapSvg(renderMapSvg(world, { firepower: true })));
  console.log(`${out}  —  ${world.provinces.length} provinces, ${world.nations.length} nations, ${spokes} spokes`);
}
