/** Core types for the economy simulation. See docs/MECHANICS-SPEC.md §3. */

export type CommodityId = string;

export type Terrain = "farmland" | "forest" | "mountains" | "desert";

export type CommodityKind = "raw" | "intermediate" | "tool" | "weapon";

/** Difficulty level. Determines player count, which scales the terrain base (§2.2). */
export type Level = "beginner" | "intermediate" | "expert";

export interface Commodity {
  id: CommodityId;
  kind: CommodityKind;
  /** Tons of each input consumed per ton of output. Empty for raws. */
  inputs: Readonly<Record<CommodityId, number>>;
  /** Productivity coefficient. For raws this is the f=1 (terrain-off) baseline. */
  k: number;
  /** Productivity exponent, > 1 — the economies-of-scale engine (§3.4). */
  a: number;
  /** Raws only: the terrain whose acreage raises this commodity's productivity. */
  terrain?: Terrain;
  /** Tools and weapons: 1-5. Drives food yield / firepower per ton, both 2^(tier-1). */
  tier?: number;
}

/** A nation's land endowment. Acreage per terrain type. */
export interface Land {
  farmland: number;
  forest: number;
  mountains: number;
  desert: number;
}

export interface EconomyState {
  level: Level;
  land: Land;
  population: number;
  /** Workers assigned per commodity. Agricultural labour is implicit (§4.1). */
  workers: Readonly<Record<CommodityId, number>>;
}

export interface CommodityResult {
  id: CommodityId;
  workers: number;
  /** Labour-determined ceiling, before input shortages. */
  capacity: number;
  output: number;
  /** Total demanded by all consumers, proportional to their capacity (§3.5). */
  demand: number;
  /** output - demand. Negative means shortfall, which is what the game displays. */
  surplus: number;
  /** `"Labor"`, or the input that capped output. */
  limitingFactor: CommodityId | "Labor";
  /** Tons received of each input. */
  received: Record<CommodityId, number>;
}

export interface AgricultureResult {
  acres: number;
  /** Workers locked into farming at 1 per acre (§4.1). */
  workers: number;
  /** Tons of each tool actually put to use, highest tier first. */
  toolsUsed: Record<CommodityId, number>;
  food: number;
  /** Food needed to hold population steady, at 1 ton per person (§4.4). */
  required: number;
  surplus: number;
}

export interface EconomyResult {
  commodities: Record<CommodityId, CommodityResult>;
  agriculture: AgricultureResult;
  /** Total firepower produced this turn, summed over weapon tiers (§5.2). */
  firepower: number;
  population: number;
  nextPopulation: number;
}
