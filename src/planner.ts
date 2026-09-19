/**
 * Exact chain staffing (§3.5).
 *
 * `balanceAllocation` moves one small share at a time, from whoever has output to spare
 * to whatever is throttling something else. That cannot cross a valley. A cold chain
 * produces nothing at any stage until every stage is staffed at once, so no single move
 * improves anything and the search stops where it started. Measured on an expert
 * two-nation union it left 60 to 200 tons of food unclaimed, and — the part that gives
 * it away — its shortfall grew as the economy grew, while the reachable optimum shrank.
 *
 * Staffing is not really a search. Output is `k * workers^a` per factory and recipes are
 * fixed ratios, so the labour any target tonnage costs can be computed outright, and it
 * climbs monotonically with the target. One binary search therefore gives the most a
 * given workforce can actually make.
 */
import type { Economy } from "./economy.ts";
import { tierYield } from "./data.ts";
import type { CommodityId, Land, Level } from "./types.ts";

export interface PlanContext {
  level: Level;
  land: Land;
  population: number;
}

/**
 * The `k` and `a` of a factory's output curve, read off `capacity` rather than the
 * calibration tables: raws take their coefficient from terrain acreage, some commodities
 * fall back to a neighbouring level, and overrides may replace either. Probing the real
 * function is exact for `k * w^a` and cannot drift away from it.
 */
function curve(economy: Economy, ctx: PlanContext, id: CommodityId): { k: number; a: number } {
  const at = (workers: number) =>
    economy.capacity({ level: ctx.level, land: ctx.land, population: ctx.population, workers: { [id]: workers } }, id);
  const k = at(1);
  if (!(k > 0)) return { k: 0, a: 1 };
  return { k, a: Math.log(at(4) / k) / Math.log(4) };
}

/** Labour to produce `tons` of `id` alone, ignoring its inputs. Infinite if it cannot. */
export function workersForTons(
  economy: Economy,
  ctx: PlanContext,
  id: CommodityId,
  tons: number,
): number {
  if (tons <= 0) return 0;
  const { k, a } = curve(economy, ctx, id);
  return k > 0 ? (tons / k) ** (1 / a) : Infinity;
}

/**
 * Tons of every commodity needed to deliver `tons` of `good`, the good itself included.
 *
 * Contributions add rather than overwrite, because the tree is a graph: iron ore feeds
 * both pig iron and iron, and a plan that ordered enough for only one of them would come
 * up short at exactly the moment both chains ran.
 */
export function chainDemand(
  economy: Economy,
  good: CommodityId,
  tons: number,
): Map<CommodityId, number> {
  const need = new Map<CommodityId, number>();
  const walk = (id: CommodityId, want: number, depth: number) => {
    if (want <= 0 || depth > 16) return;
    need.set(id, (need.get(id) ?? 0) + want);
    for (const [input, perTon] of Object.entries(economy.graph.table.get(id)?.inputs ?? {})) {
      walk(input, want * perTon, depth + 1);
    }
  };
  walk(good, tons, 0);
  return need;
}

/**
 * Labour for `tons` of `good` including its whole input tree, less whatever `already`
 * produces. Existing output is credited because a locked factory is still a supplier,
 * and charging for tonnage that is already being made would understate what the rest of
 * the workforce can afford.
 */
export function chainWorkers(
  economy: Economy,
  ctx: PlanContext,
  good: CommodityId,
  tons: number,
  already: ReadonlyMap<CommodityId, number> = new Map(),
): number {
  let total = 0;
  for (const [id, want] of chainDemand(economy, good, tons)) {
    const short = want - (already.get(id) ?? 0);
    if (short <= 0) continue;
    total += workersForTons(economy, ctx, id, short);
    if (!Number.isFinite(total)) return Infinity;
  }
  return total;
}

/** The most `good` that `workers` can staff end to end, in tons. */
export function affordableTons(
  economy: Economy,
  ctx: PlanContext,
  good: CommodityId,
  workers: number,
  already: ReadonlyMap<CommodityId, number> = new Map(),
  ceiling = Infinity,
): number {
  if (workers <= 0) return 0;
  const cost = (tons: number) => chainWorkers(economy, ctx, good, tons, already);
  if (cost(1e-6) > workers) return 0;

  let hi = 1;
  while (hi < ceiling && cost(hi) <= workers) hi *= 2;
  let lo = 0;
  hi = Math.min(hi, ceiling);
  if (cost(hi) <= workers) return hi;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (cost(mid) <= workers) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Whole workers per factory that deliver `tons` of `good`.
 *
 * Every stage rounds *up*. Flooring looked tidier and cost about 3% of the food: a
 * fractional worker dropped at each of five stages starves the stage above it, and the
 * shortfall compounds up the chain. Rounding up overspends the budget by at most one
 * worker per staffed factory, which the caller trims.
 */
export function staffChain(
  economy: Economy,
  ctx: PlanContext,
  good: CommodityId,
  tons: number,
  already: ReadonlyMap<CommodityId, number> = new Map(),
): Record<CommodityId, number> {
  const workers: Record<CommodityId, number> = {};
  for (const [id, want] of chainDemand(economy, good, tons)) {
    const short = want - (already.get(id) ?? 0);
    if (short <= 0) continue;
    const need = workersForTons(economy, ctx, id, short);
    if (Number.isFinite(need) && need > 0) workers[id] = Math.ceil(need);
  }
  return workers;
}

export interface FoodPlan {
  good: CommodityId;
  tons: number;
  food: number;
  workers: Record<CommodityId, number>;
}

/**
 * The tool chain that feeds the most people, and the labour to run it.
 *
 * `allowed`, when given, must contain every commodity in the chain and not merely the
 * tool at the end of it.
 *
 * Which tool wins is a property of the ground, not of the difficulty: forest makes the
 * farm-tools chain cheap through lumber and charcoal, while mountains and coal favour
 * iron plows, whose tier-2 ton is worth two of food instead of one. Both were the right
 * answer on two of four measured continents, so the choice has to be made per nation.
 */
export function bestFoodChain(
  economy: Economy,
  ctx: PlanContext,
  workers: number,
  allowed?: ReadonlySet<CommodityId>,
  already: ReadonlyMap<CommodityId, number> = new Map(),
): FoodPlan | null {
  const acres = ctx.land.farmland;
  let best: FoodPlan | null = null;
  for (const commodity of economy.graph.table.values()) {
    if (commodity.kind !== "tool") continue;
    // The whole tree has to be on offer, not just the tool. Checking only the tool let
    // a beginner economy be handed tractors, diesel engines and petroleum (§1.1).
    if (allowed && [...chainDemand(economy, commodity.id, 1).keys()].some((c) => !allowed.has(c))) continue;
    // Tools past one ton per acre are wasted (§4.2), so there is nothing to search above.
    const tons = affordableTons(economy, ctx, commodity.id, workers, already, acres);
    if (tons <= 0) continue;
    const food = Math.min(tons, acres) * tierYield(commodity.tier!);
    if (!best || food > best.food) {
      best = { good: commodity.id, tons, food, workers: staffChain(economy, ctx, commodity.id, tons, already) };
    }
  }
  return best;
}
