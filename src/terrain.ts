/**
 * Raw extraction capacity as a function of terrain (§2.2).
 *
 * `capacity = (base + m * acres) * L^a`, all three measured per (commodity, level)
 * from 53 readings. Three findings drive this shape:
 *
 * - The response is NOT shared across raws. Coal gains far more per mountain acre,
 *   relative to its own base, than Iron Ore does.
 * - There is no `max()` floor. An earlier draft inferred one from three points; with
 *   five points per series a plain line fits, and the non-zero intercept is what the
 *   design dialogue's "modicum of natural resources" actually is.
 * - Advanced raws have an intercept of ~0. Without desert you get no petroleum at any
 *   labour, which is why the modicum only shows up on the early-tier raws.
 */
import { RAW_PARAMS, type RawParams } from "./calibration.ts";
import type { Commodity, Land, Level, Terrain } from "./types.ts";

const ORDER: Level[] = ["beginner", "intermediate", "expert"];

export function acresOf(land: Land, terrain: Terrain | undefined): number {
  return terrain === undefined ? 0 : land[terrain];
}

/** Nearest measured level, for commodities never sampled at the level asked for. */
export function rawParams(c: Commodity, level: Level): RawParams | undefined {
  const per = RAW_PARAMS[c.id];
  if (!per) return undefined;
  const direct = per[level];
  if (direct) return direct;
  const i = ORDER.indexOf(level);
  for (let d = 1; d < ORDER.length; d++) {
    const found = per[ORDER[i - d]!] ?? per[ORDER[i + d]!];
    if (found) return found;
  }
  return undefined;
}

export function rawCoefficient(c: Commodity, level: Level, acres: number): number {
  const p = rawParams(c, level);
  return p ? Math.max(0, p.base + p.m * acres) : 0;
}
