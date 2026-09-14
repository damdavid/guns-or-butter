/**
 * Production resolution: capacity, demand-driven allocation, agriculture, population.
 * See docs/MECHANICS-SPEC.md §3.4, §3.5, §4.
 */
import { AGRICULTURE, POPULATION, commodityTable, tierYield, type PigIronVariant } from "./data.ts";
import { buildGraph, type Graph } from "./graph.ts";
import { acresOf, terrainMultiplier } from "./terrain.ts";
import type {
  AgricultureResult,
  CommodityId,
  CommodityResult,
  EconomyResult,
  EconomyState,
} from "./types.ts";

const EPS = 1e-9;

export interface EconomyOptions {
  pigIron?: PigIronVariant;
  /**
   * Per-commodity `k`/`a` overrides. Most of the table is placeholder values (§3.4)
   * that will move as more readings arrive, so calibration needs to be swappable
   * without editing the data table.
   */
  overrides?: Partial<Record<CommodityId, { k?: number; a?: number }>>;
}

export class Economy {
  readonly graph: Graph;

  constructor(options: EconomyOptions = {}) {
    const table = commodityTable(options.pigIron);
    for (const [id, o] of Object.entries(options.overrides ?? {})) {
      const c = table.get(id);
      if (!c) throw new Error(`override for unknown commodity: ${id}`);
      table.set(id, { ...c, k: o?.k ?? c.k, a: o?.a ?? c.a });
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
   * Labour-determined output ceiling: `k * f(terrain) * L^a`. Superlinear in labour —
   * this is the economies-of-scale engine the whole design turns on (§3.4).
   */
  capacity(state: EconomyState, id: CommodityId): number {
    const c = this.graph.table.get(id);
    if (!c) throw new Error(`unknown commodity: ${id}`);
    const workers = state.workers[id] ?? 0;
    if (workers <= 0) return 0;
    const f =
      c.kind === "raw" ? terrainMultiplier(state.level, acresOf(state.land, c.terrain)) : 1;
    return c.k * f * workers ** c.a;
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

/** Growth goes as the square root of food surplus; decline is steeper (§4.4). */
export function nextPopulation(population: number, foodSurplus: number): number {
  if (foodSurplus >= 0) {
    return population + POPULATION.growth * Math.sqrt(foodSurplus);
  }
  return Math.max(0, population - POPULATION.decline * Math.sqrt(-foodSurplus));
}
