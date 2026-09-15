/** Public surface of the economy simulation. See docs/MECHANICS-SPEC.md. */
export { Economy, nextPopulation, type EconomyOptions } from "./economy.ts";
export { buildGraph, type Graph } from "./graph.ts";
export { acresOf, rawCoefficient, rawParams } from "./terrain.ts";
export { PARAMS, RAW_PARAMS, type Params, type RawParams } from "./calibration.ts";
export {
  AGRICULTURE,
  DEFAULT_PIG_IRON,
  PLAYERS,
  POPULATION,
  commodityTable,
  tierYield,
  type PigIronVariant,
} from "./data.ts";
export type * from "./types.ts";
