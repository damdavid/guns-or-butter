/**
 * Terrain -> productivity multiplier for raw extraction (§2.2).
 *
 * Measured for forest -> Lumber across 21 readings. `y = max(floor, base + m*acres)`
 * in Lumber output units; normalising by the Beginner terrain-off value yields the
 * dimensionless `f`, with `f = 1` meaning "as productive as terrain-disabled Beginner".
 *
 * Intermediate and Expert have measured `base`/`m`. Anything else falls back to the
 * player-count hypothesis, which is two data points against one parameter — see §2.2.
 */
import { PLAYERS, TERRAIN } from "./data.ts";
import type { Land, Level, Terrain } from "./types.ts";

interface Response {
  base: number;
  m: number;
  /** Measured directly from 0-acre readings rather than derived from `base`. */
  floor: number;
}

/**
 * Per-level fits from the joint least-squares solve over all 22 Lumber readings
 * (a = 1.1273, rmse 1.37 tons). Expert's slope is measurably shallower than
 * Intermediate's, so a single level-independent `m` is not used where a fit exists.
 */
const MEASURED: Partial<Record<Level, Response>> = {
  intermediate: { base: 1.875, m: 0.1143, floor: 2.1635 },
  expert: { base: 0.6468, m: 0.1051, floor: 0.7581 },
};

export function response(level: Level): Response {
  const measured = MEASURED[level];
  if (measured) return measured;
  const scale = (4 / PLAYERS[level]) ** TERRAIN.playerExponent;
  const base = TERRAIN.baseIntermediate * scale;
  return { base, m: TERRAIN.m, floor: TERRAIN.floorMultiple * base };
}

/**
 * Productivity multiplier for a raw whose terrain the nation holds `acres` of.
 * Beginner disables terrain entirely, so it always returns 1.
 */
export function terrainMultiplier(level: Level, acres: number): number {
  if (level === "beginner") return 1;
  const { base, m, floor } = response(level);
  const y = Math.max(floor, base + m * acres);
  return y / TERRAIN.beginnerY;
}

export function acresOf(land: Land, terrain: Terrain | undefined): number {
  if (terrain === undefined) return 0;
  return land[terrain];
}
