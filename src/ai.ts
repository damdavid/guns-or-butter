/**
 * AI opponents [F]: a utility AI over allocations, an influence map over the province
 * graph. Nothing of Crawford's AI is recoverable, so §10.3 is the design and the
 * record of what each mistake cost.
 */
import { POPULATION, commoditiesFor } from "./data.ts";
import { affordableTons, staffChain, type PlanContext } from "./planner.ts";
import type { Economy } from "./economy.ts";
import { COMBAT, type MilitaryOrder } from "./military.ts";
import { makeRng } from "./rng.ts";
import type { CommodityId, Land, World } from "./types.ts";

export const AI = {
  /** Weight on holding a garrison in every province. */
  garrison: 2.0,
  /** Weight on growth. Heaviest, so the victory metric can defend itself (§10.3). */
  growth: 3.0,
  /** A gradient out of famine, not a cost: below the floor, growth alone is a plateau. */
  hunger: 0.4,
  /** How much a need keeps paying once met, so food and arms trade at the margin. */
  tail: 0.35,
  /** Weight on matching the force massed against you. */
  parity: 1.4,
  /** How far influence carries, and how much it loses per province crossed. */
  spread: 4,
  decay: 0.55,
  /** A neighbour is worth answering once it is this much of your own strength. */
  matchAt: 1.25,
  /** Weight on being able to take something, over and above holding what you have. */
  conquest: 1.2,
  /** Hill-climbing step sizes, coarse first. */
  steps: [16, 8, 4, 2, 1],
  /** Shares of the workforce offered to a whole chain at once, largest first. */
  invest: [0.5, 0.25, 0.12],
  /** Give up rather than spin; each pass is a full economy resolve per commodity. */
  maxMoves: 90,
} as const;

/**
 * What a nation wants, beyond winning. Seeded per continent and nation, so a given
 * world always faces the same opposition — the same reasoning as the nation names.
 */
export interface Temperament {
  /** 0 is all butter, 1 is all guns. */
  militarism: number;
  /** Growth it tries to secure before arming at all. */
  growthTarget: number;
}

export function temperamentFor(world: World, nation: number): Temperament {
  const rng = makeRng(`${world.name}/temperament/${nation}`);
  return {
    militarism: rng.range(0.25, 0.85),
    growthTarget: rng.range(0.01, 0.035),
  };
}

/**
 * Food surplus needed for a given growth rate. The saturating denominator (§4.4.1) is
 * negligible at the rates an AI aims for, so the inverse is just the coefficient.
 */
export function surplusForGrowth(population: number, rate: number): number {
  return (population * rate) / POPULATION.growth;
}

export interface Position {
  nation: number;
  provinces: number[];
  population: number;
  /** Enemy firepower in provinces bordering this nation. */
  pressure: number;
  /**
   * Force that would carry the cheapest crossing, or 0 with no frontier. Without it
   * nothing pays for an army past a garrison and the board never moves (§10.3).
   */
  opening: number;
}

/**
 * Read a nation's position, or a whole union's as if it were one (§6.1).
 *
 * A union founder allocates for every member, so its garrison need covers all their
 * provinces and its frontier is the ground none of them holds. Passing a group rather
 * than a nation is the only change that needs: everything downstream already works on
 * "the provinces we hold" rather than on a nation id.
 */
export function positionOf(world: World, nation: number | readonly number[]): Position {
  const group = typeof nation === "number" ? [nation] : nation;
  const held = new Set(group);
  const provinces = world.provinces.filter((p) => p.nation !== null && held.has(p.nation));
  const bordering = new Set<number>();
  for (const p of provinces) {
    for (const n of p.neighbours) {
      const owner = world.provinces[n.province]!.nation;
      if (owner === null || !held.has(owner)) bordering.add(n.province);
    }
  }
  let opening = Infinity;
  for (const p of provinces) {
    for (const n of p.neighbours) {
      const owner = world.provinces[n.province]!.nation;
      if (owner !== null && held.has(owner)) continue;
      opening = Math.min(opening, forceNeeded(world, p.id, n.province));
    }
  }

  return {
    nation: group[0]!,
    provinces: provinces.map((p) => p.id),
    population: provinces.reduce((s, p) => s + p.population, 0),
    pressure: [...bordering].reduce((s, id) => s + world.provinces[id]!.firepower, 0),
    opening: Number.isFinite(opening) ? opening : 0,
  };
}

// --- the economy -----------------------------------------------------------------

/**
 * Score an allocation; higher is better, and the weights reconcile mixed units.
 *
 * Growth is heaviest because population is the victory metric (§1.3). Garrison and
 * parity are floors; growth and the conquest threshold keep paying past themselves so
 * the margin splits rather than reverting wholly to food or to arms (§10.3).
 */
export function score(
  economy: Economy,
  state: { level: World["level"]; land: Land; population: number },
  workers: Readonly<Record<CommodityId, number>>,
  position: Position,
  temperament: Temperament,
): number {
  const result = economy.resolve({ ...state, workers });
  const firepower = result.firepower;
  const surplus = result.agriculture.surplus;

  const garrisonNeed = Math.max(1, position.provinces.length);
  const foodNeed = Math.max(1, surplusForGrowth(state.population, temperament.growthTarget));
  const matchNeed = position.pressure > firepower * AI.matchAt ? position.pressure : garrisonNeed;

  /** A floor there is no point overshooting. */
  const met = (have: number, need: number) => Math.min(1, have / need);
  /** A floor that keeps paying past itself: linear below, a log tail above. */
  const reach = (have: number, need: number) => {
    const ratio = have / need;
    return ratio <= 1 ? ratio : 1 + AI.tail * Math.log(ratio);
  };

  // Growth rather than surplus, so a deficit the famine floor absorbs costs nothing:
  // `nextPopulation` already knows about the floor.
  const growth = state.population > 0
    ? (result.nextPopulation - state.population) / state.population
    : 0;

  // A garrison everywhere *and* the cheapest crossing: the only term that pays for an
  // army worth attacking with. Massing it is the marching phase's job (§5.6).
  const conquestNeed = garrisonNeed + position.opening;

  return (
    AI.garrison * met(firepower, garrisonNeed) +
    AI.growth * reach(growth, temperament.growthTarget) +
    AI.hunger * Math.min(0, surplus / foodNeed) +
    temperament.militarism * AI.parity * met(firepower, matchNeed) +
    temperament.militarism * AI.conquest * reach(firepower, conquestNeed)
  );
}

/**
 * Hill-climb the allocation, coarse steps first so a cold chain can open at once.
 * Only improving moves are taken.
 */
export function planProduction(
  economy: Economy,
  world: World,
  nation: number,
  start: Readonly<Record<CommodityId, number>>,
  temperament = temperamentFor(world, nation),
  /** Plan for this whole group as one economy, which is what a union founder does. */
  members?: readonly number[],
): Record<CommodityId, number> {
  const position = positionOf(world, members ?? nation);
  const land = { farmland: 0, forest: 0, mountains: 0, desert: 0 };
  for (const id of position.provinces) {
    const l = world.provinces[id]!.land;
    land.farmland += l.farmland;
    land.forest += l.forest;
    land.mountains += l.mountains;
    land.desert += l.desert;
  }
  const state = { level: world.level, land, population: position.population };
  const spare = Math.floor(Math.max(0, state.population - land.farmland));
  if (spare <= 0) return {};

  // Only what this difficulty offers (§1.1). Searching the whole table let an
  // intermediate nation pour workers into tractors it cannot build.
  const ids = commoditiesFor(world.level, economy.graph.table.keys());
  const allowed = new Set(ids);
  // Only finished goods are worth buying a whole chain for; an intermediate is only ever
  // wanted for what sits above it, and that chain includes it already.
  const terminal = new Set(ids.filter((id) => (economy.graph.consumers.get(id)?.length ?? 0) === 0));
  let best: Record<CommodityId, number> = {};
  for (const id of ids) best[id] = start[id] ?? 0;
  let bestScore = score(economy, state, best, position, temperament);

  let moves = 0;
  for (const step of AI.steps) {
    for (;;) {
      if (moves++ > AI.maxMoves) return best;
      let chosen: Record<CommodityId, number> | null = null;
      let chosenScore = bestScore;
      for (const id of ids) {
        for (const candidate of [
          moveWorkersInto(best, id, (best[id] ?? 0) + step, spare),
          // And the same move made to the whole chain behind it, which is the only way
          // a cold chain ever opens.
          warmChain(economy, best, id, step, spare, allowed),
          // Wholesale: a properly proportioned chain bought with a share of everybody.
          // Single steps cannot get here from an allocation that is already solved for
          // one goal, because the first worker moved makes things worse.
          ...(terminal.has(id)
            ? AI.invest.map((share) =>
                investInChain(economy, state, best, id, Math.floor(spare * share), spare, allowed))
            : []),
        ]) {
          if (!candidate) continue;
          const s = score(economy, state, candidate, position, temperament);
          if (s > chosenScore + 1e-9) {
            chosenScore = s;
            chosen = candidate;
          }
        }
      }
      if (!chosen) break;
      best = chosen;
      bestScore = chosenScore;
    }
  }
  return best;
}

/**
 * Hand `workers` to `id`'s whole chain, proportioned as the recipes need, taken from
 * everyone else pro rata. `warmChain`'s flat split starves one stage while another
 * idles, so this is the move that opens a cold chain (§10.3).
 */
function investInChain(
  economy: Economy,
  state: PlanContext,
  current: Readonly<Record<CommodityId, number>>,
  id: CommodityId,
  workers: number,
  spare: number,
  allowed: ReadonlySet<CommodityId>,
): Record<CommodityId, number> | null {
  if (workers < 1) return null;
  const tons = affordableTons(economy, state, id, workers);
  if (tons <= 0) return null;
  const staff = staffChain(economy, state, id, tons);
  if (Object.keys(staff).some((c) => !allowed.has(c))) return null;

  // Affordability is fractional but staffing rounds every stage up, so a chain that
  // fits on paper need not fit in whole workers (§10.3).
  const cost = Object.values(staff).reduce((sum, n) => sum + n, 0);
  if (cost > spare) return null;
  const used = Object.values(current).reduce((sum, n) => sum + Math.max(0, n), 0);
  const fromOthers = Math.max(0, cost - Math.max(0, spare - used));
  const scale = used > 0 ? Math.max(0, (used - fromOthers) / used) : 0;

  const next: Record<CommodityId, number> = {};
  for (const [c, n] of Object.entries(current)) next[c] = Math.floor(Math.max(0, n) * scale);
  for (const [c, n] of Object.entries(staff)) next[c] = (next[c] ?? 0) + n;
  return next;
}

/**
 * Everything a commodity needs, itself included, however deep.
 *
 * A move that staffs only the head of a cold chain buys nothing — muskets want iron,
 * iron wants coal — so the climb would reject it and never find the chain at all. This
 * is the fix for the weakness §10.2 records, and it is why a single worker into iron
 * pays nothing while sixteen into iron *and coal* pays.
 */
export function chainOf(economy: Economy, id: CommodityId, seen = new Set<CommodityId>()): Set<CommodityId> {
  if (seen.has(id)) return seen;
  seen.add(id);
  for (const input of Object.keys(economy.graph.table.get(id)?.inputs ?? {})) {
    chainOf(economy, input, seen);
  }
  return seen;
}

/** Staff a commodity and every unstaffed link behind it, in one move. */
function warmChain(
  economy: Economy,
  current: Readonly<Record<CommodityId, number>>,
  id: CommodityId,
  step: number,
  workforce: number,
  allowed: ReadonlySet<CommodityId>,
): Record<CommodityId, number> | null {
  const chain = [...chainOf(economy, id)].filter((c) => allowed.has(c));
  const cold = chain.filter((c) => (current[c] ?? 0) === 0);
  if (cold.length === 0) return null;

  const next: Record<CommodityId, number> = { ...current };
  for (const c of chain) next[c] = (next[c] ?? 0) + step;
  // Scale everything back to the workforce, largest remainder, so nothing is invented.
  const total = Object.values(next).reduce((s, v) => s + v, 0);
  if (total <= workforce) return next;
  const scale = workforce / total;
  const exact = Object.entries(next).map(([k, v]) => ({ k, exact: v * scale }));
  let handed = 0;
  for (const e of exact) {
    next[e.k] = Math.floor(e.exact);
    handed += next[e.k]!;
  }
  for (const e of [...exact].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
  )) {
    if (handed >= workforce) break;
    next[e.k] = (next[e.k] ?? 0) + 1;
    handed++;
  }
  return next;
}

/** Whole workers into one factory, taken pro rata from the rest. Mirrors §3.6. */
function moveWorkersInto(
  current: Readonly<Record<CommodityId, number>>,
  id: CommodityId,
  want: number,
  workforce: number,
): Record<CommodityId, number> {
  const others = Object.keys(current).filter((k) => k !== id);
  const othersTotal = others.reduce((s, k) => s + (current[k] ?? 0), 0);
  const target = Math.max(0, Math.min(want, workforce));
  const pool = Math.max(0, workforce - target);
  const next: Record<CommodityId, number> = { ...current, [id]: target };
  if (others.length === 0) return next;

  const share = others.map((k) => ({
    k,
    exact: othersTotal > 0 ? ((current[k] ?? 0) / othersTotal) * pool : pool / others.length,
  }));
  let handed = 0;
  for (const s of share) {
    next[s.k] = Math.floor(s.exact);
    handed += next[s.k]!;
  }
  for (const s of [...share].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
  )) {
    if (handed >= pool) break;
    next[s.k] = (next[s.k] ?? 0) + 1;
    handed++;
  }
  return next;
}

// --- the military ----------------------------------------------------------------

export interface Influence {
  /** Enemy strength felt at each province, falling off with distance. */
  threat: number[];
  /** How good a place each province is to attack from, likewise. */
  opportunity: number[];
}

/** What it is worth taking a province for: its people and the land that feeds them. */
const prizeOf = (world: World, id: number) =>
  world.provinces[id]!.population + world.provinces[id]!.land.farmland;

/**
 * Firepower needed to take `to` from `from`, inverting §5.5.
 *
 * The road dominates: off it the attack is quartered, so the same province costs four
 * times as much to take. Weighing the prize alone sends every army to the wrong
 * border (§10.3).
 */
export function forceNeeded(world: World, from: number, to: number): number {
  const road = world.provinces[from]!.neighbours.find((n) => n.province === to)?.road ?? false;
  const multiplier = road ? 1 : COMBAT.offRoadMultiplier;
  return (world.provinces[to]!.firepower + COMBAT.defenderBonus) / multiplier + COMBAT.arrivalLoss;
}

/** The best attack available from a province, as prize per unit of force. */
export function appealOf(world: World, nation: number, from: number): number {
  let best = 0;
  for (const n of world.provinces[from]!.neighbours) {
    if (world.provinces[n.province]!.nation === nation) continue;
    best = Math.max(best, prizeOf(world, n.province) / forceNeeded(world, from, n.province));
  }
  return best;
}

/**
 * Diffuse threat and opportunity across the province graph.
 *
 * Opportunity is seeded on *your own* front provinces, because what a reserve is
 * asking is which of our borders to go to — the one with the cheapest way in, not the
 * one nearest the fattest prize. Threat decides whether a province holds, and stays
 * out of the marching gradient (§10.3).
 */
export function influenceMap(world: World, nation: number): Influence {
  const n = world.provinces.length;
  const threat = new Array<number>(n).fill(0);
  const opportunity = new Array<number>(n).fill(0);

  for (const p of world.provinces) {
    if (p.nation !== nation) {
      threat[p.id] = p.firepower;
    } else {
      opportunity[p.id] = appealOf(world, nation, p.id);
    }
  }

  for (let hop = 0; hop < AI.spread; hop++) {
    const nextThreat = [...threat];
    const nextOpportunity = [...opportunity];
    for (const p of world.provinces) {
      for (const q of p.neighbours) {
        nextThreat[p.id] = Math.max(nextThreat[p.id]!, threat[q.province]! * AI.decay);
        // Opportunity only travels through your own ground: a route across someone
        // else's territory is not a route.
        if (p.nation === nation && world.provinces[q.province]!.nation === nation) {
          nextOpportunity[p.id] = Math.max(
            nextOpportunity[p.id]!,
            opportunity[q.province]! * AI.decay,
          );
        }
      }
    }
    threat.splice(0, n, ...nextThreat);
    opportunity.splice(0, n, ...nextOpportunity);
  }
  return { threat, opportunity };
}

/** Whether an attack from `from` onto `to` would carry, by the §5.5 formula. */
export function canTake(world: World, from: number, to: number): boolean {
  const attacker = world.provinces[from]!;
  const defender = world.provinces[to]!;
  const road = attacker.neighbours.find((n) => n.province === to)?.road ?? false;
  const effective = Math.max(0, attacker.firepower - COMBAT.arrivalLoss) *
    (road ? 1 : COMBAT.offRoadMultiplier);
  return effective > defender.firepower + COMBAT.defenderBonus;
}

/** What one province's assault actually lands, after §5.5's arrival loss and terrain. */
function effectiveFrom(world: World, from: number, to: number): number {
  const road = world.provinces[from]!.neighbours.find((n) => n.province === to)?.road ?? false;
  return Math.max(0, world.provinces[from]!.firepower - COMBAT.arrivalLoss) *
    (road ? 1 : COMBAT.offRoadMultiplier);
}

/**
 * Provinces that together could carry a target none could carry alone. §5.6 resolves
 * waves in sequence, each softening the defender for the next, so this is a real
 * tactic and not a coincidence.
 */
function combinedAssault(world: World, nation: number, target: number): number[] | null {
  const attackers = world.provinces
    .filter((p) => p.nation === nation && p.firepower >= 1)
    .filter((p) => p.neighbours.some((n) => n.province === target))
    .sort((a, b) => effectiveFrom(world, b.id, target) - effectiveFrom(world, a.id, target));
  if (attackers.length < 2) return null;

  const defence = world.provinces[target]!.firepower;
  let landed = 0;
  const wave: number[] = [];
  for (const a of attackers) {
    wave.push(a.id);
    landed += effectiveFrom(world, a.id, target);
    // Each repulsed wave takes its effective strength off the defence, so what the last
    // wave has to beat is the defence less everything that landed before it — which
    // comes to the same thing as the total beating defence plus the one bonus.
    if (landed > defence + COMBAT.defenderBonus) return wave;
  }
  return null;
}

/**
 * Orders for one nation: strike where the sums work, otherwise flow toward the front.
 *
 * Funnelling is the intent. A province that cannot win alone marches up `opportunity`,
 * pooling force on the cheapest crossing until it can. Threat gates holding, never
 * marching — subtracting it makes the border the least attractive ground (§10.3).
 */
export function planOrders(
  world: World,
  nation: number,
  /** §6.1's union restriction. Anything this rejects is not attacked, only held. */
  mayAttack: (owner: number) => boolean = () => true,
): Record<number, MilitaryOrder> {
  const { threat, opportunity } = influenceMap(world, nation);
  const orders: Record<number, MilitaryOrder> = {};
  const attackable = (province: number) => {
    const owner = world.provinces[province]!.nation;
    return owner !== null && owner !== nation && mayAttack(owner);
  };

  // Coordinated attacks first, richest target first, so a province committed to one is
  // not also asked to wander off up the gradient.
  const targets = [...new Set(
    world.provinces
      .filter((p) => p.nation === nation)
      .flatMap((p) => p.neighbours.map((n) => n.province))
      .filter(attackable),
  )].sort((a, b) => prizeOf(world, b) - prizeOf(world, a));

  for (const target of targets) {
    const wave = combinedAssault(world, nation, target);
    if (!wave || wave.some((id) => orders[id])) continue;
    for (const id of wave) orders[id] = { marchFraction: 1, target };
  }

  for (const p of world.provinces) {
    if (p.nation !== nation || p.firepower < 1 || orders[p.id]) continue;

    // Take the best prize the sums say can be carried alone.
    const takeable = p.neighbours
      .filter((n) => attackable(n.province))
      .filter((n) => canTake(world, p.id, n.province))
      .sort((a, b) => prizeOf(world, b.province) - prizeOf(world, a.province));
    if (takeable.length > 0) {
      orders[p.id] = { marchFraction: 1, target: takeable[0]!.province };
      continue;
    }

    // Otherwise march up the gradient, which pools force on the cheapest way in until
    // it is enough. A province already standing on the best ground stays put, and so
    // does one holding a border with something coming at it.
    const facingEnemy = p.neighbours.some((n) => world.provinces[n.province]!.nation !== nation);
    if (facingEnemy && threat[p.id]! > p.firepower) continue;

    const forward = p.neighbours
      .filter((n) => world.provinces[n.province]!.nation === nation)
      .map((n) => ({ id: n.province, appeal: opportunity[n.province]! }))
      .sort((a, b) => b.appeal - a.appeal)[0];
    if (forward && forward.appeal > opportunity[p.id]!) {
      orders[p.id] = { marchFraction: 1, target: forward.id };
    }
  }
  return orders;
}
