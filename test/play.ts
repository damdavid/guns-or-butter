/**
 * Drive a game for N turns and print what happened. `npm run play -- [continent] [level] [turns]`
 *
 * Nations with no orders hold, and any without an allocation fall back to a balanced
 * subsistence economy — there is no AI yet, so this shows the loop running, not a game
 * being played well.
 */
import { Game } from "../src/game.ts";
import type { Level } from "../src/types.ts";

const [, , continent = "Kublai", level = "intermediate", turnsArg = "20"] = process.argv;
const turns = Number(turnsArg);
const game = Game.create(continent, level as Level);

console.log(`Continent ${game.world.name} — ${game.world.level}, ${game.world.nations.length} nations, ${game.world.provinces.length} provinces\n`);
const head = ["turn", ...game.world.nations.map((n) => n.name)];
console.log(head.map((h) => h.padStart(11)).join("") + "    battles");

for (let t = 0; t < turns && game.winner === null; t++) {
  game.advance(); // production
  const report = game.advance()!; // orders resolve, execution begins
  const byNation = new Map(report.rankings.map((r) => [r.nation, r]));
  const cells = game.world.nations.map((n) => {
    const r = byNation.get(n.id);
    return r ? `${r.population}/${r.provinces}` : "-";
  });
  console.log(
    [String(report.turn), ...cells].map((c) => c.padStart(11)).join("") +
    `    ${report.battles.length}`,
  );
  game.advance(); // execution -> rankings
  game.advance(); // rankings -> next turn
}

console.log("\nfinal standings — population / provinces / firepower");
for (const r of game.rankings()) {
  const name = game.world.nations[r.nation]?.name ?? `nation ${r.nation}`;
  console.log(`  ${name.padEnd(12)} ${String(r.population).padStart(5)}  ${String(r.provinces).padStart(3)}  ${r.firepower.toFixed(0).padStart(6)}`);
}
console.log(game.winner === null ? "\nno conqueror yet" : `\nnation ${game.winner} has taken the world`);
