#!/usr/bin/env python3
"""Fit the terrain->productivity function f for Guns or Butter (spec §2.2).

Observations are (terrain_acres, output) at a FIXED worker count. Add rows to OBS
and re-run. With more than 3 points the residuals become meaningful and the
family comparison is real rather than an artefact of zero degrees of freedom.

Each family has parameters that enter LINEARLY once the shape parameter is fixed,
so we grid only the shape parameter(s) and solve the rest by exact least squares.
That avoids the flat-ridge problem a naive full grid search runs into on family B.

    python3 docs/fit-terrain.py
"""
import math
import numpy as np

# (level, continent, acres, workers, output) -- same commodity throughout.
# Beginner has terrain disabled, so its rows calibrate f = 1 rather than the curve.
OBS = [
    ("Beg", "One",     0, 10,  87),
    ("Beg", "One",     0, 25, 244),
    ("Int", "One",     0, 10,  29),
    ("Int", "One",     0, 25,  81),
    ("Int", "Six",     0, 10,  29),
    ("Int", "Six",     0, 25,  81),
    ("Int", "Four",    9, 10,  39),
    ("Int", "Four",    9, 25, 111),
    ("Int", "Seven",  17, 10,  51),
    ("Int", "Seven",  17, 25, 144),
    ("Int", "Two",    26, 10,  65),
    ("Int", "Two",    26, 25, 185),
    ("Int", "Five",   50, 10, 101),
    ("Int", "Five",   50, 25, 288),
    ("Exp", "Eleven",  0, 10,  10),
    ("Exp", "Eleven",  0, 25,  29),
    ("Exp", "Three",   8, 10,  21),
    ("Exp", "Three",   8, 25,  58),
    ("Exp", "Four",    9, 10,  21),
    ("Exp", "Four",    9, 25,  58),
    ("Exp", "Two",    20, 10,  37),
    ("Exp", "Two",    20, 25, 103),
    ("Exp", "Five",   35, 10,  56),
    ("Exp", "Five",   35, 25, 160),
    ("Exp", "One",    44, 10,  72),
    ("Exp", "One",    44, 25, 201),
]
# extra Beginner anchor: the 1990 manual screenshot, continent 'trebolokhan'
OBS_BEGINNER_MANUAL = [("Beg", "trebolokhan", 0, 27, 268)]


def _lstsq(cols, y):
    M = np.column_stack(cols)
    coef, *_ = np.linalg.lstsq(M, y, rcond=None)
    r = y - M @ coef
    return coef, float(r @ r)


def solve_exponent(rows):
    """a from same-(level, continent, acres) worker pairs, by within-pair agreement."""
    pairs = {}
    for lvl, cont, ac, L, C in rows:
        pairs.setdefault((lvl, cont, ac), {})[L] = C
    pairs = {k: v for k, v in pairs.items() if len(v) == 2}
    if not pairs:
        return None, []
    def cost(a):
        s = 0.0
        for v in pairs.values():
            ys = [C / L ** a for L, C in v.items()]
            s += (ys[0] - ys[1]) ** 2 / (sum(ys) / 2) ** 2
        return s
    grid = np.linspace(1.00, 1.40, 40001)
    a = float(grid[int(np.argmin([cost(g) for g in grid]))])
    per = []
    for (lvl, cont, ac), v in sorted(pairs.items()):
        (L1, C1), (L2, C2) = sorted(v.items())
        est = math.log(C2 / C1) / math.log(L2 / L1)
        err = (0.5 / C1 + 0.5 / C2) / math.log(L2 / L1)
        per.append((lvl, cont, ac, est, err))
    return a, per


def main():
    a, per = solve_exponent(OBS)
    print("=== exponent a, from same-continent worker pairs ===")
    for lvl, cont, ac, est, err in per:
        print(f"  {lvl:3} {cont:12} {ac:3} acres:  a={est:.4f} +-{err:.4f}")
    print(f"  best global a = {a:.4f}")

    beg = [r for r in OBS + OBS_BEGINNER_MANUAL if r[0] == "Beg"]
    if len(beg) >= 2:
        (_, _, _, L1, C1), (_, _, _, L2, C2) = beg[0], beg[1]
        print(f"  Beginner-only estimate (L={L1}->{L2}): "
              f"a={math.log(C2/C1)/math.log(L2/L1):.4f}")

    print(f"\n=== y = C / L^{a:.4f}, grouped ===")
    Y = {}
    for lvl, cont, ac, L, C in OBS:
        Y.setdefault(lvl, {}).setdefault(ac, []).append(C / L ** a)
    for lvl in ("Beg", "Int", "Exp"):
        for ac in sorted(Y.get(lvl, {})):
            v = Y[lvl][ac]
            mean = sum(v) / len(v)
            sp = (f"  spread={abs(v[0]-v[1])/mean*100:5.2f}%" if len(v) == 2 else "")
            print(f"  {lvl:3} acres={ac:3}  y={mean:7.3f}{sp}")

    print("\n=== marginal return per acre ===")
    for lvl in ("Int", "Exp"):
        pts = sorted((ac, sum(v)/len(v)) for ac, v in Y.get(lvl, {}).items())
        for i in range(len(pts) - 1):
            (a1, y1), (a2, y2) = pts[i], pts[i + 1]
            print(f"  {lvl} {a1:3} -> {a2:3}: {(y2-y1)/(a2-a1):.4f} /acre")

    print("\n=== y = max(floor, base + m*acres), fitted on acres > 0 ===")
    beg_y = None
    if "Beg" in Y:
        beg_y = sum(Y["Beg"][0]) / len(Y["Beg"][0])
    for lvl in ("Int", "Exp"):
        pts = sorted((ac, sum(v)/len(v)) for ac, v in Y.get(lvl, {}).items())
        if len(pts) < 2:
            continue
        xs = np.array([p[0] for p in pts], float)
        ys = np.array([p[1] for p in pts], float)
        sel = xs > 0
        if sel.sum() < 2:
            continue
        (b, m), sse = _lstsq([np.ones(int(sel.sum())), xs[sel]], ys[sel])
        dof = int(sel.sum()) - 2
        print(f"  {lvl}: base={b:.4f}  m={m:.4f}/acre  dof={dof}"
              f"  rmse={math.sqrt(sse/max(int(sel.sum()),1)):.4f}")
        for ac, yy in pts:
            note = "   <- floor, excluded from fit" if ac == 0 else ""
            print(f"     acres={ac:3} obs={yy:7.3f} line={b+m*ac:7.3f} "
                  f"resid={yy-(b+m*ac):+7.3f}{note}")
        if beg_y is not None and m > 0:
            print(f"     Beginner terrain-off y={beg_y:.3f} "
                  f"~= {(beg_y-b)/m:.1f} {lvl} acres")


if __name__ == "__main__":
    main()
