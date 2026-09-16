/**
 * The turn loop (§1.2). Drives the economy, the map and the military through the phase
 * sequence, and is the first place the three actually meet.
 *
 * The couplings only exist here: weapon output becomes firepower on the map, food
 * surplus becomes population, conquest changes a nation's land and therefore next
 * turn's production, and scorched earth takes population back out again.
 *
 * Phases are strictly sequential and there is no going back mid-turn — the original was
 * emphatic about that, and offered `Undo Turn` at the Rankings phase as the one relief.
 */
import { AGRICULTURE } from "./data.ts";
import { Economy } from "./economy.ts";
import {
  conqueror,
  distributeWeapons,
  resolveMilitary,
  type Battle,
  type MilitaryOrder,
  type Orders,
  type Transfer,
} from "./military.ts";
import { generateWorld, nationState } from "./worldgen.ts";
import type { CommodityId, EconomyResult, Land, Level, World } from "./types.ts";

/**
 * The Economic Union phase (§6) is absent: diplomacy is specified but not built. When
 * it arrives it runs before production, and only at Expert.
 */
export type Phase = "production" | "military-orders" | "military-execution" | "rankings";

export const PHASE_ORDER: Phase[] = [
  "production",
  "military-orders",
  "military-execution",
  "rankings",
];

/** Labour as fractions of the workforce, which is what the original's sliders set. */
export type Allocation = Readonly<Record<CommodityId, number>>;

export interface Ranking {
  nation: number;
  population: number;
  provinces: number;
  firepower: number;
}

export interface TurnReport {
  turn: number;
  production: Record<number, EconomyResult>;
  transfers: Transfer[];
  battles: Battle[];
  rankings: Ranking[];
}

export interface GameSnapshot {
  world: World;
  turn: number;
  allocations: Record<number, Allocation>;
  locked: Record<number, CommodityId[]>;
}

/**
 * Labour split for a nation with nothing better to do — scaffolding so the loop can be
 * exercised end to end, NOT an AI. Step 4 of §10 replaces it. It feeds the tier-1
 * agricultural chain, because a nation that allocates nothing starves immediately and
 * the loop has nothing to show.
 */
export function subsistenceAllocation(): Allocation {
  return {
    lumber: 0.22,
    "iron-ore": 0.22,
    charcoal: 0.12,
    "pig-iron": 0.2,
    "farm-tools": 0.24,
  };
}

/**
 * Move one factory's share of the workforce, taking from or giving to the others
 * pro rata (§3.6).
 *
 * This is the original's slider behaviour, and it is deliberately aggressive: the
 * manual warns that dumping everyone into one factory "can completely obliterate your
 * carefully considered worker allocations", and that falls straight out of the
 * arithmetic here rather than being a special case.
 *
 * Locked factories are pinned against the redistribution *and* against the player,
 * which is what makes the lock worth having — it is the only way to protect an
 * allocation you have got right while you fiddle with the rest.
 *
 * The total is preserved, so an allocation that starts fully committed stays that way.
 */
export function reallocate(
  allocation: Allocation,
  id: CommodityId,
  share: number,
  locked: readonly CommodityId[] = [],
): Allocation {
  const pinned = new Set(locked);
  if (pinned.has(id)) return { ...allocation };

  const entries = Object.entries(allocation);
  const others = entries.filter(([key]) => key !== id && !pinned.has(key));
  const othersSum = others.reduce((sum, [, v]) => sum + Math.max(0, v), 0);
  const current = Math.max(0, allocation[id] ?? 0);

  // Only unpinned labour is available, so a heavily locked economy simply cannot feed
  // the factory you are dragging — which is the point.
  const target = Math.min(Math.max(0, share), current + othersSum);
  const delta = target - current;
  const next: Record<CommodityId, number> = { ...allocation, [id]: target };
  if (Math.abs(delta) < 1e-12) return next;
  if (othersSum <= 0) return next;

  const scale = (othersSum - delta) / othersSum;
  for (const [key, value] of others) next[key] = Math.max(0, Math.max(0, value) * scale);
  return next;
}

/**
 * Nudge a labour split toward one that actually produces, by following the game's own
 * advice: "when you see a factory that has too little or too much output, just change
 * the worker allocation until the surplus is close to zero."
 *
 * This is scaffolding for the loop and a building block for the AI, not the AI itself.
 * It is needed because an unbalanced split does not merely produce less — it can
 * produce nothing at all. A plausible-looking opening allocation left farm tools at
 * zero output for fifteen straight turns: charcoal is shallower in the graph, so under
 * the priority rule (§3.5) it took every ton of lumber and starved the tools completely.
 *
 * Each pass moves a little labour from an industry that is running at capacity with
 * output to spare, to whichever input is throttling something else.
 */
export function balanceAllocation(
  economy: Economy,
  base: Allocation,
  context: { level: Level; land: Land; population: number },
  passes = 80,
  locked: readonly CommodityId[] = [],
): Allocation {
  const pinned = new Set(locked);
  const ids = Object.keys(base).filter((id) => (base[id] ?? 0) > 0);
  let current: Record<CommodityId, number> = { ...base };

  for (let pass = 0; pass < passes; pass++) {
    const result = economy.resolve({
      ...context,
      workers: workersFor(current, context.population, context.land.farmland),
    });

    // Who is starving, and on what? Follow the limiting factor, exactly as a player
    // would click through from the throttled factory to its missing input.
    let needy: CommodityId | null = null;
    let worstGap = 0;
    for (const id of ids) {
      const c = result.commodities[id];
      if (!c || c.limitingFactor === "Labor") continue;
      const gap = c.capacity - c.output;
      if (gap > worstGap && ids.includes(c.limitingFactor)) {
        worstGap = gap;
        needy = c.limitingFactor;
      }
    }
    // A pinned factory cannot be topped up, so there is no point chasing it.
    if (!needy || pinned.has(needy)) break;

    // Take from whoever has the most going spare and is not itself throttled.
    let donor: CommodityId | null = null;
    let bestSpare = 0;
    for (const id of ids) {
      if (id === needy || pinned.has(id)) continue;
      const c = result.commodities[id];
      if (!c || (current[id] ?? 0) <= 0.02) continue;
      const spare = c.surplus;
      if (spare > bestSpare) {
        bestSpare = spare;
        donor = id;
      }
    }
    if (!donor) break;

    const step = Math.min(0.02, (current[donor] ?? 0) / 2);
    current = { ...current, [donor]: current[donor]! - step, [needy]: (current[needy] ?? 0) + step };
  }
  return current;
}

/** Convert labour fractions into the worker counts the economy takes. */
export function workersFor(
  allocation: Allocation,
  population: number,
  farmland: number,
): Record<CommodityId, number> {
  // Agricultural labour is locked at one worker per acre and is not the player's to
  // spend (§4.1), so only the remainder can be allocated.
  const spare = Math.max(0, population - farmland * AGRICULTURE.workersPerAcre);
  const total = Object.values(allocation).reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0 || spare <= 0) return {};
  // Fractions summing to 1 or less are taken literally, leaving the remainder idle;
  // anything above 1 is normalised. Without that a player who deliberately holds
  // labour back would find it silently spent anyway.
  const scale = total > 1 ? 1 / total : 1;
  const workers: Record<CommodityId, number> = {};
  for (const [id, fraction] of Object.entries(allocation)) {
    if (fraction > 0) workers[id] = Math.floor(fraction * scale * spare);
  }
  return workers;
}

export class Game {
  world: World;
  turn = 1;
  phase: Phase = "production";
  /** Per nation. Anything unset falls back to `subsistenceAllocation`. */
  allocations: Record<number, Allocation> = {};
  /** Per province. Anything unset holds. */
  orders: Record<number, MilitaryOrder> = {};
  /** Per nation: factories pinned against redistribution and against the player (§3.6). */
  locked: Record<number, CommodityId[]> = {};

  private production: Record<number, EconomyResult> = {};
  private transfers: Transfer[] = [];
  private battles: Battle[] = [];
  /** Start-of-turn state, which is what `Undo Turn` restores. */
  private startOfTurn: GameSnapshot;
  private readonly economy: Economy;

  private constructor(world: World, economy: Economy) {
    this.world = world;
    this.economy = economy;
    this.startOfTurn = this.snapshot();
  }

  static create(continent: string, level: Level): Game {
    return new Game(generateWorld(continent, level), new Economy());
  }

  static fromWorld(world: World, economy = new Economy()): Game {
    return new Game(world, economy);
  }

  /** The nation that has taken everything, or null while the game is live (§1.3). */
  get winner(): number | null {
    return conqueror(this.world);
  }

  /**
   * Standings, by population. Not territory and not firepower — Crawford made the
   * measure of a nation the number of people in it, which is what gives the title its
   * bite: guns cost you the very thing you are scored on.
   */
  rankings(): Ranking[] {
    return this.world.nations
      .map((n) => {
        const own = this.world.provinces.filter((p) => p.nation === n.id);
        return {
          nation: n.id,
          population: own.reduce((s, p) => s + p.population, 0),
          provinces: own.length,
          firepower: own.reduce((s, p) => s + p.firepower, 0),
        };
      })
      .sort((a, b) => b.population - a.population);
  }

  setAllocation(nation: number, allocation: Allocation): void {
    this.requirePhase("production");
    this.allocations[nation] = allocation;
  }

  /**
   * Move one factory's share, redistributing the difference across the unlocked rest.
   * This is what a slider does; `setAllocation` replaces the whole split at once.
   */
  setWorkerShare(nation: number, id: CommodityId, share: number): void {
    this.requirePhase("production");
    const current = this.allocations[nation] ?? subsistenceAllocation();
    this.allocations[nation] = reallocate(current, id, share, this.locked[nation] ?? []);
  }

  isLocked(nation: number, id: CommodityId): boolean {
    return (this.locked[nation] ?? []).includes(id);
  }

  /**
   * Pin every factory the nation is actually running. Zero-worker commodities are left
   * unlocked so a new industry can still be started; locking those too would freeze the
   * economy outright rather than protect it.
   */
  lockAll(nation: number): CommodityId[] {
    const allocation = this.allocations[nation] ?? subsistenceAllocation();
    this.locked[nation] = Object.keys(allocation).filter((id) => (allocation[id] ?? 0) > 0);
    return this.locked[nation]!;
  }

  unlockAll(nation: number): void {
    this.locked[nation] = [];
  }

  /** Pin or release a factory's allocation (§3.6). */
  toggleLock(nation: number, id: CommodityId): boolean {
    const pinned = new Set(this.locked[nation] ?? []);
    if (pinned.has(id)) pinned.delete(id);
    else pinned.add(id);
    this.locked[nation] = [...pinned];
    return pinned.has(id);
  }

  setOrder(province: number, order: MilitaryOrder): void {
    this.requirePhase("military-orders");
    this.orders[province] = order;
  }

  /**
   * Resolve the current phase and move to the next. Phases do not run backwards, so a
   * caller has to be finished before calling this — the original warned players in the
   * same terms: "don't ever select Next Phase until you're certain".
   */
  advance(): TurnReport | null {
    switch (this.phase) {
      case "production":
        this.resolveProduction();
        this.phase = "military-orders";
        return null;
      case "military-orders":
        // Orders freeze here; execution is a separate phase so a UI can animate it.
        this.phase = "military-execution";
        return null;
      case "military-execution":
        this.resolveMilitaryPhase();
        this.phase = "rankings";
        return this.report();
      case "rankings":
        this.beginTurn();
        return null;
    }
  }

  /** Discard the turn and return to how things stood at the start of it (§1.2). */
  undoTurn(): void {
    this.requirePhase("rankings");
    this.world = structuredClone(this.startOfTurn.world);
    this.turn = this.startOfTurn.turn;
    this.allocations = structuredClone(this.startOfTurn.allocations);
    // Locks deliberately survive an undo. They are a standing instruction about which
    // allocations to protect, not a move taken this turn, and losing them on undo would
    // defeat the point of having them.
    this.orders = {};
    this.production = {};
    this.transfers = [];
    this.battles = [];
    this.phase = "production";
  }

  snapshot(): GameSnapshot {
    return structuredClone({
      world: this.world,
      turn: this.turn,
      allocations: this.allocations,
      locked: this.locked,
    });
  }

  /** Save-slot key. The original kept one per continent and level (§1.2). */
  get saveKey(): string {
    return `${this.world.name.trim().toUpperCase()}-${this.world.level}`;
  }

  static restore(snapshot: GameSnapshot, economy = new Economy()): Game {
    const game = new Game(structuredClone(snapshot.world), economy);
    game.turn = snapshot.turn;
    game.allocations = structuredClone(snapshot.allocations);
    game.locked = structuredClone(snapshot.locked ?? {});
    game.startOfTurn = game.snapshot();
    return game;
  }

  private requirePhase(phase: Phase): void {
    if (this.phase !== phase) {
      throw new Error(`that belongs to the ${phase} phase; the turn is at ${this.phase}`);
    }
  }

  private beginTurn(): void {
    this.turn++;
    this.orders = {};
    this.production = {};
    this.transfers = [];
    this.battles = [];
    this.phase = "production";
    this.startOfTurn = this.snapshot();
  }

  private resolveProduction(): void {
    this.production = {};
    for (const nation of this.world.nations) {
      if (nation.provinces.length === 0) continue;
      const { land, population } = nationState(this.world, nation.id);
      const allocation =
        this.allocations[nation.id] ??
        balanceAllocation(
          this.economy,
          subsistenceAllocation(),
          { level: this.world.level, land, population },
          80,
          this.locked[nation.id] ?? [],
        );
      const result = this.economy.resolve({
        level: this.world.level,
        land,
        population,
        workers: workersFor(allocation, population, land.farmland),
      });
      this.production[nation.id] = result;

      this.applyPopulation(nation.id, population, result.nextPopulation);
      this.world = distributeWeapons(this.world, nation.id, result.firepower);
    }
  }

  /**
   * Push a nation's population change back down to its provinces, in proportion to
   * where its people already are. The economy works on nation totals but the map holds
   * population per province, and conquest moves provinces between nations, so the two
   * have to be reconciled every turn.
   */
  private applyPopulation(nation: number, before: number, after: number): void {
    if (before <= 0) return;
    const scale = Math.max(0, after) / before;
    this.world = {
      ...this.world,
      provinces: this.world.provinces.map((p) =>
        p.nation === nation ? { ...p, population: Math.max(0, Math.round(p.population * scale)) } : p,
      ),
    };
  }

  private resolveMilitaryPhase(): void {
    const orders: Orders = this.orders;
    const result = resolveMilitary(this.world, orders);
    this.world = result.world;
    this.transfers = result.transfers;
    this.battles = result.battles;
  }

  private report(): TurnReport {
    return {
      turn: this.turn,
      production: this.production,
      transfers: this.transfers,
      battles: this.battles,
      rankings: this.rankings(),
    };
  }
}
