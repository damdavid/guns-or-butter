/**
 * Economic unions (§6.1), Expert only.
 *
 * Crawford's mechanic verbatim: the weakest player declares a union against their worst
 * enemy, everyone else joins or stands aloof, the founder takes control of every
 * member's economy for the turn, and members' populations and terrain pool into a
 * single economic unit. Given superlinear productivity (§3.4) that pooling is the whole
 * point — and at Expert it is not an efficiency gain but survival, because no nation
 * there can feed itself alone (§10.3).
 *
 * What §6.1 leaves unsaid, and what this module decides:
 *
 * - **Who joins.** `willingness` (§6.4) gates it, and a joiner must regard the founder
 *   better than the target. Without that second test a nation will join a mob against
 *   its own closest ally, which reads as nonsense on the screen.
 * - **What a union of one is.** Nothing. A declaration nobody joins is dropped, so the
 *   founder is not left bound by an attack restriction bought for no pooling.
 * - **How the pooled result is split back.** By population share, for growth and for
 *   firepower alike. §6.1 pools the inputs and is silent on the outputs.
 *
 * Unions last exactly one turn (§6.1), so this runs afresh every turn.
 */
import { EVENTS, applyEvent, willingness, type Affinity, type Standing } from "./affinity.ts";
import { nationState } from "./worldgen.ts";
import type { Land, World } from "./types.ts";

export const UNION = {
  /**
   * A joiner must at least tolerate the founder. Zero is neutral regard, which at the
   * start of a game is roughly where unrelated nations sit and a little below where
   * founding neighbours do (§6.4).
   */
  joinAt: 0,
} as const;

export interface Union {
  founder: number;
  /** Whom the union is against. Members may attack nobody else (§6.1). */
  target: number;
  /** Founder first, then joiners in the order they accepted. */
  members: number[];
  formedOn: number;
}

/** What the human has decided this turn, for the two questions only they can answer. */
export interface HumanChoice {
  nation: number;
  /** The founder whose union to join, or null to stand aloof. */
  joins: number | null;
  /** Whom to declare against, if offered the chance. Null declines to declare. */
  declareAgainst: number | null;
}

/** Everyone a nation might turn on, worst regarded first. */
export function enemiesOf(
  affinity: Affinity,
  nation: number,
  standings: readonly Standing[],
  turn: number,
): number[] {
  return standings
    .map((s) => s.nation)
    .filter((other) => other !== nation)
    .sort(
      (a, b) =>
        willingness(affinity, nation, a, standings, turn) -
        willingness(affinity, nation, b, standings, turn),
    );
}

/** Whether `joiner` would sign up to `founder`'s union against `target`. */
export function willJoin(
  affinity: Affinity,
  joiner: number,
  founder: number,
  target: number,
  standings: readonly Standing[],
  turn: number,
): boolean {
  if (joiner === founder || joiner === target) return false;
  const toFounder = willingness(affinity, joiner, founder, standings, turn);
  if (toFounder < UNION.joinAt) return false;
  // Better regarded than the victim, or you are joining a mob against your own friend.
  return toFounder > willingness(affinity, joiner, target, standings, turn);
}

/**
 * Run §6.1's formation round.
 *
 * The weakest unattached nation declares, everyone still unattached answers, and then
 * the next weakest unattached nation gets its turn to declare — "further unions may
 * form; if you join none, you may declare your own". Declaring is not optional for the
 * weakest in Crawford's text, so only joining is a decision; the human may still
 * decline to name a target, which produces the same outcome as a union nobody joins.
 */
export function formUnions(
  affinity: Affinity,
  standings: readonly Standing[],
  turn: number,
  choice?: HumanChoice,
): Union[] {
  const unions: Union[] = [];
  const attached = new Set<number>();
  const weakestFirst = [...standings].sort((a, b) => a.population - b.population);

  for (const candidate of weakestFirst.map((s) => s.nation)) {
    if (attached.has(candidate)) continue;
    const enemies = enemiesOf(affinity, candidate, standings, turn);
    if (enemies.length === 0) continue;

    let target: number;
    if (choice && candidate === choice.nation) {
      if (choice.declareAgainst === null) continue;
      target = choice.declareAgainst;
    } else {
      target = enemies[0]!;
    }
    if (target === candidate) continue;

    const members = [candidate];
    for (const other of standings.map((s) => s.nation)) {
      if (attached.has(other) || other === candidate || other === target) continue;
      const joins =
        choice && other === choice.nation
          ? choice.joins === candidate
          : willJoin(affinity, other, candidate, target, standings, turn);
      if (joins) members.push(other);
    }

    // One nation is not a union: there is nothing to pool, and it would leave the
    // founder bound by an attack restriction it bought nothing with.
    if (members.length < 2) continue;
    for (const member of members) attached.add(member);
    unions.push({ founder: candidate, target, members, formedOn: turn });
  }

  return unions;
}

/** The union `nation` belongs to this turn, if any. */
export function unionOf(unions: readonly Union[], nation: number): Union | undefined {
  return unions.find((u) => u.members.includes(nation));
}

/**
 * §6.1's attack restriction: members may only attack the union's target, or anyone in
 * a union against them. An unattached nation is unrestricted.
 *
 * This is the real price of joining. If the target is nowhere near you, you have traded
 * a whole turn's aggression for the pooling — which is what stops unions being free.
 */
export function canAttack(unions: readonly Union[], from: number, to: number): boolean {
  const against = unions.find((u) => u.members.includes(to) && u.target === from);
  if (against) return true;
  const own = unionOf(unions, from);
  if (!own) return true;
  return to === own.target;
}

/** Members' land and population added together, as one economic unit (§6.1). */
export function poolOf(
  world: World,
  members: readonly number[],
): { land: Land; population: number } {
  const land: Land = { farmland: 0, forest: 0, mountains: 0, desert: 0 };
  let population = 0;
  for (const member of members) {
    const state = nationState(world, member);
    land.farmland += state.land.farmland;
    land.forest += state.land.forest;
    land.mountains += state.land.mountains;
    land.desert += state.land.desert;
    population += state.population;
  }
  return { land, population };
}

/**
 * Record the diplomatic consequences of a union forming (§6.4).
 *
 * The grievance the target takes is split 70/30 between founder and joiners rather than
 * landing at full strength on each. That single edit is what stops one union poisoning
 * seven edges at once, which is the arithmetic behind the collapse Crawford describes
 * in §6.3.
 *
 * Turning on someone you stood with last turn is betrayal, and costs trust an order of
 * magnitude more than ordinary hostility: −0.45 against −0.10. Because a union lasts
 * only one turn there is no standing pact to walk out of, so joining a union against
 * yesterday's ally is the form defection takes here.
 */
export function recordFormation(
  affinity: Affinity,
  unions: readonly Union[],
  previous: readonly Union[],
): void {
  const alliedBefore = (a: number, b: number) =>
    previous.some((u) => u.members.includes(a) && u.members.includes(b));

  for (const union of unions) {
    for (const member of union.members) {
      if (member !== union.founder) {
        applyEvent(affinity, union.founder, member, EVENTS.joinedYourUnion);
      }
      const event = alliedBefore(member, union.target)
        ? EVENTS.betrayed
        : member === union.founder
          ? EVENTS.foundedUnionAgainstYou
          : EVENTS.joinedUnionAgainstYou;
      applyEvent(affinity, union.target, member, event);
    }
  }
}

/**
 * The cooperation dividend (§6.4): every pair that held a union together warms to each
 * other a little. It is the only positive inflow the original lacked entirely, and the
 * whole reason distrust does not ratchet to Crawford's dead end.
 */
export function recordSurvival(affinity: Affinity, unions: readonly Union[]): void {
  for (const union of unions) {
    for (const a of union.members) {
      for (const b of union.members) {
        if (a !== b) applyEvent(affinity, a, b, EVENTS.unionHeld);
      }
    }
  }
}
