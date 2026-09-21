/**
 * Browser front end. No framework: the state is one `Game` and each phase renders its
 * own panel. §10.1 records what playing it found.
 */
import { ORIGINAL_PRODUCTION_CAP, commoditiesFor, commodityLabel, tierYield } from "../src/data.ts";
import { Economy } from "../src/economy.ts";
import {
  Game,
  balanceAllocation,
  economyFor,
  moveWorkers,
  phasesFor,
  subsistenceAllocation,
  workersFor,
  type Allocation,
  type GameSnapshot,
  type Phase,
  type Ranking,
  type TurnReport,
} from "../src/game.ts";
import { poolOf } from "../src/union.ts";
import { compact, grouped, standing } from "../src/format.ts";
import { NATION_FILL, continentBounds, renderMapSvg, type Rect } from "../src/svg.ts";
import { borderSegments, generateWorld, nationState } from "../src/worldgen.ts";
import type { CommodityId, EconomyResult, Land, Level, Point, World } from "../src/types.ts";

let economy = new Economy();
const you = 0;

let game: Game;
/** Uncommitted allocation, so a change can be previewed before it is applied. */
let draft: Allocation = subsistenceAllocation();
/** Province awaiting a target click, in the orders phase. */
let selected: number | null = null;
/**
 * Province whose placed order the control is showing. Kept apart from `selected` so
 * that placing an order ends the selection, rather than the next click silently
 * retargeting the march.
 */
let ordering: number | null = null;
/** What the inspector is showing. */
type Inspecting =
  | { kind: "province"; id: number }
  | { kind: "nation"; id: number }
  | { kind: "factory"; id: CommodityId }
  /** `id` is the founder, which is what identifies a union for the turn it exists. */
  | { kind: "union"; id: number };
let inspect: Inspecting | null = null;
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

/**
 * Firepower, compactly (§10.1.7). Armies are the one quantity that can run to five
 * digits and beyond; tons and workers stay exact, because balancing an economy needs
 * the difference between 1200 and 1249 and a battle does not.
 */
const power = (n: number) => compact(n, 2);

/** People, grouped in thousands. The standings are read by comparing them. */
const people = grouped;

const nationName = (id: number) => game.world.nations[id]?.name ?? `Nation ${id}`;

/** What this difficulty offers (§1.1): beginner 12 commodities, intermediate 19, expert 33. */
const levelCommodities = () => commoditiesFor(game.world.level, economy.graph.table.keys());

/**
 * The land and population production runs on. In a union that is the pooled total, not
 * your own: §6.1 makes the members one economic unit for the turn, and the screen has
 * to show the economy the player is actually allocating.
 */
function context() {
  return game.productionContext(you);
}

const spareWorkers = () => {
  const { land, population } = context();
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
  /**
   * Ring whole nations along their own frontier, not every province inside them, or
   * several highlighted nations become one undifferentiated mesh. The black national
   * borders go back on top, which seams two neighbours wearing the same colour.
   */
  const frontier = (nations: ReadonlySet<number>, kind: string) => {
    if (nations.size === 0) return "";
    const belongs = (id: number) => {
      const owner = world.provinces[id]?.nation;
      return owner !== null && owner !== undefined && nations.has(owner);
    };
    const d = borderSegments(world)
      .filter((e) => e.kind !== "province" && e.owners.some(belongs))
      .map((e) => `M${e.from.x.toFixed(1)},${e.from.y.toFixed(1)}L${e.to.x.toFixed(1)},${e.to.y.toFixed(1)}`)
      .join("");
    return d ? `<path class="highlight ${kind}" fill="none" pointer-events="none" d="${d}"/>` : "";
  };

  /** The black national borders, redrawn over a highlight so nations stay separable. */
  const seams = () => {
    const d = borderSegments(world)
      .filter((e) => e.kind === "nation")
      .map((e) => `M${e.from.x.toFixed(1)},${e.from.y.toFixed(1)}L${e.to.x.toFixed(1)},${e.to.y.toFixed(1)}`)
      .join("");
    return d ? `<path class="highlight seam" fill="none" pointer-events="none" d="${d}"/>` : "";
  };

  const outline = (provinces: typeof world.provinces, kind: string) =>
    provinces
      .map((p) => `<polygon class="highlight ${kind}" fill="none" pointer-events="none" points="${
        p.border.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ")}"/>`)
      .join("");

  if (inspect?.kind === "union") {
    // Three colours because a union has three roles, and which nation is which is the
    // thing you are looking at the map to find out: the leader whose economy it is, the
    // members who handed theirs over, and the one nation they may all attack.
    const union = game.unionFor(inspect.id);
    if (union) {
      const members = new Set(union.members.filter((n) => n !== union.founder));
      svg.insertAdjacentHTML("beforeend",
        frontier(members, "member") +
        frontier(new Set([union.target]), "foe") +
        frontier(new Set([union.founder]), "leader") +
        seams());
    }
  } else {
    const looking =
      inspect?.kind === "province"
        ? world.provinces.filter((p) => p.id === inspect!.id && p.id !== selected)
        : inspect?.kind === "nation"
          ? world.provinces.filter((p) => p.nation === inspect!.id)
          : [];
    // A whole nation is outlined in white: at eight provinces the outline is most of the
    // map, and white is the one colour no nation fill or terrain mark uses.
    if (looking.length > 0) {
      if (inspect!.kind === "nation") {
        // At Expert, who a nation may attack is a live question every turn rather than
        // a matter of geography, so the answer is drawn rather than left to be worked out.
        const prey = world.level === "expert" ? attackableBy(inspect!.id) : new Set<number>();
        svg.insertAdjacentHTML("beforeend",
          frontier(prey, "foe") + frontier(new Set([inspect!.id]), "held") + seams());
      } else {
        svg.insertAdjacentHTML("beforeend", outline(looking, "inspected"));
      }
    }
  }
  el("map-hint").textContent = replaying
    ? "Replaying the turn's marches."
    : game.phase !== "military-orders"
      ? "Click a province for its details. Drag to pan, scroll to zoom."
      : selected !== null
        ? `Ordering ${game.world.provinces[selected]!.name}. Click a neighbour — yours to reinforce, anyone else's to attack — or itself to hold.`
        : ordering !== null
          ? `${game.world.provinces[ordering]!.name} is ordered. Set the size below, or click any armed province to order the next one.`
          : "Click an armed province to order it. Solid outlines are roads; dashed cost three quarters of your strength.";
}

/** Cheap view update: the geometry has not changed, only the window onto it. */
function applyView(): void {
  el("map").querySelector("svg")?.setAttribute(
    "viewBox",
    `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`,
  );
}

/** The half of the decision the slider does not already show: what is left behind. */
function marchTally(cap: number, send: number): string {
  return `<b>${power(cap - send)}</b> stays`;
}

/** Production context for a game's player nation, for use before `render` has run. */
function contextFor(g: Game): { level: Level; land: Land; population: number } {
  const { land, population } = nationState(g.world, g.human);
  return { level: g.world.level, land, population };
}

/** The march control, docked in a corner so it covers no ground the player is reading. */
function marchControlHtml(): string {
  if (ordering === null || game.phase !== "military-orders" || replaying) return "";
  const p = game.world.provinces[ordering];
  const order = game.orders[ordering];
  if (!p || !order || order.target === null) return "";
  const target = game.world.provinces[order.target]!;
  const cap = Math.floor(p.firepower);
  const send = sentFrom(ordering);
  // Named at both ends: the control is no longer beside the province it is ordering.
  // Laid out the way the decision reads: what stays on the left, the slider, what goes
  // on the right. The slider is given real width — at 7rem a province holding hundreds
  // of firepower moved several units per pixel and no exact figure could be hit.
  return `<div class="who">${p.name} &rarr;
      ${target.nation === you ? "reinforce" : "<b>attack</b>"} ${target.name}</div>
    <div class="row">
      <span class="stays" data-tally="${p.id}">${marchTally(cap, send)}</span>
      <input type="range" min="0" max="${cap}" value="${send}" data-march="${p.id}"
        aria-label="firepower sent from ${p.name}" />
      <span class="moving">
        <button type="button" data-mstep="${p.id}" data-by="-1">&minus;</button
        ><input type="number" data-send="${p.id}" value="${send}" min="0" max="${cap}" step="1"
          aria-label="firepower sent from ${p.name}" /><button
          type="button" data-mstep="${p.id}" data-by="1">+</button> moving</span>
      <button type="button" data-act="dismiss" class="dismiss" aria-label="Done"
        title="The order stands. The next click on the map starts a new one.">&check;</button>
    </div>`;
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
      if (orderable(id)) {
        selected = id;
        ordering = null;
      }
    } else if (id === selected) {
      game.setOrder(selected, { marchFraction: game.orders[selected]?.marchFraction ?? 1, target: null });
      selected = null;
    } else if (legalTargets().has(id)) {
      game.setOrder(selected, { marchFraction: game.orders[selected]?.marchFraction ?? 1, target: id });
      // The order is placed, so the selection is finished. The control stays open on it
      // for the size of the march; the next click on the map starts fresh.
      ordering = selected;
      selected = null;
    } else if (orderable(id)) {
      selected = id;
      ordering = null;
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

/**
 * A factory's recipe and where its output goes: how much of each input it wanted
 * against how much arrived, which §3.5 makes hard to work out by eye.
 */
function factoryHtml(id: CommodityId): string {
  const c = economy.graph.table.get(id);
  const result = resolveDraft(draft);
  const r = result.commodities[id];
  if (!c || !r) return "";

  const inputs = Object.entries(c.inputs).filter(([, coeff]) => coeff > 0);
  const wanted = (coeff: number) => r.capacity * coeff;
  const inputRows = inputs
    .map(([input, coeff]) => {
      const got = r.received[input] ?? 0;
      const need = wanted(coeff);
      const short = got < need - 1e-6;
      return `<tr class="${short ? "deficit" : ""}">
        <td class="name">${commodityLabel(input)}</td>
        <td class="spare">${coeff} per ton</td>
        <td>${whole(need)}</td>
        <td class="${short ? "short" : ""}">${whole(got)}</td>
      </tr>`;
    })
    .join("");

  const consumers = (economy.graph.consumers.get(id) ?? [])
    .map((consumer) => {
      const other = economy.graph.table.get(consumer)!;
      const oc = result.commodities[consumer]!;
      const need = oc.capacity * (other.inputs[id] ?? 0);
      const got = oc.received[id] ?? 0;
      return { consumer, need, got };
    })
    .filter((x) => x.need > 0 || x.got > 0);

  const consumerRows = consumers
    .map((x) => `<tr>
      <td class="name">${commodityLabel(x.consumer)}</td>
      <td class="spare">${economy.graph.table.get(x.consumer)!.inputs[id]} per ton</td>
      <td>${whole(x.need)}</td>
      <td>${whole(x.got)}</td>
    </tr>`)
    .join("");

  const endUse =
    c.kind === "tool" ? `<dt>Feeds</dt><dd>${tierYield(c.tier!)} tons of food per ton</dd>`
    : c.kind === "weapon" ? `<dt>Arms</dt><dd>${tierYield(c.tier!)} firepower per ton</dd>`
    : "";
  const land = c.terrain
    ? `<dt>Draws on</dt><dd>${commodityLabel(c.terrain)}, ${whole(context().land[c.terrain])} acres</dd>`
    : "";

  return `<h2>${commodityLabel(id)}
      <span class="right"><button type="button" data-act="close">Close</button></span></h2>
    <dl>
      <dt>Kind</dt><dd>${c.kind}${c.tier ? `, tier ${c.tier}` : ""}</dd>
      ${land}
      <dt>Workers</dt><dd>${workersFor(draft, context().population, context().land.farmland)[id] ?? 0}</dd>
      <dt>Size</dt><dd>${whole(r.capacity)} tons, at this labour</dd>
      <dt>Output</dt><dd>${whole(r.output)} tons</dd>
      <dt>Surplus</dt>
      <dd class="${standing(r.surplus) === "short" ? "short" : ""}">${whole(r.surplus)} tons</dd>
      ${endUse}
    </dl>
    ${inputs.length === 0
      ? '<p class="hint">A raw material. It is dug or cut, not made from anything.</p>'
      : `<h3>Needs</h3>
         <table class="affinity"><thead><tr>
           <th class="name">Input</th><th>Recipe</th><th>Wanted</th><th>Got</th>
         </tr></thead><tbody>${inputRows}</tbody></table>`}
    ${consumers.length === 0
      ? `<h3>Goes to</h3><p class="hint">Nothing consumes it. ${
          c.kind === "weapon" ? "It arms your provinces." :
          c.kind === "tool" ? "It feeds your farmland." : "It is the end of its chain."}</p>`
      : `<h3>Goes to</h3>
         <table class="affinity"><thead><tr>
           <th class="name">Consumer</th><th>Recipe</th><th>Wants</th><th>Takes</th>
         </tr></thead><tbody>${consumerRows}</tbody></table>
         <p class="hint">Consumers are served shallowest first (§3.5), so the one nearest
           the top of this list takes what it needs before the rest are asked.</p>`}`;
}

/**
 * A union's roster and what it adds up to (§6.1).
 *
 * The pooled totals are the reason the thing exists, so they are the body of the panel
 * rather than a footnote: one economy's worth of people and ground, assembled out of
 * several nations for a single turn.
 */
function unionHtml(founder: number): string {
  const union = game.unionFor(founder);
  if (!union) return "";
  const { land, population, provinces } = poolOf(game.world, union.members);
  const joiners = union.members.filter((n) => n !== union.founder);
  const name = (n: number) => `${nationName(n)}${n === you ? " (you)" : ""}`;

  return `<h2>Union<span class="right"><button type="button" data-act="close">Close</button></span></h2>
    <dl>
      <dt>Leader</dt><dd><span class="role leader"></span>${name(union.founder)}</dd>
      <dt>Members</dt><dd>${joiners.length
        ? joiners.map((n) => `<span class="role member"></span>${name(n)}`).join("<br />")
        : "&mdash;"}</dd>
      <dt>Declared against</dt><dd><span class="role foe"></span>${name(union.target)}</dd>
      <dt><b>Pooled people</b></dt><dd><b>${people(population)}</b></dd>
      <dt><b>Provinces</b></dt><dd><b>${provinces}</b></dd>
      ${terrainRows(land)}
    </dl>
    <p class="hint">${name(union.founder)} allocates the whole of this for the turn.
      Members may attack ${nationName(union.target)}, or any nation in no union at all
      &mdash; but never each other, and never another bloc.</p>`;
}

/**
 * Nations this one could actually march on: allowed by §6.1 *and* sharing a border
 * (§5.4). Both halves matter — a member whose target is far away can attack nobody,
 * which is the real price of joining.
 */
function attackableBy(nation: number): Set<number> {
  const reachable = new Set<number>();
  for (const p of game.world.provinces) {
    if (p.nation !== nation) continue;
    for (const n of p.neighbours) {
      const owner = game.world.provinces[n.province]!.nation;
      if (owner === null || owner === nation) continue;
      if (game.mayAttack(nation, owner)) reachable.add(owner);
    }
  }
  return reachable;
}

/**
 * What a nation's firepower is made of. Public: §10.1 withholds food output alone,
 * because that is the number that says when a rival is about to grow; this only
 * describes strength the map is already showing.
 */
function armedWith(nation: number): string {
  const weapons = game.weaponsOf(nation);
  if (weapons.length === 0) return `<span class="secret">nothing</span>`;
  return weapons
    .map((w) => `${commodityLabel(w.id)} <span class="hint">${power(w.firepower)}</span>`)
    .join("<br />");
}

function inspectorHtml(): string {
  if (!inspect) return "";
  if (inspect.kind === "union") return unionHtml(inspect.id);
  if (inspect.kind === "factory") return factoryHtml(inspect.id);
  if (inspect.kind === "province") {
    const p = shownWorld().provinces[inspect.id];
    if (!p) return "";
    return `<h2>${p.name}<span class="right"><button type="button" data-act="close">Close</button></span></h2>
      <dl>
        <dt>Ruled by</dt><dd>${nationName(p.nation)}${p.nation === you ? " (you)" : ""}</dd>
        <dt>Population</dt><dd>${people(p.population)}</dd>
        <dt>Military power</dt><dd>${power(p.firepower)}</dd>
        ${terrainRows(p.land)}
        <dt>Coast</dt><dd>${p.coastal ? "yes" : "inland"}</dd>
        <dt>Neighbours</dt><dd>${p.neighbours.length} (${p.neighbours.filter((n) => n.road).length} by road)</dd>
      </dl>`;
  }

  const r = game.rankings().find((x) => x.nation === inspect!.id);
  if (!r) return "";
  const own = r.nation === you;
  // §6.2 puts a hard "Can attack him / Cannot attack him" on the diplomacy screen, and
  // at Expert that is a live question every turn rather than a matter of geography.
  const canAttack = [...attackableBy(r.nation)].sort(
    (a, b) => nationName(a).localeCompare(nationName(b)),
  );
  return `<h2>${nationName(r.nation)}${own ? " (you)" : ""}
      <span class="right"><button type="button" data-act="close">Close</button></span></h2>
    <dl>
      <dt>Military strength</dt><dd>${power(r.firepower)}</dd>
      <dt>Armed with</dt><dd>${armedWith(r.nation)}</dd>
      <dt>Population</dt><dd>${people(r.population)}</dd>
      <dt>Provinces</dt><dd>${r.provinces}</dd>
      ${terrainRows(r.land)}
      <dt>Food output</dt>
      <dd>${own
        ? whole(resolveDraft(draft).agriculture.food)
        : '<span class="secret">a national secret</span>'}</dd>
      ${game.world.level === "expert" ? `<dt>Can attack</dt><dd>${
        canAttack.length
          ? canAttack.map((n) => `<span class="role foe"></span>${nationName(n)}`).join("<br />")
          : '<span class="secret">nobody this turn</span>'}</dd>` : ""}
    </dl>
    ${affinityHtml(r.nation)}`;
}

/** Where a value sits on the -1..1 scale, as a word. */
function temper(w: number): { label: string; cls: string } {
  if (w >= 0.5) return { label: "warm", cls: "warm" };
  if (w >= 0.15) return { label: "friendly", cls: "warm" };
  if (w > -0.15) return { label: "neutral", cls: "" };
  if (w > -0.5) return { label: "wary", cls: "cool" };
  return { label: "hostile", cls: "cool" };
}

/**
 * How a nation regards the others (§6.4). Public, because the live terms are computed
 * from public standings anyway; whether the stored history should be secret is open
 * (§10.1.7).
 */
function affinityHtml(nation: number): string {
  const others = game.willingnessFrom(nation).filter((x) =>
    game.world.provinces.some((p) => p.nation === x.nation));
  if (others.length === 0) return "";
  const rows = others
    .map((x) => {
      const t = temper(x.willingness);
      const liking = game.affinity.liking[nation]![x.nation]!;
      const trust = game.affinity.trust[nation]![x.nation]!;
      return `<tr>
        <td class="name"><span class="swatch" style="background:${fill(x.nation)}"></span>
          ${nationName(x.nation)}${x.nation === you ? " (you)" : ""}</td>
        <td class="${t.cls}">${t.label}</td>
        <td class="spare" title="warmth, volatile">${liking.toFixed(2)}</td>
        <td class="spare" title="reliability, durable">${trust.toFixed(2)}</td>
        <td class="${t.cls}">${x.willingness >= 0 ? "+" : ""}${x.willingness.toFixed(2)}</td>
      </tr>`;
    })
    .join("");
  return `<h3>How ${nationName(nation)} regards the others</h3>
    <table class="affinity">
      <thead><tr>
        <th class="name">Nation</th><th></th>
        <th title="Warmth. Half-life four turns.">Like</th>
        <th title="Reliability. Half-life fifteen turns.">Trust</th>
        <th title="Willingness to join a union, all terms together">Net</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Winning breeds dislike and arming breeds distrust, both read off the
      current standings &mdash; so this moves as the game does, not only when something
      happens.</p>`;
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
      <span class="num">${people(r.population)} people &middot; ${r.provinces} prov</span>
    </li>`)
    .join("");
  // Unions only exist at Expert (§1.1), and only for the turn they were declared in.
  const unions = game.unions
    .map((u) => `<li class="${inspect?.kind === "union" && inspect.id === u.founder ? "open" : ""}"
      data-union="${u.founder}">
      <span class="swatch" style="background:${fill(u.founder)}"></span>
      ${nationName(u.founder)} <span class="hint">and ${u.members.length - 1} against</span>
      ${nationName(u.target)}
      <span class="num">${people(poolOf(game.world, u.members).population)} people</span>
    </li>`)
    .join("");

  return `<h2>Nations <small>standing by population</small></h2>
    <ul class="nations">${rows}</ul>
    ${unions ? `<h2 class="sub">Unions <small>this turn</small></h2>
      <ul class="nations unions">${unions}</ul>` : ""}
    <p class="hint">Click one for its strength and territory. Food output is a national secret.</p>`;
}

// --- production ------------------------------------------------------------------

function productionPanel(): string {
  const union = game.unionFor(you);
  const mine = game.controlsEconomy(you);
  const banner = !union
    ? ""
    : mine
      ? `<p class="union-line">You founded this turn's union against
          ${nationName(union.target)}. You are allocating for
          ${union.members.map(nationName).join(", ")} &mdash; their people and land are
          pooled with yours.</p>`
      : `<p class="union-line">You joined ${nationName(union.founder)}'s union against
          ${nationName(union.target)}. They are allocating the pooled economy of
          ${union.members.map(nationName).join(", ")} this turn, so there is nothing for
          you to set (§6.1).</p>`;

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
      // In someone else's union the founder allocates the pooled economy (§6.1), so
      // every control is dead — but the padlocks still show *your* locks, not a screen
      // full of ticks you did not put there.
      const frozen = !mine || locked;
      const limited = c.limitingFactor !== "Labor";
      return `<tr class="${w === 0 ? "idle" : ""} ${limited ? "limited" : ""} ${
        standing(c.surplus) === "short" ? "deficit" : ""
      }" data-row="${id}">
        <td class="lock"><input type="checkbox" data-lock="${id}" ${locked ? "checked" : ""}
          ${!mine ? "disabled" : ""}
          title="Lock this factory against redistribution" /></td>
        <td class="name"><button type="button" class="link" data-factory="${id}"
          >${commodityLabel(id)}</button></td>
        <td data-cell="cap" class="capacity">${whole(c.capacity)}</td>
        <td data-cell="out">${whole(c.output)}</td>
        <td data-cell="sur" class="${standing(c.surplus)}">${whole(c.surplus)}</td>
        <td data-cell="lim" class="lim">${c.limitingFactor === "Labor" ? "&mdash;" : commodityLabel(c.limitingFactor)}</td>
        <td class="tune">
          <button type="button" data-step="${id}" data-by="-1" ${frozen ? "disabled" : ""}>&minus;</button
          ><input type="number" data-workers="${id}" value="${w}" min="0" max="${spare}" step="1"
            ${frozen ? "disabled" : ""} aria-label="workers in ${commodityLabel(id)}" /><button
            type="button" data-step="${id}" data-by="1" ${frozen ? "disabled" : ""}>+</button>
        </td>
        <td class="slider"><input type="range" min="0" max="${spare}" value="${w}"
          data-slider="${id}" ${frozen ? "disabled" : ""} /></td>
      </tr>`;
    })
    .join("");

  return `<h2>Production
      <span class="right"><button type="button" data-act="expand">${expanded ? "Shrink" : "Expand"}</button></span>
    </h2>
    ${banner}
    <table class="production${mine ? "" : " read-only"}">
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
  return `<b>Population:</b> ${people(result.population)} &rarr;
      <span class="${growing ? "growing" : "starving"}">${people(result.nextPopulation)}</span><br />
    <b>Firepower:</b> ${power(result.firepower)} this turn<br />
    <span class="spare"><b>Land:</b> ${whole(land.farmland)} farm, ${whole(land.forest)} forest,
      ${whole(land.mountains)} mountain, ${whole(land.desert)} desert</span>`;
}

/**
 * Refresh the numbers in place while a control is being used: re-rendering would tear
 * the input out from under the pointer. `editing` is the one control not written back
 * to, being the box already holding what the user meant.
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
    sur.className = standing(c.surplus);
    row.querySelector<HTMLElement>('[data-cell="lim"]')!.textContent =
      c.limitingFactor === "Labor" ? "—" : commodityLabel(c.limitingFactor);
    row.classList.toggle("limited", c.limitingFactor !== "Labor");
    row.classList.toggle("deficit", standing(c.surplus) === "short");
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
 * counts come from a largest-remainder split of the whole workforce, so setting a
 * share of `n / spare` does not reliably yield `n`, and the stray worker lands on an
 * unrelated factory (§10.1).
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
  // The epsilon is not cosmetic. The order stores a *fraction*, so a slider set to 6 of
  // 19.4 saves 6/19.4 and reads back 19.4 x that = 5.99999..., which floors to 5. The
  // exact figure you asked for was the one value you could not get.
  return Math.min(Math.floor(p.firepower), Math.floor(p.firepower * order.marchFraction + 1e-9));
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
        <td>${p.name}</td><td>${power(p.firepower)}</td>
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

  return `<h2>Military orders</h2>
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
  return `<h2>Execution
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

/**
 * What a turn moved, in the units the screen is scored in.
 *
 * Shown against the figure it belongs to rather than as a column of its own: the
 * standing is the number that matters, and the change is the reason it moved.
 */
function change(now: number, before: number, unit = ""): string {
  // Against the *displayed* figures, so the arithmetic on screen always adds up.
  const delta = Math.floor(now) - Math.floor(before);
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "&minus;";
  return ` <span class="delta ${delta > 0 ? "up" : "down"}">${sign}${people(Math.abs(delta))}${unit}</span>`;
}

/**
 * The Economic Union phase (§6.1, Expert only), taken one declaration at a time.
 *
 * Deliberately *not* on this screen: who else is joining. The declaration is public
 * and the answers are not (§6.5), so a predicted roster would hand the player the one
 * thing the rule withholds.
 */
function unionPanel(): string {
  const ask = game.unionAsk();
  const settled = game.unionsSoFar();
  const name = (n: number) => `${nationName(n)}${n === you ? " (you)" : ""}`;

  const formed = settled.length
    ? `<h3>Formed so far</h3>${settled.map((u) => `<div class="offer">
        <dt>${name(u.founder)} <span class="hint">and ${u.members.length - 1} against</span>
          ${name(u.target)}</dt>
        <dd>${u.members.map(name).join(", ")}</dd>
      </div>`).join("")}`
    : "";

  let question: string;
  if (!ask) {
    question = `<p class="hint">The declarations are finished${settled.length ? "" : " and nobody formed a union"}.</p>`;
  } else if (ask.kind === "declare") {
    // "A player can choose any other nation" — so every one of them is offered, worst
    // regarded first, since that is the order the question is usually answered in.
    const choices = game.willingnessFrom(you)
      .map((w) => `<button type="button" data-declare="${w.nation}">${nationName(w.nation)}
        <span class="hint">${w.willingness.toFixed(2)}</span></button>`)
      .reverse()
      .join(" ");
    question = `<h3>You are the weakest nation still unattached</h3>
      <p class="hint">Declare a union against any nation. The others will answer one by
        one, and you will not learn who joined until it forms.</p>
      <p class="declare">${choices}</p>
      <p><button type="button" data-aloof="1">Declare nothing</button></p>`;
  } else {
    question = `<h3>${nationName(ask.founder)} has declared against ${name(ask.target)}</h3>
      <p class="hint">Join and you pool your people and land into
        ${nationName(ask.founder)}'s economy for the turn &mdash; they allocate all of
        it &mdash; and you may attack ${nationName(ask.target)} or any unaligned nation,
        but no member of any union. You do not know who else is joining.</p>
      <p class="declare">
        <button type="button" data-join="${ask.founder}">Join ${nationName(ask.founder)}</button>
        <button type="button" data-aloof="1">Stand aloof</button></p>`;
  }

  return `<h2>Economic Union</h2>
    <p class="hint">The weakest player declares first and the rest answer, then the next
      weakest still unattached declares, until nobody is left to join.</p>
    ${question}
    ${formed}`;
}

function rankingsPanel(): string {
  const opening = new Map(game.openingRankings().map((r) => [r.nation, r]));
  const rows = game
    .rankings()
    .map((r: Ranking) => {
      const was = opening.get(r.nation);
      return `<div class="${r.nation === you ? "you" : ""} ${
        inspect?.kind === "nation" && inspect.id === r.nation ? "open" : ""
      }" data-nation="${r.nation}">
      <dt>${nationName(r.nation)}${r.nation === you ? " (you)" : ""}</dt>
      <dd>${people(r.population)} people${was ? change(r.population, was.population) : ""}
        &middot; ${r.provinces} provinces${was ? change(r.provinces, was.provinces) : ""}
        &middot; ${power(r.firepower)} firepower</dd>
    </div>`;
    })
    .join("");
  return `<h2>Rankings</h2>
    <p class="hint">Standing is population. Not territory, not firepower &mdash; which is
      what makes arming yourself expensive. The change is this turn's.</p>
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
      text: `${power(t.firepower)} marches ${name(t.from)} &rarr; ${name(t.to)}`,
      apply: (w) => { w.provinces[t.to]!.firepower += t.firepower; },
    });
  }

  for (const b of report.battles) {
    for (const wave of b.waves) {
      const captured = wave.captured;
      const nation = before.provinces[wave.from]!.nation;
      steps.push({
        from: wave.from, to: b.target, force: wave.committed, hostile: true, taken: captured,
        text: `${power(wave.committed)} from ${name(wave.from)} attacks ${name(b.target)} ` +
          `${wave.viaRoad ? "by road" : "across country, quartered"}: ${power(wave.effective)} ` +
          `against ${power(wave.defenceBefore)} &mdash; ` +
          (captured ? `<b>taken</b>, ${power(wave.survivors)} hold it` : "repulsed"),
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
        text: `${name(b.target)} loses ${people(b.civilianLoss)} civilians to the fighting`,
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
  const label = power(step.force);
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

const PHASE_LABELS: Record<Phase, string> = {
  union: "Unions",
  production: "Production",
  "military-orders": "Orders",
  "military-execution": "Execution",
  rankings: "Rankings",
};

function render(): void {
  // Expert runs a fifth phase the others do not (§1.1), so the tracker is built from
  // the level's own phase list rather than a fixed four.
  const phases = phasesFor(game.world.level);
  const index = phases.indexOf(game.phase);
  el("phases").innerHTML = phases.map((p, i) =>
    `<span class="${p === game.phase ? "on" : i < index ? "done" : ""}">${PHASE_LABELS[p]}</span>`).join("");
  el("turn").textContent = `Turn ${game.turn}`;

  const mine = game.rankings().find((r) => r.nation === you);
  const capped = game.world.productionCap !== undefined;
  el("standing").innerHTML = `Continent <b>${game.world.name}</b> &middot; ${game.world.level}${
    capped ? " &middot; original caps" : ""}
       &middot; you are <b>${nationName(you)}</b> &middot; ${people(mine?.population ?? 0)} people,
       ${mine?.provinces ?? 0} provinces`;

  document.body.classList.toggle("expanded", expanded && game.phase === "production");

  el("panel").innerHTML =
    game.phase === "union" ? unionPanel()
    : game.phase === "production" ? productionPanel()
    : game.phase === "military-orders" ? ordersPanel()
    : game.phase === "military-execution" ? executionPanel()
    : rankingsPanel();

  const inspectorEl = el("inspector");
  inspectorEl.innerHTML = inspectorHtml();
  inspectorEl.hidden = inspectorEl.innerHTML === "";
  // Expanded production gives the inspector its own column rather than hiding it, but
  // only when there is something in it to read.
  document.body.classList.toggle("inspecting", !inspectorEl.hidden);
  el("nations").innerHTML = nationsHtml();

  const advance = el<HTMLButtonElement>("advance");
  const nextLabel: Record<Phase, string> = {
    union: "Settle the unions",
    production: "Begin military orders",
    "military-orders": "Execute orders",
    "military-execution": "See rankings",
    rankings: "Next turn",
  };
  advance.textContent = nextLabel[game.phase];
  advance.className = "primary";
  advance.disabled = replaying;
  el("undo").hidden = game.phase !== "rankings";
  el("notice").textContent = notice;
  drawMap();

  const control = el("march-control");
  control.innerHTML = marchControlHtml();
  control.hidden = control.innerHTML.trim() === "";

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
      <dd>${people(r.population)} people &middot; ${r.provinces} provinces</dd>
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
      const held = game.world.provinces[province]!.firepower;
      game.setOrder(province, {
        ...order,
        marchFraction: held > 0 ? Math.min(1, Math.max(0, Number(target.value) / held)) : 0,
      });
      // Siblings follow the order as clamped, not the text as typed: `max` on a number
      // input does not stop someone typing past it.
      const send = sentFrom(province);
      for (const other of document.querySelectorAll<HTMLInputElement>(
        `[data-march="${province}"], [data-send="${province}"]`,
      )) {
        if (other !== target) other.value = String(send);
      }
      const tally = document.querySelector(`[data-tally="${province}"]`);
      if (tally) tally.innerHTML = marchTally(Math.floor(held), send);
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
    "[data-act], [data-step], [data-mstep], [data-nation], [data-factory], " +
    "[data-join], [data-declare], [data-aloof], [data-union]",
  );
  if (!node) return;

  if (node.dataset.join || node.dataset.declare || node.dataset.aloof) {
    const answer = node.dataset.join ?? node.dataset.declare;
    game.answerUnion(answer === undefined ? null : Number(answer));
    render();
    return;
  }

  if (node.dataset.factory) {
    const id = node.dataset.factory as CommodityId;
    inspect = inspect?.kind === "factory" && inspect.id === id ? null : { kind: "factory", id };
    render();
    return;
  }

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
  if (node.dataset.union) {
    const id = Number(node.dataset.union);
    inspect = inspect?.kind === "union" && inspect.id === id ? null : { kind: "union", id };
    render();
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
    case "dismiss":
      // Only puts the control away. Cancelling an order is clicking its province twice.
      ordering = null;
      break;
    case "expand":
      expanded = !expanded;
      break;
    case "skip":
      skipReplay = true;
      return;
    case "auto": {
      const before = draft;
      draft = balanceAllocation(economy, draft, context(), game.locked[you] ?? []);
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
  // §6.1: in someone else's union the founder allocates, so there is nothing to submit.
  if (game.phase === "production" && game.controlsEconomy(you)) game.setAllocation(you, draft);

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
  ordering = null;
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
  ordering = null;
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
 * Autosave, so a refresh resumes rather than starts over. The snapshot holds no phase
 * or orders, so a resume lands at the start of the saved turn — half a turn of orders
 * is not a state the game has a name for.
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

function begin(continent: string, nation: string, level: Level, caps: boolean): void {
  const world = generateWorld(continent, level, {
    playerNation: nation,
    ...(caps ? { productionCap: ORIGINAL_PRODUCTION_CAP } : {}),
  });
  economy = economyFor(world);
  game = Game.fromWorld(world, economy);
  // Balanced, not raw: the raw split falls into the §3.5 priority trap and would open
  // the player 192 tons in deficit where every AI gets the balanced one (§10.1).
  draft = balanceAllocation(economy, subsistenceAllocation(), contextFor(game), game.locked[you] ?? []);
  view = continentBounds(game.world);
  selected = null;
  ordering = null;
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
    data.get("caps") === "original",
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
  ordering = null;
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
  location.href = "index.html";
});

// A continent in the URL skips the start screen, which is what the test harness uses.
const params = new URLSearchParams(location.search);
if (params.get("continent")) {
  begin(
    params.get("continent")!,
    params.get("nation") ?? "Babylon",
    (params.get("level") ?? "intermediate") as Level,
    params.get("caps") === "original",
  );
} else {
  offerResume();
}
