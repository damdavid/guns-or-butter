/**
 * Writes a generated world to SVG so the geometry can be eyeballed. Map generation is
 * the one step where a passing test tells you much less than a glance does.
 *
 *   npm run map -- [continent] [beginner|intermediate|expert] [out.svg]
 */
import { writeFileSync } from "node:fs";
import { generateWorld } from "../src/worldgen.ts";
import type { Level, World } from "../src/types.ts";

const [, , name = "Kittycat", level = "expert", out = "/tmp/gb-map.svg"] = process.argv;

// Deliberately muted and distinguishable in greyscale, since the original was mono.
const NATION_FILL = [
  "#c8d8e4", "#e4d5c3", "#cfe0cd", "#e7d3dc",
  "#d9d4e8", "#e8e2c8", "#cfe1e5", "#e0d9d1",
];

function render(world: World): string {
  const { width, height } = world;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#f7f5f0"/>`,
  ];

  for (const p of world.provinces) {
    const d = p.border.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    parts.push(
      `<polygon points="${d}" fill="${NATION_FILL[p.nation % NATION_FILL.length]}" stroke="#333" stroke-width="1"/>`,
    );
  }

  // Nation borders: double-drawn, matching the original's "surrounded by a double
  // black border" (manual p.7).
  for (const p of world.provinces) {
    for (const n of p.neighbours) {
      if (n.province < p.id) continue;
      const q = world.provinces[n.province]!;
      if (q.nation === p.nation) continue;
      parts.push(
        `<line x1="${p.capital.x.toFixed(1)}" y1="${p.capital.y.toFixed(1)}" x2="${q.capital.x.toFixed(1)}" y2="${q.capital.y.toFixed(1)}" stroke="#b03a2e" stroke-width="0.6" stroke-dasharray="3 4" opacity="0.5"/>`,
      );
    }
  }

  // Roads, drawn along the spokes they are.
  for (const p of world.provinces) {
    for (const n of p.neighbours) {
      if (!n.road || n.province < p.id) continue;
      const q = world.provinces[n.province]!;
      parts.push(
        `<line x1="${p.capital.x.toFixed(1)}" y1="${p.capital.y.toFixed(1)}" x2="${q.capital.x.toFixed(1)}" y2="${q.capital.y.toFixed(1)}" stroke="#7b6a52" stroke-width="1.6"/>`,
      );
    }
  }

  const glyph: Record<string, string> = { forest: "▲", mountains: "◆", desert: "·" };
  for (const p of world.provinces) {
    parts.push(
      `<circle cx="${p.capital.x.toFixed(1)}" cy="${p.capital.y.toFixed(1)}" r="4" fill="#fff" stroke="#111" stroke-width="1.4"/>`,
    );
    const dominant = (["mountains", "forest", "desert"] as const)
      .filter((t) => p.land[t] > 0)
      .sort((a, b) => p.land[b] - p.land[a])[0];
    const mark = dominant ? ` ${glyph[dominant]}` : "";
    parts.push(
      `<text x="${p.capital.x.toFixed(1)}" y="${(p.capital.y - 8).toFixed(1)}" font-family="Georgia,serif" font-size="10" text-anchor="middle" fill="#222">${p.name}${mark}</text>`,
    );
  }

  parts.push(
    `<text x="12" y="${height - 12}" font-family="Georgia,serif" font-size="13" fill="#555">` +
    `Continent ${world.name} — ${world.level}, ${world.nations.length} nations, ${world.provinces.length} provinces</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}

const world = generateWorld(name, level as Level);
writeFileSync(out, render(world));
console.log(
  `${out}  —  ${world.provinces.length} provinces, ${world.nations.length} nations, ` +
  `${world.provinces.reduce((s, p) => s + p.neighbours.length, 0) / 2} spokes`,
);
