/**
 * AI opponents (§10 step 6).
 *
 * Nothing about Crawford's AI is recoverable beyond the union-declaration rule in §6.1,
 * so this is design. Two standard mechanisms, one per half:
 *
 * - **The economy is a utility AI.** Candidate allocations are scored by a weighted sum
 *   and the best improving move is taken, rather than following a list of priorities in
 *   order. The weights encode the same intent a priority list would — garrison first,
 *   then enough food to grow, then arms — but they trade off against each other instead
 *   of strictly outranking, so a little more food can beat a little more army.
 * - **The military is an influence map.** Each nation's firepower is diffused across the
 *   province graph, giving every province a threat and an opportunity value. Orders are
 *   then gradient ascent on the difference, which produces concentration for free: inland
 *   provinces flow toward the front, and the front strikes when it can win.
 *
 * The objective behind both is §1.3: population is the victory metric, so people are the
 * unit of account and firepower is valued for what it protects and takes.
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
  /** Weight on feeding the growth a nation is aiming for. */
  food: 1.6,
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
 * Food surplus needed for a given growth rate.
 *
 * Growth is linear in surplus with a saturating denominator (§4.4.1), and the
 * denominator is negligible at the rates an AI aims for, so the inverse is just the
 * coefficient. Note this is *not* the manual's square root: that claim did not survive
 * the readings, and a square-root rule asks for 2.3x too much food.
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
   * Force that would carry the cheapest crossing on the frontier, or 0 if there is no
   * frontier. Without this the utility has no reason to arm past a garrison: both
   * saturating military terms are met at one firepower per province, so two efficient
   * neighbours each sat on exactly enough to defend, neither could ever attack, and the
   * board did not move for sixty turns.
   */
  opening: number;
}

export function positionOf(world: World, nation: number): Position {
  const provinces = world.provinces.filter((p) => p.nation === nation);
  const bordering = new Set<number>();
  for (const p of provinces) {
    for (const n of p.neighbours) {
      if (world.provinces[n.province]!.nation !== nation) bordering.add(n.province);
    }
  }
  let opening = Infinity;
  for (const p of provinces) {
    for (const n of p.neighbours) {
      if (world.provinces[n.province]!.nation === nation) continue;
      opening = Math.min(opening, forceNeeded(world, p.id, n.province));
    }
  }

  return {
    nation,
    provinces: provinces.map((p) => p.id),
    population: provinces.reduce((s, p) => s + p.population, 0),
    pressure: [...bordering].reduce((s, id) => s + world.provinces[id]!.firepower, 0),
    opening: Number.isFinite(opening) ? opening : 0,
  };
}

// --- the economy -----------------------------------------------------------------

/**
 * Score an allocation. Higher is better; the units are deliberately mixed and the
 * weights are what reconciles them.
 *
 * The three saturating terms are the priorities — each contributes its weight once met
 * and nothing more, so there is no gain in overshooting a floor. Growth is the only
 * unbounded term, which is what makes population the thing ultimately maximised.
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

  // Saturating above, but *not* clamped below: a starving nation has to be able to see
  // that less starving is better. Clamping the shortfall at zero left the whole region
  // scoring the same, and a hill climb on a plateau does nothing — measured, a nation
  // sat at -217 tons of food and 0 firepower for 140 turns without moving a worker.
  const met = (have: number, need: number) => Math.min(1, have / need);
  const growth = state.population > 0
    ? (result.nextPopulation - state.population) / state.population
    : 0;

  // Enough to garrison every province *and* mass the cheapest crossing. Both other
  // military terms are met by a bare garrison, so this is the only one that pays for an
  // army big enough to attack with, and it rises as the neighbour arms.
  const conquestNeed = garrisonNeed + position.opening;

  return (
    AI.garrison * met(firepower, garrisonNeed) +
    AI.food * met(surplus, foodNeed) +
    growth +
    temperament.militarism * AI.parity * met(firepower, matchNeed) +
    temperament.militarism * AI.conquest * met(firepower, conquestNeed)
  );
}

/**
 * Hill-climb the allocation, coarse steps first.
 *
 * Only improving moves are taken, which is the difference from `balanceAllocation`:
 * that one chases the largest shortfall and can walk past a better allocation (§10.2).
 * Starting coarse also lets a whole cold chain open at once — a single worker into iron
 * pays nothing, sixteen might.
 */
export function planProduction(
  economy: Economy,
  world: World,
  nation: number,
  start: Readonly<Record<CommodityId, number>>,
  temperament = temperamentFor(world, nation),
): Record<CommodityId, number> {
  const position = positionOf(world, nation);
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
 * Hand `workers` people to `id`'s whole chain, proportioned the way the recipes need,
 * taking them from everyone else pro rata.
 *
 * `warmChain` puts the same flat number of people into every link, which is not how a
 * chain runs: a ton of muskets wants a particular tonnage of iron behind it and no more,
 * so a flat split starves one stage while another idles. Solving the proportions is what
 * lets the climb open a cold chain that actually produces — without it, an allocation
 * already solved for food had no improving move left and the nation built no weapons at
 * all for sixty turns.
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

  const cost = Object.values(staff).reduce((sum, n) => sum + n, 0);
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
 * The road matters more than anything else here: off a road the attack is quartered, so
 * the same province costs four times as much to take. An influence map that weighs only
 * the prize sends every army to the wrong border — measured, it produced a permanent
 * stalemate, with 53 firepower staring at a cross-country target it could never carry
 * while the road in was held by a province with 3.
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
 * Opportunity is seeded on *your own* front provinces rather than on enemy ground,
 * because the question a reserve is answering is "which of our borders should I go
 * to?" — and the answer is the one with the cheapest way in, not the one nearest the
 * fattest prize. Marching is gradient ascent on opportunity alone: an inland province
 * sees the best jumping-off point as uphill and goes there.
 *
 * Threat is deliberately *not* in that gradient. Subtracting it makes the border the
 * least attractive ground on the map, since that is where the enemy is — measured, an
 * interior province ended up sitting on 132 of a nation's 194 firepower and never
 * moving, because every neighbour looked worse than home. Threat decides whether a
 * province holds what it has, which is a different question from where to send it.
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

/**
 * Orders for one nation: strike where the sums work, otherwise flow toward the front.
 *
 * Deliberate funnelling is the intent, not a side effect. A province that cannot win
 * alone marches to whichever neighbour stands better on `opportunity - threat`, which
 * pools force on the province facing the weakest, richest enemy until it *can* win.
 */
/** What one province's assault actually lands, after §5.5's arrival loss and terrain. */
function effectiveFrom(world: World, from: number, to: number): number {
  const road = world.provinces[from]!.neighbours.find((n) => n.province === to)?.road ?? false;
  return Math.max(0, world.provinces[from]!.firepower - COMBAT.arrivalLoss) *
    (road ? 1 : COMBAT.offRoadMultiplier);
}

/**
 * Provinces that together could carry a target none of them could carry alone.
 *
 * §5.6 resolves several attacks on one province in sequence, each wave softening the
 * defender for the next, so a combined assault is a real tactic rather than a
 * coincidence. Each wave pays the arrival loss separately, which is what the `10 *
 * waves` term accounts for. Without this the AI stalled one province short of winning:
 * every attacker could see it could not take the last province alone, and none of them
 * ever tried it together.
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

export function planOrders(world: World, nation: number): Record<number, MilitaryOrder> {
  const { threat, opportunity } = influenceMap(world, nation);
  const orders: Record<number, MilitaryOrder> = {};

  // Coordinated attacks first, richest target first, so a province committed to one is
  // not also asked to wander off up the gradient.
  const targets = [...new Set(
    world.provinces
      .filter((p) => p.nation === nation)
      .flatMap((p) => p.neighbours.map((n) => n.province))
      .filter((id) => world.provinces[id]!.nation !== nation),
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
      .filter((n) => world.provinces[n.province]!.nation !== nation)
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
