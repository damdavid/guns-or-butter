/**
 * Naming: the commodity labels a player reads, and the nations they play against.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ANCIENT_NATIONS, nationNames } from "../src/names.ts";
import { commoditiesFor, commodityLabel } from "../src/data.ts";
import { makeRng } from "../src/rng.ts";
import { generateWorld } from "../src/worldgen.ts";
import { Economy } from "../src/economy.ts";

describe("commodity labels (§3.2)", () => {
  it("turns the ids lifted from the binary into names a player reads", () => {
    assert.equal(commodityLabel("lumber"), "Lumber");
    assert.equal(commodityLabel("iron-ore"), "Iron Ore");
    assert.equal(commodityLabel("farm-tools"), "Farm Tools");
    assert.equal(commodityLabel("high-grade-steel"), "High Grade Steel");
  });

  it("labels every commodity in the table, with no leftover hyphens", () => {
    for (const id of new Economy().graph.table.keys()) {
      const label = commodityLabel(id);
      assert.ok(!label.includes("-"), `${id} -> ${label}`);
      assert.match(label, /^[A-Z]/, `${id} -> ${label}`);
      assert.equal(label.toLowerCase().replace(/ /g, "-"), id);
    }
  });
});

describe("nation names", () => {
  it("draws distinct names, seeded so a continent keeps its opposition", () => {
    const a = nationNames(makeRng("Kittycat/nations"), 8);
    const b = nationNames(makeRng("Kittycat/nations"), 8);
    assert.deepEqual(a, b, "same seed must give the same nations");
    assert.equal(new Set(a).size, 8, "names must not repeat");
    for (const n of a) assert.ok(ANCIENT_NATIONS.includes(n), `${n} is not in the list`);
    assert.notDeepEqual(a, nationNames(makeRng("Kublai/nations"), 8));
  });

  it("keeps the player's own name out of the draw, whatever its case or padding", () => {
    for (const taken of ["Babylon", "  babylon  ", "BABYLON"]) {
      const drawn = nationNames(makeRng("Kittycat/nations"), 8, [taken]);
      assert.ok(!drawn.some((n) => n.toLowerCase() === "babylon"), `${taken} leaked through`);
      assert.equal(new Set(drawn).size, 8);
    }
  });

  it("has more names than the largest game needs", () => {
    assert.ok(ANCIENT_NATIONS.length > 8, "expert plays eight nations");
    assert.equal(new Set(ANCIENT_NATIONS).size, ANCIENT_NATIONS.length, "list has duplicates");
  });
});

describe("naming a world", () => {
  it("gives every nation a name, and the player the one they asked for", () => {
    const world = generateWorld("Kittycat", "intermediate", { playerNation: "Babylon" });
    assert.equal(world.nations[0]!.name, "Babylon");
    for (const n of world.nations) assert.ok(n.name.length > 0, `nation ${n.id} is nameless`);
    assert.equal(new Set(world.nations.map((n) => n.name)).size, world.nations.length);
  });

  it("names the nations without disturbing the map the continent's name makes", () => {
    // The nation draw runs off its own seed, so choosing a name cannot reshape the land.
    const plain = generateWorld("Kittycat", "intermediate");
    const named = generateWorld("Kittycat", "intermediate", { playerNation: "Babylon" });
    assert.deepEqual(
      plain.provinces.map((p) => ({ capital: p.capital, land: p.land, nation: p.nation })),
      named.provinces.map((p) => ({ capital: p.capital, land: p.land, nation: p.nation })),
    );
    assert.deepEqual(plain.outline, named.outline);
  });

  it("falls back to a drawn name when the player does not give one", () => {
    const world = generateWorld("Kittycat", "beginner");
    assert.ok(ANCIENT_NATIONS.includes(world.nations[0]!.name));
  });
});

describe("commodity sets per difficulty (§1.1)", () => {
  const table = [...new Economy().graph.table.keys()];
  const at = (level: "beginner" | "intermediate" | "expert") => commoditiesFor(level, table);

  it("offers what the measurements say each level offered", () => {
    // Read off docs/*.csv, where a blank means the commodity could not be made at that
    // level. §1.1 says 13 for beginner; the readings show 12.
    assert.equal(at("beginner").length, 12);
    assert.equal(at("intermediate").length, 19);
    assert.equal(at("expert").length, table.length);
    assert.equal(at("expert").length, 33);
  });

  it("adds Combine and Rifle at intermediate, with the chain that feeds them", () => {
    for (const id of ["combine", "rifle", "steam-engine", "low-grade-steel", "explosives",
                      "light-metal", "nitrate"]) {
      assert.ok(!at("beginner").includes(id), `${id} should not be in the beginner set`);
      assert.ok(at("intermediate").includes(id), `${id} is missing from intermediate`);
    }
  });

  it("holds the heavy industry back for expert", () => {
    for (const id of ["tank", "tractor", "cannon", "irrigation", "diesel-engine",
                      "high-grade-steel", "petroleum", "heavy-metal"]) {
      assert.ok(!at("intermediate").includes(id), `${id} should not be in intermediate`);
      assert.ok(at("expert").includes(id));
    }
  });

  it("nests the levels, and keeps the table's own order", () => {
    const b = at("beginner"), i = at("intermediate"), e = at("expert");
    for (const id of b) assert.ok(i.includes(id), `${id} vanished at intermediate`);
    for (const id of i) assert.ok(e.includes(id), `${id} vanished at expert`);
    for (const set of [b, i, e]) {
      const positions = set.map((id) => table.indexOf(id));
      assert.deepEqual(positions, [...positions].sort((x, y) => x - y), "order should follow the table");
    }
  });

  it("can feed every level's own chain from within that level", () => {
    // A level that offered a factory without its inputs would be unplayable.
    const { table: t } = new Economy().graph;
    for (const level of ["beginner", "intermediate", "expert"] as const) {
      const set = new Set(at(level));
      for (const id of set) {
        for (const input of Object.keys(t.get(id)!.inputs)) {
          assert.ok(set.has(input), `${level}: ${id} needs ${input}, which the level lacks`);
        }
      }
    }
  });
});
