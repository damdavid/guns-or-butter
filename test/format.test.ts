/**
 * Compact numbers (§10.1.7). Firepower is the one quantity that can run past five
 * digits, and the map has no room for it.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compact, grouped, standing } from "../src/format.ts";

describe("compact numbers", () => {
  it("matches the three cases the rule was written from", () => {
    assert.equal(compact(10_000), "10k");
    assert.equal(compact(2_000_000), "2000k");
    assert.equal(compact(20_000_000), "20m");
  });

  it("puts decimals on the unit change and nowhere else", () => {
    // Every quantity in the game is a whole number of things, so the digits in 10.43k
    // are thousands rather than fractions of anything.
    const power = (n: number) => compact(n, 2);
    assert.equal(power(10_432.7), "10.43k", "the digits the unit change would have lost");
    assert.equal(power(268_510.8), "268.51k");
    assert.equal(power(456_123), "456.12k");
    for (const n of [0, 4.2, 12.87, 26, 165.53, 999.4, 9999.7]) {
      assert.equal(power(n), String(Math.floor(n)), `${n} is below the unit change`);
    }
    // And a whole number of units keeps no zeros.
    assert.equal(power(10_000), "10k");
    assert.equal(power(2_000_000), "2000k");
    assert.equal(power(20_000_000), "20m");
  });

  it("never shows a fraction of a thing, at any magnitude", () => {
    for (let n = 0; n < 12_000; n += 7.3) {
      const shown = compact(n, 2);
      if (!shown.endsWith("k")) {
        assert.ok(/^\d+$/.test(shown), `${n} rendered as ${shown}`);
      }
    }
  });

  it("truncates the decimals rather than rounding them up", () => {
    // Everything on screen rounds down, so a nation never appears to hold more than it
    // does. toFixed alone would turn 456,999 into 457.00k.
    assert.equal(compact(456_999, 2), "456.99k");
    assert.equal(compact(19_999, 2), "19.99k");
    assert.equal(compact(9.999, 2), "9", "below the unit change it is a whole thing");
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

describe("short or spare", () => {
  it("agrees with the figure the player is shown", () => {
    // The bug: the class tested the raw tonnage against half a ton while the cell
    // floored it, so -0.3 displayed as "-1" with nothing to mark it as a deficit.
    for (const tons of [-0.01, -0.3, -0.49, -0.5, -0.9, -1, -12.7]) {
      assert.equal(standing(tons), "short", `${tons} displays as ${Math.floor(tons)}`);
    }
  });

  it("calls nothing short or spare when it displays as zero", () => {
    for (const tons of [0, 0.01, 0.4, 0.5, 0.99]) {
      assert.equal(standing(tons), "", `${tons} displays as ${Math.floor(tons)}`);
    }
  });

  it("calls a visible surplus spare", () => {
    for (const tons of [1, 1.2, 40, 3000.7]) assert.equal(standing(tons), "spare");
  });

  it("never disagrees with the sign of the displayed whole number", () => {
    for (let tons = -5; tons <= 5; tons += 0.07) {
      const shown = Math.floor(tons);
      const want = shown < 0 ? "short" : shown > 0 ? "spare" : "";
      assert.equal(standing(tons), want, `${tons.toFixed(2)} shows ${shown}`);
    }
  });
});
