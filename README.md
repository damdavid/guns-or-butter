# Guns or Butter

A reimplementation of Chris Crawford's *The Global Dilemma: Guns or Butter* (1990),
rebuilt from the original manual, Crawford's design retrospective, and measurements
taken from the DOS binary running under emulation.

- `docs/MECHANICS-SPEC.md` — the reconstructed design spec. Every claim is tagged
  `[C]` confirmed, `[I]` inferred, or `[F]` free-to-choose.
- `docs/fit-terrain.py` — fits the terrain response from in-game readings.
- `src/` — the simulation. No runtime dependencies.
- `the-global-dilemma-guns-or-butter/` — the original 1990 build, for reference.

## Status

Economy sim only: production graph, productivity function, demand-driven allocation,
agriculture, population. Map generation, military and diplomacy are specified but not
yet built — see §10 of the spec for the intended order.

## Commands

    npm test          # 68 tests, including the manual p.12 reference state
    npm run typecheck
    npm run fixture   # print the reference state as a Production Summary

Requires Node >= 22.6 (runs TypeScript directly via `--experimental-strip-types`).
