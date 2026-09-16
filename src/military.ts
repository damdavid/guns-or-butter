/**
 * Military resolution (§5). Weapon distribution, orders, transfers, then battles.
 *
 * Firepower is a single continuous scalar per province — not units, not stacks. A
 * province can hold 4.2 "bangs". Crawford counted this among the game's real
 * innovations, and ch24 calls the military system "its best feature".
 */
import { tierYield } from "./data.ts";
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
 * Spread a nation's new firepower over its provinces: a flat 1 to each, then the rest in
 * proportion to what each already holds (§5.3). Automatic, with no player control: where
 * you massed last turn is where production flows this turn, which quietly rewards
 * concentration.
 *
 * The flat 1 comes off the top because the proportional rule alone has an absorbing
 * state — a province holding nothing is owed nothing, so it holds nothing for the rest of
 * the game. That is how a province taken by an enemy and stripped bare, or one that spent
 * everything on a failed assault, became permanently indefensible. Every province now
 * gets at least a garrison.
 *
 * When there is not enough to go round — fewer than one per province — every province
 * gets the same fraction instead, which keeps the split free of any ordering bias and
 * leaves nothing undistributed.
 *
 * With nothing massed anywhere — the opening turn — the remainder falls back to an even
 * spread, since the proportional rule has nothing to work from.
 */
export function distributeWeapons(world: World, nation: number, firepower: number): World {
  if (firepower <= 0) return world;
  const own = world.provinces.filter((p) => p.nation === nation);
  if (own.length === 0) return world;

  const flat = Math.min(1, firepower / own.length);
  const rest = firepower - flat * own.length;
  const held = own.reduce((sum, p) => sum + p.firepower, 0);
  const share = new Map<number, number>();
  for (const p of own) {
    share.set(p.id, flat + (held > 0 ? (p.firepower / held) * rest : rest / own.length));
  }
  return {
    ...world,
    provinces: world.provinces.map((p) =>
      share.has(p.id) ? { ...p, firepower: p.firepower + share.get(p.id)! } : p,
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
 * One assault against a province's current defence (§5.5).
 *
 * The attacker loses a flat 10 on arrival and is quartered if not coming down a road;
 * the defender fights with a flat +10. Both thresholds Appendix B quotes fall out of
 * this: an undefended province needs more than 20 firepower by road, more than 50
 * across anything else.
 *
 * The +10 is a modifier rather than real firepower, so a defender who holds is left
 * with its own strength less what actually reached it, not less the bonus as well.
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
 * Execute a turn's military orders.
 *
 * Friendly transfers resolve first, so a player who reads an attack coming can shuffle
 * troops in ahead of it (§5.6). Several attacks on one province then resolve in
 * sequence, which is what lets a first wave soften a defender for a second.
 */
export function resolveMilitary(world: World, orders: Orders): MilitaryResult {
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

  const byTarget = new Map<number, typeof marching>();
  for (const a of assaults) {
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
    // Scorched earth: a big conquest guts the prize it was fought over (§5.5).
    population.set(target, Math.max(0, population.get(target)! - battle.civilianLoss));
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
