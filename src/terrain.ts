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
 * Per-level fits from the joint least-squares solve over all 27 Lumber readings
 * (a = 1.1344, rmse 1.18 tons). Expert's slope is measurably shallower than
 * Intermediate's, so a single level-independent `m` is not used where a fit exists.
 *
 * Beginner's slope is 0 because the manual states terrain is ignored at that level;
 * every Beginner reading happens to be zero-forest, so the slope is not testable there.
 */
const MEASURED: Partial<Record<Level, Response>> = {
  beginner: { base: 6.3626, m: 0, floor: 6.3626 },
  intermediate: { base: 1.8607, m: 0.1117, floor: 2.1148 },
  expert: { base: 0.6342, m: 0.103, floor: 0.7431 },
};

export function response(level: Level): Response {
  const measured = MEASURED[level];
  if (measured) return measured;
  const floor = TERRAIN.floorCoefficient * PLAYERS[level] ** TERRAIN.playerExponent;
  return { base: floor / TERRAIN.floorOverBase, m: TERRAIN.m, floor };
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
