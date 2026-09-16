/**
 * Browser front end.
 *
 * No framework: the whole of the state is one `Game`, and each phase renders its own
 * panel. The one thing worth care is the production screen, which shows the pro-rata
 * redistribution *as you drag* — §3.6 notes that the original's confusion was a UI
 * failure rather than a mechanical one, so the mechanic is kept and made visible.
 */
import { Economy } from "../src/economy.ts";
import {
  Game,
  balanceAllocation,
  reallocate,
  subsistenceAllocation,
  workersFor,
  type Allocation,
} from "../src/game.ts";
import { renderMapSvg } from "../src/svg.ts";
import { nationState } from "../src/worldgen.ts";
import type { CommodityId, EconomyResult, Level } from "../src/types.ts";

const CORE: CommodityId[] = [
  "lumber", "sulfur", "iron-ore", "coal", "charcoal", "pig-iron", "gunpowder", "iron",
  "farm-tools", "iron-plow", "sword", "musket",
];

const params = new URLSearchParams(location.search);
const continent = params.get("continent") ?? "Kittycat";
const level = (params.get("level") ?? "intermediate") as Level;
const you = Number(params.get("nation") ?? "0");

const economy = new Economy();
const game = Game.create(continent, level);

/** Uncommitted allocation, so a drag can be previewed before it is applied. */
let draft: Allocation = game.allocations[you] ?? subsistenceAllocation();
let selected: number | null = null;
let notice = "";
let lastReport: ReturnType<Game["advance"]> = null;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function context() {
  const { land, population } = nationState(game.world, you);
  return { level: game.world.level, land, population };
}

const spareWorkers = () => {
  const { land, population } = nationState(game.world, you);
  return Math.max(0, population - land.farmland);
};

const resolveDraft = (allocation: Allocation): EconomyResult => {
  const ctx = context();
  return economy.resolve({ ...ctx, workers: workersFor(allocation, ctx.population, ctx.land.farmland) });
};

// --- map -------------------------------------------------------------------------

function legalTargets(): Map<number, boolean> {
  const map = new Map<number, boolean>();
  if (selected === null) return map;
  for (const n of game.world.provinces[selected]!.neighbours) map.set(n.province, n.road);
  return map;
}

/** Ordered marches, so the map shows the plan and not just the orders table. */
function marches(): { from: number; to: number; hostile: boolean }[] {
  if (game.phase === "rankings") return [];
  return Object.entries(game.orders).flatMap(([from, order]) => {
    const id = Number(from);
    if (order.target === null || game.world.provinces[id]!.nation !== you) return [];
    return [{ from: id, to: order.target, hostile: game.world.provinces[order.target]!.nation !== you }];
  });
}

function drawMap(): void {
  el("map").innerHTML = renderMapSvg(game.world, {
    selected,
    targets: game.phase === "military-orders" ? legalTargets() : undefined,
    firepower: true,
    marches: marches(),
  });
  for (const node of el("map").querySelectorAll<SVGElement>("[data-province]")) {
    const id = Number(node.dataset.province);
    if (game.world.provinces[id]!.nation === you) node.classList.add("mine");
  }
  el("map-hint").textContent =
    game.phase === "military-orders"
      ? selected === null
        ? "Click one of your armed provinces to give it orders. Solid outlines are road crossings; dashed ones cost you three quarters of your strength."
        : `Ordering ${game.world.provinces[selected]!.name}. Click a neighbour to march on it — one of yours to reinforce it, anyone else’s to attack — or click it again to hold.`
      : "";
}

el("map").addEventListener("click", (event) => {
  if (game.phase !== "military-orders") return;
  const node = (event.target as Element).closest<SVGElement>("[data-province]");
  if (!node) return;
  const id = Number(node.dataset.province);

  const orderable = (p: number) =>
    game.world.provinces[p]!.nation === you && game.world.provinces[p]!.firepower >= 1;

  if (selected === null) {
    if (!orderable(id)) return;
    selected = id;
  } else if (id === selected) {
    game.setOrder(selected, { marchFraction: game.orders[selected]?.marchFraction ?? 1, target: null });
    selected = null;
  } else if (legalTargets().has(id)) {
    const existing = game.orders[selected]?.marchFraction ?? 1;
    game.setOrder(selected, { marchFraction: existing, target: id });
    selected = null;
  } else if (orderable(id)) {
    selected = id;
  }
  render();
});

// --- production ------------------------------------------------------------------

function productionPanel(): string {
  const result = resolveDraft(draft);
  const spare = spareWorkers();
  const workers = workersFor(draft, context().population, context().land.farmland);
  const rows = [...new Set([...CORE, ...Object.keys(draft).filter((id) => (draft[id] ?? 0) > 0)])];
  const used = Object.values(workers).reduce((s, v) => s + v, 0);
  const a = result.agriculture;
  const ctx = context();

  const body = rows
    .map((id) => {
      const c = result.commodities[id];
      if (!c) return "";
      const share = draft[id] ?? 0;
      const locked = game.isLocked(you, id);
      const limited = c.limitingFactor !== "Labor";
      return `<tr class="${(workers[id] ?? 0) === 0 ? "idle" : ""} ${limited ? "limited" : ""}" data-row="${id}">
        <td>${id}</td>
        <td data-cell="out">${c.output.toFixed(0)}</td>
        <td data-cell="sur" class="${c.surplus < -0.5 ? "short" : c.surplus > 0.5 ? "spare" : ""}">${c.surplus.toFixed(0)}</td>
        <td data-cell="lim" class="lim">${c.limitingFactor === "Labor" ? "—" : c.limitingFactor}</td>
        <td data-cell="w">${workers[id] ?? 0}</td>
        <td class="slider"><input type="range" min="0" max="${spare}" value="${Math.round(share * spare)}"
          data-slider="${id}" ${locked ? "disabled" : ""} /></td>
        <td class="lock"><input type="checkbox" data-lock="${id}" ${locked ? "checked" : ""}
          title="Lock this factory against redistribution" /></td>
      </tr>`;
    })
    .join("");

  return `<h2>Production <small>turn ${game.turn}</small></h2>
    <table>
      <thead><tr><th>Commodity</th><th>Out</th><th>Surplus</th><th>Short of</th><th>Workers</th><th></th><th>🔒</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td>Food</td><td>${a.food.toFixed(0)}</td>
        <td class="${a.surplus < 0 ? "short" : "spare"}">${a.surplus.toFixed(0)}</td>
        <td class="lim">needs ${a.required.toFixed(0)}</td><td>${a.workers}</td><td></td><td></td>
      </tr></tfoot>
    </table>
    <div class="totals" id="totals">${totalsHtml(result, used, spare, ctx.land)}</div>
    <div class="controls">
      <button type="button" data-act="auto">Auto-balance</button>
      <button type="button" data-act="lock-all">Lock all</button>
      <button type="button" data-act="unlock-all">Unlock all</button>
    </div>`;
}

function totalsHtml(
  result: EconomyResult,
  used: number,
  spare: number,
  land: { farmland: number; forest: number; mountains: number; desert: number },
): string {
  const growing = result.nextPopulation >= result.population;
  const idle = spare - used;
  return `population ${result.population.toFixed(0)} &rarr;
      <span class="${growing ? "growing" : "starving"}">${result.nextPopulation.toFixed(0)}</span><br />
    workers ${used} of ${spare}${idle > 0 ? ` &middot; <span class="preview">${idle} idle</span>` : ""}
      &middot; firepower this turn ${result.firepower.toFixed(0)}<br />
    <span class="spare">land: ${land.farmland} farm, ${land.forest} forest, ${land.mountains} mountain, ${land.desert} desert</span>`;
}

/**
 * Refresh the numbers in place while a slider is being dragged.
 *
 * Re-rendering the panel would tear the slider out from under the pointer, and the
 * whole point is to watch the other factories move as this one is pulled.
 */
function refreshNumbers(): void {
  const result = resolveDraft(draft);
  const ctx = context();
  const workers = workersFor(draft, ctx.population, ctx.land.farmland);
  const spare = spareWorkers();

  for (const row of document.querySelectorAll<HTMLTableRowElement>("[data-row]")) {
    const id = row.dataset.row!;
    const c = result.commodities[id];
    if (!c) continue;
    row.querySelector<HTMLElement>('[data-cell="out"]')!.textContent = c.output.toFixed(0);
    const sur = row.querySelector<HTMLElement>('[data-cell="sur"]')!;
    sur.textContent = c.surplus.toFixed(0);
    sur.className = c.surplus < -0.5 ? "short" : c.surplus > 0.5 ? "spare" : "";
    row.querySelector<HTMLElement>('[data-cell="lim"]')!.textContent =
      c.limitingFactor === "Labor" ? "—" : String(c.limitingFactor);
    row.querySelector<HTMLElement>('[data-cell="w"]')!.textContent = String(workers[id] ?? 0);
    row.classList.toggle("limited", c.limitingFactor !== "Labor");
    row.classList.toggle("idle", (workers[id] ?? 0) === 0);
    // Sliders other than the one under the pointer follow the redistribution.
    const slider = row.querySelector<HTMLInputElement>("[data-slider]")!;
    if (document.activeElement !== slider) slider.value = String(Math.round((draft[id] ?? 0) * spare));
  }
  const used = Object.values(workers).reduce((s, v) => s + v, 0);
  el("totals").innerHTML = totalsHtml(result, used, spare, ctx.land);
}

// --- other phases ----------------------------------------------------------------

function ordersPanel(): string {
  const armed = game.world.provinces.filter((p) => p.nation === you && p.firepower >= 1);
  const rows = armed
    .map((p) => {
      const target = game.orders[p.id]?.target ?? null;
      const pct = Math.round((game.orders[p.id]?.marchFraction ?? 1) * 100);
      return `<tr>
        <td>${p.name}</td><td>${p.firepower.toFixed(0)}</td>
        <td>${target === null ? '<span class="spare">holding</span>'
          : game.world.provinces[target]!.nation === you
            ? `reinforce ${game.world.provinces[target]!.name}`
            : `<b>attack ${game.world.provinces[target]!.name}</b>`}</td>
        <td class="slider">${target === null ? ""
          : `<input type="range" min="0" max="100" value="${pct}" data-march="${p.id}" />`}</td>
        <td>${target === null ? "" : (p.firepower * pct / 100).toFixed(0)}</td>
      </tr>`;
    })
    .join("");

  return `<h2>Military orders <small>turn ${game.turn}</small></h2>
    ${armed.length === 0
      ? '<p class="spare">No armed provinces. Put workers into swords during production.</p>'
      : `<table><thead><tr><th>Province</th><th>Firepower</th><th>Order</th><th>March</th><th>Sent</th></tr></thead>
         <tbody>${rows}</tbody></table>`}
    <p class="hint">An attack loses 10 firepower on arrival and the defender fights with 10 more,
      so an empty province still needs over 20 by road &mdash; over 50 across country.</p>`;
}

function executionPanel(): string {
  const marching = game.world.provinces.filter(
    (p) => p.nation === you && (game.orders[p.id]?.target ?? null) !== null,
  );
  return `<h2>Execution <small>turn ${game.turn}</small></h2>
    <p>Orders are frozen. ${marching.length === 0
      ? "You march nowhere this turn."
      : `${marching.length} province${marching.length === 1 ? "" : "s"} on the move.`}</p>
    <ul class="log">${marching.map((p) => {
      const order = game.orders[p.id]!;
      const force = p.firepower * order.marchFraction;
      return `<li>${p.name} sends ${force.toFixed(0)} of ${p.firepower.toFixed(0)}
        against ${game.world.provinces[order.target!]!.name}</li>`;
    }).join("")}</ul>
    <p class="hint">Assaults on one province resolve in order, so a first wave softens
      the defender for the second.</p>`;
}

function battleLog(): string {
  if (!lastReport) return "";
  const { transfers, battles } = lastReport;
  const lines = [
    ...transfers.map((t) =>
      `<li>${t.firepower.toFixed(0)} firepower marches ${game.world.provinces[t.from]!.name}
        &rarr; ${game.world.provinces[t.to]!.name}</li>`),
    ...battles.flatMap((b) => {
      const name = game.world.provinces[b.target]!.name;
      const waves = b.waves.map((w) =>
        `<li class="${w.captured ? "taken" : ""}">${w.committed.toFixed(0)} from
          ${game.world.provinces[w.from]!.name} attacks ${name}
          ${w.viaRoad ? "by road" : "across country, quartered"}:
          ${w.effective.toFixed(0)} against ${w.defenceBefore.toFixed(0)} —
          ${w.captured ? `<b>taken</b>, ${w.survivors.toFixed(0)} hold it` : "repulsed"}</li>`);
      if (b.captured) {
        waves.push(`<li class="taken">${name} falls to nation ${b.owner};
          ${b.civilianLoss.toFixed(0)} civilians lost</li>`);
      }
      return waves;
    }),
  ];
  return lines.length === 0
    ? '<p class="spare">A quiet turn — nothing marched.</p>'
    : `<ul class="log">${lines.join("")}</ul>`;
}

function rankingsPanel(): string {
  const rows = game
    .rankings()
    .map((r) => `<div class="${r.nation === you ? "you" : ""}">
      <dt>Nation ${r.nation}${r.nation === you ? " (you)" : ""}</dt>
      <dd>${r.population.toFixed(0)} people &middot; ${r.provinces} provinces
        &middot; ${r.firepower.toFixed(0)} firepower</dd>
    </div>`)
    .join("");
  return `<h2>Rankings <small>end of turn ${game.turn}</small></h2>
    ${battleLog()}
    <p class="hint">Standing is population. Not territory, not firepower &mdash; which is
      what makes arming yourself expensive.</p>
    <dl class="rank">${rows}</dl>`;
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
  el("standing").innerHTML = game.winner !== null
    ? `<b>Nation ${game.winner} has conquered the world.</b>`
    : `Continent <b>${game.world.name}</b> &middot; ${game.world.level} &middot;
       you are nation <b>${you}</b> &middot; ${(mine?.population ?? 0).toFixed(0)} people,
       ${mine?.provinces ?? 0} provinces`;

  el("side").innerHTML =
    game.phase === "production" ? productionPanel()
    : game.phase === "military-orders" ? ordersPanel()
    : game.phase === "military-execution" ? executionPanel()
    : rankingsPanel();

  const advance = el<HTMLButtonElement>("advance");
  advance.textContent = {
    production: "Begin military orders",
    "military-orders": "Execute orders",
    "military-execution": "See rankings",
    rankings: "Next turn",
  }[game.phase];
  advance.className = "primary";
  advance.disabled = game.winner !== null;
  el("undo").hidden = game.phase !== "rankings";
  el("notice").textContent = notice;
  drawMap();
}

el("side").addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.slider) {
    const id = target.dataset.slider as CommodityId;
    draft = reallocate(draft, id, Number(target.value) / Math.max(spareWorkers(), 1), game.locked[you] ?? []);
    refreshNumbers();
  } else if (target.dataset.march) {
    const province = Number(target.dataset.march);
    const order = game.orders[province];
    if (order && order.target !== null) {
      game.setOrder(province, { ...order, marchFraction: Number(target.value) / 100 });
      render();
    }
  }
});

el("side").addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.lock) {
    const id = target.dataset.lock as CommodityId;
    notice = game.toggleLock(you, id)
      ? `${id} locked — redistribution will leave it alone.`
      : `${id} unlocked.`;
    render();
  }
});

el("side").addEventListener("click", (event) => {
  const act = (event.target as HTMLElement).dataset?.act;
  if (!act) return;
  if (act === "auto") {
    const before = draft;
    draft = balanceAllocation(economy, draft, context(), 80, game.locked[you] ?? []);
    notice = Object.keys(draft).some((id) => Math.abs((draft[id] ?? 0) - (before[id] ?? 0)) > 1e-9)
      ? "Balanced around the locked factories."
      : "Nothing to balance — everything involved is locked.";
  } else if (act === "lock-all") {
    game.lockAll(you);
    notice = "All factories locked. Unlock the ones you mean to change.";
  } else if (act === "unlock-all") {
    game.unlockAll(you);
    notice = "All factories unlocked.";
  }
  render();
});

el("advance").addEventListener("click", () => {
  notice = "";
  if (game.phase === "production") game.setAllocation(you, draft);
  const report = game.advance();
  if (report) lastReport = report;
  if (game.phase === "production") draft = game.allocations[you] ?? draft;
  selected = null;
  render();
});

el("undo").addEventListener("click", () => {
  game.undoTurn();
  draft = game.allocations[you] ?? draft;
  lastReport = null;
  selected = null;
  notice = "Turn undone.";
  render();
});

render();
