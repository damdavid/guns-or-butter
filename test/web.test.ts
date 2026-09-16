/**
 * The browser app's contract with the things it does not own: the ids in index.html and
 * the `data-` hooks in the SVG. Both are strings crossing a file boundary, so nothing
 * else would catch a typo in them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateWorld } from "../src/worldgen.ts";
import { renderMapSvg } from "../src/svg.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("web/index.html");
const main = read("web/main.ts");
const css = read("web/style.css");

const matchAll = (source: string, re: RegExp) => [...source.matchAll(re)].map((m) => m[1]!);

test("every element the app looks up exists in the page or in its own markup", () => {
  const shell = new Set(matchAll(html, /id="([^"]+)"/g));
  // Panels inject further ids of their own, so those count as defined too.
  const defined = new Set([...shell, ...matchAll(main, /id="([^"]+)"/g)]);
  const looked = new Set(matchAll(main, /\bel(?:<[^>]*>)?\("([^"]+)"\)/g));
  for (const id of looked) {
    assert.ok(defined.has(id), `main.ts reads #${id}, which nothing defines`);
  }
  assert.ok(looked.size >= 6, "expected the app to drive the shell's panels");
  for (const id of shell) {
    assert.ok(looked.has(id), `index.html defines #${id}, which the app never touches`);
  }
});

test("the page loads the bundle the build script writes", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const src = /src="([^"]+)"/.exec(html)?.[1];
  assert.ok(src, "index.html loads no script");
  assert.ok(
    pkg.scripts.build!.includes(`--outfile=web/${src}`),
    `index.html loads ${src}, which the build script does not produce`,
  );
});

test("the map exposes a province id on every clickable shape", () => {
  const world = generateWorld("Kittycat", "intermediate");
  const svg = renderMapSvg(world);
  const ids = new Set(matchAll(svg, /data-province="(\d+)"/g).map(Number));
  for (const p of world.provinces) {
    assert.ok(ids.has(p.id), `province ${p.id} is not clickable`);
  }
  // One polygon and one capital each, and nothing for the offshore cells.
  assert.equal(matchAll(svg, /data-province="(\d+)"/g).length, world.provinces.length * 2);
});

test("selection and march targets are marked, and the stylesheet styles them", () => {
  const world = generateWorld("Kittycat", "intermediate");
  const [near, far] = world.provinces[0]!.neighbours.length >= 2
    ? world.provinces[0]!.neighbours
    : [world.provinces[0]!.neighbours[0]!, undefined];
  const svg = renderMapSvg(world, {
    selected: 0,
    targets: new Map([[near!.province, true], ...(far ? [[far.province, false] as const] : [])]),
  });

  assert.match(svg, new RegExp(`class="province selected" data-province="0"`));
  assert.match(svg, new RegExp(`class="province target-road" data-province="${near!.province}"`));
  if (far) {
    assert.match(svg, new RegExp(`class="province target-rough" data-province="${far.province}"`));
  }
  for (const cls of ["selected", "target-road", "target-rough"]) {
    assert.ok(css.includes(`.highlight.${cls}`), `style.css does not style .highlight.${cls}`);
  }

  // The highlight has to outrank the nation borders, which are drawn as their own lines
  // over the province fills and were burying it.
  const lastBorder = svg.lastIndexOf('stroke-width="3.6"');
  assert.ok(lastBorder > 0, "expected nation borders in a four-nation world");
  assert.ok(
    svg.indexOf('class="highlight selected"') > lastBorder,
    "the selection outline must be drawn after the borders, or it gets painted over",
  );
});

test("firepower captions appear only when asked, and only where there is any", () => {
  const world = generateWorld("Kittycat", "intermediate");
  world.provinces[0]!.firepower = 42;
  world.provinces[1]!.firepower = 0;
  assert.ok(!renderMapSvg(world, { firepower: false }).includes('class="fp"'));
  const svg = renderMapSvg(world, { firepower: true });
  assert.equal(matchAll(svg, /class="fp"[^>]*>(\d+)</g).length, 1);
  assert.match(svg, /class="fp"[^>]*>42</);
});

test("terrain marks and nation fills stay inside the drawing", () => {
  const world = generateWorld("Kittycat", "beginner");
  const svg = renderMapSvg(world);
  assert.ok(svg.startsWith("<svg "), "renderer should emit a bare svg element");
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.ok(!svg.includes("NaN"), "a NaN coordinate would silently drop the shape");
  assert.ok(!svg.includes("undefined"));
  assert.equal(matchAll(svg, /class="road"/g).length > 0, true);
});
