/**
 * Affinity between nations (§6.4).
 *
 * Design, not archaeology: none of this is recoverable from the original, and it exists
 * to fix the failure in §9.1, where distrust only ever accumulated and unions died out.
 * Two stored channels decay toward zero and saturate on update, so no number of
 * grievances can pin a relationship at the floor; live terms read off the current
 * standings, so threat can always overwhelm stale history.
 *
 * Unions are not built yet (§10 step 7). The union events are specified below and
 * implemented, but nothing calls them; what does fire today is war and the standings.
 */
import type { World } from "./types.ts";

export const AFFINITY = {
  /** Half-lives of 4 and 15 turns. Warmth is volatile, reliability is durable. */
  likingDecay: 0.1591,
  trustDecay: 0.0452,
  /** Weights in the decision variable. Trust outranks warmth: betrayal costs more. */
  wTrust: 1.0,
  wLiking: 0.6,
  /** Live penalties, normalised so they mean the same at 2, 4 and 8 players. */
  populationDislike: 1.2,
  militaryDistrust: 1.0,
  sharedEnemyBonus: 0.3,
  /** Mutual gain each turn for a pair both in the bottom half by population. */
  underdogLiking: 0.08,
  underdogTrust: 0.02,
  /** How long an attack counts toward a shared enemy. */
  grudgeTurns: 5,
} as const;

/** Event magnitudes, as (liking, trust) deltas. Penalties are negative. */
export const EVENTS = {
  attacked: { liking: -0.35, trust: -0.05 },
  /** Applied on top of `attacked` when the attack succeeded. */
  attackWon: { liking: -0.15, trust: -0.05 },
  betrayed: { liking: -0.25, trust: -0.45 },
  joinedYourUnion: { liking: 0.2, trust: 0.1 },
  unionHeld: { liking: 0.05, trust: 0.05 },
  foundedUnionAgainstYou: { liking: -0.3, trust: -0.1 },
  joinedUnionAgainstYou: { liking: -0.09, trust: -0.03 },
} as const;

export interface Affinity {
  /** `liking[a][b]` is how warmly A regards B. Not symmetric once events land. */
  liking: number[][];
  trust: number[][];
  /** `grudge[victim][attacker]` is the turn of the last attack, for shared enemies. */
  grudge: number[][];
}

const square = (n: number, fill: number) =>
  Array.from({ length: n }, () => Array.from({ length: n }, () => fill));

/**
 * Move a channel by `d`, saturating toward the bound it is heading for.
 *
 * At neutral the whole of `d` lands; near ±1 it barely moves. Four betrayals at 0.45
 * reach −0.91 and never −1, which is the point: no history is unrecoverable.
 */
export function nudge(x: number, d: number): number {
  const moved = d < 0 ? x + d * (1 + x) : x + d * (1 - x);
  return Math.min(1, Math.max(-1, moved));
}

/** Shared province borders between each pair of nations, for the founding seed. */
export function sharedBorders(world: World): number[][] {
  const n = world.nations.length;
  const counts = square(n, 0);
  for (const p of world.provinces) {
    for (const q of p.neighbours) {
      if (q.province < p.id) continue;
      const other = world.provinces[q.province]!;
      if (other.nation === p.nation) continue;
      counts[p.nation]![other.nation]!++;
      counts[other.nation]![p.nation]!++;
    }
  }
  return counts;
}

/**
 * Founding neighbours start warmer, scaled by how much border they share (§6.4).
 *
 * Seeded rather than permanent, so history can spend it. Most of it sits in trust
 * deliberately, which is what makes the tie last 20-30 turns rather than about 12.
 */
export function seedAffinity(world: World): Affinity {
  const n = world.nations.length;
  const affinity: Affinity = { liking: square(n, 0), trust: square(n, 0), grudge: square(n, -Infinity) };
  const shared = sharedBorders(world);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const s = shared[a]![b]!;
      if (s <= 0) continue;
      const trust = Math.min(0.45, 0.2 + 0.08 * (s - 1));
      const liking = Math.min(0.3, 0.15 + 0.05 * (s - 1));
      affinity.trust[a]![b] = affinity.trust[b]![a] = trust;
      affinity.liking[a]![b] = affinity.liking[b]![a] = liking;
    }
  }
  return affinity;
}

/** One turn of decay toward neutral, plus the underdog dividend. */
export function agePairs(affinity: Affinity, bottomHalf: readonly number[]): void {
  const n = affinity.liking.length;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      affinity.liking[a]![b]! *= 1 - AFFINITY.likingDecay;
      affinity.trust[a]![b]! *= 1 - AFFINITY.trustDecay;
    }
  }
  // Shared adversity builds a real bond, so this accumulates rather than being live.
  // Against the decay it reaches equilibrium (liking 0.335, trust 0.307) rather than
  // running away — §6.4 calls it the strongest dial and the first one to turn down.
  for (const a of bottomHalf) {
    for (const b of bottomHalf) {
      if (a === b) continue;
      affinity.liking[a]![b] = nudge(affinity.liking[a]![b]!, AFFINITY.underdogLiking);
      affinity.trust[a]![b] = nudge(affinity.trust[a]![b]!, AFFINITY.underdogTrust);
    }
  }
}

/** Record what one nation did to another. `victim` is the one whose regard moves. */
export function applyEvent(
  affinity: Affinity,
  victim: number,
  actor: number,
  event: { liking: number; trust: number },
): void {
  if (victim === actor) return;
  affinity.liking[victim]![actor] = nudge(affinity.liking[victim]![actor]!, event.liking);
  affinity.trust[victim]![actor] = nudge(affinity.trust[victim]![actor]!, event.trust);
}

/** An attack, and whether it took the province. Both land on the defender's regard. */
export function applyAttack(
  affinity: Affinity,
  defender: number,
  attacker: number,
  captured: boolean,
  turn: number,
): void {
  if (defender === attacker) return;
  applyEvent(affinity, defender, attacker, EVENTS.attacked);
  if (captured) applyEvent(affinity, defender, attacker, EVENTS.attackWon);
  affinity.grudge[defender]![attacker] = turn;
}

export interface Standing {
  nation: number;
  population: number;
  firepower: number;
}

/**
 * Union willingness, A toward B (§6.4).
 *
 * Both channels feed it, plus the live terms that read the current standings. The point
 * of the live terms is that they can overwhelm stale grievance: a 15-turn-old betrayal
 * is worth −0.225, where a runaway leader's live penalty is −0.749.
 */
export function willingness(
  affinity: Affinity,
  from: number,
  to: number,
  standings: readonly Standing[],
  turn = 0,
): number {
  if (from === to) return 0;
  const n = standings.length;
  if (n < 2) return 0;
  const totalPop = standings.reduce((s, r) => s + r.population, 0);
  const totalMil = standings.reduce((s, r) => s + r.firepower, 0);
  const target = standings.find((r) => r.nation === to);
  if (!target) return 0;

  // Deviation from an equal share, normalised by its own maximum, so the weights mean
  // the same thing whatever the player count.
  const deviation = (share: number) => (share - 1 / n) / (1 - 1 / n);
  const popShare = totalPop > 0 ? target.population / totalPop : 1 / n;
  const milShare = totalMil > 0 ? target.firepower / totalMil : 1 / n;

  return (
    AFFINITY.wTrust * affinity.trust[from]![to]! +
    AFFINITY.wLiking * affinity.liking[from]![to]! -
    AFFINITY.populationDislike * deviation(popShare) -
    AFFINITY.militaryDistrust * deviation(milShare) +
    AFFINITY.sharedEnemyBonus * (sharedEnemy(affinity, from, to, turn) ? 1 : 0)
  );
}

/**
 * Whether A and B have been attacked by the same nation lately.
 *
 * §6.4 names the term but not its test; recent common aggressors is the reading that
 * needs nothing unions would have supplied.
 */
export function sharedEnemy(affinity: Affinity, a: number, b: number, turn: number): boolean {
  const recent = (victim: number, actor: number) =>
    turn - (affinity.grudge[victim]?.[actor] ?? -Infinity) <= AFFINITY.grudgeTurns;
  return affinity.grudge.some(
    (_, c) => c !== a && c !== b && recent(a, c) && recent(b, c),
  );
}
