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
import { AGRICULTURE, commoditiesFor } from "./data.ts";
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
import { agePairs, applyAttack, seedAffinity, willingness, type Affinity, type Standing }
  from "./affinity.ts";
import { affordableTons, bestFoodChain, chainDemand, staffChain } from "./planner.ts";
import { planOrders, planProduction } from "./ai.ts";
import { makeRng } from "./rng.ts";
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
  /** Terrain the nation holds, summed over its provinces. */
  land: Land;
  acres: number;
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
  /** Absent in saves written before §6.4 existed; reseeded from the world if so. */
  affinity?: Affinity;
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
  const allocated = entries.reduce((sum, [, v]) => sum + Math.max(0, v), 0);
  const current = Math.max(0, allocation[id] ?? 0);
  // Labour nobody has been given yet. It is drawn on before any factory is raided,
  // otherwise it is stranded: with everything else locked there would be no donor, and
  // a request to grow would be refused while workers stood idle.
  const idle = Math.max(0, 1 - allocated);

  const target = Math.min(Math.max(0, share), current + othersSum + idle);
  const delta = target - current;
  const next: Record<CommodityId, number> = { ...allocation, [id]: target };
  if (Math.abs(delta) < 1e-12) return next;

  // Growing: spend the idle pool first, then take the rest from the unlocked factories
  // pro rata. Shrinking: hand it back to them, or let it fall idle if none are free.
  const fromOthers = delta > 0 ? delta - Math.min(delta, idle) : delta;
  if (Math.abs(fromOthers) < 1e-12 || othersSum <= 0) return next;

  const scale = Math.max(0, (othersSum - fromOthers) / othersSum);
  for (const [key, value] of others) next[key] = Math.max(0, Math.max(0, value) * scale);
  return next;
}

/**
 * Rebuild a labour split so that what the player has asked for is actually produced.
 *
 * The game's own advice is "when you see a factory that has too little or too much
 * output, just change the worker allocation until the surplus is close to zero", and an
 * earlier version did exactly that, one small nudge at a time. It could not cross a
 * valley: a cold chain yields nothing at any stage until every stage is staffed at once,
 * so no single nudge improved anything and the search stopped where it began. Worse, it
 * could not start at all from a finished good on its own — nothing consumes a sword, so
 * with only swords staffed there was no factory with a surplus to move labour from, and
 * it gave up on the first pass. On an expert two-nation union that cost 60 to 200 tons
 * of food, and the gap widened as the economy grew.
 *
 * So the split is solved rather than searched (see `src/planner.ts`). The finished goods
 * the player has put labour on are read as the goods they want; the workforce is divided
 * between them in proportion to that labour; and each one's whole input tree is staffed
 * to the largest tonnage its share can pay for.
 *
 * Locked factories are left exactly as they are, and their output is credited against
 * what the chains need, so locking a working iron mine helps the chains above it instead
 * of being ignored.
 */
export function balanceAllocation(
  economy: Economy,
  base: Allocation,
  context: { level: Level; land: Land; population: number },
  locked: readonly CommodityId[] = [],
): Allocation {
  const spare = Math.floor(
    Math.max(0, context.population - context.land.farmland * AGRICULTURE.workersPerAcre),
  );
  if (spare <= 0) return base;

  const pinned = new Set(locked);
  const offered = new Set(commoditiesFor(context.level, economy.graph.table.keys()));
  const current = workersFor(base, context.population, context.land.farmland);
  const heldBack = [...pinned].reduce((sum, id) => sum + (current[id] ?? 0), 0);
  const cap = Math.max(0, spare - heldBack);
  if (cap <= 0) return base;

  // A pinned factory keeps running, so its tonnage is supply the chains need not buy.
  const already = new Map<CommodityId, number>();
  if (pinned.size > 0) {
    const fixed = economy.resolve({ ...context, workers: current });
    for (const id of pinned) already.set(id, fixed.commodities[id]?.output ?? 0);
  }

  // Nothing consumes a finished good, so those are the ends the player is working
  // toward; everything else is only ever a means to one of them. A chain reaching
  // outside what the difficulty offers cannot be built at all (§1.1).
  const goals = Object.keys(current).filter(
    (id) =>
      (current[id] ?? 0) > 0 &&
      (economy.graph.consumers.get(id)?.length ?? 0) === 0 &&
      [...chainDemand(economy, id, 1).keys()].every((c) => offered.has(c)),
  );

  // Kept per goal rather than accumulated, so that re-solving one chain replaces its
  // labour instead of stacking a second copy of it on top.
  const plans = new Map<CommodityId, Record<CommodityId, number>>();
  const costOf = (good: CommodityId) =>
    Object.values(plans.get(good) ?? {}).reduce((sum, n) => sum + n, 0);
  const staff = (good: CommodityId, tons: number) => {
    const workers = tons > 0 ? staffChain(economy, context, good, tons, already) : {};
    for (const id of pinned) delete workers[id];
    plans.set(good, workers);
  };

  // A locked factory keeps its labour, so what it can make is already decided; its
  // inputs still have to be bought or it stands there producing nothing. Leaving these
  // out meant locking the one factory you cared about was the way to starve it.
  let budget = cap;
  for (const good of goals) {
    if (!pinned.has(good)) continue;
    staff(good, economy.capacity({ ...context, workers: current }, good));
    budget = Math.max(0, budget - costOf(good));
  }

  const open = goals.filter((good) => !pinned.has(good));
  if (open.length > 0) {
    const weight = open.reduce((sum, id) => sum + (current[id] ?? 0), 0);
    const share = new Map(open.map((good) => [good, (budget * (current[good] ?? 0)) / weight]));
    const buy = (good: CommodityId) =>
      staff(good, affordableTons(economy, context, good, share.get(good)!, already));
    for (const good of open) buy(good);

    // A chain nobody could afford leaves its share unspent; offer it to the others
    // rather than let people stand idle.
    const spent = () => open.reduce((sum, good) => sum + costOf(good), 0);
    for (const good of open) {
      const left = budget - spent();
      if (left <= 1) break;
      share.set(good, share.get(good)! + left);
      buy(good);
    }
  } else if (plans.size === 0) {
    // Nobody has asked for anything makeable, so feed people: that is the one goal a
    // nation always has, and the manual's opening advice besides.
    const plan = bestFoodChain(economy, context, budget, offered, already);
    if (!plan) return base;
    staff(plan.good, plan.tons);
  }

  const planned: Record<CommodityId, number> = {};
  for (const workers of plans.values()) {
    for (const [id, count] of Object.entries(workers)) planned[id] = (planned[id] ?? 0) + count;
  }

  // Staffing rounds every stage up, so the plan can overshoot by a worker per factory.
  const total = Object.values(planned).reduce((sum, count) => sum + count, 0);
  const scale = total > cap ? cap / total : 1;

  // Pinned shares pass through untouched, save for the same normalisation `workersFor`
  // applies: an allocation already committed past 1 would otherwise hand its locked
  // shares back at face value and push the total past 1 all over again.
  const committed = Object.values(base).reduce((sum, v) => sum + Math.max(0, v), 0);
  const normalise = committed > 1 ? 1 / committed : 1;
  const next: Record<CommodityId, number> = {};
  for (const id of pinned) if ((base[id] ?? 0) > 0) next[id] = base[id]! * normalise;
  for (const [id, count] of Object.entries(planned)) {
    if (!pinned.has(id)) next[id] = (count * scale) / spare;
  }
  return next;
}

/**
 * Move one factory to a whole number of workers, taking the difference from the other
 * unlocked factories pro rata — in whole workers, not in fractions (§3.6).
 *
 * `reallocate` works in shares, which is what the model stores, but the player is moving
 * people. Rounding a share back into integers could take a worker off a factory the
 * player had not touched while handing two to another, so lowering sulfur by one could
 * lower charcoal by one as well. Working in integers makes the rule visible: raising a
 * factory lowers exactly one other, and lowering it raises exactly one other.
 *
 * `workforce` is the labour available to spend. Pass it and the idle pool is a
 * participant: labour stranded as unspent can be drawn back out, which is the only way a
 * factory can grow when every other factory is locked. Leave it out and the function
 * merely conserves whatever it was given.
 */
export function moveWorkers(
  current: Readonly<Record<CommodityId, number>>,
  id: CommodityId,
  want: number,
  locked: readonly CommodityId[] = [],
  workforce?: number,
): Record<CommodityId, number> {
  const pinned = new Set(locked);
  if (pinned.has(id)) return { ...current };

  const keys = Object.keys(current);
  const others = keys.filter((k) => k !== id && !pinned.has(k));
  const lockedTotal = keys.filter((k) => pinned.has(k)).reduce((s, k) => s + (current[k] ?? 0), 0);
  const total = keys.reduce((s, k) => s + (current[k] ?? 0), 0);

  // Everything the unlocked factories and the idle pool have between them.
  const available = Math.max(0, (workforce ?? total) - lockedTotal);
  const target = Math.max(0, Math.min(Math.round(want), available));
  const pool = available - target;

  const next: Record<CommodityId, number> = { ...current, [id]: target };
  // Nowhere to put the remainder but the idle pool, which `target` can draw back out.
  if (others.length === 0) return next;

  const othersTotal = others.reduce((s, k) => s + (current[k] ?? 0), 0);
  // Largest remainder, so the pool is handed out whole and in proportion.
  const share = others.map((k) => ({
    k,
    exact: othersTotal > 0 ? ((current[k] ?? 0) / othersTotal) * pool : pool / others.length,
  }));
  let handed = 0;
  for (const s of share) {
    next[s.k] = Math.floor(s.exact);
    handed += next[s.k]!;
  }
  const byRemainder = [...share].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
  );
  for (let i = 0; handed < pool && i < byRemainder.length; i++, handed++) {
    next[byRemainder[i]!.k] = (next[byRemainder[i]!.k] ?? 0) + 1;
  }
  return next;
}

/** Convert labour fractions into the worker counts the economy takes. */
export function workersFor(
  allocation: Allocation,
  population: number,
  farmland: number,
): Record<CommodityId, number> {
  // Agricultural labour is locked at one worker per acre and is not the player's to
  // spend (§4.1), so only the remainder can be allocated.
  // Whole people. Population is continuous (§4.4) but a fraction of a worker cannot be
  // put in a factory, and a fractional remainder showed up as unspendable idle labour.
  const spare = Math.floor(Math.max(0, population - farmland * AGRICULTURE.workersPerAcre));
  const total = Object.values(allocation).reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0 || spare <= 0) return {};
  // Fractions summing to 1 or less are taken literally, leaving the remainder idle;
  // anything above 1 is normalised. Without that a player who deliberately holds
  // labour back would find it silently spent anyway.
  const scale = total > 1 ? 1 / total : 1;

  // Largest remainder, not a plain floor per commodity. Flooring each independently
  // loses up to one worker per factory and reports the dust as idle labour, which is
  // both wrong and maddening: the screen offers workers that cannot be spent because in
  // fraction terms the allocation is already fully committed.
  // The epsilon is not cosmetic. The UI works in whole workers and stores them back as
  // `workers / spare`, and those fractions re-add to 0.9999999999 rather than 1 often
  // enough to matter: the floor then swallowed a worker, and because largest remainder
  // decides who loses it, pressing + on a factory could stop moving it at all. Typing
  // the number worked, which is what made the bug look random.
  const target = Math.floor(spare * Math.min(total, 1) + 1e-9);
  const wanted = Object.entries(allocation)
    .filter(([, fraction]) => fraction > 0)
    .map(([id, fraction]) => ({ id, exact: fraction * scale * spare }));

  const workers: Record<CommodityId, number> = {};
  let handed = 0;
  for (const { id, exact } of wanted) {
    workers[id] = Math.floor(exact);
    handed += workers[id]!;
  }
  const byRemainder = [...wanted].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
  );
  for (let i = 0; handed < target && i < byRemainder.length; i++, handed++) {
    workers[byRemainder[i]!.id]!++;
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
  /** How the nations regard each other (§6.4). */
  affinity: Affinity;
  /** The nation a person is playing. Every other one is run by the AI (§10 step 6). */
  human = 0;
  /** Set false to leave the other nations inert, which isolates the economy in a test. */
  ai = true;

  private production: Record<number, EconomyResult> = {};
  private transfers: Transfer[] = [];
  private battles: Battle[] = [];
  /** Start-of-turn state, which is what `Undo Turn` restores. */
  private startOfTurn: GameSnapshot;
  private readonly economy: Economy;

  private constructor(world: World, economy: Economy) {
    this.world = world;
    this.economy = economy;
    this.affinity = seedAffinity(world);
    this.startOfTurn = this.snapshot();
  }

  /** What each nation is worth as an ally, to `from` (§6.4). */
  willingnessFrom(from: number): { nation: number; willingness: number }[] {
    const standings: Standing[] = this.rankings().map((r) => ({
      nation: r.nation,
      population: r.population,
      firepower: r.firepower,
    }));
    return standings
      .filter((s) => s.nation !== from)
      .map((s) => ({
        nation: s.nation,
        willingness: willingness(this.affinity, from, s.nation, standings, this.turn),
      }))
      .sort((a, b) => b.willingness - a.willingness);
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
        const land = nationState(this.world, n.id).land;
        return {
          nation: n.id,
          population: own.reduce((s, p) => s + p.population, 0),
          provinces: own.length,
          firepower: own.reduce((s, p) => s + p.firepower, 0),
          land,
          acres: land.farmland + land.forest + land.mountains + land.desert,
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
   * Pin every factory, including those standing at zero workers.
   *
   * Locking only the staffed ones was tried first, on the reasoning that a new industry
   * should still be startable. In practice that is the wrong default: it leaves every
   * unstaffed factory free to be raised, and raising one drains the unlocked economy
   * behind your back. Locking everything and then releasing the two you mean to tune is
   * the predictable workflow, and it makes "all" mean all.
   */
  lockAll(nation: number): CommodityId[] {
    this.locked[nation] = [...this.economy.graph.table.keys()];
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
        // Combat resolves on the way *into* execution, not out of it, so that the
        // execution phase is the one the player watches it happen in. A UI that animates
        // the marches has the whole report in hand for the length of that phase (§1.2.1).
        this.planAiOrders();
        this.resolveMilitaryPhase();
        this.phase = "military-execution";
        return this.report();
      case "military-execution":
        this.phase = "rankings";
        return null;
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
    if (this.startOfTurn.affinity) this.affinity = structuredClone(this.startOfTurn.affinity);
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
      affinity: this.affinity,
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
    if (snapshot.affinity) game.affinity = structuredClone(snapshot.affinity);
    game.startOfTurn = game.snapshot();
    return game;
  }

  private requirePhase(phase: Phase): void {
    if (this.phase !== phase) {
      throw new Error(`that belongs to the ${phase} phase; the turn is at ${this.phase}`);
    }
  }

  private beginTurn(): void {
    // Affinity ages between turns: both channels decay toward neutral, and the bottom
    // half by population draw closer together (§6.4).
    const standings = this.rankings().filter((r) => r.provinces > 0);
    const bottom = standings
      .slice(-Math.floor(standings.length / 2))
      .map((r) => r.nation);
    agePairs(this.affinity, bottom);

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
      const spare = Math.floor(Math.max(0, population - land.farmland));
      let allocation: Allocation;
      if (nation.id === this.human || !this.ai) {
        allocation =
          this.allocations[nation.id] ??
          balanceAllocation(
            this.economy,
            subsistenceAllocation(),
            { level: this.world.level, land, population },
            this.locked[nation.id] ?? [],
          );
      } else {
        // The AI plans in whole workers and stores the result back as shares (§1.2.1).
        // A first plan starts from a balanced economy rather than a raw subsistence
        // split, so the climb does not begin inside the §3.5 trap it would have to
        // climb out of.
        const seed = this.allocations[nation.id] ?? balanceAllocation(
          this.economy,
          subsistenceAllocation(),
          { level: this.world.level, land, population },
        );
        const from = workersFor(seed, population, land.farmland);
        const planned = planProduction(this.economy, this.world, nation.id, from);
        allocation = spare > 0
          ? Object.fromEntries(Object.entries(planned).map(([k, v]) => [k, v / spare]))
          : {};
        this.allocations[nation.id] = allocation;
      }
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

  /**
   * Orders for every nation but the player's, written just before resolution so they
   * are given on the same board the player saw (§5.6 resolves them simultaneously).
   */
  private planAiOrders(): void {
    if (!this.ai) return;
    for (const nation of this.world.nations) {
      if (nation.id === this.human || nation.provinces.length === 0) continue;
      for (const [province, order] of Object.entries(planOrders(this.world, nation.id))) {
        this.orders[Number(province)] = order;
      }
    }
  }

  private resolveMilitaryPhase(): void {
    const orders: Orders = this.orders;
    // Seeded per world and turn, so the tie-break draw is the same one on a replay after
    // Undo Turn. A draw that moved under undo would be a worse rule than a fixed order.
    const result = resolveMilitary(
      this.world,
      orders,
      makeRng(`${this.world.name}/battle/${this.turn}`),
    );
    this.world = result.world;
    this.transfers = result.transfers;
    this.battles = result.battles;

    // War is the one affinity event that can fire today; the rest wait on unions (§6.4).
    for (const battle of result.battles) {
      for (const wave of battle.waves) {
        const attacker = this.startOfTurn.world.provinces[wave.from]?.nation;
        const defender = this.startOfTurn.world.provinces[battle.target]?.nation;
        if (attacker === undefined || defender === undefined) continue;
        applyAttack(this.affinity, defender, attacker, wave.captured, this.turn);
      }
    }
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
