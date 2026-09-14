/** Public surface of the economy simulation. See docs/MECHANICS-SPEC.md. */
export { Economy, nextPopulation, type EconomyOptions } from "./economy.ts";
export { buildGraph, type Graph } from "./graph.ts";
export { acresOf, response, terrainMultiplier } from "./terrain.ts";
export {
  AGRICULTURE,
  DEFAULT_PIG_IRON,
  PLAYERS,
  POPULATION,
  TERRAIN,
  commodityTable,
  tierYield,
  type PigIronVariant,
} from "./data.ts";
export type * from "./types.ts";
