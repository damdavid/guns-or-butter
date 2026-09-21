/**
 * The browser app's contract with the things it does not own: the ids in play.html and
 * the `data-` hooks in the SVG. Both are strings crossing a file boundary, so nothing
 * else would catch a typo in them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateWorld } from "../src/worldgen.ts";
import { continentBounds, renderMapSvg } from "../src/svg.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = read("web/play.html");
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

  // An id also earns its place by being what a <label for> points at, which is why the
  // start form's fields are not looked up by id — they are read by name from FormData.
  const labelled = new Set(matchAll(html, /<label for="([^"]+)"/g));
  for (const id of shell) {
    assert.ok(
      looked.has(id) || labelled.has(id),
      `play.html defines #${id}, which the app never touches and no label points at`,
    );
  }
  assert.ok(labelled.size > 0, "expected the start form's fields to be labelled");
  for (const id of labelled) {
    assert.ok(shell.has(id), `a label points at #${id}, which does not exist`);
  }
});

test("the page loads the bundle the build script writes", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const src = /src="([^"]+)"/.exec(html)?.[1];
  assert.ok(src, "play.html loads no script");
  assert.ok(
    pkg.scripts.build!.includes(`--outfile=web/${src}`),
    `play.html loads ${src}, which the build script does not produce`,
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

test("the default view frames the continent rather than the empty field", () => {
  const world = generateWorld("Kittycat", "intermediate");
  const box = continentBounds(world);

  // Every point of the coastline has to be inside it, or the map clips the land.
  for (const p of world.outline) {
    assert.ok(p.x >= box.x && p.x <= box.x + box.w, `x ${p.x} outside ${box.x}..${box.x + box.w}`);
    assert.ok(p.y >= box.y && p.y <= box.y + box.h, `y ${p.y} outside ${box.y}..${box.y + box.h}`);
  }
  // And it has to stay inside the world, so panning never runs off the ocean.
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.w <= world.width + 1e-9);
  assert.ok(box.y + box.h <= world.height + 1e-9);
  // The point of it: the land does not fill the field, so this is a real crop.
  assert.ok(box.w * box.h < world.width * world.height * 0.9,
    `crop is ${((box.w * box.h) / (world.width * world.height) * 100).toFixed(0)}% of the field`);
});

test("continentBounds falls back to the whole field with no coastline", () => {
  const world = { ...generateWorld("Kittycat", "beginner"), outline: [] };
  assert.deepEqual(continentBounds(world), { x: 0, y: 0, w: world.width, h: world.height });
});

test("the renderer honours a view box and draws forces in transit", () => {
  const world = generateWorld("Kittycat", "intermediate");
  const plain = renderMapSvg(world);
  assert.match(plain, /viewBox="0.0 0.0 1000.0 700.0"/);

  const zoomed = renderMapSvg(world, {
    view: { x: 100, y: 50, w: 400, h: 280 },
    markers: [{ at: { x: 123.5, y: 234.5 }, label: "42", hostile: true }],
  });
  assert.match(zoomed, /viewBox="100.0 50.0 400.0 280.0"/);
  assert.match(zoomed, /class="in-transit hostile"/);
  assert.match(zoomed, /cx="123.5" cy="234.5"/);
  assert.match(zoomed, />42</);
  // The ocean covers the field, not the view, so a pan never reveals bare paper.
  assert.match(zoomed, /<rect x="0" y="0" width="1000" height="700"/);
  assert.ok(!plain.includes("in-transit"), "no markers unless asked for");

  for (const cls of ["in-transit", "in-transit-label", "highlight.inspected", "highlight.held"]) {
    assert.ok(css.includes(cls), `style.css does not style .${cls}`);
  }
});
