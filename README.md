# Guns or Butter

A reimplementation of Chris Crawford's *The Global Dilemma: Guns or Butter* (1990),
rebuilt from the original manual, Crawford's design retrospective, and measurements
taken from the DOS binary running under emulation.

**Play it at [gb.mitchthefat.com](https://gb.mitchthefat.com)** — it runs in the
browser, needs no install, and saves your game in the page.

No source code for the game survives — Crawford's own
[source-release page](https://www.erasmatazz.com/library/source-code/index.html) notes
he does not think he has anything on this title — so the design is reconstructed rather
than ported. The whole game is here: the economy, map generation, combat, the turn
loop, AI opponents and the Expert economic unions. What each rule is derived from, and
where the reconstruction had to invent, is recorded in the spec.

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
- `scripts/build-site.ts` — assembles the deployable site out of `web/`.
- `worker/` — the Worker behind `/api/start` and `/reports`; `migrations/` is its D1 schema.
- `web/` — the browser front end: plain TypeScript and direct DOM, bundled by esbuild.
  `index.html` is the landing page; `play.html` is the game. The map renderer in
  `src/svg.ts` is shared with the command-line one.

## Commands

    npm run dev       # play it in a browser on localhost:5173
    npm test          # 397 tests, including the 1990 manual's p.12 reference state
    npm run typecheck # both configs: Node for src/, DOM for web/
    npm run validate  # score the sim against all 644 measurements
    npm run fixture   # print the reference state as a Production Summary
    npm run map -- Kittycat expert out.svg   # render a generated continent
    npm run play -- Kublai intermediate 20   # watch the turn loop run
    npm run game -- Kittycat intermediate    # play it yourself in the terminal
    npm run soak -- 30 16                    # every level and continent, checking
                                             # invariants on every turn

`npm test` is fast enough to run constantly. `npm run soak` is not — it plays whole
games and takes about twenty minutes — but it has caught defects the unit tests did
not, so it is worth running after touching the economy, the planner or the AI.

The game takes `?continent=`, `?level=`, `?nation=` and `?caps=original` query
parameters, so `localhost:5173/play.html?continent=Kublai&level=expert` skips the start
screen and opens a particular world.

## Deploying

The game itself is static — saves live in `localStorage` — so it is served as files
from the edge. A small Worker (`worker/index.ts`) sits in front of two paths only: the
game posts each start to `/api/start`, which records it in D1, and `/reports` lists
those starts with nation, continent, difficulty, caps and IP address.

    npm run build:site   # assemble site/ : pages, styles, art, minified bundle
    npm run deploy       # assemble, then push it to Cloudflare Workers

`wrangler.jsonc` declares `gb.mitchthefat.com` as a custom domain. The zone is already
on Cloudflare DNS, so the first deploy creates the record and its certificate; there is
nothing to set up in the dashboard. Authenticate once with `npx wrangler login`.

`/reports` expects a Cloudflare Access application covering `gb.mitchthefat.com/reports`,
set up in the Zero Trust dashboard. The Worker refuses any request that did not come
through Access, so until that policy exists the page returns 403.

Schema changes go in `migrations/`, applied with
`npx wrangler d1 migrations apply guns-or-butter --remote` (`--local` for `wrangler dev`).

`site/` is assembled rather than committed: `web/` mixes source and output, and a host
should not be handed `main.ts`.

## Running it

Developed and verified on Node 26.8.2, which `.nvmrc` pins — `nvm use` picks it up.
Node runs the TypeScript directly, with no build step for anything outside `web/`.

Requires Node >= 22.18, the release that made type stripping the default. Below that
`node file.ts` fails with `ERR_UNKNOWN_FILE_EXTENSION`; the old
`--experimental-strip-types` flag is no longer needed and is not used.

Nothing ships at runtime; the dev dependencies are `typescript`, `@types/node`, and
`esbuild` for the browser bundle. `wrangler` is not one of them — `npm run deploy`
fetches it through `npx` on the rare occasions it is wanted.

## License

[MIT](LICENSE) — covers the simulation code and the reconstructed spec in `docs/`.

It does not and cannot cover the source material the spec is derived from: the 1990
game, its manual, and *Chris Crawford on Game Design* all remain the property of their
respective owners. None of them are distributed here; `docs/SOURCES.md` points to them
instead. Short quotations in the spec are there to show the provenance of a claim.
