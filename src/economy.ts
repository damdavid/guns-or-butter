/**
 * Production resolution: capacity, demand-driven allocation, agriculture, population.
 * See docs/MECHANICS-SPEC.md §3.4, §3.5, §4.
 */
import { AGRICULTURE, POPULATION, commodityTable, tierYield, type PigIronVariant } from "./data.ts";
import { buildGraph, type Graph } from "./graph.ts";
import { PARAMS } from "./calibration.ts";
import { acresOf, rawCoefficient, rawParams } from "./terrain.ts";
import type {
  AgricultureResult,
  CommodityId,
  Level,
  CommodityResult,
  EconomyResult,
  EconomyState,
} from "./types.ts";

const EPS = 1e-9;

export interface EconomyOptions {
  pigIron?: PigIronVariant;
  /**
   * Per-commodity overrides on the measured coefficient and exponent. Used to probe
   * "what if this industry were calibrated differently" without regenerating
   * src/calibration.ts — see the §8.2 pig iron test for the motivating case.
   */
  overrides?: Partial<Record<CommodityId, { k?: number; a?: number }>>;
}

export class Economy {
  readonly graph: Graph;
  private readonly overrides: NonNullable<EconomyOptions["overrides"]>;

  constructor(options: EconomyOptions = {}) {
    const table = commodityTable(options.pigIron);
    this.overrides = options.overrides ?? {};
    for (const id of Object.keys(this.overrides)) {
      if (!table.has(id)) throw new Error(`override for unknown commodity: ${id}`);
    }
    this.graph = buildGraph(table);
  }

  /** Workers locked into farming, at one per acre of farmland (§4.1). */
  agriculturalWorkers(state: EconomyState): number {
    return state.land.farmland * AGRICULTURE.workersPerAcre;
  }

  /** Workers the player is free to allocate. Negative means farmland exceeds population. */
  allocatableWorkers(state: EconomyState): number {
    return state.population - this.agriculturalWorkers(state);
  }

  /**
   * Labour-determined output ceiling, superlinear in labour — the economies-of-scale
   * engine the whole design turns on (§3.4). Every exponent is measured, and they
   * range from 1.126 (Lumber, Farm Tools, Sword) to 2.53 (Diesel Engine).
   *
   * Raws draw their coefficient from their own terrain acreage; everything else has a
   * coefficient measured directly per level. Both vary by difficulty level, and the
   * per-level ratio differs between commodities, so no single multiplier will do.
   */
  capacity(state: EconomyState, id: CommodityId): number {
    const c = this.graph.table.get(id);
    if (!c) throw new Error(`unknown commodity: ${id}`);
    const workers = state.workers[id] ?? 0;
    if (workers <= 0) return 0;
    const over = this.overrides[id];
    if (c.kind === "raw") {
      const p = rawParams(c, state.level);
      if (!p) return 0;
      const K = over?.k ?? rawCoefficient(c, state.level, acresOf(state.land, c.terrain));
      return K * workers ** (over?.a ?? p.a);
    }
    const p = PARAMS[c.id]?.[state.level] ?? nearestParams(c.id, state.level);
    if (!p && over?.k === undefined) return 0;
    return (over?.k ?? p!.k) * workers ** (over?.a ?? p?.a ?? 1.1);
  }

  resolve(state: EconomyState): EconomyResult {
    const { table, byDepth, consumers } = this.graph;

    const capacity = new Map<CommodityId, number>();
    for (const id of table.keys()) capacity.set(id, this.capacity(state, id));

    // Demand is proportional to CAPACITY, not to achievable output — a factory reserves
    // inputs it cannot actually use and does not release them (§3.5).
    const demand = new Map<CommodityId, number>();
    const demandBy = new Map<CommodityId, Map<CommodityId, number>>();
    for (const id of table.keys()) {
      demand.set(id, 0);
      demandBy.set(id, new Map());
    }
    for (const c of table.values()) {
      for (const [input, coeff] of Object.entries(c.inputs)) {
        const want = capacity.get(c.id)! * coeff;
        demand.set(input, demand.get(input)! + want);
        demandBy.get(input)!.set(c.id, want);
      }
    }

    const output = new Map<CommodityId, number>();
    const received = new Map<CommodityId, Record<CommodityId, number>>();
    for (const id of table.keys()) received.set(id, {});

    // Shallowest first. Every consumer of a commodity is strictly deeper than it, so by
    // the time we compute a factory's output all of its inputs have been allocated.
    for (const tier of byDepth) {
      for (const id of tier) {
        const c = table.get(id)!;
        const cap = capacity.get(id)!;
        const got = received.get(id)!;

        let produced = cap;
        for (const [input, coeff] of Object.entries(c.inputs)) {
          if (coeff <= 0) continue;
          produced = Math.min(produced, (got[input] ?? 0) / coeff);
        }
        output.set(id, produced);

        // Distribute to consumers, shallowest consumer first: a simpler factory's
        // failure ripples further, so it gets first call on scarce supply (§3.5).
        let remaining = produced;
        for (const consumer of consumers.get(id)!) {
          const want = demandBy.get(id)!.get(consumer) ?? 0;
          const take = Math.min(want, remaining);
          received.get(consumer)![id] = take;
          remaining -= take;
        }
      }
    }

    const agriculture = this.resolveAgriculture(state, output);
    for (const [tool, used] of Object.entries(agriculture.toolsUsed)) {
      demand.set(tool, demand.get(tool)! + used);
    }

    const commodities: Record<CommodityId, CommodityResult> = {};
    for (const id of table.keys()) {
      const c = table.get(id)!;
      const cap = capacity.get(id)!;
      const out = output.get(id)!;
      const got = received.get(id)!;

      let limitingFactor: CommodityId | "Labor" = "Labor";
      if (out < cap - EPS) {
        let worst = Infinity;
        for (const [input, coeff] of Object.entries(c.inputs)) {
          if (coeff <= 0) continue;
          const ratio = (got[input] ?? 0) / coeff;
          if (ratio < worst) {
            worst = ratio;
            limitingFactor = input;
          }
        }
      }

      commodities[id] = {
        id,
        workers: state.workers[id] ?? 0,
        capacity: cap,
        output: out,
        demand: demand.get(id)!,
        surplus: out - demand.get(id)!,
        limitingFactor,
        received: got,
      };
    }

    let firepower = 0;
    for (const c of table.values()) {
      if (c.kind === "weapon") firepower += output.get(c.id)! * tierYield(c.tier!);
    }

    return {
      commodities,
      agriculture,
      firepower,
      population: state.population,
      nextPopulation: nextPopulation(state.population, agriculture.surplus),
    };
  }

  /**
   * Food output and tool usage (§4.2). Tool use is capped at one ton per acre in total;
   * higher tiers are consumed first because they yield more food per ton.
   */
  private resolveAgriculture(
    state: EconomyState,
    output: Map<CommodityId, number>,
  ): AgricultureResult {
    const acres = state.land.farmland;
    const tools = [...this.graph.table.values()]
      .filter((c) => c.kind === "tool")
      .sort((x, y) => tierYield(y.tier!) - tierYield(x.tier!));

    let headroom = acres * AGRICULTURE.toolsPerAcre;
    let fromTools = 0;
    const toolsUsed: Record<CommodityId, number> = {};
    for (const tool of tools) {
      const used = Math.min(output.get(tool.id) ?? 0, headroom);
      if (used <= 0) continue;
      toolsUsed[tool.id] = used;
      fromTools += used * tierYield(tool.tier!);
      headroom -= used;
    }

    const food = acres * AGRICULTURE.baseYield + fromTools;
    const required = state.population * AGRICULTURE.foodPerPerson;
    return {
      acres,
      workers: this.agriculturalWorkers(state),
      toolsUsed,
      food,
      required,
      surplus: food - required,
    };
  }
}

const LEVEL_ORDER: Level[] = ["beginner", "intermediate", "expert"];

/** Nearest measured level, for commodities never sampled at the level asked for. */
function nearestParams(id: CommodityId, level: Level) {
  const per = PARAMS[id];
  if (!per) return undefined;
  const i = LEVEL_ORDER.indexOf(level);
  for (let d = 1; d < LEVEL_ORDER.length; d++) {
    const found = per[LEVEL_ORDER[i - d]!] ?? per[LEVEL_ORDER[i + d]!];
    if (found) return found;
  }
  return undefined;
}

/** Growth goes as the square root of food surplus; decline is steeper (§4.4). */
export function nextPopulation(population: number, foodSurplus: number): number {
  if (foodSurplus >= 0) {
    return population + POPULATION.growth * Math.sqrt(foodSurplus);
  }
  return Math.max(0, population - POPULATION.decline * Math.sqrt(-foodSurplus));
}
