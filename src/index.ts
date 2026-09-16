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
export {
  Game,
  PHASE_ORDER,
  balanceAllocation,
  reallocate,
  subsistenceAllocation,
  workersFor,
  type Allocation,
  type GameSnapshot,
  type Phase,
  type Ranking,
  type TurnReport,
} from "./game.ts";
export {
  COMBAT,
  conqueror,
  distributeWeapons,
  firepowerOf,
  nationFirepower,
  resolveAssault,
  resolveMilitary,
  type Battle,
  type MilitaryOrder,
  type MilitaryResult,
  type Orders,
  type Transfer,
} from "./military.ts";
export { generateWorld, nationState, borderSegments, polygonContains, vertexPairKey, WORLDGEN, type BorderSegment, type WorldgenOptions } from "./worldgen.ts";
export { makeRng, hashName, type Rng } from "./rng.ts";
export { triangulate, dualPolygons, edges as spokeEdges, edgeKey } from "./delaunay.ts";
export { provinceName, uniqueNames } from "./names.ts";
export type * from "./types.ts";
