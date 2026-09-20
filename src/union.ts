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
 * - **How far the attack restriction reaches.** §6.1 says members may attack the target
 *   and nobody else; `canAttack` lets them also attack anyone in no union at all. See
 *   there for why.
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
  /** Whom the union is against. The one union member a member may attack (§6.1). */
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

/** What the round is waiting on the player to answer. */
export type UnionAsk =
  | { kind: "declare"; nation: number }
  | { kind: "join"; nation: number; founder: number; target: number };

interface Pending {
  founder: number;
  target: number;
  members: number[];
  /**
   * Everyone who may follow, fixed at the moment of declaration. Snapshotting it is
   * what makes the answers independent: nobody's decision can be informed by anybody
   * else's, because the candidate list does not shrink as people accept.
   */
  eligible: readonly number[];
  answered: boolean;
}

/**
 * A formation round in progress (§6.1).
 *
 * The round is taken one declaration at a time, weakest first, because that is how it
 * reads and because the player has to be able to answer each one on its own. Everyone
 * who might follow decides without knowing what the others chose — the declaration is
 * public, the answers are not — so a union's membership is a surprise to its own
 * members until it forms.
 */
export interface RoundState {
  /** Nation ids, weakest first. Declarations are offered in this order. */
  order: readonly number[];
  /** How far down `order` the declarations have got. */
  at: number;
  attached: readonly number[];
  unions: readonly Union[];
  pending: Pending | null;
  /** Set when the round is blocked on the player; null while it can run itself. */
  ask: UnionAsk | null;
  done: boolean;
}

export function startRound(standings: readonly Standing[]): RoundState {
  return {
    order: [...standings].sort((a, b) => a.population - b.population).map((s) => s.nation),
    at: 0,
    attached: [],
    unions: [],
    pending: null,
    ask: null,
    done: false,
  };
}

/**
 * Carry the round forward until it needs the player again, or finishes.
 *
 * `answer` responds to `state.ask`: a nation to declare against (or null to decline),
 * or for a join, the founder to follow (or null to stand aloof). Pass `human = -1` and
 * the round runs start to finish without stopping.
 */
export function runRound(
  state: RoundState,
  affinity: Affinity,
  standings: readonly Standing[],
  turn: number,
  human: number,
  answer?: number | null,
): RoundState {
  let { at, pending, unions, attached } = {
    at: state.at,
    pending: state.pending ? { ...state.pending, members: [...state.pending.members] } : null,
    unions: [...state.unions],
    attached: [...state.attached],
  };
  let reply = answer;
  const ids = standings.map((s) => s.nation);
  const free = (n: number) => !attached.includes(n);

  for (;;) {
    if (pending) {
      const { founder, target, eligible } = pending;
      // The player answers first, so that the AI's independent choices cannot be read
      // off the board before they commit.
      if (!pending.answered && human >= 0 && eligible.includes(human)) {
        if (reply === undefined) {
          return { ...state, at, attached, unions, pending,
            ask: { kind: "join", nation: human, founder, target }, done: false };
        }
        if (reply === founder) pending.members.push(human);
        pending.answered = true;
        reply = undefined;
      }
      for (const other of eligible) {
        if (other === human) continue;
        if (willJoin(affinity, other, founder, target, standings, turn)) pending.members.push(other);
      }
      // One nation is not a union: there is nothing to pool, and it would leave the
      // founder bound by an attack restriction it bought nothing with.
      if (pending.members.length >= 2) {
        attached = [...attached, ...pending.members];
        unions = [...unions, { founder, target, members: pending.members, formedOn: turn }];
      }
      pending = null;
      continue;
    }

    while (at < state.order.length && !free(state.order[at]!)) at++;
    if (at >= state.order.length) {
      return { ...state, at, attached, unions, pending: null, ask: null, done: true };
    }

    const founder = state.order[at]!;
    at++;
    let target: number | null;
    if (founder === human) {
      if (reply === undefined) {
        return { ...state, at: at - 1, attached, unions, pending: null,
          ask: { kind: "declare", nation: human }, done: false };
      }
      target = reply;
      reply = undefined;
      // `at` was rewound for the ask, so step over the declarer now it has answered.
      at = state.order.indexOf(founder) + 1;
    } else {
      target = enemiesOf(affinity, founder, standings, turn)[0] ?? null;
    }
    if (target === null || target === founder) continue;

    pending = {
      founder,
      target,
      members: [founder],
      eligible: ids.filter((n) => n !== founder && n !== target && free(n)),
      answered: false,
    };
  }
}

/**
 * Run a whole round at once. Convenience for tests and for games with no player in
 * them; `choice` supplies the answers a player would have given.
 */
export function formUnions(
  affinity: Affinity,
  standings: readonly Standing[],
  turn: number,
  choice?: HumanChoice,
): Union[] {
  const human = choice ? choice.nation : -1;
  let state = startRound(standings);
  for (let guard = 0; guard < 64 && !state.done; guard++) {
    const answer =
      state.ask === null ? undefined
      : state.ask.kind === "declare" ? choice!.declareAgainst
      : choice!.joins;
    state = runRound(state, affinity, standings, turn, human, answer);
  }
  return [...state.unions];
}

/** The union `nation` belongs to this turn, if any. */
export function unionOf(unions: readonly Union[], nation: number): Union | undefined {
  return unions.find((u) => u.members.includes(nation));
}

/**
 * Who a nation may attack. A member may take the union's target, or anyone standing
 * outside every union; anyone unattached is unrestricted; and whoever a union is
 * declared against may answer its members whatever else is true.
 *
 * **This relaxes §6.1 [F].** Crawford's rule is that members "may *only* attack the
 * union's target", neutrals included. Taken literally a member whose target lay across
 * the continent had no legal attack at all, however hostile the neighbour on its own
 * border — and since almost every nation joins something (§10.4), almost all aggression
 * was funnelled at two nations who could only answer their own target in turn. Expert
 * stopped being a war. Unions are still exclusive toward each other, which is what
 * keeps them meaningful: you cannot raid a rival bloc, only the one nation yours has
 * named. What you no longer forfeit is the right to defend your own frontier.
 */
export function canAttack(unions: readonly Union[], from: number, to: number): boolean {
  // A coalition declared against you may always be answered, whatever else holds.
  if (unions.some((u) => u.members.includes(to) && u.target === from)) return true;
  const own = unionOf(unions, from);
  if (!own) return true;
  if (to === own.target) return true;
  // Everyone else is off limits while they are somebody's ally — including your own.
  return unionOf(unions, to) === undefined;
}

/** Members' land and population added together, as one economic unit (§6.1). */
export function poolOf(
  world: World,
  members: readonly number[],
): { land: Land; population: number; provinces: number } {
  const land: Land = { farmland: 0, forest: 0, mountains: 0, desert: 0 };
  let population = 0;
  let provinces = 0;
  for (const member of members) {
    const state = nationState(world, member);
    land.farmland += state.land.farmland;
    land.forest += state.land.forest;
    land.mountains += state.land.mountains;
    land.desert += state.land.desert;
    population += state.population;
    provinces += world.provinces.filter((p) => p.nation === member).length;
  }
  return { land, population, provinces };
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
