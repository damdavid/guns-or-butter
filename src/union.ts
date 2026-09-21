/**
 * Economic unions (§6.1), Expert only. §6.5 records what this module decides where
 * §6.1 is silent; §10.4 records what it does in play.
 *
 * A union lasts one turn, so the round runs afresh every turn.
 */
import { EVENTS, applyEvent, willingness, type Affinity, type Standing } from "./affinity.ts";
import { nationState } from "./worldgen.ts";
import type { Land, World } from "./types.ts";

export const UNION = {
  /** Neutral regard: a joiner must at least tolerate the founder (§6.4). */
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
  /** Fixed when the declaration is made, which is what keeps the answers blind (§6.5). */
  eligible: readonly number[];
  answered: boolean;
}

/**
 * A formation round in progress: one declaration at a time, weakest first (§6.5).
 *
 * Only nations still holding ground take part, which the caller expresses by leaving
 * the conquered out of `standings`.
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
 * Carry the round to the next question, or to the end. `answer` responds to
 * `state.ask` — a target, a founder to follow, or null to decline. `human = -1` runs
 * the whole round without stopping.
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
    // `standings` carries only nations still holding ground, so this also refuses a
    // declaration against one that has been conquered out of the game — the player's
    // answer arrives from a UI and is not trusted to have checked.
    if (target === null || target === founder || !ids.includes(target)) continue;

    pending = {
      founder,
      target,
      members: [founder],
      eligible: ids.filter((n) => n !== founder && n !== target && free(n)),
      answered: false,
    };
  }
}

/** Run a whole round at once; `choice` supplies the answers a player would give. */
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
 * Who a nation may attack: its union's target, anyone in no union, and anyone in a
 * union declared against it. Unattached nations are unrestricted.
 *
 * Relaxes §6.1's "the target and nobody else" [F] — see §10.4 for why and for what
 * measuring it changed.
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
 * The diplomatic bill for a union forming (§6.4): the target's grievance split 70/30
 * between founder and joiners, and betrayal for anyone turning on last turn's partner.
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

/** The cooperation dividend (§6.4), and the only positive inflow the model has. */
export function recordSurvival(affinity: Affinity, unions: readonly Union[]): void {
  for (const union of unions) {
    for (const a of union.members) {
      for (const b of union.members) {
        if (a !== b) applyEvent(affinity, a, b, EVENTS.unionHeld);
      }
    }
  }
}
