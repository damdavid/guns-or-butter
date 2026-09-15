# Guns or Butter

A reimplementation of Chris Crawford's *The Global Dilemma: Guns or Butter* (1990),
rebuilt from the original manual, Crawford's design retrospective, and measurements
taken from the DOS binary running under emulation.

No source code for the game survives — Crawford's own
[source-release page](https://www.erasmatazz.com/library/source-code/index.html) notes
he does not think he has anything on this title — so the design is reconstructed rather
than ported.

## Layout

- `docs/MECHANICS-SPEC.md` — the reconstructed design spec. Every claim is tagged
  `[C]` confirmed, `[I]` inferred, or `[F]` free-to-choose, so the boundary between
  recovered fact and invention stays visible.
- `docs/*.csv` — 644 output measurements taken from the DOS build. Original readings,
  and the basis for every productivity parameter.
- `docs/calibrate.py` — fits those measurements and generates `src/calibration.ts`.
- `docs/SOURCES.md` — where to obtain the copyrighted source material, which is not
  committed here.
- `src/` — the simulation. No runtime dependencies.

## Status

**Economy sim complete and calibrated.** Production graph, superlinear productivity,
demand-driven allocation with input hoarding and depth-ordered priority, agriculture,
population. All 33 commodities have measured parameters; exponents span 1.13 to 2.53.

Map generation, military and diplomacy are specified but not yet built. See §10 of the
spec for the intended order.

## Commands

    npm test          # 81 tests, including the 1990 manual's p.12 reference state
    npm run typecheck
    npm run validate  # score the sim against the 640 usable measurements
    npm run fixture   # print the reference state as a Production Summary

Requires Node >= 22.6, which runs the TypeScript directly via
`--experimental-strip-types`. The only dev dependencies are `typescript` and
`@types/node`.

## License

[MIT](LICENSE) — covers the simulation code and the reconstructed spec in `docs/`.

It does not and cannot cover the source material the spec is derived from: the 1990
game, its manual, and *Chris Crawford on Game Design* all remain the property of their
respective owners. None of them are distributed here; `docs/SOURCES.md` points to them
instead. Short quotations in the spec are there to show the provenance of a claim.
