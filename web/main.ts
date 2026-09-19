/**
 * Browser front end.
 *
 * No framework: the whole of the state is one `Game`, and each phase renders its own
 * panel. Two things are worth care. The production screen shows the pro-rata
 * redistribution *as you change it* — §3.6 notes that the original's confusion was a UI
 * failure rather than a mechanical one, so the mechanic is kept and made visible. And the
 * execution phase replays the turn's marches one at a time rather than cutting straight
 * to the result, because the ordering rules (§5.6, and waves within a battle) are
 * invisible otherwise.
 */
import { commoditiesFor, commodityLabel } from "../src/data.ts";
import { Economy } from "../src/economy.ts";
import {
  Game,
  balanceAllocation,
  moveWorkers,
  subsistenceAllocation,
  workersFor,
  type Allocation,
  type GameSnapshot,
  type Ranking,
  type TurnReport,
} from "../src/game.ts";
import { NATION_FILL, continentBounds, renderMapSvg, type Rect } from "../src/svg.ts";
import { generateWorld, nationState } from "../src/worldgen.ts";
import type { CommodityId, EconomyResult, Land, Level, Point, World } from "../src/types.ts";

const economy = new Economy();
const you = 0;

let game: Game;
/** Uncommitted allocation, so a change can be previewed before it is applied. */
let draft: Allocation = subsistenceAllocation();
/** Province being given orders, in the orders phase. */
let selected: number | null = null;
/** What the inspector is showing. */
let inspect: { kind: "province" | "nation"; id: number } | null = null;
let notice = "";
let expanded = false;
let view: Rect;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Resources are shown rounded down, never up: a factory with 16.7 tons has 16 whole tons
 * to give anyone. Applied to negatives too, so a 16.7-ton shortfall reads as -17 — the
 * whole tons you would have to find to cover it.
 */
const whole = (n: number) => String(Math.floor(n));

const nationName = (id: number) => game.world.nations[id]?.name ?? `Nation ${id}`;

/** What this difficulty offers (§1.1): beginner 12 commodities, intermediate 19, expert 33. */
const levelCommodities = () => commoditiesFor(game.world.level, economy.graph.table.keys());

function context() {
  const { land, population } = nationState(game.world, you);
  return { level: game.world.level, land, population };
}

const spareWorkers = () => {
  const { land, population } = nationState(game.world, you);
  return Math.floor(Math.max(0, population - land.farmland));
};

const resolveDraft = (allocation: Allocation): EconomyResult => {
  const ctx = context();
  return economy.resolve({ ...ctx, workers: workersFor(allocation, ctx.population, ctx.land.farmland) });
};

const acresOf = (land: Land) => land.farmland + land.forest + land.mountains + land.desert;
const fill = (nation: number) => NATION_FILL[nation % NATION_FILL.length]!;

// --- replay state ----------------------------------------------------------------

interface Step {
  from: number;
  to: number;
  force: number;
  hostile: boolean;
  text: string;
  taken: boolean;
  apply: (w: World) => void;
}

/** During a replay the map shows this instead of the real world. */
let replayWorld: World | null = null;
let replayMarkers: { at: Point; label: string; hostile: boolean }[] = [];
let replayLog: { text: string; taken: boolean }[] = [];
let replaying = false;
let skipReplay = false;
/** Set between resolving the turn and the replay starting, so victory waits for it. */
let replayPending = false;

// --- map -------------------------------------------------------------------------

const shownWorld = () => replayWorld ?? game.world;

function legalTargets(): Map<number, boolean> {
  const map = new Map<number, boolean>();
  if (selected === null) return map;
  for (const n of game.world.provinces[selected]!.neighbours) map.set(n.province, n.road);
  return map;
}

/** Ordered marches, so the map shows the plan and not just the orders table. */
function marches(): { from: number; to: number; hostile: boolean }[] {
  if (game.phase !== "military-orders" || replaying) return [];
  return Object.entries(game.orders).flatMap(([from, order]) => {
    const id = Number(from);
    if (order.target === null || game.world.provinces[id]!.nation !== you) return [];
    return [{ from: id, to: order.target, hostile: game.world.provinces[order.target]!.nation !== you }];
  });
}

function drawMap(): void {
  const world = shownWorld();
  el("map").innerHTML = renderMapSvg(world, {
    selected,
    targets: game.phase === "military-orders" ? legalTargets() : undefined,
    firepower: true,
    marches: marches(),
    markers: replayMarkers,
    view,
  });
  const svg = el("map").querySelector("svg")!;
  for (const node of svg.querySelectorAll<SVGElement>("[data-province]")) {
    const id = Number(node.dataset.province);
    if (world.provinces[id]!.nation === you) node.classList.add("mine");
  }
  // What the inspector is looking at, outlined separately from the order selection —
  // you are often reading about one province while ordering another.
  const looking =
    inspect?.kind === "province"
      ? world.provinces.filter((p) => p.id === inspect!.id && p.id !== selected)
      : inspect?.kind === "nation"
        ? world.provinces.filter((p) => p.nation === inspect!.id)
        : [];
  if (looking.length > 0) {
    // A whole nation is outlined in white: at eight provinces the outline is most of the
    // map, and white is the one colour no nation fill or terrain mark uses.
    const kind = inspect!.kind === "nation" ? "held" : "inspected";
    svg.insertAdjacentHTML("beforeend", looking
      .map((p) => `<polygon class="highlight ${kind}" fill="none" pointer-events="none" points="${
        p.border.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ")}"/>`)
      .join(""));
  }
  el("map-hint").textContent = replaying
    ? "Replaying the turn's marches."
    : game.phase === "military-orders"
      ? selected === null
        ? "Click an armed province to order it. Solid outlines are roads; dashed cost three quarters of your strength."
        : `Ordering ${game.world.provinces[selected]!.name}. Click a neighbour — yours to reinforce, anyone else's to attack — or itself to hold.`
      : "Click a province for its details. Drag to pan, scroll to zoom.";
}

/** Cheap view update: the geometry has not changed, only the window onto it. */
function applyView(): void {
  el("map").querySelector("svg")?.setAttribute(
    "viewBox",
    `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`,
  );
  placeMarchControl();
}

/** World coordinates to a position within the map pane. The inverse of `toWorld`. */
function toPane(at: Point): { left: number; top: number } | null {
  const svg = el("map").querySelector("svg");
  const pane = document.querySelector(".map-pane");
  if (!svg || !pane) return null;
  const r = svg.getBoundingClientRect();
  const box = pane.getBoundingClientRect();
  const scale = Math.min(r.width / view.w, r.height / view.h);
  return {
    left: r.x - box.x + (r.width - view.w * scale) / 2 + (at.x - view.x) * scale,
    top: r.y - box.y + (r.height - view.h * scale) / 2 + (at.y - view.y) * scale,
  };
}

/**
 * The march control sits on the map beside the province it is ordering, so the number
 * being set is next to the thing being ordered rather than in a table across the page.
 */
function marchControlHtml(): string {
  if (selected === null || game.phase !== "military-orders" || replaying) return "";
  const p = game.world.provinces[selected];
  const order = game.orders[selected];
  if (!p || !order || order.target === null) return "";
  const target = game.world.provinces[order.target]!;
  const cap = Math.floor(p.firepower);
  const send = sentFrom(selected);
  return `${target.nation === you ? "reinforce" : "<b>attack</b>"} ${target.name}
    <button type="button" data-mstep="${p.id}" data-by="-1">&minus;</button
    ><input type="number" data-send="${p.id}" value="${send}" min="0" max="${cap}" step="1"
      aria-label="firepower sent from ${p.name}" /><button
      type="button" data-mstep="${p.id}" data-by="1">+</button>
    <input type="range" min="0" max="${cap}" value="${send}" data-march="${p.id}" />
    <span class="spare">of ${cap}</span>`;
}

function placeMarchControl(): void {
  const box = el("march-control");
  if (box.hidden || selected === null) return;
  const p = game.world.provinces[selected];
  const at = p && toPane({ x: p.capital.x, y: p.capital.y + 14 });
  if (!at) return;
  box.style.left = `${at.left}px`;
  box.style.top = `${at.top}px`;
}

const MIN_VIEW = 80;

function clampView(next: Rect): Rect {
  const { width, height } = game.world;
  const w = Math.min(width, Math.max(MIN_VIEW, next.w));
  const h = Math.min(height, Math.max(MIN_VIEW * (height / width), next.h));
  return {
    w,
    h,
    x: Math.min(Math.max(0, next.x), width - w),
    y: Math.min(Math.max(0, next.y), height - h),
  };
}

/**
 * Client coordinates to world coordinates. The SVG letterboxes to preserve the aspect
 * ratio, so the scale is the smaller of the two fits and the remainder is a margin.
 */
function toWorld(cx: number, cy: number): Point {
  const svg = el("map").querySelector("svg");
  if (!svg) return { x: 0, y: 0 };
  const r = svg.getBoundingClientRect();
  const scale = Math.min(r.width / view.w, r.height / view.h);
  return {
    x: view.x + (cx - r.x - (r.width - view.w * scale) / 2) / scale,
    y: view.y + (cy - r.y - (r.height - view.h * scale) / 2) / scale,
  };
}

function zoomAbout(cx: number, cy: number, factor: number): void {
  const anchor = toWorld(cx, cy);
  const w = view.w / factor;
  const h = view.h / factor;
  view = clampView({
    w,
    h,
    x: anchor.x - ((anchor.x - view.x) / view.w) * w,
    y: anchor.y - ((anchor.y - view.y) / view.h) * h,
  });
  applyView();
}

el("map").addEventListener("wheel", (event) => {
  if (!game) return;
  event.preventDefault();
  zoomAbout(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
}, { passive: false });

// Pan on drag, and treat a pointer that barely moved as a click so the two do not fight.
let drag: { cx: number; cy: number; view: Rect; moved: number } | null = null;

el("map").addEventListener("pointerdown", (event) => {
  if (!game || event.button !== 0) return;
  drag = { cx: event.clientX, cy: event.clientY, view: { ...view }, moved: 0 };
  el("map").querySelector("svg")?.classList.add("panning");
});

addEventListener("pointermove", (event) => {
  if (!drag) return;
  const svg = el("map").querySelector("svg");
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const scale = Math.min(r.width / drag.view.w, r.height / drag.view.h);
  const dx = event.clientX - drag.cx;
  const dy = event.clientY - drag.cy;
  drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
  view = clampView({ ...drag.view, x: drag.view.x - dx / scale, y: drag.view.y - dy / scale });
  applyView();
});

addEventListener("pointerup", (event) => {
  if (!drag) return;
  const wasClick = drag.moved < 4;
  drag = null;
  el("map").querySelector("svg")?.classList.remove("panning");
  if (!wasClick || replaying) return;

  const node = (event.target as Element | null)?.closest<SVGElement>("[data-province]");
  if (!node) return;
  const id = Number(node.dataset.province);
  inspect = { kind: "province", id };

  if (game.phase === "military-orders") {
    const orderable = (q: number) =>
      game.world.provinces[q]!.nation === you && game.world.provinces[q]!.firepower >= 1;
    if (selected === null) {
      if (orderable(id)) selected = id;
    } else if (id === selected) {
      game.setOrder(selected, { marchFraction: game.orders[selected]?.marchFraction ?? 1, target: null });
      selected = null;
    } else if (legalTargets().has(id)) {
      // The province stays selected, so the control that appears beside it can be used
      // without hunting for the row in the table.
      game.setOrder(selected, { marchFraction: game.orders[selected]?.marchFraction ?? 1, target: id });
    } else if (orderable(id)) {
      selected = id;
    }
  }
  render();
});

el("zoom-in").addEventListener("click", () => {
  const r = el("map").getBoundingClientRect();
  zoomAbout(r.x + r.width / 2, r.y + r.height / 2, 1.4);
});
el("zoom-out").addEventListener("click", () => {
  const r = el("map").getBoundingClientRect();
  zoomAbout(r.x + r.width / 2, r.y + r.height / 2, 1 / 1.4);
});
el("zoom-fit").addEventListener("click", () => {
  view = continentBounds(game.world);
  applyView();
});

// --- inspector -------------------------------------------------------------------

const terrainRows = (land: Land) => `
  <dt>Farmland</dt><dd>${whole(land.farmland)} acres</dd>
  <dt>Forest</dt><dd>${whole(land.forest)} acres</dd>
  <dt>Mountains</dt><dd>${whole(land.mountains)} acres</dd>
  <dt>Desert</dt><dd>${whole(land.desert)} acres</dd>
  <dt><b>Total land</b></dt><dd><b>${whole(acresOf(land))} acres</b></dd>`;

function inspectorHtml(): string {
  if (!inspect) return "";
  if (inspect.kind === "province") {
    const p = shownWorld().provinces[inspect.id];
    if (!p) return "";
    return `<h2>${p.name}<span class="right"><button type="button" data-act="close">Close</button></span></h2>
      <dl>
        <dt>Ruled by</dt><dd>${nationName(p.nation)}${p.nation === you ? " (you)" : ""}</dd>
        <dt>Population</dt><dd>${whole(p.population)}</dd>
        <dt>Military power</dt><dd>${whole(p.firepower)}</dd>
        ${terrainRows(p.land)}
        <dt>Coast</dt><dd>${p.coastal ? "yes" : "inland"}</dd>
        <dt>Neighbours</dt><dd>${p.neighbours.length} (${p.neighbours.filter((n) => n.road).length} by road)</dd>
      </dl>`;
  }

  const r = game.rankings().find((x) => x.nation === inspect!.id);
  if (!r) return "";
  const own = r.nation === you;
  return `<h2>${nationName(r.nation)}${own ? " (you)" : ""}
      <span class="right"><button type="button" data-act="close">Close</button></span></h2>
    <dl>
      <dt>Military strength</dt><dd>${whole(r.firepower)}</dd>
      <dt>Population</dt><dd>${whole(r.population)}</dd>
      <dt>Provinces</dt><dd>${r.provinces}</dd>
      ${terrainRows(r.land)}
      <dt>Food output</dt>
      <dd>${own
        ? whole(resolveDraft(draft).agriculture.food)
        : '<span class="secret">a national secret</span>'}</dd>
    </dl>`;
}

function nationsHtml(): string {
  const rows = game
    .rankings()
    .filter((r) => r.provinces > 0)
    .map((r) => `<li class="${r.nation === you ? "you" : ""} ${
      inspect?.kind === "nation" && inspect.id === r.nation ? "open" : ""
    }" data-nation="${r.nation}">
      <span class="swatch" style="background:${fill(r.nation)}"></span>
      ${nationName(r.nation)}${r.nation === you ? " (you)" : ""}
      <span class="num">${whole(r.population)} people &middot; ${r.provinces} prov</span>
    </li>`)
    .join("");
  return `<h2>Nations <small>standing by population</small></h2>
    <ul class="nations">${rows}</ul>
    <p class="hint">Click one for its strength and territory. Food output is a national secret.</p>`;
}

// --- production ------------------------------------------------------------------

function productionPanel(): string {
  const result = resolveDraft(draft);
  const spare = spareWorkers();
  const ctx = context();
  const workers = workersFor(draft, ctx.population, ctx.land.farmland);
  const rows = levelCommodities();
  const used = Object.values(workers).reduce((s, v) => s + v, 0);
  const idle = spare - used;

  const body = rows
    .map((id) => {
      const c = result.commodities[id];
      if (!c) return "";
      const w = workers[id] ?? 0;
      const locked = game.isLocked(you, id);
      const limited = c.limitingFactor !== "Labor";
      return `<tr class="${w === 0 ? "idle" : ""} ${limited ? "limited" : ""} ${
        c.surplus < -0.5 ? "deficit" : ""
      }" data-row="${id}">
        <td class="lock"><input type="checkbox" data-lock="${id}" ${locked ? "checked" : ""}
          title="Lock this factory against redistribution" /></td>
        <td class="name">${commodityLabel(id)}</td>
        <td data-cell="cap" class="capacity">${whole(c.capacity)}</td>
        <td data-cell="out">${whole(c.output)}</td>
        <td data-cell="sur" class="${c.surplus < -0.5 ? "short" : c.surplus > 0.5 ? "spare" : ""}">${whole(c.surplus)}</td>
        <td data-cell="lim" class="lim">${c.limitingFactor === "Labor" ? "&mdash;" : commodityLabel(c.limitingFactor)}</td>
        <td class="tune">
          <button type="button" data-step="${id}" data-by="-1" ${locked ? "disabled" : ""}>&minus;</button
          ><input type="number" data-workers="${id}" value="${w}" min="0" max="${spare}" step="1"
            ${locked ? "disabled" : ""} aria-label="workers in ${commodityLabel(id)}" /><button
            type="button" data-step="${id}" data-by="1" ${locked ? "disabled" : ""}>+</button>
        </td>
        <td class="slider"><input type="range" min="0" max="${spare}" value="${w}"
          data-slider="${id}" ${locked ? "disabled" : ""} /></td>
      </tr>`;
    })
    .join("");

  return `<h2>Production <small>turn ${game.turn}</small>
      <span class="right"><button type="button" data-act="expand">${expanded ? "Shrink" : "Expand"}</button></span>
    </h2>
    <table class="production">
      <colgroup>
        <col class="c-lock" /><col class="c-name" /><col class="c-num" /><col class="c-num" />
        <col class="c-num" /><col class="c-short" /><col class="c-tune" /><col class="c-slider" />
      </colgroup>
      <thead><tr>
        <th class="lock">&#128274;</th><th class="name">Factory</th>
        <th title="What its workers could make">Size</th>
        <th title="What it actually made">Output</th><th>Surplus</th><th>Short of</th>
        <th>Workers</th><th class="slider"></th>
      </tr></thead>
      <tbody>${body}
        <tr class="idle-row" data-row="__idle">
          <td></td><td class="name">Idle</td><td></td><td></td><td></td>
          <td class="lim">${idle > 0 ? "unspent labour" : "&mdash;"}</td>
          <td class="tune" data-cell="idle">${whole(idle)}</td><td class="slider"></td>
        </tr>
      </tbody>
      <tfoot id="food">${foodHtml(result)}</tfoot>
    </table>
    <div class="totals" id="totals">${totalsHtml(result, ctx.land)}</div>
    <div class="controls">
      <button type="button" data-act="auto">Auto-balance</button>
      <button type="button" data-act="lock-all">Lock all</button>
      <button type="button" data-act="unlock-all">Unlock all</button>
    </div>`;
}

/**
 * The food rows. Kept separate because they have to be refreshed alongside the factory
 * rows as the allocation changes — leaving them out of `refreshNumbers` is what made
 * food look like it never responded to tool production at all.
 */
function foodHtml(result: EconomyResult): string {
  const a = result.agriculture;
  const toolTons = Object.values(a.toolsUsed).reduce((s, v) => s + v, 0);
  const fromTools = a.food - a.acres;
  return `<tr class="total ${a.surplus < 0 ? "deficit" : ""}">
      <td></td><td class="name">Food</td><td class="capacity">${whole(a.acres)} ac</td>
      <td>${whole(a.food)}</td>
      <td class="${a.surplus < 0 ? "short" : "spare"}">${whole(a.surplus)}</td>
      <td class="lim">needs ${whole(a.required)}</td>
      <td>${whole(a.workers)} farming</td><td class="slider"></td>
    </tr>
    <tr>
      <td colspan="8" class="spare wrap">
        ${whole(a.acres)} from the land + ${whole(fromTools)} from
        ${whole(toolTons)} tons of tools${toolTons > 0 ? "" : " (none made yet)"};
        tools are capped at one ton per acre, so at most ${whole(a.acres)} tons can be used
      </td>
    </tr>`;
}

function totalsHtml(result: EconomyResult, land: Land): string {
  const growing = result.nextPopulation >= result.population;
  return `<b>Population:</b> ${whole(result.population)} &rarr;
      <span class="${growing ? "growing" : "starving"}">${whole(result.nextPopulation)}</span><br />
    <b>Firepower:</b> ${whole(result.firepower)} this turn<br />
    <span class="spare"><b>Land:</b> ${whole(land.farmland)} farm, ${whole(land.forest)} forest,
      ${whole(land.mountains)} mountain, ${whole(land.desert)} desert</span>`;
}

/**
 * Refresh the numbers in place while a control is being used.
 *
 * Re-rendering the panel would tear the input out from under the pointer, and the whole
 * point is to watch the other factories move as this one is changed.
 *
 * `editing` is the one control not to write back to — the box being typed into, whose
 * value is already what the user meant.
 */
function refreshNumbers(editing?: Element | null): void {
  const result = resolveDraft(draft);
  const ctx = context();
  const workers = workersFor(draft, ctx.population, ctx.land.farmland);
  const spare = spareWorkers();

  for (const row of document.querySelectorAll<HTMLTableRowElement>("[data-row]")) {
    const id = row.dataset.row!;
    const c = result.commodities[id];
    if (!c) continue;
    const w = workers[id] ?? 0;
    row.querySelector<HTMLElement>('[data-cell="cap"]')!.textContent = whole(c.capacity);
    row.querySelector<HTMLElement>('[data-cell="out"]')!.textContent = whole(c.output);
    const sur = row.querySelector<HTMLElement>('[data-cell="sur"]')!;
    sur.textContent = whole(c.surplus);
    sur.className = c.surplus < -0.5 ? "short" : c.surplus > 0.5 ? "spare" : "";
    row.querySelector<HTMLElement>('[data-cell="lim"]')!.textContent =
      c.limitingFactor === "Labor" ? "—" : commodityLabel(c.limitingFactor);
    row.classList.toggle("limited", c.limitingFactor !== "Labor");
    row.classList.toggle("deficit", c.surplus < -0.5);
    row.classList.toggle("idle", w === 0);
    for (const input of row.querySelectorAll<HTMLInputElement>("[data-slider], [data-workers]")) {
      if (input !== editing) input.value = String(w);
    }
  }
  const used = Object.values(workers).reduce((s, v) => s + v, 0);
  const idleCell = document.querySelector<HTMLElement>('[data-cell="idle"]');
  if (idleCell) idleCell.textContent = String(spare - used);
  el("food").innerHTML = foodHtml(result);
  el("totals").innerHTML = totalsHtml(result, ctx.land);
}

/**
 * Move one factory to a worker count, redistributing the rest pro rata (§3.6).
 *
 * The share is nudged until the rounding actually lands on the count asked for. Worker
 * counts come from a largest-remainder split of the whole workforce, so setting a share
 * of `n / spare` does not reliably yield `n` — and when it did not, the spare worker went
 * to some unrelated factory, which is what made adding one worker to muskets look like it
 * was raising the gunpowder surplus.
 */
function setWorkers(id: CommodityId, count: number): void {
  const spare = spareWorkers();
  if (spare <= 0) return;
  const next = moveWorkers(currentWorkers(), id, count, game.locked[you] ?? [], spare);
  const shares: Record<CommodityId, number> = {};
  for (const [k, v] of Object.entries(next)) shares[k] = v / spare;
  draft = shares;
}

/** Whole workers per factory, covering every commodity this level offers. */
function currentWorkers(): Record<CommodityId, number> {
  const ctx = context();
  const now = workersFor(draft, ctx.population, ctx.land.farmland);
  const out: Record<CommodityId, number> = {};
  for (const id of levelCommodities()) out[id] = now[id] ?? 0;
  return out;
}

// --- other phases ----------------------------------------------------------------

/** Firepower actually marching from a province, as a whole number. */
function sentFrom(province: number): number {
  const p = game.world.provinces[province];
  const order = game.orders[province];
  if (!p || !order || order.target === null) return 0;
  return Math.min(Math.floor(p.firepower), Math.floor(p.firepower * order.marchFraction));
}

function ordersPanel(): string {
  const armed = game.world.provinces.filter((p) => p.nation === you && p.firepower >= 1);
  const rows = armed
    .map((p) => {
      const target = game.orders[p.id]?.target ?? null;
      const cap = Math.floor(p.firepower);
      const send = sentFrom(p.id);
      const off = target === null ? "disabled" : "";
      return `<tr>
        <td>${p.name}</td><td>${whole(p.firepower)}</td>
        <td>${target === null ? '<span class="spare">holding</span>'
          : game.world.provinces[target]!.nation === you
            ? `reinforce ${game.world.provinces[target]!.name}`
            : `<b>attack ${game.world.provinces[target]!.name}</b>`}</td>
        <td class="tune">
          <button type="button" data-mstep="${p.id}" data-by="-1" ${off}>&minus;</button
          ><input type="number" data-send="${p.id}" value="${send}" min="0" max="${cap}" step="1"
            ${off} aria-label="firepower sent from ${p.name}" /><button
            type="button" data-mstep="${p.id}" data-by="1" ${off}>+</button>
        </td>
        <td class="slider"><input type="range" min="0" max="${cap}" value="${send}"
          data-march="${p.id}" ${off} /></td>
      </tr>`;
    })
    .join("");

  return `<h2>Military orders <small>turn ${game.turn}</small></h2>
    ${armed.length === 0
      ? '<p class="spare">No armed provinces. Put workers into swords during production.</p>'
      : `<table class="orders">
           <colgroup>
             <col class="c-name" /><col class="c-num" /><col class="c-order" />
             <col class="c-tune" /><col class="c-slider" />
           </colgroup>
           <thead><tr>
             <th>Province</th><th>Power</th><th>Order</th><th>Send</th><th class="slider"></th>
           </tr></thead><tbody>${rows}</tbody></table>`}
    <p class="hint">An attack loses 10 firepower on arrival and the defender fights with 10
      more, so an empty province still needs over 20 by road &mdash; over 50 across country.</p>`;
}

function executionPanel(): string {
  return `<h2>Execution <small>turn ${game.turn}</small>
      ${replaying ? '<span class="right"><button type="button" data-act="skip">Skip</button></span>' : ""}
    </h2>
    ${replayLog.length === 0
      ? `<p class="spare">${replaying ? "Marching&hellip;" : "A quiet turn &mdash; nothing marched."}</p>`
      : `<ul class="log">${replayLog
          .map((l, i) => `<li class="${l.taken ? "taken" : ""} ${
            i === replayLog.length - 1 && replaying ? "now" : ""
          }">${l.text}</li>`)
          .join("")}</ul>`}`;
}

function rankingsPanel(): string {
  const rows = game
    .rankings()
    .map((r: Ranking) => `<div class="${r.nation === you ? "you" : ""} ${
      inspect?.kind === "nation" && inspect.id === r.nation ? "open" : ""
    }" data-nation="${r.nation}">
      <dt>${nationName(r.nation)}${r.nation === you ? " (you)" : ""}</dt>
      <dd>${whole(r.population)} people &middot; ${r.provinces} provinces
        &middot; ${whole(r.firepower)} firepower</dd>
    </div>`)
    .join("");
  return `<h2>Rankings <small>end of turn ${game.turn}</small></h2>
    <p class="hint">Standing is population. Not territory, not firepower &mdash; which is
      what makes arming yourself expensive.</p>
    <dl class="rank">${rows}</dl>`;
}

// --- replaying the turn ----------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build the marches to replay, in the order `resolveMilitary` resolved them (§5.6). */
function replaySteps(before: World, report: TurnReport): Step[] {
  const name = (id: number) => before.provinces[id]!.name;
  const steps: Step[] = [];

  for (const t of report.transfers) {
    steps.push({
      from: t.from, to: t.to, force: t.firepower, hostile: false, taken: false,
      text: `${whole(t.firepower)} marches ${name(t.from)} &rarr; ${name(t.to)}`,
      apply: (w) => { w.provinces[t.to]!.firepower += t.firepower; },
    });
  }

  for (const b of report.battles) {
    for (const wave of b.waves) {
      const captured = wave.captured;
      const nation = before.provinces[wave.from]!.nation;
      steps.push({
        from: wave.from, to: b.target, force: wave.committed, hostile: true, taken: captured,
        text: `${whole(wave.committed)} from ${name(wave.from)} attacks ${name(b.target)} ` +
          `${wave.viaRoad ? "by road" : "across country, quartered"}: ${whole(wave.effective)} ` +
          `against ${whole(wave.defenceBefore)} &mdash; ` +
          (captured ? `<b>taken</b>, ${whole(wave.survivors)} hold it` : "repulsed"),
        apply: (w) => {
          const target = w.provinces[b.target]!;
          if (captured) {
            target.nation = nation;
            target.firepower = wave.survivors;
          } else {
            target.firepower = Math.max(0, wave.defenceBefore - wave.effective);
          }
        },
      });
    }
    if (b.civilianLoss > 0) {
      steps.push({
        from: b.target, to: b.target, force: 0, hostile: true, taken: b.captured,
        text: `${name(b.target)} loses ${whole(b.civilianLoss)} civilians to the fighting`,
        apply: (w) => {
          const target = w.provinces[b.target]!;
          target.population = Math.max(0, target.population - b.civilianLoss);
        },
      });
    }
  }
  return steps;
}

/** Travel a marker from one capital to another, redrawing as it goes. */
async function travel(step: Step, world: World): Promise<void> {
  const a = world.provinces[step.from]!.capital;
  const b = world.provinces[step.to]!.capital;
  const label = whole(step.force);
  const start = performance.now();
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / MARCH_MS);
    replayMarkers = [{
      at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      label,
      hostile: step.hostile,
    }];
    drawMap();
    if (t >= 1 || skipReplay) break;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  replayMarkers = [];
}

/** Half the speed it first ran at: the first pass was too quick to follow. */
const MARCH_MS = 840;
const BEAT_MS = 560;

async function replay(before: World, report: TurnReport): Promise<void> {
  const steps = replaySteps(before, report);
  // A quiet turn has nothing to show, and pausing on it would only stall the player.
  if (steps.length === 0) return;
  const stage = structuredClone(before);

  // Marching forces leave home before anything resolves (§5.6), which is why a province
  // that empties itself is genuinely undefended when a counter-attack lands.
  for (const [id, order] of Object.entries(game.orders)) {
    if (order.target === null) continue;
    const p = stage.provinces[Number(id)]!;
    p.firepower = Math.max(0, p.firepower - p.firepower * Math.min(1, Math.max(0, order.marchFraction)));
  }

  replaying = true;
  skipReplay = false;
  replayWorld = stage;
  replayLog = [];
  render();
  await sleep(BEAT_MS / 2);

  for (const step of steps) {
    if (step.from !== step.to && !skipReplay) await travel(step, stage);
    step.apply(stage);
    replayLog = [...replayLog, { text: step.text, taken: step.taken }];
    render();
    if (!skipReplay) await sleep(BEAT_MS);
  }

  replaying = false;
  replayWorld = null;
  replayMarkers = [];
  render();
}

// --- shell -----------------------------------------------------------------------

const PHASES = [
  ["production", "Production"],
  ["military-orders", "Orders"],
  ["military-execution", "Execution"],
  ["rankings", "Rankings"],
] as const;

function render(): void {
  const index = PHASES.findIndex(([p]) => p === game.phase);
  el("phases").innerHTML = PHASES.map(([p, label], i) =>
    `<span class="${p === game.phase ? "on" : i < index ? "done" : ""}">${label}</span>`).join("");

  const mine = game.rankings().find((r) => r.nation === you);
  el("standing").innerHTML = `Continent <b>${game.world.name}</b> &middot; ${game.world.level}
       &middot; you are <b>${nationName(you)}</b> &middot; ${whole(mine?.population ?? 0)} people,
       ${mine?.provinces ?? 0} provinces`;

  document.body.classList.toggle("expanded", expanded && game.phase === "production");

  el("panel").innerHTML =
    game.phase === "production" ? productionPanel()
    : game.phase === "military-orders" ? ordersPanel()
    : game.phase === "military-execution" ? executionPanel()
    : rankingsPanel();

  const inspectorEl = el("inspector");
  inspectorEl.innerHTML = inspectorHtml();
  inspectorEl.hidden = inspectorEl.innerHTML === "";
  el("nations").innerHTML = nationsHtml();

  const advance = el<HTMLButtonElement>("advance");
  advance.textContent = {
    production: "Begin military orders",
    "military-orders": "Execute orders",
    "military-execution": "See rankings",
    rankings: "Next turn",
  }[game.phase];
  advance.className = "primary";
  advance.disabled = replaying;
  el("undo").hidden = game.phase !== "rankings";
  el("notice").textContent = notice;
  drawMap();

  const control = el("march-control");
  control.innerHTML = marchControlHtml();
  control.hidden = control.innerHTML.trim() === "";
  placeMarchControl();

  if (game.winner !== null && !replaying && !replayPending) showSplash(game.winner);
}

function showSplash(winner: number): void {
  const won = winner === you;
  el("splash-title").textContent = won ? "The world is yours" : `${nationName(winner)} has conquered the world`;
  const turns = `${game.turn} turn${game.turn === 1 ? "" : "s"}`;
  el("splash-body").textContent = won
    ? `${nationName(you)} holds every province on ${game.world.name}, after ${turns}.`
    : `${nationName(winner)} holds every province on ${game.world.name}. ${nationName(you)} is no more.`;
  el("splash-rank").innerHTML = game
    .rankings()
    .map((r) => `<div class="${r.nation === you ? "you" : ""}">
      <dt>${nationName(r.nation)}${r.nation === you ? " (you)" : ""}</dt>
      <dd>${whole(r.population)} people &middot; ${r.provinces} provinces</dd>
    </div>`)
    .join("");
  el("splash").hidden = false;
}

// --- events ----------------------------------------------------------------------

document.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.slider || target.dataset.workers) {
    const id = (target.dataset.slider ?? target.dataset.workers) as CommodityId;
    setWorkers(id, Number(target.value));
    refreshNumbers(target);
  } else if (target.dataset.march || target.dataset.send) {
    const province = Number(target.dataset.march ?? target.dataset.send);
    const order = game.orders[province];
    if (order && order.target !== null) {
      const power = game.world.provinces[province]!.firepower;
      game.setOrder(province, {
        ...order,
        marchFraction: power > 0 ? Math.min(1, Math.max(0, Number(target.value) / power)) : 0,
      });
      // Siblings follow the order as clamped, not the text as typed: `max` on a number
      // input does not stop someone typing past it.
      const sent = String(sentFrom(province));
      for (const other of document.querySelectorAll<HTMLInputElement>(
        `[data-march="${province}"], [data-send="${province}"]`,
      )) {
        if (other !== target) other.value = sent;
      }
    }
  }
});

document.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.lock) {
    const id = target.dataset.lock as CommodityId;
    notice = game.toggleLock(you, id)
      ? `${commodityLabel(id)} locked — redistribution will leave it alone.`
      : `${commodityLabel(id)} unlocked.`;
    render();
  } else if (target.dataset.workers) {
    // Commit clamps: `max` does not stop anyone typing past it.
    const ctx = context();
    const w = workersFor(draft, ctx.population, ctx.land.farmland)[target.dataset.workers] ?? 0;
    target.value = String(w);
  } else if (target.dataset.send) {
    target.value = String(sentFrom(Number(target.dataset.send)));
  }
});

document.addEventListener("click", (event) => {
  const node = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-act], [data-step], [data-mstep], [data-nation]",
  );
  if (!node) return;

  if (node.dataset.step) {
    const id = node.dataset.step as CommodityId;
    setWorkers(id, (currentWorkers()[id] ?? 0) + Number(node.dataset.by));
    refreshNumbers();
    return;
  }
  if (node.dataset.mstep) {
    const province = Number(node.dataset.mstep);
    const order = game.orders[province];
    const power = game.world.provinces[province]!.firepower;
    if (order && order.target !== null && power > 0) {
      const send = sentFrom(province) + Number(node.dataset.by);
      game.setOrder(province, { ...order, marchFraction: Math.min(1, Math.max(0, send / power)) });
      render();
    }
    return;
  }
  if (node.dataset.nation) {
    const id = Number(node.dataset.nation);
    inspect = inspect?.kind === "nation" && inspect.id === id ? null : { kind: "nation", id };
    render();
    return;
  }

  switch (node.dataset.act) {
    case "close":
      inspect = null;
      break;
    case "expand":
      expanded = !expanded;
      break;
    case "skip":
      skipReplay = true;
      return;
    case "auto": {
      const before = draft;
      draft = balanceAllocation(economy, draft, context(), 80, game.locked[you] ?? []);
      notice = Object.keys(draft).some((id) => Math.abs((draft[id] ?? 0) - (before[id] ?? 0)) > 1e-9)
        ? "Balanced around the locked factories."
        : "Nothing to balance — everything involved is locked.";
      break;
    }
    case "lock-all":
      game.lockAll(you);
      notice = "All factories locked. Unlock the ones you mean to change.";
      break;
    case "unlock-all":
      game.unlockAll(you);
      notice = "All factories unlocked.";
      break;
    default:
      return;
  }
  render();
});

el("advance").addEventListener("click", async () => {
  if (replaying) return;
  notice = "";
  if (game.phase === "production") game.setAllocation(you, draft);

  // Combat resolves on the way into execution, so the replay runs *during* that phase —
  // after Execute orders and before See rankings.
  const animate = game.phase === "military-orders";
  const before = animate ? structuredClone(game.world) : null;

  replayPending = animate;
  const report = game.advance();
  if (game.phase === "production") {
    draft = game.allocations[you] ?? draft;
    replayLog = [];
  }
  selected = null;
  render();

  if (animate && before && report) {
    await replay(before, report);
    replayPending = false;
    render();
  }
  replayPending = false;
  save();
});

el("undo").addEventListener("click", () => {
  game.undoTurn();
  save();
  draft = game.allocations[you] ?? draft;
  replayLog = [];
  selected = null;
  inspect = null;
  notice = "Turn undone.";
  render();
});

// --- saving ----------------------------------------------------------------------

const SAVE = "guns-or-butter/save";

interface Saved {
  snapshot: GameSnapshot;
  draft: Allocation;
}

/**
 * Autosave, so a refresh resumes rather than starts over.
 *
 * `GameSnapshot` holds the world, the turn and the allocations but not the phase or the
 * orders, so a resume lands at the start of the saved turn. That is the honest thing to
 * restore: half a turn of orders is not a state the game has a name for.
 */
function save(): void {
  try {
    const payload: Saved = { snapshot: game.snapshot(), draft };
    localStorage.setItem(SAVE, JSON.stringify(payload));
  } catch {
    // A full or blocked store is not worth interrupting a game over.
  }
}

function saved(): Saved | null {
  try {
    const raw = localStorage.getItem(SAVE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Saved;
    return parsed?.snapshot?.world?.provinces?.length ? parsed : null;
  } catch {
    return null;
  }
}

function offerResume(): void {
  const found = saved();
  const button = el<HTMLButtonElement>("resume");
  button.hidden = found === null;
  if (found) {
    const world = found.snapshot.world;
    button.textContent = `Resume ${world.nations[0]?.name ?? "your game"} on ${world.name}, turn ${found.snapshot.turn}`;
  }
}

// --- start and finish ------------------------------------------------------------

function begin(continent: string, nation: string, level: Level): void {
  game = Game.fromWorld(generateWorld(continent, level, { playerNation: nation }), economy);
  draft = subsistenceAllocation();
  view = continentBounds(game.world);
  selected = null;
  inspect = null;
  replayLog = [];
  notice = "";
  el("splash").hidden = true;
  el("start").hidden = true;
  render();
  save();
}

el<HTMLFormElement>("start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  begin(
    String(data.get("continent") ?? "").trim() || "Kittycat",
    String(data.get("nation") ?? "").trim() || "Babylon",
    (String(data.get("level")) || "intermediate") as Level,
  );
});

el("again").addEventListener("click", () => {
  el("splash").hidden = true;
  el("start").hidden = false;
  offerResume();
});

el("resume").addEventListener("click", () => {
  const found = saved();
  if (!found) return;
  game = Game.restore(found.snapshot, economy);
  draft = found.draft ?? game.allocations[you] ?? subsistenceAllocation();
  view = continentBounds(game.world);
  selected = null;
  inspect = null;
  replayLog = [];
  notice = `Resumed at the start of turn ${game.turn}.`;
  el("splash").hidden = true;
  el("start").hidden = true;
  render();
});

el("quit").addEventListener("click", () => {
  save();
  el("splash").hidden = true;
  el("start").hidden = false;
  offerResume();
});

el("exit").addEventListener("click", () => {
  // Only works for a window a script opened, so fall back to saying so plainly.
  window.close();
  el("splash-title").textContent = "Thanks for playing";
  el("splash-body").textContent =
    "Close the tab when you are ready, or start another game.";
  el<HTMLButtonElement>("exit").hidden = true;
});

// A continent in the URL skips the start screen, which is what the test harness uses.
const params = new URLSearchParams(location.search);
if (params.get("continent")) {
  begin(
    params.get("continent")!,
    params.get("nation") ?? "Babylon",
    (params.get("level") ?? "intermediate") as Level,
  );
} else {
  offerResume();
}
