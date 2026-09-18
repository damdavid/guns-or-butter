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
- `web/` — the browser front end: plain TypeScript and direct DOM, bundled by esbuild.
  The map renderer in `src/svg.ts` is shared with the command-line one.

## Status

**Economy sim complete and calibrated.** Production graph, superlinear productivity,
demand-driven allocation with input hoarding and depth-ordered priority, agriculture,
population. All 33 commodities have measured parameters; exponents span 1.13 to 2.53.
The population response is measured too, from 29 readings — which cost the manual two of
its stated rules, since growth turns out to be linear with saturation rather than a square
root, and the "30% growth" boundary condition is 14.5% in the shipped game.

**Map generation complete.** Continents are seeded by name, as in the original.
Capitals, a Delaunay spoke graph, provinces as its centroid dual, roads on half the
spokes, terrain on the rest, and contiguous nations — feeding straight into the economy.

**Military and the turn loop complete.** Continuous firepower, the combat formula,
transfers-before-battles, and a phase loop that ties the three subsystems together —
production, orders, execution, rankings, undo.

**Browser UI.** `npm run dev`. A start screen for the continent, your nation's name and
the difficulty; worker allocation that *previews* the pro-rata redistribution before it is
committed, with a number box and nudge buttons for fine work; a pannable, zoomable map
cropped to the continent; province and nation inspectors, with food output withheld as a
national secret; military orders given by clicking province to province; and an execution
phase that replays each march across the map rather than cutting to the result.
Deliberately built before the AI: the UI is where the original lost, and it is the only
subsystem whose defects are invisible to tests — playing it has found ten so far that the
unit tests did not. See §10.1.

AI and diplomacy are specified but not yet built. See §10 of the spec.

## Commands

    npm run dev       # play it in a browser on localhost:5173
    npm test          # 234 tests, including the 1990 manual's p.12 reference state
    npm run typecheck
    npm run build     # bundle the browser app to web/dist/
    npm run validate  # score the sim against all 644 measurements
    npm run fixture   # print the reference state as a Production Summary
    npm run map -- Kittycat expert out.svg   # render a generated continent
    npm run play -- Kublai intermediate 20   # watch the turn loop run
    npm run game -- Kittycat intermediate    # play it yourself in the terminal

The browser app takes `?continent=`, `?level=` and `?nation=` query parameters, so
`localhost:5173/?continent=Kublai&level=expert` starts a different world.

Developed and verified on Node 26.8.2, which `.nvmrc` pins — `nvm use` picks it up.
Node runs the TypeScript directly, with no build step for anything outside `web/`.

Requires Node >= 22.18, the release that made type stripping the default. Below that
`node file.ts` fails with `ERR_UNKNOWN_FILE_EXTENSION`; the old
`--experimental-strip-types` flag is no longer needed and is not used.

Nothing ships at runtime; the dev dependencies are `typescript`, `@types/node`, and
`esbuild` for the browser bundle.

## License

[MIT](LICENSE) — covers the simulation code and the reconstructed spec in `docs/`.

It does not and cannot cover the source material the spec is derived from: the 1990
game, its manual, and *Chris Crawford on Game Design* all remain the property of their
respective owners. None of them are distributed here; `docs/SOURCES.md` points to them
instead. Short quotations in the spec are there to show the provenance of a claim.
