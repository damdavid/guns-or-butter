/**
 * Compact numbers (§10.1.7). Firepower is the one quantity that can run past five
 * digits, and the map has no room for it.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compact } from "../src/format.ts";

describe("compact numbers", () => {
  it("matches the three cases the rule was written from", () => {
    assert.equal(compact(10_000), "10k");
    assert.equal(compact(2_000_000), "2000k");
    assert.equal(compact(20_000_000), "20m");
  });

  it("stays exact below five digits", () => {
    for (const n of [0, 1, 7, 42, 999, 1000, 5678, 9999]) {
      assert.equal(compact(n), String(n));
    }
  });

  it("changes unit only when the mantissa would reach five digits", () => {
    assert.equal(compact(9_999), "9999");
    assert.equal(compact(10_000), "10k");
    assert.equal(compact(9_999_999), "9999k");
    // 10000k would itself be five digits, so it rolls on — the same step as 20m.
    assert.equal(compact(10_000_000), "10m");
    assert.equal(compact(10_000_000_000), "10b");
    assert.equal(compact(10_000_000_000_000), "10t");
  });

  it("keeps four significant figures, which SI-style notation would not", () => {
    // 1200 and 1249 both render as "1.2K" under Intl compact notation, and the
    // difference between two armies that size decides the battle between them.
    assert.notEqual(compact(1200), compact(1249));
    assert.notEqual(compact(1_200_000), compact(1_249_000));
  });

  it("rounds down, like every other quantity on screen", () => {
    assert.equal(compact(9999.9), "9999");
    assert.equal(compact(10_999), "10k");
    assert.equal(compact(0.9), "0");
  });

  it("survives negatives and nonsense without throwing", () => {
    assert.equal(compact(-10_000), "-10k");
    assert.equal(compact(-7), "-7");
    assert.equal(compact(1e30), "1000000000000000000t");
  });

  it("never grows longer than the plain number it replaces", () => {
    for (let exponent = 0; exponent <= 15; exponent++) {
      for (const lead of [1, 2, 5, 9]) {
        const n = lead * 10 ** exponent;
        assert.ok(
          compact(n).length <= String(n).length,
          `compact(${n}) is "${compact(n)}", longer than the number itself`,
        );
      }
    }
  });
});
