#!/usr/bin/env python3
"""Fit every commodity's productivity parameters from the two measurement CSVs.

capacity(c, level, acres, L) = K(c, level, acres) * L^a(c)

  a(c)  is per-commodity and level-independent (verified below).
  K     for non-raws is k(c) * levelMultiplier(level).
        for raws it is max(floor, base + m*acres) in that raw's own terrain.

Emits the calibration table for src/data.ts.  Usage: python3 docs/calibrate.py
"""
import csv
import math
from collections import defaultdict

import numpy as np

RAW_CSV = "docs/raw-outputs-by-worker-and-terrain.csv"
INT_CSV = "docs/intermediate-outputs-by-worker.csv"
TERRAIN = {
    "Lumber": "Forest", "Sulfur": "Desert", "Iron Ore": "Mountain", "Coal": "Mountain",
    "Light Metal": "Mountain", "Nitrate": "Desert", "Heavy Metal": "Mountain",
    "Petroleum": "Desert",
}
LEVELS = ["Beginner", "Intermediate", "Expert"]

# Nothing is currently excluded. Continent Seven's Iron Ore series was excluded for
# several revisions -- it fitted an exponent of 1.65 where every other series gave
# ~1.13 -- and a re-read confirmed the original values were wrong. Kept as a named set
# so the next bad series is a one-line change rather than a restructure.
EXCLUDE: set[tuple[str, str, str]] = set()

ID = {
    "Lumber": "lumber", "Sulfur": "sulfur", "Iron Ore": "iron-ore", "Coal": "coal",
    "Light Metal": "light-metal", "Nitrate": "nitrate", "Heavy Metal": "heavy-metal",
    "Petroleum": "petroleum", "Charcoal": "charcoal", "Pig Iron": "pig-iron",
    "Gunpowder": "gunpowder", "Iron": "iron", "Low-Grade Steel": "low-grade-steel",
    "Explosives": "explosives", "High-Grade Steel": "high-grade-steel",
    "High Explosives": "high-explosives", "Steam Engine": "steam-engine",
    "Wire": "wire", "Pipe": "pipe", "Electrics": "electrics",
    "Ball Bearing": "ball-bearing", "Diesel Engine": "diesel-engine",
    "Instruments": "instruments", "Farm Tools": "farm-tools", "Iron Plow": "iron-plow",
    "Combine": "combine", "Irrigation": "irrigation", "Tractor": "tractor",
    "Sword": "sword", "Musket": "musket", "Rifle": "rifle", "Cannon": "cannon",
    "Tank": "tank",
}
LEVEL_ID = {"Beginner": "beginner", "Intermediate": "intermediate", "Expert": "expert"}


def load():
    """series[(commodity, level, continent)] = [(workers, output), ...]"""
    series = defaultdict(list)
    land = {}
    with open(RAW_CSV) as f:
        rows = [[x.strip() for x in r] for r in csv.reader(f)]
    hdr = rows[1]
    for v in rows[2:]:
        if not v or not v[0]:
            continue
        lvl, cont = v[0], v[1]
        land[(lvl, cont)] = {
            "Farmland": float(v[4]), "Mountain": float(v[5]),
            "Forest": float(v[6]), "Desert": float(v[7]),
        }
        for c, val in zip(hdr[9:], v[9:]):
            if val and float(val) > 0:
                series[(c, lvl, cont)].append((float(v[8]), float(val)))

    with open(INT_CSV) as f:
        rows = [[x.strip() for x in r] for r in csv.reader(f)]
    hdr = rows[1]
    for v in rows[2:]:
        if not v or not v[0]:
            continue
        for c, val in zip(hdr[2:], v[2:]):
            if val and float(val) > 0:
                # The intermediate file pools continents within a level; that is only
                # sound because non-raws turn out not to depend on terrain at all.
                series[(c, v[0], "pooled")].append((float(v[1]), float(val)))
    return series, land


def loglog(pts):
    L = np.log([p[0] for p in pts])
    O = np.log([p[1] for p in pts])
    a, lnk = np.polyfit(L, O, 1)
    return float(a), float(math.exp(lnk)), float(np.abs(O - (a * L + lnk)).max())


def fit_exponents(series):
    """One exponent per commodity, weighted towards long clean series."""
    by_c = defaultdict(list)
    for (c, lvl, cont), pts in series.items():
        if len(pts) < 3 or (c, lvl, cont) in EXCLUDE:
            continue
        a, k, res = loglog(pts)
        by_c[c].append((a, len(pts), res))
    out = {}
    for c, fits in by_c.items():
        # weight by point count, penalise scatter: short noisy series are unreliable
        w = np.array([n / (1.0 + 40.0 * res) for _, n, res in fits])
        a = np.array([x[0] for x in fits])
        out[c] = (float((w * a).sum() / w.sum()), float(a.std()), len(fits))
    return out


def fit_response(pts, a):
    """Fit `base + m*acres` against readings, minimising RELATIVE error.

    Absolute least squares is wrong here: a raw's outputs span three orders of
    magnitude within one level, so the largest reading would set both parameters on
    its own. Relative error also stops `base` being driven negative and clamped to
    zero, which mattered for Petroleum -- its zero-desert reading (4 tons at 160
    workers) proves the intercept is non-zero, and clamping was costing a 267% error.
    """
    acres = np.array([p[0] for p in pts], float)
    scale = np.array([p[1] ** a for p in pts], float)
    obs = np.array([p[2] for p in pts], float)
    if len(set(acres.tolist())) < 2:
        return float(np.mean(obs / scale)), 0.0

    # Seed from the unweighted linear fit, then refine on a local grid.
    k = obs / scale
    m0, b0 = np.polyfit(acres, k, 1)
    best = (np.inf, max(b0, 0.0), max(m0, 0.0))
    span_b = max(abs(b0), k.max()) * 1.5
    span_m = max(abs(m0), k.max() / max(acres.max(), 1)) * 1.5
    for _ in range(4):
        _, cb, cm = best
        for b in np.linspace(max(0.0, cb - span_b), cb + span_b, 120):
            for m in np.linspace(max(0.0, cm - span_m), cm + span_m, 120):
                pred = np.maximum(0.0, b + m * acres) * scale
                err = float((((pred - obs) / obs) ** 2).sum())
                if err < best[0]:
                    best = (err, float(b), float(m))
        span_b /= 8.0
        span_m /= 8.0
    return best[1], best[2]


def refit_k(series, exps):
    """With a pinned, k follows from each series by least squares in log space."""
    out = {}
    for (c, lvl, cont), pts in series.items():
        if c not in exps or len(pts) < 3 or (c, lvl, cont) in EXCLUDE:
            continue
        a = exps[c][0]
        ks = [o / L**a for L, o in pts]
        out[(c, lvl, cont)] = (float(np.mean(ks)), float(np.std(ks) / np.mean(ks)))
    return out


def main():
    series, land = load()
    exps = fit_exponents(series)

    print("=== exponents (level-independent) ===")
    print(f"{'commodity':18} {'a':>7} {'sd':>7} {'series':>7}")
    for c, (a, sd, n) in sorted(exps.items(), key=lambda kv: kv[1][0]):
        print(f"{c:18} {a:7.4f} {sd:7.4f} {n:7}")

    ks = refit_k(series, exps)

    print("\n=== non-raw level multiplier (Beginner = 1) ===")
    mult = defaultdict(list)
    for c in exps:
        if c in TERRAIN:
            continue
        base = ks.get((c, "Beginner", "pooled"), [None])[0]
        if not base:
            continue
        for lvl in LEVELS:
            v = ks.get((c, lvl, "pooled"))
            if v:
                mult[lvl].append(v[0] / base)
    for lvl in LEVELS:
        if mult[lvl]:
            v = np.array(mult[lvl])
            print(f"  {lvl:14} n={len(v):2}  mean {v.mean():.4f}  sd {v.std():.4f}")

    emit(series, land, exps, ks)

    print("\n=== raw terrain response: k = base + m*acres, per level ===")
    for c in TERRAIN:
        for lvl in LEVELS:
            pts = [
                (land[(lvl, cont)][TERRAIN[c]], v[0])
                for (cc, ll, cont), v in ks.items()
                if cc == c and ll == lvl and cont != "pooled"
            ]
            if len(pts) < 2:
                continue
            x = np.array([p[0] for p in pts])
            y = np.array([p[1] for p in pts])
            if len(set(x)) < 2:
                print(f"  {c:14} {lvl:14} floor only: k={y.mean():.4f} ({len(pts)} pts)")
                continue
            m, b = np.polyfit(x, y, 1)
            pred = b + m * x
            err = float(np.abs(pred - y).max() / max(y.mean(), 1e-9))
            print(f"  {c:14} {lvl:14} base={b:9.4f} m={m:8.5f} "
                  f"n={len(pts)} maxerr={err * 100:4.1f}%")


def emit(series, land, exps, ks):
    """Write src/calibration.ts. Generated, so the sim never drifts from the data.

    Parameters are stored per (commodity, level). A single pooled exponent plus a flat
    level multiplier was tried first and rejected: it left p90 error at 37%, because the
    per-level coefficient ratio is not constant across commodities (Steam Engine's is
    6.4, Charcoal's is 1.6).
    """
    def per_level(c):
        """(a, k) fitted independently per level, pooling continents for non-raws."""
        out = {}
        for lvl in LEVELS:
            pts = []
            for (cc, ll, cont), s in series.items():
                if cc == c and ll == lvl and (cc, ll, cont) not in EXCLUDE:
                    pts += s
            if len(pts) >= 3:
                a, k, res = loglog(pts)
                out[lvl] = (a, k, res, len(pts))
        return out

    lines = [
        "/**",
        " * GENERATED by docs/calibrate.py from the measurement CSVs. Do not edit by hand.",
        " *",
        " * capacity = K * L^a, both per (commodity, level).",
        " *   non-raws: K = k",
        " *   raws:     K = base + m * acres, in that raw's own terrain",
        " */",
        "import type { CommodityId, Level } from \"./types.ts\";",
        "",
        "export interface Params { a: number; k: number }",
        "export interface RawParams { a: number; base: number; m: number }",
        "",
        "/** Non-raw productivity, measured per level. */",
        "export const PARAMS: Partial<Record<CommodityId, Partial<Record<Level, Params>>>> = {",
    ]
    for c in sorted(exps, key=lambda x: ID[x]):
        if c in TERRAIN:
            continue
        pl = per_level(c)
        if not pl:
            continue
        lines.append(f"  \"{ID[c]}\": {{")
        for lvl, (a, k, _r, _n) in pl.items():
            lines.append(f"    {LEVEL_ID[lvl]}: {{ a: {a:.4f}, k: {k:.6f} }},")
        lines.append("  },")
    lines += ["};", "",
              "/**",
              " * Raw productivity. `base` is the intercept at zero acres of the relevant",
              " * terrain -- the design dialogue's 'modicum'. Advanced raws have base ~0: no",
              " * terrain, no output, whatever the labour.",
              " */",
              "export const RAW_PARAMS: Partial<Record<CommodityId, Partial<Record<Level, RawParams>>>> = {"]
    raw_rows = {}
    for c in TERRAIN:
        if c not in exps:
            continue
        rows = []
        for lvl in LEVELS:
            all_here = [(cont, s) for (cc, ll, cont), s in series.items()
                        if cc == c and ll == lvl and (cc, ll, cont) not in EXCLUDE]
            # The exponent needs a slope, so only series with >= 3 points vote on it.
            exp_series = [(cont, s) for cont, s in all_here if len(s) >= 3]
            if not exp_series:
                continue
            # Fit the exponent PER CONTINENT and average. Pooling the points instead
            # biases the slope: each continent is a parallel line at its own offset, so
            # one line through all of them tilts toward whichever has the wider L range.
            fits = [loglog(s) for _, s in exp_series]
            w = np.array([len(s) / (1.0 + 40.0 * f[2]) for (_, s), f in zip(exp_series, fits)])
            a = float((w * np.array([f[0] for f in fits])).sum() / w.sum())
            # k, by contrast, needs only one reading per continent once a is known. Using
            # every series -- not just the long ones -- is what lets Petroleum, observed
            # 1-3 times per continent, still get a terrain response.
            pts = [(land[(lvl, cont)][TERRAIN[c]], L, o)
                   for cont, s in all_here for L, o in s]
            b, m = fit_response(pts, a)
            rows.append((lvl, a, b, m))
        if not rows:
            continue
        raw_rows[c] = {lvl: (a, b, m) for lvl, a, b, m in rows}

    # Project the levels a raw was never sampled at, from how its terrain siblings move
    # between those levels. Petroleum is only ever observed at Expert, and Heavy Metal
    # likewise; without this they would inherit Expert parameters at Beginner, where
    # Sulfur's base is 94x larger. Terrain is ignored at Beginner, so m projects to 0.
    ratios = {}
    for terr in set(TERRAIN.values()):
        sibs = [c for c in raw_rows if TERRAIN[c] == terr]
        for src in LEVELS:
            for dst in LEVELS:
                if src == dst:
                    continue
                bs = [raw_rows[c][dst][1] / raw_rows[c][src][1]
                      for c in sibs
                      if src in raw_rows[c] and dst in raw_rows[c] and raw_rows[c][src][1] > 0]
                # Beginner has m = 0 by construction (terrain ignored), so only pairs
                # with a positive slope at both ends can inform a slope ratio.
                ms = [raw_rows[c][dst][2] / raw_rows[c][src][2]
                      for c in sibs
                      if src in raw_rows[c] and dst in raw_rows[c]
                      and raw_rows[c][src][2] > 0 and raw_rows[c][dst][2] > 0]
                if bs:
                    ratios[(terr, src, dst)] = (
                        float(np.exp(np.mean(np.log(bs)))),
                        float(np.exp(np.mean(np.log(ms)))) if ms else 0.0,
                    )

    projected = {}
    for c, per in raw_rows.items():
        for dst in LEVELS:
            if dst in per:
                continue
            src = min((l for l in per), key=lambda l: abs(LEVELS.index(l) - LEVELS.index(dst)))
            r = ratios.get((TERRAIN[c], src, dst))
            if not r:
                continue
            a, b, m = per[src]
            projected[(c, dst)] = (a, b * r[0], 0.0 if dst == "Beginner" else m * r[1])

    for c in TERRAIN:
        if c not in raw_rows:
            continue
        lines.append(f"  \"{ID[c]}\": {{")
        for lvl in LEVELS:
            if lvl in raw_rows[c]:
                a, b, m = raw_rows[c][lvl]
                note = ""
            elif (c, lvl) in projected:
                a, b, m = projected[(c, lvl)]
                note = "  // projected from terrain siblings; never sampled"
            else:
                continue
            lines.append(
                f"    {LEVEL_ID[lvl]}: {{ a: {a:.4f}, base: {b:.6f}, m: {m:.6f} }},{note}")
        lines.append("  },")
    lines += ["};", ""]
    with open("src/calibration.ts", "w") as f:
        f.write("\n".join(lines))
    print("\nwrote src/calibration.ts")


if __name__ == "__main__":
    main()
