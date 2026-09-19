/**
 * Compact numbers (§10.1.7). Firepower is the one quantity that can run past five
 * digits, and the map has no room for it.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compact, grouped } from "../src/format.ts";

describe("compact numbers", () => {
  it("matches the three cases the rule was written from", () => {
    assert.equal(compact(10_000), "10k");
    assert.equal(compact(2_000_000), "2000k");
    assert.equal(compact(20_000_000), "20m");
  });

  it("carries two decimals for firepower, but never a run of zeros", () => {
    const power = (n: number) => compact(n, 2);
    assert.equal(power(10_432.7), "10.43k", "the digits the unit change would have lost");
    assert.equal(power(268_510.8), "268.51k");
    assert.equal(power(456_123), "456.12k");
    assert.equal(power(12.87), "12.87");
    assert.equal(power(999.4), "999.4", "one useful digit, not two");
    // A whole number stays whole.
    assert.equal(power(26), "26");
    assert.equal(power(999), "999");
    assert.equal(power(10_000), "10k");
    assert.equal(power(2_000_000), "2000k");
    assert.equal(power(20_000_000), "20m");
  });

  it("truncates the decimals rather than rounding them up", () => {
    // Everything on screen rounds down, so a nation never appears to hold more than it
    // does. toFixed alone would turn 456,999 into 457.00k.
    assert.equal(compact(456_999, 2), "456.99k");
    assert.equal(compact(9.999, 2), "9.99");
    assert.equal(compact(19_999, 2), "19.99k");
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

describe("grouped numbers", () => {
  it("puts a comma at every thousand", () => {
    assert.equal(grouped(18_500), "18,500");
    assert.equal(grouped(1_234_567), "1,234,567");
    assert.equal(grouped(1_000), "1,000");
  });

  it("leaves anything under a thousand alone", () => {
    for (const n of [0, 1, 42, 638, 999]) assert.equal(grouped(n), String(n));
  });

  it("rounds down, like every other quantity on screen", () => {
    assert.equal(grouped(18_500.9), "18,500");
    assert.equal(grouped(999.99), "999");
  });

  it("does not depend on the machine's locale", () => {
    // `toLocaleString` would put full stops in for half the world.
    assert.ok(!grouped(1_234_567).includes("."));
    assert.equal(grouped(1_234_567).split(",").length, 3);
  });

  it("keeps the whole number, where compact would not", () => {
    // Population is the victory metric (§1.3) and the standings are read by comparing
    // them, so two nations a hundred people apart must not print the same.
    assert.notEqual(grouped(2_412_077), grouped(2_412_340));
    assert.equal(compact(2_412_077), compact(2_412_340), "compact collapses them to 2412k");
  });

  it("handles negatives, which a population should never be", () => {
    assert.equal(grouped(-1_234), "-1,234");
  });
});
