/**
 * Military resolution (§5). Weapon distribution, orders, transfers, then battles.
 *
 * Firepower is a single continuous scalar per province — not units, not stacks. A
 * province can hold 4.2 "bangs". Crawford counted this among the game's real
 * innovations, and ch24 calls the military system "its best feature".
 */
import { tierYield } from "./data.ts";
import { makeRng, type Rng } from "./rng.ts";
import type { CommodityId, Province, World } from "./types.ts";

export const COMBAT = {
  /** Flat loss the attacker takes on arrival, and the flat bonus the defender gets.
   *  Embert's purpose: "I hate it when somebody wins a victory with trivial forces." */
  arrivalLoss: 10,
  defenderBonus: 10,
  /** Attacking across anything that is not a road quarters your strength (§5.5). */
  offRoadMultiplier: 0.25,
} as const;

export interface MilitaryOrder {
  /** Fraction of the province's firepower that marches, 0..1. The rest defends. */
  marchFraction: number;
  /** An adjacent province, or null to hold. */
  target: number | null;
}

export type Orders = Readonly<Record<number, MilitaryOrder>>;

export interface Transfer {
  from: number;
  to: number;
  firepower: number;
}

export interface Battle {
  target: number;
  /** Attacking provinces, in the order their assaults resolved. */
  waves: {
    from: number;
    viaRoad: boolean;
    committed: number;
    /** After the arrival loss and any off-road quartering. */
    effective: number;
    defenceBefore: number;
    captured: boolean;
    survivors: number;
  }[];
  captured: boolean;
  /** Nation that ended up holding the province. */
  owner: number;
  /** Population destroyed, being the total power brought to bear (§5.5). */
  civilianLoss: number;
}

export interface MilitaryResult {
  world: World;
  transfers: Transfer[];
  battles: Battle[];
}

/** Total firepower a nation holds, summed over its provinces. */
export function nationFirepower(world: World, nation: number): number {
  return world.provinces
    .filter((p) => p.nation === nation)
    .reduce((sum, p) => sum + p.firepower, 0);
}

/** Firepower embodied in a turn's weapon output, at 2^(tier-1) per ton (§5.2). */
export function firepowerOf(output: Readonly<Record<CommodityId, number>>, tiers: Readonly<Record<CommodityId, number>>): number {
  let total = 0;
  for (const [id, tons] of Object.entries(output)) {
    const tier = tiers[id];
    if (tier !== undefined) total += tons * tierYield(tier);
  }
  return total;
}

/**
 * Reconcile a nation's provinces with the power it can field this turn (§5.3). The
 * provinces always sum to this turn's weapon production, which makes an army a flow
 * rather than a stock (§5.3.1): you cannot arm once and coast.
 *
 * Falling scales every province alike, so the deployment keeps its shape. Rising gives
 * a flat 1 each and the remainder in proportion, which rewards concentrating — and
 * only to the increase, or a drawdown would quietly flatten what the player built.
 */
export function distributeWeapons(world: World, nation: number, firepower: number): World {
  const own = world.provinces.filter((p) => p.nation === nation);
  if (own.length === 0) return world;

  const target = Math.max(0, firepower);
  const held = own.reduce((sum, p) => sum + p.firepower, 0);
  const next = new Map<number, number>();

  if (target <= held) {
    const scale = held > 0 ? target / held : 0;
    for (const p of own) next.set(p.id, p.firepower * scale);
  } else {
    const increase = target - held;
    const flat = Math.min(1, increase / own.length);
    const rest = increase - flat * own.length;
    for (const p of own) {
      next.set(
        p.id,
        p.firepower + flat + (held > 0 ? (p.firepower / held) * rest : rest / own.length),
      );
    }
  }

  return {
    ...world,
    provinces: world.provinces.map((p) =>
      next.has(p.id) ? { ...p, firepower: next.get(p.id)! } : p,
    ),
  };
}

function isRoad(world: World, from: number, to: number): boolean {
  return world.provinces[from]!.neighbours.find((n) => n.province === to)?.road ?? false;
}

function areAdjacent(world: World, from: number, to: number): boolean {
  return world.provinces[from]!.neighbours.some((n) => n.province === to);
}

/**
 * One assault against a province's current defence (§5.5). The +10 is a modifier, not
 * real firepower, so a defender who holds keeps its own strength less what reached it.
 */
export function resolveAssault(
  attack: number,
  defence: number,
  viaRoad: boolean,
): { captured: boolean; effective: number; survivors: number; defenceAfter: number } {
  const effective = Math.max(0, attack - COMBAT.arrivalLoss) *
    (viaRoad ? 1 : COMBAT.offRoadMultiplier);
  const result = effective - (defence + COMBAT.defenderBonus);
  if (result > 0) {
    return { captured: true, effective, survivors: result, defenceAfter: 0 };
  }
  return {
    captured: false,
    effective,
    survivors: 0,
    defenceAfter: Math.max(0, defence - effective),
  };
}

/**
 * Execute a turn's military orders. Friendly transfers first, so troops can be shuffled
 * in ahead of an attack (§5.6); then waves in sequence, smallest army first with ties
 * drawn at random (§5.6.1).
 *
 * `rng` is seeded by the caller so a turn replays identically under `Undo Turn`.
 */
export function resolveMilitary(
  world: World,
  orders: Orders,
  rng: Rng = makeRng("battle"),
): MilitaryResult {
  const firepower = new Map<number, number>(world.provinces.map((p) => [p.id, p.firepower]));
  const owner = new Map<number, number>(world.provinces.map((p) => [p.id, p.nation]));
  const population = new Map<number, number>(world.provinces.map((p) => [p.id, p.population]));

  // Marching forces leave their province before anything resolves, so a province that
  // empties itself is genuinely undefended when a counter-attack lands on it.
  // Each force carries the nation that owned it when it set out. Reading allegiance
  // off the home province at battle time instead lets an army change sides mid-turn if
  // its home falls to an earlier assault.
  const marching: { from: number; to: number; force: number; nation: number }[] = [];
  for (const p of world.provinces) {
    const order = orders[p.id];
    if (!order || order.target === null) continue;
    if (!areAdjacent(world, p.id, order.target)) {
      throw new Error(`province ${p.id} cannot reach ${order.target}: not adjacent`);
    }
    const fraction = Math.min(1, Math.max(0, order.marchFraction));
    const force = firepower.get(p.id)! * fraction;
    if (force <= 0) continue;
    firepower.set(p.id, firepower.get(p.id)! - force);
    marching.push({ from: p.id, to: order.target, force, nation: p.nation });
  }

  const transfers: Transfer[] = [];
  const assaults: typeof marching = [];
  for (const move of marching) {
    if (move.nation === owner.get(move.to)) {
      firepower.set(move.to, firepower.get(move.to)! + move.force);
      transfers.push({ from: move.from, to: move.to, firepower: move.force });
    } else {
      assaults.push(move);
    }
  }

  // Smallest first, ties drawn at random. Sorting before the grouping means the battles
  // themselves also run smallest-first, which is the order the replay then shows.
  const draw = assaults.map(() => rng.next());
  const ordered = assaults
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.force - y.a.force || draw[x.i]! - draw[y.i]!)
    .map(({ a }) => a);

  const byTarget = new Map<number, typeof marching>();
  for (const a of ordered) {
    const list = byTarget.get(a.to);
    if (list) list.push(a);
    else byTarget.set(a.to, [a]);
  }

  const battles: Battle[] = [];
  for (const [target, waves] of byTarget) {
    const battle: Battle = {
      target,
      waves: [],
      captured: false,
      owner: owner.get(target)!,
      civilianLoss: 0,
    };
    for (const wave of waves) {
      // A province taken by an earlier wave is friendly to later ones from the same
      // nation, so they reinforce rather than assault it.
      if (wave.nation === owner.get(target)) {
        firepower.set(target, firepower.get(target)! + wave.force);
        transfers.push({ from: wave.from, to: target, firepower: wave.force });
        continue;
      }
      const defence = firepower.get(target)!;
      const viaRoad = isRoad(world, wave.from, target);
      const outcome = resolveAssault(wave.force, defence, viaRoad);
      battle.waves.push({
        from: wave.from,
        viaRoad,
        committed: wave.force,
        effective: outcome.effective,
        defenceBefore: defence,
        captured: outcome.captured,
        survivors: outcome.survivors,
      });
      battle.civilianLoss += wave.force;
      if (outcome.captured) {
        owner.set(target, wave.nation);
        firepower.set(target, outcome.survivors);
        battle.captured = true;
        battle.owner = owner.get(target)!;
      } else {
        firepower.set(target, outcome.defenceAfter);
      }
    }
    // Scorched earth, but bounded: a province that falls is left with the people its own
    // farmland can feed, and one that holds loses nobody (§5.5.1). Charging the whole
    // force brought to bear, as §5.5 has it, made conquest cost more than it could ever
    // return — see §10.1.4.
    const before = population.get(target)!;
    if (battle.captured) {
      const acres = world.provinces[target]!.land.farmland;
      const after = Math.max(0, Math.min(before, acres));
      battle.civilianLoss = before - after;
      population.set(target, after);
    } else {
      battle.civilianLoss = 0;
    }
    battles.push(battle);
  }

  const provinces: Province[] = world.provinces.map((p) => ({
    ...p,
    nation: owner.get(p.id)!,
    firepower: firepower.get(p.id)!,
    population: population.get(p.id)!,
  }));

  return {
    world: {
      ...world,
      provinces,
      nations: world.nations.map((n) => ({
        ...n,
        provinces: provinces.filter((p) => p.nation === n.id).map((p) => p.id),
      })),
    },
    transfers,
    battles,
  };
}

/** Has one nation taken everything? The game ends there (§1.3). */
export function conqueror(world: World): number | null {
  const owners = new Set(world.provinces.map((p) => p.nation));
  return owners.size === 1 ? [...owners][0]! : null;
}
