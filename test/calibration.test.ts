/**
 * The fitted exponents against the readings they came from.
 *
 * `npm run validate` scores predicted *output*; this scores the economies-of-scale
 * exponent itself, which is the one number §3.4 calls the foundation of the design. It
 * reads the committed CSVs and refits them independently of `docs/calibrate.py`, so a
 * change to the fitter that flattened the curve would fail here.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PARAMS } from "../src/calibration.ts";
import { rawParams } from "../src/terrain.ts";
import { Economy } from "../src/economy.ts";
import { commodityLabel } from "../src/data.ts";
import type { Level } from "../src/types.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const parse = (text: string) => text.split(/\r?\n/).map((line) => line.split(","));

/** Least squares on log(output) against log(workers): the exponent, by definition. */
function exponent(points: [number, number][]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const lx = points.map(([w]) => Math.log(w));
  const ly = points.map(([, y]) => Math.log(y));
  const sx = lx.reduce((a, b) => a + b, 0);
  const sy = ly.reduce((a, b) => a + b, 0);
  const sxx = lx.reduce((a, b) => a + b * b, 0);
  const sxy = lx.reduce((a, b, i) => a + b * ly[i]!, 0);
  const d = n * sxx - sx * sx;
  return Math.abs(d) < 1e-12 ? null : (n * sxy - sx * sy) / d;
}

/** Measured exponents per level and commodity name, averaged over the series. */
function measured(): Map<string, number> {
  const series = new Map<string, [number, number][]>();
  const add = (file: string, levelCol: number, workerCol: number, firstCol: number, groupCol: number | null) => {
    const rows = parse(read(file));
    const header = rows[1]!.map((c) => c.trim());
    for (const row of rows.slice(2)) {
      const level = row[levelCol]?.trim().toLowerCase();
      const workers = Number(row[workerCol]);
      if (!level || !Number.isFinite(workers) || workers <= 0) continue;
      const group = groupCol === null ? "" : row[groupCol]?.trim();
      for (let i = firstCol; i < Math.min(header.length, row.length); i++) {
        const name = header[i];
        const value = Number(row[i]);
        if (!name || !row[i]?.trim() || !Number.isFinite(value) || value <= 0) continue;
        const key = `${level}|${name}|${group}`;
        (series.get(key) ?? series.set(key, []).get(key)!).push([workers, value]);
      }
    }
  };
  add("docs/raw-outputs-by-worker-and-terrain.csv", 0, 8, 9, 1);
  add("docs/intermediate-outputs-by-worker.csv", 0, 1, 2, null);

  const grouped = new Map<string, number[]>();
  for (const [key, points] of series) {
    const a = exponent(points.sort((p, q) => p[0] - q[0]));
    if (a === null) continue;
    const [level, name] = key.split("|");
    const k = `${level}|${name}`;
    (grouped.get(k) ?? grouped.set(k, []).get(k)!).push(a);
  }
  return new Map(
    [...grouped].map(([k, list]) => [k, list.reduce((a, b) => a + b, 0) / list.length]),
  );
}

describe("economies of scale, against the readings (§3.4)", () => {
  const table = new Economy().graph.table;
  const LEVELS: Level[] = ["beginner", "intermediate", "expert"];
  // The CSV headers hyphenate two names that the id cannot distinguish.
  const heading = (id: string) =>
    commodityLabel(id).replace("Low Grade", "Low-Grade").replace("High Grade", "High-Grade");

  const pairs = (() => {
    const found = measured();
    const out: { id: string; level: Level; measured: number; model: number }[] = [];
    for (const [id, c] of table) {
      for (const level of LEVELS) {
        const m = found.get(`${level}|${heading(id)}`);
        const a = c.kind === "raw" ? rawParams(c, level)?.a : PARAMS[id]?.[level]?.a;
        if (m === undefined || a === undefined) continue;
        out.push({ id, level, measured: m, model: a });
      }
    }
    return out;
  })();

  it("compares against a useful share of the readings", () => {
    assert.ok(pairs.length >= 60, `only ${pairs.length} commodity/level pairs matched the CSVs`);
  });

  it("reproduces every measured exponent closely", () => {
    const errors = pairs.map((p) => Math.abs(p.model - p.measured));
    const worst = pairs[errors.indexOf(Math.max(...errors))]!;
    assert.ok(
      Math.max(...errors) < 0.15,
      `worst exponent error ${Math.max(...errors).toFixed(3)} on ${worst.id}/${worst.level}` +
      ` (measured ${worst.measured.toFixed(3)}, model ${worst.model.toFixed(3)})`,
    );
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    assert.ok(mean < 0.02, `mean exponent error ${mean.toFixed(4)}`);
  });

  it("does not flatten the curve systematically", () => {
    // A fitter that averaged the scale away would show up as a consistent negative bias.
    const bias = pairs.reduce((s, p) => s + (p.model - p.measured), 0) / pairs.length;
    assert.ok(Math.abs(bias) < 0.02, `mean model-minus-measured bias ${bias.toFixed(4)}`);
  });

  it("keeps doubling labour more than doubling capacity, everywhere", () => {
    // The manual's player-facing promise, and the one §3.4 says the game turns on.
    for (const p of pairs) {
      assert.ok(p.model > 1, `${p.id}/${p.level} has exponent ${p.model}, which is not superlinear`);
      assert.ok(p.measured > 1, `${p.id}/${p.level} was measured at ${p.measured}`);
    }
  });
});
