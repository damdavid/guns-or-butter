/**
 * Play a game in the terminal. `npm run game -- [continent] [level] [nation]`
 *
 * The production screen is laid out after the original's Production Summary (manual
 * p.12): commodity, output, surplus, limiting factor, workers. The other nations have
 * no AI yet, so they balance a subsistence economy and hold their troops.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Game, balanceAllocation, reallocate, subsistenceAllocation, workersFor } from "../src/game.ts";
import { Economy } from "../src/economy.ts";
import { nationState } from "../src/worldgen.ts";
import type { Allocation, CommodityId, Level } from "../src/index.ts";

const [, , continent = "Kittycat", levelArg = "intermediate", nationArg = "0"] = process.argv;
const level = levelArg as Level;
const you = Number(nationArg);

const game = Game.create(continent, level);
const economy = new Economy();
/**
 * Input. A real terminal is prompted line by line; piped input is drained up front.
 *
 * Readline fires `close` as soon as a piped stream ends, which happens while lines are
 * still sitting in its buffer, so a scripted session that reacted to `close` would quit
 * with most of its commands unread.
 */
const interactive = Boolean(stdin.isTTY);
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
let queued: string[] = [];

if (!interactive) {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  queued = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function ask(prompt: string): Promise<string> {
  if (rl) return rl.question(prompt);
  const line = queued.shift();
  if (line === undefined) return "quit";
  stdout.write(prompt + line + "\n");
  return line;
}

function finish(): void {
  rl?.close();
}

/** Always on screen: the commodities a nation can realistically reach early. */
const CORE: CommodityId[] = [
  "lumber", "sulfur", "iron-ore", "coal", "charcoal", "pig-iron", "gunpowder", "iron",
  "farm-tools", "iron-plow", "sword", "musket",
];

let allocation: Record<CommodityId, number> = { ...subsistenceAllocation() };
let locked: CommodityId[] = [];
/**
 * Feedback for the last command, printed under the screen rather than logged straight
 * away. The loop redraws on every input, so anything written immediately scrolls off
 * the top before it can be read — which is how a rejected command looked like a
 * command that had silently done nothing.
 */
let notice = "";

/**
 * Resolve a commodity the player typed. Punctuation and case are ignored, so
 * `farm-tools`, `farmtools` and `Farm Tools` all land, and a near miss gets a
 * suggestion rather than a bare usage line.
 */
function resolveCommodity(input: string): { id?: CommodityId; hint?: string } {
  const ids = [...economy.graph.table.keys()];
  const flatten = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = flatten(input ?? "");
  if (!wanted) return { hint: "which factory? e.g. set farm-tools 40" };

  const exact = ids.find((id) => flatten(id) === wanted);
  if (exact) return { id: exact };

  const distance = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i]![j] = Math.min(
          d[i - 1]![j]! + 1,
          d[i]![j - 1]! + 1,
          d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return d[a.length]![b.length]!;
  };

  const [best] = ids
    .map((id) => ({ id, d: distance(wanted, flatten(id)) }))
    .sort((x, y) => x.d - y.d);
  if (best && best.d <= Math.max(2, Math.floor(wanted.length / 3))) {
    return { hint: `no factory called "${input}" — did you mean ${best.id}?` };
  }
  return { hint: `no factory called "${input}"` };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

function productionScreen(): void {
  const { land, population } = nationState(game.world, you);
  const spare = Math.max(0, population - land.farmland);
  const workers = workersFor(allocation, population, land.farmland);
  const result = economy.resolve({ level, land, population, workers });
  // Anything the player has staffed joins the list, so `set tractor 60` is visible.
  const rows = [...new Set([...CORE, ...Object.keys(allocation).filter((id) => (allocation[id] ?? 0) > 0)])];

  console.log(`\n=== PRODUCTION — turn ${game.turn} — nation ${you} ===`);
  console.log(
    "Commodity".padEnd(13) + pad("Output", 9) + pad("Surplus", 9) +
    " " + "Limiting".padStart(14) + pad("Workers", 9),
  );
  for (const id of rows) {
    const c = result.commodities[id];
    if (!c) continue;
    const surplus = c.surplus < -0.5 ? `(${c.surplus.toFixed(0)})` : c.surplus.toFixed(0);
    console.log(
      id.padEnd(13) + pad(c.output.toFixed(0), 9) + pad(surplus, 9) +
      " " + String(c.limitingFactor).padStart(14) + pad(workers[id] ?? 0, 9) +
      (locked.includes(id) ? "  [locked]" : ""),
    );
  }
  const a = result.agriculture;
  console.log(
    `Food (${a.required.toFixed(0)})`.padEnd(13) + pad(a.food.toFixed(0), 9) +
    pad(a.surplus.toFixed(0), 9) + " " + "Labor".padStart(14) + pad(a.workers, 9),
  );

  const used = Object.values(workers).reduce((s, v) => s + v, 0);
  const trend = result.nextPopulation >= population ? "growing" : "STARVING";
  console.log(
    `\npopulation ${population} -> ${result.nextPopulation.toFixed(0)} (${trend})   ` +
    `land: ${land.farmland} farm, ${land.forest} forest, ${land.mountains} mtn, ${land.desert} desert`,
  );
  const idle = spare - used;
  console.log(
    `workers: ${used} of ${spare} allocated, ${idle} idle   firepower this turn: ${result.firepower.toFixed(0)}` +
    (idle > 0 ? "   <- idle labour is free to take; raise a factory to use it" : ""),
  );
  console.log(
    "\n  set <commodity> <workers>   auto   show   next\n" +
      "  lock <commodity|all>   unlock <commodity|all>",
  );
  console.log("  setting one factory takes from the others pro rata; locked ones are left alone");
  if (notice) console.log(`\n  ${notice}`);
  notice = "";
}

function ordersScreen(): void {
  console.log(`\n=== MILITARY ORDERS — turn ${game.turn} ===`);
  const mine = game.world.provinces.filter((p) => p.nation === you);
  for (const p of mine) {
    if (p.firepower < 1) continue;
    const targets = p.neighbours.map((n) => {
      const q = game.world.provinces[n.province]!;
      const who = q.nation === you ? "yours" : `nation ${q.nation}`;
      return `${n.province}:${q.name}(${who}${n.road ? ", road" : ", no road"}, fp ${q.firepower.toFixed(0)})`;
    });
    console.log(`  [${p.id}] ${p.name.padEnd(12)} firepower ${p.firepower.toFixed(0).padStart(6)}`);
    console.log(`        -> ${targets.join("  ")}`);
  }
  if (mine.every((p) => p.firepower < 1)) console.log("  (no armed provinces yet — build swords)");
  console.log("\n  order <province> <fraction 0-1> <target>   clear   next");
}

async function run(): Promise<void> {
  console.log(
    `Continent ${game.world.name} — ${level}, ${game.world.nations.length} nations, ` +
    `${game.world.provinces.length} provinces. You are nation ${you}.`,
  );

  while (game.winner === null) {
    if (game.phase === "production") {
      productionScreen();
      const done = await command(async (verb, args) => {
        const { land, population } = nationState(game.world, you);
        const spare = Math.max(0, population - land.farmland);
        if (verb === "set") {
          const { id, hint } = resolveCommodity(args[0] ?? "");
          const count = Number(args[1]);
          if (!id) {
            notice = hint!;
            return false;
          }
          if (!Number.isFinite(count)) {
            notice = `how many workers for ${id}? e.g. set ${id} 40`;
            return false;
          }
          if (locked.includes(id)) {
            notice = `${id} is locked — unlock ${id} first`;
            return false;
          }
          // Pro rata, as the original's sliders did (§3.6) — the others move too.
          const before = allocation[id] ?? 0;
          allocation = { ...reallocate(allocation, id, Math.max(0, count) / Math.max(spare, 1), locked) };
          const got = Math.round((allocation[id] ?? 0) * spare);
          notice = got === count
            ? `${id}: ${got} workers`
            : `${id}: ${got} workers — ${count} was more than the idle pool and the unlocked factories could supply`;
          if (Math.abs((allocation[id] ?? 0) - before) < 1e-12 && got !== count) {
            notice = `${id} unchanged at ${got} — nothing unlocked to draw on, and no idle labour`;
          }
          return false;
        }
        if (verb === "auto") {
          const previous = allocation;
          allocation = {
            ...balanceAllocation(economy, allocation, { level, land, population }, 80, locked),
          };
          const moved = Object.keys(allocation).some(
            (id) => Math.abs((allocation[id] ?? 0) - (previous[id] ?? 0)) > 1e-9,
          );
          notice = moved
            ? "balanced around the locked factories"
            : "nothing to balance — everything involved is locked";
          return false;
        }
        if (verb === "lock" || verb === "unlock") {
          const which = (args[0] ?? "").toLowerCase();
          if (which === "all") {
            // Every factory, idle ones included, so that releasing the two you mean to
            // tune is the whole of what can move.
            locked = verb === "lock" ? [...economy.graph.table.keys()] : [];
            notice = verb === "lock"
              ? `all ${locked.length} factories locked — unlock the ones you want to change`
              : "all factories unlocked";
            return false;
          }
          const { id, hint } = resolveCommodity(args[0] ?? "");
          if (!id) {
            notice = `${hint}   (or: ${verb} all)`;
            return false;
          }
          locked = verb === "lock"
            ? [...new Set([...locked, id])]
            : locked.filter((k) => k !== id);
          notice = `${id} ${verb === "lock" ? "locked" : "unlocked"}`;
          return false;
        }
        if (verb === "show") return false;
        notice = `unknown command "${verb}" — try set, auto, lock, unlock, show or next`;
        return false;
      });
      if (!done) continue;
      game.setAllocation(you, allocation as Allocation);
      game.advance();
    } else if (game.phase === "military-orders") {
      ordersScreen();
      const done = await command(async (verb, args) => {
        if (verb === "order") {
          const [from, fraction, target] = [Number(args[0]), Number(args[1]), Number(args[2])];
          try {
            game.setOrder(from, { marchFraction: fraction, target });
            console.log(`  province ${from}: ${(fraction * 100).toFixed(0)}% marches on ${target}`);
          } catch (e) {
            console.log(`  ${(e as Error).message}`);
          }
          return false;
        }
        if (verb === "clear") {
          game.orders = {};
          console.log("  orders cleared.");
          return false;
        }
        return true;
      });
      if (!done) continue;
      game.advance();
    } else if (game.phase === "military-execution") {
      const report = game.advance()!;
      console.log(`\n=== EXECUTION — turn ${report.turn} ===`);
      if (report.transfers.length === 0 && report.battles.length === 0) console.log("  quiet turn.");
      for (const t of report.transfers) {
        console.log(`  ${t.firepower.toFixed(0)} firepower moves ${t.from} -> ${t.to}`);
      }
      for (const b of report.battles) {
        const name = game.world.provinces[b.target]!.name;
        for (const w of b.waves) {
          console.log(
            `  ${w.committed.toFixed(0)} attacks ${name} from ${w.from}` +
            `${w.viaRoad ? " by road" : " cross-country (quartered)"}: ` +
            `${w.effective.toFixed(0)} vs ${w.defenceBefore.toFixed(0)} — ` +
            (w.captured ? `TAKEN, ${w.survivors.toFixed(0)} hold it` : "repulsed"),
          );
        }
        if (b.captured) console.log(`    ${name} falls to nation ${b.owner}; ${b.civilianLoss.toFixed(0)} civilians lost`);
      }
    } else {
      console.log(`\n=== RANKINGS — end of turn ${game.turn} ===`);
      for (const r of game.rankings()) {
        console.log(
          `  ${r.nation === you ? "you " : "    "} nation ${r.nation}: ` +
          `${pad(r.population, 6)} people  ${pad(r.provinces, 3)} provinces  ${pad(r.firepower.toFixed(0), 6)} firepower`,
        );
      }
      console.log("\n  undo   next   quit");
      const answer = (await ask("> ")).trim().toLowerCase();
      if (answer === "quit") break;
      if (answer === "undo") {
        game.undoTurn();
        console.log("  turn undone.");
        continue;
      }
      game.advance();
    }
  }

  if (game.winner !== null) {
    console.log(`\nNation ${game.winner} has conquered the world.${game.winner === you ? " That is you." : ""}`);
  }
  finish();
}

/** Read commands until one of them means "advance the phase". */
async function command(
  handle: (verb: string, args: string[]) => Promise<boolean>,
): Promise<boolean> {
  const line = (await ask("> ")).trim();
  const [verb = "", ...args] = line.split(/\s+/);
  if (verb === "quit") {
    finish();
    process.exit(0);
  }
  if (verb === "next" || verb === "") return true;
  return handle(verb.toLowerCase(), args);
}

await run();
