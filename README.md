# Guns or Butter

A reimplementation of Chris Crawford's *The Global Dilemma: Guns or Butter* (1990),
rebuilt from the original manual, Crawford's design retrospective, and measurements
taken from the DOS binary running under emulation.

- `docs/MECHANICS-SPEC.md` — the reconstructed design spec. Every claim is tagged
  `[C]` confirmed, `[I]` inferred, or `[F]` free-to-choose.
- `docs/calibrate.py` — fits every commodity's productivity parameters from the
  measurement CSVs and generates `src/calibration.ts`.
- `docs/fit-terrain.py` — earlier, forest-only fit; superseded by `calibrate.py`.
- `docs/*.csv` — 644 output measurements taken from the DOS build under emulation.
- `src/` — the simulation. No runtime dependencies.
- `the-global-dilemma-guns-or-butter/` — the original 1990 build, for reference.

## Status

Economy sim only: production graph, productivity function, demand-driven allocation,
agriculture, population. Map generation, military and diplomacy are specified but not
yet built — see §10 of the spec for the intended order.

## Commands

    npm test          # 81 tests, including the manual p.12 reference state
    npm run typecheck
    npm run fixture   # print the reference state as a Production Summary
    npm run validate  # score the sim against all 644 measurements

Requires Node >= 22.6 (runs TypeScript directly via `--experimental-strip-types`).

## License

[MIT](LICENSE) — covers the simulation code and the reconstructed spec in `docs/`.

It does not and cannot cover the source material the spec is derived from: the 1990
game, its manual, and *Chris Crawford on Game Design* all remain the property of their
respective owners. None of them are distributed here; `docs/SOURCES.md` points to them
instead. Short quotations in the spec are there to show the provenance of a claim.
