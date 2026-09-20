/**
 * Play many whole games with every nation on the AI and assert the invariants that
 * should hold on every turn of every one. `npm run soak -- [turns] [continents]`
 *
 * This exists because it found something 336 unit tests did not: the AI could plan more
 * workers than the nation had, because affordability is worked out in fractional people
 * while staffing rounds every stage up. The overshoot was stored as an allocation whose
 * shares summed to 2.5, and nothing failed — `workersFor` renormalises, so the economy
 * still ran and the only symptom was that the AI scored a plan it never received. Only
 * checking the invariant across 1,230 turns made it visible.
 *
 * It is a script rather than a `*.test.ts` because a full run takes about twenty
 * minutes, which is too slow for `npm test`. Run it after touching the economy, the
 * planner or the AI.
 */
import { Game, type TurnReport } from "../src/game.ts";
import { nationState } from "../src/worldgen.ts";
import type { Level } from "../src/types.ts";

const CONTINENTS = [
  "Thule", "Kittycat", "Kublai", "Ganthor", "Vashti", "Nineveh", "Saturday", "Corinth",
  "Avalon", "Byzantium", "Carthage", "Dahlia", "Eridu", "Meroe", "Tyre", "Ur",
];
const LEVELS: Level[] = ["beginner", "intermediate", "expert"];

const [, , turnsArg = "30", countArg = String(CONTINENTS.length)] = process.argv;
const turns = Number(turnsArg);
const continents = CONTINENTS.slice(0, Number(countArg));

const problems: string[] = [];
const note = (message: string) => {
  // One line per distinct problem: a broken invariant usually repeats every turn for
  // the rest of the game, and a thousand copies of it hides whatever else went wrong.
  if (!problems.includes(message)) problems.push(message);
};

/** Spare workforce per nation, as it stood when the turn began. */
function workforce(game: Game): Map<number, number> {
  const spare = new Map<number, number>();
  for (const nation of game.world.nations) {
    if (nation.provinces.length === 0) continue;
    const { land, population } = nationState(game.world, nation.id);
    spare.set(nation.id, Math.floor(Math.max(0, population - land.farmland)));
  }
  return spare;
}

function check(
  game: Game,
  report: TurnReport | null,
  opening: Map<number, number>,
  where: string,
): void {
  const finite = (value: number, what: string) => {
    if (!Number.isFinite(value)) note(`${where}: ${what} is ${value}`);
  };

  for (const province of game.world.provinces) {
    finite(province.firepower, "province firepower");
    finite(province.population, "province population");
    if (province.firepower < -1e-9) note(`${where}: negative firepower ${province.firepower}`);
    if (province.population < -1e-9) note(`${where}: negative population ${province.population}`);
    if (province.nation !== null && !game.world.nations[province.nation]) {
      note(`${where}: province owned by a nation that does not exist`);
    }
  }

  for (const nation of game.world.nations) {
    if (nation.provinces.length === 0) continue;
    const { land, population } = nationState(game.world, nation.id);
    const spare = Math.floor(Math.max(0, population - land.farmland));
    finite(population, `nation ${nation.id} population`);

    const allocation = game.allocations[nation.id];
    if (allocation) {
      let sum = 0;
      for (const [id, share] of Object.entries(allocation)) {
        finite(share, `share of ${id}`);
        if (share < -1e-9) note(`${where}: negative share ${id}=${share}`);
        sum += Math.max(0, share);
      }
      // Shares over 1 mean somebody planned labour the nation does not have.
      if (sum > 1 + 1e-6) note(`${where}: nation ${nation.id} shares sum to ${sum.toFixed(6)}`);
    }

    // Against the workforce as it was when production resolved, not as it is now:
    // taking a province brings farmland, and its people are capped to that farmland
    // (§5.7), so a conquest can leave a nation with *fewer* spare workers than it
    // started the turn with.
    const had = opening.get(nation.id) ?? spare;
    const used = Object.values(report?.production[nation.id]?.commodities ?? {})
      .reduce((total, c) => total + c.workers, 0);
    if (used > had + 1e-6) {
      note(`${where}: nation ${nation.id} staffed ${used} of ${had} spare workers`);
    }
  }

  for (const ranking of game.rankings()) {
    finite(ranking.population, "ranking population");
    finite(ranking.firepower, "ranking firepower");
    if (ranking.provinces < 0) note(`${where}: negative province count`);
  }
}

let played = 0;
let decided = 0;
for (const level of LEVELS) {
  for (const continent of continents) {
    const game = Game.create(continent, level);
    game.human = -1; // nobody is the player, so every nation is the AI
    for (let turn = 0; turn < turns && game.winner === null; turn++) {
      const opening = workforce(game);
      game.advance();                       // production resolves
      const report = game.advance();        // orders resolve; the report carries them
      game.advance();
      game.advance();
      played++;
      check(game, report, opening, `${continent}/${level}/turn ${turn}`);
    }
    if (game.winner !== null) decided++;
  }
}

const games = LEVELS.length * continents.length;
console.log(`${games} games, ${played} turns, ${decided} decided within ${turns}`);
if (problems.length === 0) {
  console.log("no invariant violations");
} else {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
