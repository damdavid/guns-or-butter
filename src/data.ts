/**
 * Commodity table and tuning constants, transcribed from docs/MECHANICS-SPEC.md.
 *
 * Recipes are §3.3 (confirmed in-game). `k`/`a` are §3.4 — only five industries are
 * anchored to real data; the rest are placeholders. Terrain constants are §2.2
 * (measured for Lumber only).
 */
import type { Commodity, CommodityId, Level } from "./types.ts";

/**
 * Pig Iron's coefficients disagree between sources (§8.2): the in-game reading is
 * 0.25 charcoal + 0.95 iron ore, but the manual's reference state only closes with
 * ~0.246 + ~0.94. Selectable so the fixture test can report on both.
 */
export type PigIronVariant = "in-game" | "fixture-derived";

/**
 * Default is `fixture-derived`. The in-game display reads 0.25 / 0.95, but those values
 * cannot reproduce the manual's reference state (they give pig iron 196 against an
 * observed 199, and an iron-ore shortfall the screenshot does not show). The screenshot
 * closes on ~0.246 / ~0.94, so the displayed figures are almost certainly rounded.
 */
export const DEFAULT_PIG_IRON: PigIronVariant = "fixture-derived";

const PIG_IRON: Record<PigIronVariant, Record<CommodityId, number>> = {
  "in-game": { charcoal: 0.25, "iron-ore": 0.95 },
  "fixture-derived": { charcoal: 0.246, "iron-ore": 0.94 },
};

export function commodityTable(
  pigIron: PigIronVariant = DEFAULT_PIG_IRON,
): Map<CommodityId, Commodity> {
  const list: Commodity[] = [
    // --- raws (§3.2). Lumber's a/k are measured; the other seven are placeholders.
    { id: "lumber", kind: "raw", inputs: {}, k: 6.3626, a: 1.1344, terrain: "forest" },
    { id: "sulfur", kind: "raw", inputs: {}, k: 4.5, a: 1.1, terrain: "desert" },
    { id: "iron-ore", kind: "raw", inputs: {}, k: 5.1716, a: 1.1, terrain: "mountains" },
    { id: "coal", kind: "raw", inputs: {}, k: 6.0, a: 1.1, terrain: "mountains" },
    { id: "light-metal", kind: "raw", inputs: {}, k: 4.0, a: 1.1, terrain: "mountains" },
    { id: "nitrate", kind: "raw", inputs: {}, k: 4.0, a: 1.1, terrain: "desert" },
    { id: "heavy-metal", kind: "raw", inputs: {}, k: 3.5, a: 1.1, terrain: "mountains" },
    { id: "petroleum", kind: "raw", inputs: {}, k: 3.0, a: 1.1, terrain: "desert" },

    // --- intermediates
    { id: "charcoal", kind: "intermediate", inputs: { lumber: 1.0 }, k: 6.5279, a: 1.125 },
    { id: "pig-iron", kind: "intermediate", inputs: PIG_IRON[pigIron], k: 4.643, a: 1.15 },
    { id: "gunpowder", kind: "intermediate", inputs: { sulfur: 0.25, charcoal: 0.5 }, k: 4.643, a: 1.15 },
    { id: "iron", kind: "intermediate", inputs: { "iron-ore": 1.0, coal: 0.5 }, k: 5.8751, a: 1.125 },
    { id: "low-grade-steel", kind: "intermediate", inputs: { "iron-ore": 0.8, "light-metal": 0.25, coal: 0.8 }, k: 5.2876, a: 1.125 },
    { id: "explosives", kind: "intermediate", inputs: { sulfur: 0.25, charcoal: 0.5, nitrate: 0.25 }, k: 4.1787, a: 1.15 },
    { id: "high-grade-steel", kind: "intermediate", inputs: { "iron-ore": 0.75, "light-metal": 0.15, coal: 0.75 }, k: 5.2876, a: 1.125 },
    { id: "high-explosives", kind: "intermediate", inputs: { sulfur: 0.25, petroleum: 0.5, nitrate: 0.25 }, k: 5.2876, a: 1.125 },
    { id: "steam-engine", kind: "intermediate", inputs: { "low-grade-steel": 0.5, coal: 0.5 }, k: 4.643, a: 1.15 },
    { id: "wire", kind: "intermediate", inputs: { "light-metal": 1.0 }, k: 6.5279, a: 1.125 },
    { id: "pipe", kind: "intermediate", inputs: { "heavy-metal": 1.0 }, k: 6.5279, a: 1.125 },
    { id: "electrics", kind: "intermediate", inputs: { "heavy-metal": 0.5, wire: 0.5 }, k: 4.643, a: 1.15 },
    { id: "ball-bearing", kind: "intermediate", inputs: { "high-grade-steel": 0.6, "heavy-metal": 0.4 }, k: 4.643, a: 1.15 },
    { id: "diesel-engine", kind: "intermediate", inputs: { petroleum: 0.5, "high-grade-steel": 0.4, electrics: 0.1, "ball-bearing": 0.1 }, k: 2.9721, a: 1.175 },
    { id: "instruments", kind: "intermediate", inputs: { electrics: 0.5, "ball-bearing": 0.5 }, k: 3.6693, a: 1.175 },

    // --- agricultural tiers. Combine precedes Irrigation (§4.3).
    { id: "farm-tools", kind: "tool", tier: 1, inputs: { lumber: 0.5, "pig-iron": 0.5 }, k: 3.5126, a: 1.2 },
    { id: "iron-plow", kind: "tool", tier: 2, inputs: { iron: 0.5, lumber: 0.5 }, k: 1.5077, a: 1.24 },
    { id: "combine", kind: "tool", tier: 3, inputs: { "steam-engine": 0.5, iron: 0.5 }, k: 0.6328, a: 1.28 },
    { id: "irrigation", kind: "tool", tier: 4, inputs: { pipe: 0.75, electrics: 0.25 }, k: 0.2599, a: 1.32 },
    { id: "tractor", kind: "tool", tier: 5, inputs: { "diesel-engine": 0.75, "low-grade-steel": 0.25 }, k: 0.1045, a: 1.36 },

    // --- weapon tiers
    { id: "sword", kind: "weapon", tier: 1, inputs: { "pig-iron": 1.0 }, k: 3.5126, a: 1.2 },
    { id: "musket", kind: "weapon", tier: 2, inputs: { iron: 0.5, gunpowder: 0.5 }, k: 1.5077, a: 1.24 },
    { id: "rifle", kind: "weapon", tier: 3, inputs: { "low-grade-steel": 0.5, explosives: 0.5 }, k: 0.6328, a: 1.28 },
    { id: "cannon", kind: "weapon", tier: 4, inputs: { "low-grade-steel": 0.5, "high-explosives": 0.5 }, k: 0.2599, a: 1.32 },
    { id: "tank", kind: "weapon", tier: 5, inputs: { "high-grade-steel": 0.4, "high-explosives": 0.25, "diesel-engine": 0.25, instruments: 0.125 }, k: 0.1045, a: 1.36 },
  ];
  return new Map(list.map((c) => [c.id, c]));
}

/** Tier n yields 2^(n-1), for both food per ton of tool and firepower per ton (§4.3, §5.2). */
export const tierYield = (tier: number): number => 2 ** (tier - 1);

export const PLAYERS: Record<Level, number> = {
  beginner: 2,
  intermediate: 4,
  expert: 8,
};

/**
 * Terrain response, measured for forest -> Lumber (§2.2).
 *
 * `y = max(floor, base + m * acres)` in Lumber output units; dividing by the Beginner
 * terrain-off value makes it the dimensionless multiplier `f`. Reusing it for mountains
 * and deserts is an untested assumption.
 */
export const TERRAIN = {
  /** Marginal return per acre. Slightly shallower at Expert; measured per level. */
  m: 0.111,
  /**
   * The zero-acre floor scales with player count as `18.4461 * N^-1.5490`, fitted
   * across all three levels (2/4/8 players) to within 2%. Two independent doublings
   * both land near a ratio of 2.9, so this is a measured relationship rather than the
   * one-parameter guess it started as.
   */
  floorCoefficient: 18.4461,
  playerExponent: -1.549,
  /** The floor sits ~15% above the zero-acre extrapolation of the linear part. */
  floorOverBase: 1.1541,
  /** Beginner, terrain ignored. Defines f = 1. */
  beginnerY: 6.3626,
} as const;

export const AGRICULTURE = {
  /** Tons of food per acre with no tools (§4.2). */
  baseYield: 1.0,
  /** Tools beyond 1 ton per acre are wasted (§4.2). */
  toolsPerAcre: 1.0,
  /** Workers locked to farmland, not adjustable (§4.1). */
  workersPerAcre: 1.0,
  /** Tons of food per person for break-even (§4.4). */
  foodPerPerson: 1.0,
} as const;

/**
 * Population response to food surplus (§4.4). Growth goes as the square root of
 * surplus; decline is steeper than growth. Both coefficients are unmeasured — calibrate
 * `growth` so an all-labour tier-1 agricultural start yields ~30% growth.
 */
export const POPULATION = {
  growth: 1.0,
  decline: 1.5,
} as const;
