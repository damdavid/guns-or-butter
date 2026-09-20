# The Global Dilemma: Guns or Butter — Mechanics Specification

A reconstruction of the 1990 Chris Crawford design, written as an implementation
spec for a new game using the same mechanics.

## Provenance

Three primary sources, all in this directory:

| Source | File | What it gives |
|---|---|---|
| Original manual, 30pp | `gb-manual.pdf` / `.txt` | Rules, phase structure, Appendix A (production internals), Appendix B (strategy, with hard numbers), Appendix D "A Weird Appendix" (Crawford's design derivation as a Socratic dialogue) |
| *Chris Crawford on Game Design* (2006), ch. 24 | `crawford-ch24-guns-and-butter.txt` | Retrospective: world generation, economy rationale, combat, postmortem |
| The shipped binary | `../the-global-dilemma-guns-or-butter/G&B.EXE` | Exact commodity names, UI strings, screen labels |

Plus one high-value artifact: the **Production Summary screenshot on manual p.12**,
which is a fully legible snapshot of a real beginner-level game state. Most of the
numeric calibration below is derived from it.

**Confidence key** — used throughout:

- **[C]** Confirmed — stated explicitly in a source, or derived by arithmetic that
  closes exactly against the screenshot.
- **[I]** Inferred — consistent with the sources and arithmetic, but with residual slack.
- **[F]** Free — not recoverable; you must choose and tune. Sensible defaults given.

---

## 1. Game structure

### 1.1 Difficulty levels [C]

| Level | Players | Map | Commodity set |
|---|---|---|---|
| Beginner | 2 | small | 13 commodities; terrain ignored |
| Intermediate | 4 | larger | extended; terrain matters |
| Expert | 8 | largest, up to 64 provinces | full set; adds Economic Union phase |

#### Which commodities, measured [C]

The manual says how many but not which. The readings do: `docs/*.csv` leave a cell blank
wherever a commodity could not be produced at that level, so the blanks name the sets.
`LEVEL_COMMODITIES` in `src/data.ts` holds the result.

| Level | Count | Adds |
|---|---|---|
| Beginner | **12** | Lumber, Sulfur, Iron Ore, Coal, Charcoal, Pig Iron, Gunpowder, Iron, Farm Tools, Iron Plow, Sword, Musket |
| Intermediate | 19 | Light Metal, Nitrate, Low-Grade Steel, Explosives, Steam Engine, Combine, Rifle |
| Expert | 33 | Heavy Metal, Petroleum, High-Grade Steel, High Explosives, Wire, Pipe, Electrics, Ball Bearing, Diesel Engine, Instruments, Irrigation, Tractor, Cannon, Tank |

**Beginner measures 12, where §1.1 says 13.** Either the manual's count is off by one
against what the binary offers, or it counts food among the commodities. The readings are
the better evidence, so 12 is what is implemented.

Each level's set is closed under inputs — every factory it offers can be fed from within
the same level — which is asserted in `test/names.test.ts`.

### 1.2 Turn phases [C]

Strictly sequential; **no going back** once a phase is advanced.

0. **Economic Union** *(Expert only, runs before production)*
1. **Production** — allocate labor across factories
2. **Military Orders** — per province, set the marching fraction and its destination
3. **Military Execution** — friendly transfers resolve first, then battles
4. **Rankings** — standings by population; autosave; `Undo Turn` available *here only*

The autosave is keyed on continent name + level, which is why the shipped game
directory contains `KITTYCAT.B/.I` and `OLMI.B/.I`.

### 1.2.1 Implementation notes [F]

`src/game.ts`. `npm run play -- <continent> <level> <turns>` watches it run;
`npm run game -- <continent> <level> <nation>` plays it in the terminal, with a
production screen laid out after the original's Production Summary on manual p.12.

Phases advance one way only, and input is refused if it belongs to another phase —
the original warned players in the same terms: *"don't ever select Next Phase until
you're certain that you've finished your work in that phase."* `Undo Turn` restores a
snapshot taken at the start of the turn, and is available only at Rankings.

**Combat resolves on the way *into* the execution phase**, not out of it, and
`advance()` returns the turn report there. Execution is then a phase with nothing left
to decide, which is the point: it exists so the marches can be watched. A UI has the
whole report in hand for its entire duration.

**The Economic Union phase runs before production, at Expert only** (`src/union.ts`).
It is phase 0 on every Expert turn including the first, which is the turn a nation most
needs one: none of them can feed itself alone (§10.3). The other levels never enter it,
so `phasesFor(level)` — not a fixed four — is what a UI should build its tracker from.

**The round is taken one declaration at a time.** The weakest nation declares, everyone
still unattached answers, then the next weakest still unattached declares, and so on
until nobody is left to join. `RoundState` carries a round across calls and `runRound`
advances it to the next question or to the end, so a player answers each declaration on
its own rather than committing to the whole turn at once. Leaving a question outstanding
when the phase is advanced counts as declining it — refusing to advance would make the
phase a trap for a player who has stopped caring about diplomacy this turn.

**Nobody learns who else is joining.** The declaration is public; the answers are not.
The candidate list is snapshotted when the declaration is made, so no nation's choice
can be informed by another's, and a union's membership is a surprise to its own members
until it forms. A UI that previewed a likely roster would hand the player the one thing
the rule says nobody has.

**A declaring player may name any other nation.** The AI picks its worst enemy by `W`
(§6.4); a person is offered all of them, worst regarded first.

**Population lives on provinces, but the economy works on nation totals.** Food surplus
is resolved per nation and then pushed back down to the provinces, because conquest
moves provinces between nations and the two views have to be reconciled every turn.

**Growth settles in proportion to farmland; famine takes people in proportion to
population [F].** Taking a province cuts it to what its farmland feeds (§5.7), leaving
it near one person per acre where the rest of the nation sits at about 1.49. Sharing
growth out by population held that gap open forever — every province grew by the same
*percentage*, so the conquered one stayed exactly as far behind as the day it fell, and
the absolute gap widened as the nation grew. By farmland it takes the same absolute
share as any equally fertile province, so a food surplus is what repairs a conquest.
Famine keeps to population because hunger kills where the people are, and a loss shared
by acreage would ask a province to give up people it does not have.

Note what this converges to. Every acre gains the same number of people, so the
*absolute* density gap is preserved and the *ratio* closes: measured on Kittycat, a
province cut to 1.00 people per acre against a nation at 1.49 improves from a ratio of
1.49 to 1.30 over seven turns and then holds there once the surplus runs out. It
recovers in proportion and never quite in density. Filling the emptiest land first would
reach parity instead; it is not what is built.

**Labour is stored as fractions, not worker counts** — matching the original's sliders,
and necessary because the workforce changes size every turn as population moves.

#### An unbalanced allocation produces nothing, not merely less

Worth knowing before building an AI, and the clearest demonstration of §3.5 in motion.
A plausible opening split — a fifth of the workforce each into lumber, iron ore,
charcoal, pig iron and farm tools — left **farm tools at zero output for fifteen
consecutive turns**, while the nation starved from 484 people down to an equilibrium at
bare farmland yield.

Nothing was broken. Charcoal sits at depth 1 and farm tools at depth 3, so under the
priority rule charcoal claimed *every ton of lumber* before the tool factory saw any.
Demand is proportional to capacity, so charcoal's claim did not shrink to match what it
could use.

`balanceAllocation` implements the manual's own remedy — follow the limiting factor from
the throttled factory to its missing input, and move labour there — and turns the same
opening into steady growth: 484 people to 580 over twelve turns, farm tools 204 to 336
tons. It is scaffolding for the loop and a building block for the AI, not the AI.

### 1.3 Victory [C]

Conquer the world. The running measure of standing is **population**, not territory
or military strength.

---

## 2. World generation

The continent **name is the RNG seed** [C] — Crawford's solution to reproducing
buggy worlds during development. Keep this; it is free replayability and free
bug reports.

Algorithm [C]:

1. Place province capitals at random. Constraints: not too near the map edge, not
   too near each other. Up to 64 cities.
2. Connect cities with **spokes**. Ideal objective is minimum total spoke length;
   Crawford found the exact solve intractable at 64 cities and used a heuristic.
   [F] — any reasonable planar connection (e.g. Delaunay, then prune) will do.
3. **Provinces are the dual of the spoke graph**: connect the midpoints of the
   spokes to form each province's border.
4. Wiggle the border polylines with random X/Y offsets as you draw, to kill the
   polygonal look.
5. **Mark roughly half the spokes as roads** [C]. The rest are plain borders.
6. Terrain: define polygons *straddling* the **road-less** borders, then spatter them
   with small mountain / forest / desert icons. The random icon placement hides the
   geometric shape of the underlying polygon.

**Spokes are adjacency; roads are a ~50% subset of them** [C]. The two are not the
same graph. From the design dialogue:

> "Should every pair of adjacent provinces be connected by roads?"
> "Surely we can do better than that. Let's say that, oh, only half of the adjacent
> provinces are connected by roads. The others will have no connections other than
> the simple adjacency."

Every pair of provinces sharing a spoke is adjacent and mutually attackable. Only
about half of those crossings are roads; the other half carry the terrain penalty
(§5.5). Store the road flag **per edge**, not per province.

Crawford's own regret: continents came out "a little too conservative — always boxy
and simple," and generation was slow. Worth more variety in step 1.

### 2.0 Implementation notes [F]

Built in `src/worldgen.ts`, with the geometry in `src/delaunay.ts`. Render one with
`npm run map -- <continent> <level>`; map generation is the step where looking at the
output tells you far more than a passing test does.

**Delaunay stands in for the minimum-length spoke heuristic.** Crawford wanted to
"minimize the total lengths of all spokes" and found the exact solve intractable at 64
cities. Delaunay is planar, contains the Euclidean minimum spanning tree, and — the
part that matters — its dual tiles, which is what makes step 3 possible at all.

**Provinces use the centroid dual.** Walking a capital's incident triangles and stepping
*midpoint of spoke → triangle centroid → midpoint of spoke* honours the spec's "connect
the midpoints of the spokes" while still tiling; midpoints alone would leave a gap at
every triangle. The fan must be walked by connectivity, not sorted by angle: angular
sorting looks equivalent but degenerates on boundary capitals and produces provinces
that cross the map.

**Coastal cells are handled with offshore capitals.** A capital on the convex hull has
an unbounded dual cell. Two attempts to close one directly — through the capital, then
by running the open ends outward — produced slivers and then map-spanning wedges.
Instead, capitals are sown across the whole map and only those inside the coastline
become provinces; the rest stay at sea, where they bound the coastal cells and give the
continent its irregular edge. They take no part in adjacency.

Their spacing is a genuine tug-of-war. Too fine and the sea points crowd land capitals
out of each other's Delaunay neighbourhood, severing adjacency — at 9 units against
~100-unit land spacing, one beginner world left 15 of 16 provinces unreachable. Too
sparse, or confined to a coastal band, and a province with open water beyond it runs to
the map border and is cut flat there. They are now spaced like the land capitals and
cover the whole ocean, with a repair pass that joins any stranded peninsula to its
nearest neighbour rather than relying on the tuning holding.

**The continent is a union of overlapping lobes, not a radial outline.** A first version
used `r(theta) = 1 + harmonics`, which is star-shaped by construction: one radius per
bearing, so it can wobble but can never reach a peninsula out past a bay beside it.
Three to five lobes, each hung off an earlier one, give isthmuses where two barely meet
and peninsulas where one hangs off the edge. Measured raggedness — perimeter squared
over `4 * pi * area`, where a circle is 1.0 — runs 1.7 to 3.1, against about 1.3 for the
radial version. The lobes are recentred and shrunk to fit the map before use, and the
mask is then held fixed: growing it to reach the target province count pushed the coast
past the map border on 13 worlds in 30.

**The coastline is traced from the provinces**, by chaining the border edges that have
only one province on them, rather than being the mask they were cut from. The shoreline
drawn is therefore exactly where the provinces end.

**Wiggle before clipping**, and displace shared vertices consistently via a lookup keyed
on position — otherwise neighbouring provinces part company along every border, and
wiggling after the clip pushes vertices back outside the map.

**Terrain is drawn, not just counted.** Marks are scattered in a band straddling each
road-less border — the same border the acreage comes from — so the picture and the
economy agree. Each type differs in silhouette as well as hue, because at map scale
shape carries more than colour: a grey triangle beside a green one reads as the same
object. Deserts additionally need fewer, larger marks; at the density that suits peaks
and trees, dune shapes overlap into an indistinct mass.

Calibrated against the 11 nations in the measurement CSVs:

| Quantity | Observed | Generator |
|---|---|---|
| Provinces per nation | 5–11, mean 8.2 | 8, drifting 7–9 |
| Farmland per province | 34–58 acres | 42 mean, scaled by drawn area |
| Other terrain per province | ~7.2 acres | 7.2 mean |
| Starting population | **1.4933 × farmland**, sd 0.0021 | same, exactly |

That population relationship is the tightest thing in the whole dataset — 11 nations
agreeing to three decimal places — so starting population is derived from farmland
rather than generated independently.

Terrain is placed on the road-less borders and **straddles** them, so both provinces
share the acreage, and its type is drawn from regional seeds rather than per-edge. The
measured nations cluster hard — continent Six holds 74 mountain acres and no forest at
all — which an even sprinkle would not reproduce.

Still free, and worth revisiting: Crawford wanted more varied coastlines than his own
generator produced, and clipping to a rectangle is if anything boxier. Islands and lakes
were cut from the original and are not modelled.

### 2.1 Terrain → resources [C]

| Terrain | Provides |
|---|---|
| Farmland | acreage (drives food, see §4) |
| Forest | Lumber |
| Mountains | Iron Ore, Coal, Light Metal, Heavy Metal |
| Desert | Sulfur, Nitrate, Petroleum |

**Terrain never blocks a road** [C] — the generation order makes that impossible.
Roads are chosen first (step 5), and terrain is then placed *into the gaps*:

> "Ooh, ooh, we can put the forests, mountains, and deserts into those places where
> there aren't roads!"
> "Capital idea, my man! Yes, let's! And that suggests another simple idea: attacks
> down roads are easier than attacks across borders without roads."

So terrain's position is *defined by* road absence, rather than competing with it.
Terrain and roads are complementary by construction, and no terrain type is
impassable — see §5.5 for what that costs an attacker.

Critically: lacking a terrain type does **not** block the commodity — it raises the
labor cost of producing it [C]: *"you can still get these things even if you have no
deserts, no mountains, and no forests, but it will cost you a lot more workers to get
the same amount of stuff."*

Each province carries **a fixed endowment of each basic resource**, and a nation's
base is the plain sum over its provinces [C]:

> "each province provided a fixed amount of each basic resource. The player's overall
> resource base was simply the sum of the resource bases of each province in the
> country."

The design also promises a **modicum for everyone**, independent of terrain — an
explicit decision so that a badly-seeded start is not unwinnable:

> "we must not take it so far that a particularly unfortunate mortal would never be
> able to get his economy started ... Let us provide a modicum of natural resources to
> each mortal, augmented by a bounteous supply for those blessed with the proper
> terrain."

Measurement locates that modicum precisely (§3.4): it is the **intercept** of a linear
response, not a `max()` floor, and it is real only for the early-tier raws.

    capacity_raw = (base + m * acres) * L^a       in that raw's own terrain

**Terrain affects only the raws, but difficulty level affects everything.** Each raw
responds to one terrain type and nothing else — a nation with 74 mountain acres and no
forest produces exactly as much lumber as one with no mountains at all. Intermediates,
tools and weapons take no terrain term, but their coefficients *do* vary by difficulty
level, which an earlier draft of this section denied. Farmland is separate again: it
feeds acreage into §4, not into this response.

### 2.2 Terrain magnitude — measured

**No source gives a per-acre coefficient.** The manual says only "a lot more workers,"
ch24 says only "a fixed amount," and the design dialogue says only "a modicum ...
augmented by a bounteous supply." Every number below is measured, not recovered.

This section establishes the *shape* of the terrain response from Lumber alone. §3.4
supersedes it on magnitudes: each raw turns out to have its own response, so the
per-commodity parameters there are the ones to implement.

**Terrain scales productivity and never caps output** [C]. In an Intermediate game,
Lumber's `Limiting Factor` reads `Labor` at *every* worker allocation, however far it
is pushed.

Two consequences follow, both load-bearing:

- **Raws are always `Labor`-limited.** They have no commodity inputs, and terrain
  cannot cap them, so no other limiting factor is reachable. Implement the
  `Limiting Factor` column accordingly — for the eight raws it is a constant.
- **Nothing in the industrial economy has a hard cap.** The only ceiling anywhere in
  the game is agricultural: tools usable per acre (§4.2). Land constrains food; land
  never constrains industry, which is bounded by labour alone. So conquering a
  mountain province buys you *efficiency*, never *access* — a resource-poor nation can
  still build tanks, just wastefully. This sharpens the design's central thesis
  (population is the only real resource) and it makes the runaway-leader problem in
  §9.2 worse, since a large nation is never locked out of any commodity. Worth keeping
  in mind if you add a counterweight there.

#### Measured: forest → Lumber [C]

Twenty-seven readings across all three levels, with full land composition and province
counts. Refit any time with `docs/calibrate.py`; the sim asserts against them in
`test/fixture.test.ts`.

| Level | Continent | Prov | Farm | Mtn | Forest | Desert | L=10 | L=25 |
|---|---|---|---|---|---|---|---|---|
| Beginner | One | 9 | 372 | 0 | 0 | 34 | 87 | 244 |
| Beginner | trebolokhan *(1990 manual)* | — | 309 | — | — | — | — | 268 @ L=27 |
| Intermediate | One | 6 | 208 | 0 | 0 | 19 | 29 | 81 |
| Intermediate | Six | 9 | 523 | 74 | 0 | 14 | 29 | 81 |
| Intermediate | Four | 8 | 351 | 0 | 9 | 37 | 39 | 111 |
| Intermediate | Seven | 5 | 238 | 32 | 17 | 6 | 51 | 144 |
| Intermediate | Two | 8 | 320 | 0 | 26 | 32 | 65 | 185 |
| Intermediate | Five | 9 | 433 | 0 | 50 | 3 | 101 | 288 |
| Expert | Eleven | 6 | 204 | 38 | 0 | 0 | 10 | 29 |
| Expert | Three | 8 | 363 | 0 | 8 | 42 | 21 | 58 |
| Expert | Four | 9 | 291 | 22 | 9 | 20 | 21 | 58 |
| Expert | Two | 10 | 382 | 35 | 20 | 12 | 37 | 103 |
| Expert | Five | 11 | 422 | 66 | 35 | 3 | 56 | 160 |
| Expert | One | 10 | 360 | 48 | 44 | 0 | 72 | 201 |

#### The model

    y = C / L^1.1344 = max(floor_level, base_level + m_level * acres)

| Level | Players | `base` | `m` per acre | `floor` |
|---|---|---|---|---|
| Beginner | 2 | 6.3626 | n/a — terrain ignored | 6.3626 |
| Intermediate | 4 | 1.8607 | 0.1117 | 2.1148 |
| Expert | 8 | 0.6342 | 0.1030 | 0.7431 |

Joint least-squares over all 27 readings: **`a = 1.1344`, rmse 1.18 tons**.

#### Nation size does not drive the base [C]

The decisive comparison, and the reason this question is now closed. Two Intermediate
nations, both with **zero forest**:

| Continent | Provinces | Farmland | Mountain | Desert | L=10 | L=25 |
|---|---|---|---|---|---|---|
| One | 6 | 208 | 0 | 19 | 29 | 81 |
| Six | 9 | 523 | 74 | 14 | 29 | 81 |

**Identical output** across 1.5× the provinces and 2.5× the farmland. So `base` and
`floor` are set by difficulty level, not by how big the nation is. The same pair also
shows **mountain and desert acreage do not leak into Lumber** — 74 mountain acres buy
nothing. Each raw responds only to its own terrain.

#### Superseded: the floor and its player-count scaling

This section previously reported a zero-acre floor scaling as `18.4461 * N^-1.549`
across all three levels, fitted to within 2%. **Both the floor and that scaling were
artifacts of thin data.** With five worker points per series rather than two, a plain
line fits from zero acres upward and no `max()` is needed; and with each raw fitted
separately, the per-level coefficients do not share a single exponent in player count.

What survives: coefficients do fall steeply with difficulty level — for Lumber the
ratio is close to 3 per level step — and the intercept is non-zero for the early-tier
raws, which is the "modicum" the design dialogue promises. §3.4 has the measured
values. The episode is recorded here because it is the second conclusion in this
document that better data overturned, and the pattern is worth distrusting: anything
fitted from two or three points here has been wrong about as often as right.

#### The exponent conflict is resolved [C]

An earlier draft recorded a genuine conflict: Beginner readings appeared to want
`a = 1.1098` while Intermediate/Expert wanted ~1.128. **It was a misread.** Beginner
continent One at L=10 was first reported as 89 and re-read as **87**:

    a from (89 @ 10, 268 @ 27) = 1.1098    <- the outlier
    a from (87 @ 10, 268 @ 27) = 1.1327    <- agrees with everything else

All 13 same-continent worker pairs now agree, inverse-variance weighted mean
**1.1334**, joint fit **1.1344**. One exponent fits every level. The calibration
override seam added to work around the conflict remains in `Economy` — it is still
useful for the 25 placeholder industries — but nothing depends on it now.

#### Still open

1. **Do mountains and deserts share forest's response?** Untested. Repeat against Iron
   Ore or Coal, and against Sulfur. The land composition is now recorded for every
   reading, so this needs only the output figures.
2. **Is `a ≈ 1.1344` specific to Lumber?** Only Lumber is measured. A two-worker-count
   reading on one intermediate and one tool tier would test whether the per-class rules
   in §3.4 hold, and is the highest-value measurement left.
3. **Residual Expert scatter** of up to ~3.4 tons remains, consistent with ±1 acre of
   acreage-reading error — continents Three (8 acres) and Four (9 acres) still return
   byte-identical output, which one acre should not permit.

---

## 3. The economy

### 3.1 Founding simplifications [C]

These are deliberate and load-bearing. Do not "fix" them casually.

- **No capital.** Only land and labor. Justification: a turn is a generation, so
  capital fully depreciates each turn.
- **No stockpiles.** Unused output is discarded at end of turn — "use it or lose it."
- **No money and no trade.** Crawford built a complete trade subsystem and cut it
  two months before ship because it worked but wasn't fun.
- **The player's only lever is the fraction of the workforce assigned to each factory.**

#### 3.1.1 The principle behind them: a turn is a generation [C]

"A turn is a generation, so capital fully depreciates each turn" is given above as the
justification for having no capital, but it is the more general rule and it settles
questions well outside §3. **Nothing carries from one turn to the next except land,
population and territory.** There is no stored state for a nation to draw on, anywhere.

It decides three questions that otherwise look like free choices:

| Question | Answer it forces | Where |
| --- | --- | --- |
| What happens to unused commodity output? | Discarded. | §3.1 |
| Does firepower accumulate, or is it what you built this turn? | A flow, not a stock. | §5.3.1 |
| Is the famine floor a remembered starting population, or a function of farmland? | Farmland. A remembered figure would be exactly the carried-over state the design excludes. | §4.4.1 |

Reach for this first when a mechanic seems to need memory. The answer is almost always
that it does not have any.

### 3.2 Commodity set [C — names lifted from the binary]

**Raw** (terrain-gated): Lumber, Sulfur, Iron Ore, Coal, Light Metal, Nitrate, Heavy Metal, Petroleum

**Intermediate**: Charcoal, Pig Iron, Gunpowder, Iron, Low-Grade Steel, Explosives,
High-Grade Steel, High Explosives, Wire, Pipe, Electrics, Ball Bearing, Steam Engine,
Diesel Engine, Instruments

**Agricultural tiers** (1→5): Farm Tools, Iron Plow, Combine, Irrigation, Tractor

**Weapon tiers** (1→5): Sword, Musket, Rifle, Cannon, Tank

**Sinks**: Food → population; Firepower → military strength

The beginner set, in the game's own display order [C]:

    Lumber, Sulfur, Iron Ore, Coal, Charcoal, Pig Iron, Gunpowder,
    Iron, Farm Tools, Iron Plow, Food, Sword, Musket

**Display order is *not* a strict dependency order** [I]. Annotating the beginner list
with each commodity's depth in the confirmed graph gives
`0,0,0,0,1,2,2,1,3,2,–,3,3` — Iron (depth 1) is listed after Gunpowder (depth 2), and
Iron Plow (2) after Farm Tools (3). So the display groups commodities thematically
(raws, then the pre-industrial branch, then the industrial branch, then tools, then
weapons) rather than strictly by complexity.

Since the priority rule (§3.5) is explicitly about complexity, **resolve allocation in
topological order, not display order** — see §8.4 for a validated ordering. Whether
the original did the same is worth one in-game check: starve lumber and see whether
Iron or Gunpowder gives way first.

### 3.3 Production graph

Confirmed recipes:

| Output | Inputs |
|---|---|
| Charcoal | 1.0 Lumber |
| Pig Iron | 0.25 Charcoal + 0.95 Iron Ore |
| Gunpowder | 0.25 Sulfur + 0.5 Charcoal |
| Iron | 1.0 Iron Ore + 0.5 Coal |
| Low-Grade Steel | 0.8 Iron Ore + 0.25 Light Metal + 0.8 Coal |
| Explosives | 0.25 Sulfur + 0.5 Charcoal + 0.25 Nitrate |
| High-Grade Steel | 0.75 Iron Ore + 0.15 Light Metal + 0.75 Coal |
| High Explosives | 0.25 Sulfur + 0.5 Petroleum + 0.25 Nitrate |
| Steam Engine | 0.5 Low-Grade Steel + 0.5 Coal |
| Wire | 1.0 Light Metal |
| Pipe | 1.0 Heavy Metal |
| Electrics | 0.5 Heavy Metal + 0.5 Wire |
| Ball Bearing | 0.6 High-Grade Steel + 0.4 Heavy Metal |
| Diesel Engine | 0.5 Petroleum + 0.4 High-Grade Steel + 0.1 Electrics + 0.1 Ball Bearing |
| Instruments | 0.5 Electrics + 0.5 Ball Bearing |
| Farm Tools | 0.5 Lumber + 0.5 Pig Iron |
| Iron Plow | 0.5 Iron + 0.5 Lumber |
| Combine | 0.5 Steam Engine + 0.5 Iron |
| Irrigation | 0.75 Pipe + 0.25 Electrics |
| Tractor | 0.75 Diesel Engine + 0.25 Low-Grade Steel |
| Sword | 1.0 Pig Iron |
| Musket | 0.5 Iron + 0.5 Gunpowder |
| Rifle | 0.5 Low-Grade Steel + 0.5 Explosives |
| Cannon | 0.5 Low-Grade Steel + 0.5 High Explosives |
| Tank | 0.4 High-Grade Steel + 0.25 High Explosives + 0.25 Diesel Engine + 0.125 Instruments |

### 3.4 The productivity function — the core of the design

    capacity_i = k_i * L_i ^ a_i

where `L_i` is workers assigned to industry `i`. **Superlinear in labor** — this is
the economies-of-scale engine, and Crawford calls it the foundation of the entire
game [C]. The manual's player-facing statement: *"If you double the workers, the
capacity more than doubles. THIS IS IMPORTANT!!!! ... The entire game turns on this
simple fact."*

Parameter rule [C]:

> "The more advanced industries must have **smaller proportionality constants and
> larger exponents** so that they are less efficient at smaller scales and more
> efficient at larger scales."

So `k` decreases and `a` increases as you move up the chain. This is what ties tech
progression to population growth *without a research tree* — you cannot use an
advanced industry until you are big enough to feed it labor. Crawford's phrasing:
without this "we would have 15th century peasants building digital watches."

#### Every exponent is now measured [C]

644 output readings — 297 across 53 raw series carrying land composition, 347 across 22
intermediate/tool/weapon series — covering all three levels. All 644 are scored; nothing
is excluded. Fitted by `docs/calibrate.py`, which emits
`src/calibration.ts`; scored by `npm run validate`.

    capacity = K * L^a        both K and a measured per (commodity, level)

**The exponent is per-commodity and spans 1.13 to 2.53.** An earlier draft assigned
1.10 to every raw and derived the rest from a depth rule. That was wrong in kind, not
just in value — the real structure is a tight ladder:

| a | Commodities |
|---|---|
| 1.126–1.134 | Farm Tools, Sword, Pig Iron, Charcoal, Lumber, Iron Ore |
| 1.39–1.42 | Gunpowder, Musket, Iron Plow |
| 1.62–1.73 | Steam Engine, Iron, Rifle, Sulfur, Explosives, Coal |
| 1.77–2.03 | Combine, Low-Grade Steel, Light Metal, Irrigation, Heavy Metal, Wire, Pipe |
| 2.07–2.25 | Electrics, Cannon, Nitrate, High Explosives, Instruments, Tank, Ball Bearing |
| 2.35–2.53 | Tractor, High-Grade Steel, Diesel Engine |

This is Crawford's rule made visible — *"smaller proportionality constants and larger
exponents so that they are less efficient at smaller scales and more efficient at
larger scales"* — and it holds monotonically across both the tool and weapon tiers. A
tractor factory is near-useless small and dominant large; that is what forces
technology to follow population.

**Farm Tools and Sword share parameters exactly** (a = 1.1264, identical k at every
level), as do Pig Iron and Iron Ore. Tier-1 butter and tier-1 guns are an exactly even
labour trade, which for a game with this title reads as deliberate.

#### Parameters vary by level, for every commodity

Not just raws. Charcoal's coefficient falls from 6.49 (Beginner) to 4.71
(Intermediate) to 2.90 (Expert), and it has no terrain input at all. **The per-level
ratio is not shared across commodities** — Steam Engine's Intermediate/Expert ratio is
6.4 where Charcoal's is 1.6 — so a single level multiplier does not work. It was tried
and left p90 error at 37%; parameters are now stored per (commodity, level).

#### Raws: per-commodity terrain response, and no floor

    capacity_raw = (base + m * acres) * L^a       in that raw's own terrain

Three corrections to earlier drafts, all forced by the larger dataset:

- **The response is not shared across raws.** Coal gains far more per mountain acre,
  relative to its own base, than Iron Ore does. Each raw needs its own `base` and `m`.
- **There is no `max()` floor.** The floor was inferred from three points; with five
  points per series a plain line fits, and the non-zero intercept *is* the design
  dialogue's "modicum of natural resources." Simpler, and closer to the text.
- **Every raw keeps a small positive intercept.** An earlier revision reported the
  advanced raws as having a zero intercept, but that was an artifact of least squares
  driving `base` negative and the emitter clamping it. Petroleum's zero-desert reading —
  4 tons at 160 workers — proves otherwise. The response is now fitted in **relative**
  error, which both stops the clamping and stops the largest reading in a series from
  setting both parameters on its own, since a raw's outputs span three orders of
  magnitude within one level. So the modicum applies to all eight raws, exactly as the
  manual describes: *"you can still get these things ... but it will cost you a lot more
  workers."*
- **Levels a raw was never sampled at are projected from its terrain siblings.**
  Petroleum is observed only at Expert and Heavy Metal likewise; without projection they
  would inherit Expert parameters at Beginner, where Sulfur's base is 46× larger. The
  projection takes the geometric-mean per-level ratio across raws sharing that terrain,
  and sets `m = 0` at Beginner since terrain is ignored there. Projected entries are
  marked as such in `src/calibration.ts`.

#### Accuracy

Relative error across all 644 readings, stratified because outputs are
displayed as integers and a reading of 3 carries ±17% of rounding on its own:

| Observed output | n | median | p90 | worst |
|---|---|---|---|---|
| < 10 | 60 | 10.4% | 37% | 75% |
| 10–50 | 126 | 4.5% | 20% | 62% |
| 50–200 | 198 | 2.6% | 14% | 62% |
| ≥ 200 | 260 | **1.2%** | 7.4% | 47% |

Error falls monotonically with magnitude, which is the signature of rounding-bound
measurement rather than model error. The values that matter for gameplay are good to
about 1%.

#### Known data problems

- **Continent Seven's Iron Ore was wrong and has been re-read.** The original series
  fitted an exponent of 1.65 where every other Iron Ore series gave ~1.13, and it broke
  monotonicity in mountain acreage — 32 acres yielded less than 0 acres did elsewhere.
  Both were correct diagnoses: the re-read replaced it, and Iron Ore's exponent spread
  across eleven series fell from sd 0.1495 to 0.0096, its Intermediate terrain fit from
  23.7% to 2.1% max error, and its worst single prediction from 181.7% to 9.9%. Nothing
  is excluded from the fit any more, though `EXCLUDE` remains in `calibrate.py` as a
  named empty set so the next bad series is a one-line change.
- **Petroleum is the sparsest series**: seven non-zero readings across four continents,
  and its longest single series has only three points. Its exponent rests on that one
  series and its Beginner and Intermediate parameters are projected, not measured.
  Relative-error fitting cut its worst prediction from 267% to 62%. Extrapolating its
  *exponent* from the Sulfur → Nitrate step was tried and rejected: that gives 2.5625
  against a measured 2.2324 and roughly doubles the error, because the one long series
  constrains the exponent well even though it constrains little else. The extrapolated
  *slope* (0.000018) and the relative-error fit (0.000015) agree, which is the one place
  the sibling-scaling idea corroborated the direct fit. It is also the only commodity for which
  the fitter's point thresholds mattered: an earlier revision required four points per
  series to fit an exponent, which silently dropped Petroleum, zeroed its capacity, and
  through it killed High Explosives, Diesel Engine, Cannon, Tank and Tractor. The
  exponent now needs three points but the coefficient needs only one, since `a` pinned
  makes every individual reading a `k` estimate. Two coverage tests in
  `test/economy.test.ts` now assert that no commodity can lose its parameters.
- **Acreage is good to about ±1 acre**, which dominates the error on small-acreage
  nations. Continents Three (8 acres) and Four (9 acres) return byte-identical output,
  which one acre should not permit.

### 3.5 Allocation: demand-driven, and deliberately dumb [C]

This is the part players find infuriating, and it is intentional. Appendix A:

1. **Each factory demands inputs proportional to its full capacity**, not to what it
   can actually make.
2. **A factory does not release inputs it cannot use.** A farm tools factory with
   capacity 100 demands 50 lumber and 50 pig iron. Given 50 pig iron but only 40
   lumber, it is capped at 80 output — and it *still holds all 50 pig iron*.
3. **Contention resolves by priority to the simpler factory**, i.e. the one lower in
   the production sequence. Rationale: its failure ripples further. If lumber all
   went to farm tools, charcoal would fail, so pig iron would fail, so farm tools
   would fail anyway.

Resolution order: walk commodities in topological order, shallowest first (§8.4);
each factory takes what it demands from available supply until exhausted.

Report per commodity: **output**, **surplus** (may be negative), **limiting factor**
(the input that capped it, or `Labor`), **workers**.

For the eight raws the limiting factor is **always `Labor`** — confirmed in-game
(§2.2). They take no commodity inputs, and the terrain endowment scales productivity
rather than capping output, so nothing else can ever bind.

### 3.6 The worker redistribution algorithm [C]

The player moves one slider, and everything else shifts:

- Setting a factory's labor fraction pulls workers **from all other factories,
  pro rata**.
- Reducing a factory's allocation distributes the freed workers **to all others,
  pro rata**.
- Consequence, called out in the manual as a trap: dumping all workers into one
  factory **wipes out every other allocation**.
- **Worker Lock** — a per-factory checkbox pins an allocation against both the
  player and the redistribution algorithm. Also togglable from the summary screen
  by clicking the worker count.
- Agricultural labor is **not adjustable** (see §4.1).

I would keep the pro-rata mechanic but make the redistribution *previewable* before
commit. Crawford himself concedes it is "mysterious and confusing"; the confusion is
mostly a UI failure, not a mechanical one.

#### Implementation notes [F]

`reallocate()` in `src/game.ts`, exercised by `set` and `lock` in `npm run game`.

The trap the manual warns about is not special-cased — it falls straight out of the
arithmetic. Setting one factory to the whole workforce scales every unlocked other by
`(othersSum - delta) / othersSum`, which is exactly zero, so they are all wiped at once.

The total is preserved, so an allocation that starts fully committed stays that way.
Only unlocked labour is available to draw on, which means a heavily locked economy
simply cannot feed the factory being dragged — that is the point of the lock, and the
clamp is what makes it real rather than advisory.

**Locks survive an undo**, though the rest of the turn does not. They are a standing
instruction about which allocations to protect rather than a move taken this turn, and
dropping them on undo would defeat the purpose. They are saved with the game.

`balanceAllocation` honours them too: it will neither top up a pinned factory nor raid
one, so the auto-balance works around whatever the player has protected.

`lockAll` pins **every** factory, unstaffed ones included. Pinning only the staffed
ones was tried first, reasoning that a new industry should stay startable, and it is the
wrong default: it leaves every idle factory free to be raised, and raising one drains
the unlocked economy behind the player's back. Locking everything and then releasing the
two you mean to tune is the predictable workflow, and it makes "all" mean all. With
nothing unlocked, a change has nothing to draw on and is correctly refused.

Narrowing the pool is the sharp edge. Unlock a single commodity out of an otherwise
pinned economy and it becomes the sole donor, so a modest change empties it and
cascades into whatever it fed.

**Idle labour is drawn on before any factory is raided.** The original has no idle
pool — every worker is always somewhere — but allowing an allocation to sum to less
than one means labour can be left spare, and it must remain reachable. Without this a
player with everything locked and workers standing around is simply refused, which was
reported from play.

**Feedback has to outlive the redraw.** The terminal game reprints the whole screen on
every input, so anything logged when a command is handled scrolls off the top before it
can be read. A rejected command therefore looked exactly like a command that had
silently done nothing — a mistyped commodity name was reported once and then buried,
and read as the allocation being stuck. Messages are now held and printed under the
screen, immediately above the prompt. This is a small instance of Crawford's own
complaint in §9.3: the economy was opaque, and players could not see why it was not
doing what they asked.

**Worker counts use largest-remainder rounding.** Flooring each factory independently
loses up to one worker per factory and reports the dust as idle, which is worse than
merely inaccurate: the screen offers labour that cannot be spent, because in fraction
terms the allocation is already fully committed.

---

## 4. Agriculture and population

The cleanest-derived part of the model — every number below closes exactly against
the screenshot (§8.1).

### 4.1 Labor [C]

Agricultural labor is **frozen at exactly 1 worker per acre** of farmland. The
player cannot adjust it. Justification from the design dialogue: workers-per-acre was
empirically stable across most of real agricultural history, so freezing it removes
a degree of freedom at little cost in realism.

### 4.2 Yield [C]

    food = acres * base_yield + tool_yield_per_ton * min(tons_of_tool, acres)

- Base yield: **1.0 ton per acre** with no tools. (An earlier draft wrote this formula
  with the tool term inside the parenthesis, which is dimensionally wrong — it
  multiplies tonnage by acreage. Caught while implementing.)
- **Tool usage is capped at 1 ton per acre.** Tools beyond that are pure waste and
  show up as surplus. Appendix B: *"If you have 300 acres of farmland and you are
  making 500 tons of iron plows, then you are wasting 200 tons."*
- Tier-1 (Farm Tools) yields **+1.0 ton of food per ton of tool**. So fully-tooled
  tier-1 farmland produces exactly 2.0 tons/acre.

### 4.3 Tool tiers [C]

Each successive tier is **exactly 2× as productive per ton**; production cost also
rises geometrically but at a **lower** rate, so advancing is a genuine efficiency gain.

| Tier | Tool | Food per ton |
|---|---|---|
| 1 | Farm Tools | 1.0 |
| 2 | Iron Plow | 2.0 |
| 3 | Combine | 4.0 |
| 4 | Irrigation | 8.0 |
| 5 | Tractor | 16.0 |

**Combine sits at tier 3, ahead of Irrigation** — corrected from the confirmed recipes
(§3.3), which had the two the other way round in an earlier draft. Three things agree
on this ordering: the recipes escalate by engine sophistication (Combine ← Steam
Engine, Irrigation ← Electrics, Tractor ← Diesel Engine); the design dialogue
introduces the steam-driven combine specifically to fill the *mid*-Industrial-
Revolution gap, calling farm tools and the iron plow pre-IR and irrigation and the
tractor post-IR; and it is the order the recipe list came back in from the game.

**Crossover is at 342 tons** [C]: producing 342 tons of any tier should be exactly as
productive as producing 171 tons of the next. Use this to solve `k` for the tool
industries. Appendix B warns the crossover shifts with your terrain mix.

### 4.4 Population [C]

- Food requirement: **1.0 ton per person per year** is break-even.
- Surplus drives growth; deficit drives decline.
- Growth is a **square root** of surplus — explicitly chosen as a diminishing-returns
  function, because *"we can't have them doubling their population merely by doubling
  their food surplus."*
- Severe decline sets in around **0.5 tons per person**; between 0.5 and 1.0 the
  decline is intentionally gentle.
- Boundary condition used for initial balance [C]: if a nation puts *all* labor into
  tier-1 agriculture, that should produce enough food for roughly **30% growth**.

Form, now measured from 29 readings (§4.4.1):

    surplus = food - population
    floor   = 1.4933 * farmland
    if surplus >= 0: population += 0.4727 * surplus / (1 + surplus / (2.0242 * population))
    else:            population  = max(min(floor, population),
                                       population - 0.6971 * -surplus)

**The square root is not what the game does.** Growth is *linear* in surplus; the
diminishing return the manual insists on comes from the saturating denominator instead.
Doubling a surplus of 0.34 per head multiplies the gain by 1.75 — less than the 2 Crawford
wanted to avoid, more than the 1.41 a square root would give. The stated intent is
honoured; the stated mechanism is not.

**Famine has a floor.** A nation sitting on `1.4933 * farmland` people loses nobody at
all, to deficits as deep as 207 tons. That constant is worldgen's measured
population-to-farmland ratio — which is to say, a nation cannot be starved below where it
started, unless it loses the farmland itself.

**The 30% boundary condition above does not survive.** Population starts at
`1.4933 * farmland`, and tier-1 tools cap food at `2 * farmland`, so an all-labour tier-1
start has a surplus of `0.5067 * farmland` on `1.4933 * farmland` people — which the
measured response turns into **14.5% growth, not 30%**. Two readings confirm it directly:
628 people with a 214-ton surplus (food 842, the tier-1 ceiling for 421 acres) grew to
719. The 30% is design intent the shipped game missed, which puts it alongside §6.3 and
§9.

#### 4.4.1 The population readings [C]

29 readings from the DOS build, at Beginner and Intermediate, spanning populations 628 to
1316 and surpluses from -304 to +686. Held in `test/economy.test.ts` as the oracle for
every constant in `POPULATION`.

| Parameter | Value | Accuracy against the readings |
| --- | --- | --- |
| `growth` | 0.4727 | median 4.7%, worst 9.7% (16 readings) |
| `saturation` | 2.0242 | fitted, and close enough to 2 to look hand-typed |
| `decline` | 0.6971 | median 0.0%, worst 6.6% (7 readings) |
| `floorPerAcre` | 1.4933 | 6 readings sit exactly on it and lose nobody |

##### How the form was chosen

Seven structural candidates were fitted. What the readings rule out:

| Form | median | worst | Verdict |
| --- | --- | --- | --- |
| `a*surplus/(1+surplus/(2*pop))` | 4.7% | 9.7% | **implemented** — two parameters, best worst case |
| `a*surplus^b*pop^c` | 4.5% | 16.7% | fitted exponent 0.91, not 0.5 |
| `a*surplus^b` | 4.7% | 14.5% | population dependence is real, if weak |
| `a*sqrt(surplus*pop)` | 14.2% | 174.2% | the previous implementation, decisively out |
| `a*surplus` linear | 8.9% | 28.6% | misses the saturation at large surplus |

A four-parameter fit reaches median 2.4% but at a worst case of 19% on 16 points, so it
was rejected as overfitting. Farmland was tested as the saturation scale and fits slightly
better, but farmland varies only 421 to 467 across the readings — 11% — so it cannot be
separated from a constant, whereas population varies 2.1x and its dependence *is*
identifiable. Growth per head is a function of surplus per head; two readings at the same
food-per-head but different sizes (1161 with 240, and 1278 with 264) differ by 20% in
growth rate, which is what forced the population term in.

##### An earlier prediction, now settled

Fitting a square root to the first reading alone made the equilibrium unstable: the square
root has infinite slope at zero surplus, so population converged to a 2-cycle with a 4%
swing instead of settling at food balance. That was recorded as a falsifiable prediction.
The full readings settle it — growth is linear near zero, population converges smoothly,
and the oscillation was an artefact of the wrong functional form rather than a feature of
the game.

##### Both open questions, now closed

Neither needed another reading; §3.1.1 settles them.

- **The floor is `1.4933 * farmland`, not a remembered starting population.** The readings
  fit both equally well, because a nation starts at exactly `1.4933 * farmland`. The
  design principle breaks the tie: a remembered starting figure is carried-over state, and
  this game has none. So a nation that *gains* farmland raises its own floor, and one that
  loses farmland can be starved further than its original size — which also makes conquest
  of farmland worth more than it first appears, since it moves the victim's floor down as
  well as the conqueror's up.
- **Decline is linear.** Every measured deficit is shallow, at most 0.23 per head, and
  linear fits them to a median of 0.0%. Nothing in the design suggests a curve, and the
  saturation in the *growth* term exists to stop a nation buying unbounded growth with
  food it has no other use for — a constraint with no counterpart on the way down.

One empirical caveat worth keeping in view: because no measured deficit exceeds 0.23 per
head, linearity is established over that range and adopted beyond it on principle. At a
deficit approaching one ton per head the rule costs a nation 70% of its people in a turn,
and no reading confirms that directly.

**Population is the workforce.** In the reference state, population 461 against 458
allocated workers. Population is also the victory metric and the input to economies
of scale — which is what makes food the true strategic resource and gives the game
its title.

---

## 5. Military

### 5.1 Firepower is continuous [C]

Military power is a **single scalar per province** — not units, not stacks. A province
can hold 4.2 "bangs." Crawford considered this one of the game's genuine innovations,
and the chapter calls the military system "its best feature."

### 5.2 Weapon tiers [C]

Each tier is **2× as powerful ton-for-ton** as the last: Sword 1, Musket 2, Rifle 4,
Cannon 8, Tank 16. Same doubling logic as agriculture, and the same abandon-the-old-
branch dynamic (§3.3).

### 5.3 Weapon distribution [C]

Automatic, with no player control: **each turn, new weapons are distributed across
provinces in proportion to the previous turn's firepower concentration.** Where you
massed last turn is where production flows this turn. Simple, and it gives
concentration a second-order payoff.

#### 5.3.1 Deviation: firepower is a flow, drawn down in proportion [F]

Two deliberate departures from the `[C]` rule above. Neither is a reading of it.

**A nation's firepower tracks this turn's weapon production.** In the original it
accumulated: the manual's design dialogue has weapons "distributed each turn in
proportion to the previous turn's concentration" and never mentions them being lost, so a
nation could arm itself once and coast for the rest of the game at no cost. Here the
provinces always sum to what the nation can field now. Stop making weapons and you are
defenceless. That matches the economy's own rule (§3) — unused output is discarded at end
of turn, "use it or lose it" — and it supplies one of the brakes §9.2 says the design
lacks, since a standing army is a permanent charge against the population you are scored
on.

**How the total is apportioned depends on which way it moves.** Nothing is ever cleared
and rebuilt; a province is scaled or added to, so what it held carries through.

| National power | Rule |
| --- | --- |
| Rising | The *increase* is handed out: a flat 1 to each province, then the remainder in proportion to what each already holds. |
| Steady | Nothing moves. |
| Falling, including to nothing | Every province is scaled by the same factor, so the shape of the deployment survives the cut. |

So 66 and 33 against a national 100 become 33 and 16 at a national 50, and at a national
0 every province is 0. A province is drawn from in proportion to what it holds.

The flat grant applies **only to the increase**. A province holding nothing has no weight
and would be shut out of a rise entirely, so it needs that floor; but granting one on a
drawdown would quietly flatten the concentration the player built up, which is the thing
§5.3 exists to reward. The consequence is that an emptied province stays empty until
national power next rises, and is then garrisoned.

##### Consequences, measured

A uniform spread reproduces itself forever. The proportional term can only reinforce a
concentration that already exists, and nothing accumulates to create one, so **marching
forces together is the only way to concentrate** — and because a steady total moves
nothing, a concentration once built is kept rather than eroded. That makes the transfer
order a real strategic move rather than a convenience.

Reinforcements cannot feed a same-turn attack. `resolveMilitary` debits every marching
force from its home province before any transfer lands (§5.6), so funnelling into a hub
and attacking out of it takes two turns.

Offence remains reachable, but it is bounded by production rather than by patience. Nine
provinces funnelling into one hub reach a fixed point in a single turn:

| Weapon production | Hub firepower at equilibrium |
| --- | --- |
| 33/turn | 22.0 |
| 59/turn | 39.3 |
| 120/turn | 80.0 |

Appendix B's threshold is >20 by road against an undefended province, so 33/turn is about
the floor for offensive capability at nine provinces — and it does not grow with patience.
Compare the accumulating model, where the same nation reached 237 total firepower in four
turns simply by waiting.

### 5.4 Orders [C]

Exactly two per province:

1. **Fraction that marches** (slider), remainder defends.
2. **Destination** — one adjacent province (drag from source to target).

Moving into a friendly province reinforces it. Moving into an unfriendly one attacks it.

### 5.5 Combat resolution [C]

    effective = (attack - 10) * (via_road ? 1.0 : 0.25)
    result    = effective - (defence + 10)
    if result > 0: attacker takes the province with `result` firepower remaining

- Attacker loses a flat **10 firepower** on arrival; defender gets a flat **+10 bonus**.
  Purpose: *"I hate it when somebody wins a victory with trivial forces."*
- **The terrain penalty is binary: road, or not-road.** Asked "what do you count as
  terrain?", Embert answers *"Anything that isn't a road. Attacking down a road, you
  fight with normal strength, but anywhere else, your strength is quartered."*
  Mountain, forest and desert are mechanically **identical** for attacking — there is
  no per-type modifier. The quartering is the same thing Appendix B describes as "an
  additional 75% casualties," applied after the flat 10-point loss.

*Provenance footnote:* the design dialogue has Florin arguing for **differences** over
ratios precisely because a difference makes the minimum-force threshold fall out
naturally — then Embert wins a coin flip and the verdict is recorded as "strength
ratios with additive penalties and bonuses." Appendix B, the player-facing rules,
describes subtraction. It does not matter: given the additive ±10, the two are
algebraically identical for the win test, since
`(A−10)·m − (D+10) > 0  ⟺  (A−10)·m / (D+10) > 1`. They differ only in the surviving
force after victory, and Appendix B specifies the difference for that.
- These thresholds are confirmed by Appendix B: taking an *undefended* province needs
  **≥20 firepower by road, ≥50 cross-country**. Both fall out of the formula exactly.
- **Civilian cost**: the defending province's population is reduced by the military
  power brought against it. Scorched earth — a big conquest guts the prize. *Deviation:
  this implementation bounds it instead, see §5.5.1.*

### 5.5.1 Implementation notes [F]

`src/military.ts`. Both of Appendix B's quoted minimums fall out of the formula
unchanged: an undefended province needs more than 20 firepower by road, more than 50
across anything else.

**The `+10` is a modifier, not firepower.** A defender who holds is left with its own
strength less what actually reached it — not less the bonus as well. Otherwise a
fortification bonus would be consumed as if it were troops, and a defender could be
ground down by attacks too weak to have any effect.

**A marching force keeps the allegiance it set out with.** Resolving it from the home
province at battle time instead lets an army change sides mid-turn when its home falls
to an earlier assault: province A attacks B while B attacks A, B's assault lands first,
and A's army — already in the field — finds itself fighting for the enemy. Each force
carries its owning nation from the moment orders are given.

**A later wave whose nation already took the province reinforces it** rather than
assaulting it, which matters when several provinces converge on one target.

**Deviation — the civilian cost is bounded by the land [F].** §5.5 charges the defending
province the whole military power brought against it, win or lose. A captured province
is now instead left with **the people its own farmland can feed**, and a province that
holds loses nobody.

Charging the force brought to bear made conquest cost more than it could ever return:
scorched earth gutted the population, that population is the workforce, and firepower is
a flow that has to be paid for again every turn (§5.3.1). Scripted play could take three
provinces and then watched its firepower collapse from 300 to 49 with no way back — forty
turns left the same twelve provinces of sixteen (§10.1.4).

Under the bounded rule the same scripted play conquers a continent in eight turns on one
map and reaches thirteen to fifteen provinces of sixteen on four others, with population
*rising* through the conquests rather than collapsing. The cost no longer depends on how
hard you hit, only on the province falling, which also removes the perverse case where a
heavier assault destroyed more of the prize.

### 5.6 Execution order [C]

1. All friendly transfers resolve **first** — so defensive reshuffling beats incoming
   attacks, and anticipating an attack is rewarded.
2. Then battles. **Multiple attacks on one province resolve in sequence**, so the
   first wave can soften a defender for the second.

This ordering is what generates the game's best tactics: attacking from several
directions; counter-attacking the enemy's stripped jumping-off province; screening
that counter-attack with reserves. It is cheap to implement and should be preserved
exactly.

#### 5.6.1 Which army leads [F]

§5.6 fixes that waves resolve in sequence but says nothing about *who goes first*, and
the answer matters: the leading wave spends itself on the defender's full strength and
the last one walks into whatever is left.

**The smallest army strikes first, across every battle and regardless of whose it is.
Equal armies are drawn at random.**

This replaces resolving them in province order, which is what the implementation did by
accident — the index came from the order worldgen happened to place capitals, so an
invisible number decided which of your provinces was sacrificed to soften a target for
another. Nothing in the manual suggests the original did better, but nothing suggests it
did this either, so it is `[F]`.

Two consequences worth knowing:

- A small force sent alongside a large one is a **screen**: it arrives first, absorbs the
  defender's strength, and the large one lands on what remains. That is a real tactic
  rather than a lottery, and it is symmetrical — the same is true of the enemy's forces,
  and the ordering is global, so a rival's small army can soften a province for *your*
  large one if you both attack the same place in the same turn.
- You cannot choose to lead with your strongest. If that turns out to matter, the lever
  is an explicit order-of-attack control rather than a different automatic rule.

The draw is seeded per world and turn (`<continent>/battle/<turn>`), so a round replays
identically. A tie-break that moved under `Undo Turn` would let a player re-roll a battle
by undoing it, which is worse than an arbitrary order rather than better.

---

## 6. Diplomacy and economic unions (Expert)

### 6.1 Mechanic [C]

- The **weakest player declares a union against their worst enemy**. Others join or
  stand aloof. Further unions may form; if you join none, you may declare your own.
- The union **founder takes control of every member's economy for that turn**.
- Members' **populations and terrain pool into one economic unit** — which, given
  superlinear productivity, is an enormous efficiency gain. This is the whole point.
- Members may **only attack the union's target** (or anyone in a union against them).

### 6.2 Affinity model [C]

Displayed as a cocktail-party layout: your icon centred, the target placed below at a
distance proportional to their dislike of you, everyone else drifting toward friends
and away from enemies. Anyone inside your circle will join. The UI labels are
`loves / likes / dislikes / hates`, modified by `a lot / a little`, plus a hard
`Can attack him / Cannot attack him`.

**The layout was live, not a picture.** Each player declared on their own separate turn,
and while a declaration stood the others *moved* — drifting toward the circle and back
out of it again as they watched who else was drifting in, liking or disliking the
company that was assembling. Joining was therefore a negotiation played out in space:
you could see a coalition forming and change your mind about it, and your own movement
was itself a signal to everyone still deciding.

That is a materially different game from a blind vote. It makes membership common
knowledge as it forms, so the last to commit has the most information, and it gives
reluctance a way to express itself short of refusal. Nothing else in the design recovers
it, so it is recorded here even though what is built is the simpler thing — see §6.5.

Affinity deltas [C]:

| Event | Effect |
|---|---|
| Join someone's union | founder likes you more; target resents you |
| Declare a union against someone | that player resents you |
| Attack a player's province | negative |
| **Win** that attack | **more** negative — *"the only thing worse than attacking another player's province is winning the attack"* |
| Betray an ally (defect to their enemy) | persistent **distrust**, inhibiting future alliances |

### 6.3 Why §6.1–6.2 failed in play

The mechanics above are what shipped, and Crawford calls the result "a complete
muddle":

> "Early in the game, the alliances would work well, but as the game progressed and
> players betrayed each other, the overall level of distrust built up so high that
> nobody would trust anybody enough to form an alliance; at that point, the game was
> won by the biggest brute in the world."

This is the single most consequential defect in the design. Unions were the **only**
brake on runaway growth (§9.2), so once the diplomatic system seized, nothing was left
to stop the leader. Implement §6.1–6.2 as written and you inherit that outcome.

§9.1 has the diagnosis — two structural causes, no positive inflow and no relative
term. §6.4 is a worked replacement. Both are worth reading before writing any of this.

### 6.4 Redesigned affinity model [F]

Everything in this subsection is **design, not archaeology** — nothing here is
recoverable from the original. It replaces §6.2's mechanics while keeping its event
vocabulary, and it exists to fix the failure quoted in §9.1.

#### Two stored channels

Betrayal and routine border warfare should not poison the same pool.

| Channel | Meaning | Half-life | Decay λ |
|---|---|---|---|
| `liking` | warmth; volatile | 4 turns | 0.1591 |
| `trust` | reliability; durable | 15 turns | 0.0452 |

Both clamped to [−1, 1], both decaying toward 0 each turn. Updates **saturate**, so no
number of grievances can pin a relationship at the floor:

    penalty:  x ← x − d · (1 + x)
    bonus:    x ← x + d · (1 − x)

At neutral the full `d` lands; near a bound it barely moves. Four consecutive
betrayals at `d = 0.45` reach −0.91, never −1.

#### The decision variable

Union willingness is a single score. Both channels feed it — `trust` weighted higher,
because betrayal risk matters more than warmth — plus the live terms:

    W(A→B) =  1.0 · trust[A][B]
            + 0.6 · liking[A][B]
            − θ_pop · d_pop(B)                 θ_pop = 1.2
            − θ_mil · d_mil(B)                 θ_mil = 1.0
            + σ    · sharedEnemy(A, B)         σ     = 0.3

    d_pop(B) = (popShare[B] − 1/N) / (1 − 1/N)
    d_mil(B) = (milShare[B] − 1/N) / (1 − 1/N)

Normalising the deviation by its maximum keeps θ meaning the same thing at 2, 4 and 8
players. `milShare` is share of total firepower summed over provinces (§5.1).

**`W` gates membership, not `trust` alone.** This matters: if trust alone gated it, the
underdog bonus below could never actually produce a coalition.

#### Live term 1 — population breeds dislike

Population is the victory metric (§1.3), so the nation that is *winning* is the nation
everyone resents. This enters `liking`'s axis as a live penalty, never stored, so it
responds the turn standings change and vanishes if the leader falls back.

#### Live term 2 — military power breeds distrust

Firepower share enters `trust`'s axis. Arming yourself makes you a dangerous partner
regardless of what you have actually done.

Splitting the two axes this way opens a design space worth having. At N = 8:

| Profile | pop share | mil share | dislike | distrust | net `W` shift |
|---|---|---|---|---|---|
| Runaway leader | 0.40 | 0.45 | +0.377 | +0.371 | **−0.749** |
| Big but peaceful | 0.34 | 0.10 | +0.295 | −0.029 | −0.266 |
| Small but armed | 0.05 | 0.30 | −0.103 | +0.200 | −0.097 |
| Weakling | 0.04 | 0.02 | −0.117 | −0.120 | **+0.237** |

So you are resented for *winning* and distrusted for *arming*, independently. A large
peaceful nation stays a viable ally; a small heavily-armed one does not. Hiding your
strength becomes a real strategy.

*Optional extension:* weight `d_mil` by proximity, counting only firepower in provinces
adjacent to A. A big army on the far side of the continent is not a threat to you. The
adjacency graph already exists (§2), so this is nearly free.

#### Accumulating term — underdog solidarity

Each turn, for every pair both in the bottom ⌊N/2⌋ by population:

    liking[A][B] += 0.08 · (1 − liking[A][B])      (mutual)
    trust[A][B]  += 0.02 · (1 − trust[A][B])       (mutual)

This accumulates rather than being live, because shared adversity should build a real
bond — two nations that have been poor together for fifteen turns deserve to be closer
than two that just dropped into the bottom half.

Under decay these reach equilibrium rather than running away:

    liking → 0.08 / (0.08 + 0.1591) = 0.335
    trust  → 0.02 / (0.02 + 0.0452) = 0.307
    combined W contribution        = +0.508

**This is the strongest single dial in the model and the first one to turn down.** It
compounds with live term 1 — the bottom half already attract everyone slightly by
having sub-mean population — so underdogs are doubly appealing to each other. That is
the intent, but if the bottom half becomes an unbeatable permanent bloc, reduce the
trust component first; it is the durable half. Note the coalition's *composition* churns
automatically as populations move, which is the healthy behaviour.

#### Initial condition — founding neighbours

At world generation, for each pair of nations sharing at least one province border,
seeded into both channels and scaled by how much border they share:

    s = number of shared spokes between A and B
    if s > 0:
        trust[A][B]  = trust[B][A]  = min(0.45, 0.20 + 0.08·(s − 1))
        liking[A][B] = liking[B][A] = min(0.30, 0.15 + 0.05·(s − 1))

Seeded rather than permanent, so it erodes as real events overwrite it — founding
goodwill that history can spend. Decay profile at `s = 1`:

| Turn | trust | liking | `W` contribution |
|---|---|---|---|
| 0 | 0.200 | 0.150 | +0.290 |
| 10 | 0.126 | 0.027 | +0.142 |
| 20 | 0.079 | 0.005 | +0.082 |
| 30 | 0.050 | 0.001 | +0.050 |

Most of it sits in `trust` deliberately, so the tie lasts 20–30 turns rather than the
~12 a liking-only seed would give. If you want founding ties to *never* fade, make it a
permanent constant in `W` instead of a seed.

**This creates a deliberate tension worth knowing about.** You can only attack adjacent
provinces (§5.4), so your starting friends are exactly the people you are able to
attack, while unreachable nations start neutral. That is precisely the manual's advice —
*"Find a firm friend and stick with him through thick and thin — until the two of you
have bumped off everybody else. Then have the knife ready in hand as you embrace him."*
Watch for the failure mode in playtest, though: if neighbour goodwill is too high, early
war may never start at all, since the only reachable targets are all friends.

#### Event magnitudes

| Event | `liking` | `trust` |
|---|---|---|
| B attacked you | −0.35 | −0.05 |
| B won that attack | −0.15 further | −0.05 further |
| B betrayed you (defected from your union) | −0.25 | −0.45 |
| B joined your union | +0.20 | +0.10 |
| Union survived a turn intact | +0.05 | +0.05 |
| B founded a union against you | −0.30 | −0.10 |
| B merely joined a union against you | −0.09 | −0.03 |

Two changes from §6.2 worth noting. **Union-target grievance is split 70/30 between
founder and joiners** rather than landing full strength on each — that single edit is
what stops one union poisoning seven edges at once, which is the arithmetic behind
Crawford's collapse. And the **cooperation dividend** (union survives intact) is the
only positive inflow the original lacked entirely.

#### The tuning constraint that matters

**The live terms must be able to overwhelm stale grievance**, or you are back in
Crawford's dead end with extra machinery. Check it numerically:

    15-turn-old betrayal        trust = −0.225  ->  W −0.225
    runaway leader's live terms                 ->  W −0.749

Threat dominates by 3×. If you lower θ_pop or θ_mil, re-verify that inequality at the
power concentrations your playtests actually reach.

A pleasant consequence: early game all shares sit near the mean, so the live terms are
~0 and history governs; late game they dominate. Alliances are about relationships early
and survival late, with no extra code.

#### Acceptance test

Log **unions formed per turn** across a full game. Crawford's failure is visibly a decay
curve reaching zero. You want a roughly flat rate with *changing composition* — track
membership churn alongside the count. If the rate holds but composition freezes, the
underdog dividend is too strong relative to the live terms.

### 6.5 Blind vote, for now [F]

What is built is the sequencing of §6.2 without its negotiation. Declarations are taken
one at a time in order of weakness, exactly as the original did, and each nation still
unattached answers that declaration on its own. But the answers are **simultaneous and
hidden**: the candidate list is fixed the moment a declaration is made, so no nation's
choice can be informed by another's, and a union's membership is a surprise to its own
members until it forms.

This is a deliberate simplification and not a reading of the original. It was chosen
because it is a complete, playable rule that needs no new interface, where the drifting
layout needs both a spatial view and a notion of provisional commitment that can be
withdrawn. The intent is to build the movement later; until then a UI must not preview
a likely roster, because that would hand the player the one thing a blind vote withholds
while giving none of what the live layout offered in exchange.

Worth carrying into that work: under a blind vote the last to answer has no advantage,
which is why order-of-weakness matters less here than it did in the original. If the
movement is built, expect the weakest-first order to start doing real work, because the
information asymmetry it creates is the whole point of going first.

---

## 7. Data model sketch

```ts
type CommodityId = string

interface Commodity {
  id: CommodityId
  priority: number                          // display order == allocation priority
  inputs: { id: CommodityId; perTon: number }[]
  // Productivity parameters are NOT here: they are measured per (commodity, level)
  // and live in src/calibration.ts, generated from the measurement CSVs.
  terrain?: TerrainType                     // absence raises labor cost, never blocks
}

interface Province {
  id: number
  owner: PlayerId
  capital: Point
  border: Point[]
  neighbours: { province: number; road: boolean }[]   // adjacency; road is a ~50% subset
  acres: number
  resources: Record<TerrainType, number>
  population: number
  firepower: number                         // continuous
  orders?: { marchFraction: number; target: number | null }
}

interface Nation {
  id: PlayerId
  provinces: number[]
  population: number
  allocation: Record<CommodityId, number>   // labor fraction
  locked: Set<CommodityId>
  affinity: Record<PlayerId, number>
  distrust: Record<PlayerId, number>
}
```

Turn pipeline:

```
unionPhase() → allocateLabor() → resolveProduction() → applyFood()
  → collectOrders() → resolveTransfers() → resolveBattles()
  → distributeWeapons() → rank() → autosave()
```

---

## 8. Calibration data

### 8.1 The reference state (manual p.12)

Beginner game, nation GANTHOR on continent "trebolokhan":

| Commodity | Output | Surplus | Limiting | Workers |
|---|---|---|---|---|
| Lumber | 268 | −1 | Labor | 27 |
| Sulfur | 0 | 0 | Labor | 0 |
| Iron Ore | 218 | 0 | Labor | 30 |
| Coal | 0 | 0 | Labor | 0 |
| Charcoal | 49 | −8 | Labor | 6 |
| Pig Iron | 199 | −21 | Charcoal | 30 |
| Gunpowder | 0 | 0 | Labor | 0 |
| Iron | 0 | 0 | Labor | 0 |
| Farm Tools | 399 | 90 | Pig Iron | 56 |
| Iron Plow | 0 | 0 | Labor | 0 |
| **Food (461)** | 618 | 157 | Labor | 309 |
| Sword | 0 | 0 | Labor | 0 |
| Musket | 0 | 0 | Labor | 0 |

The companion screenshot shows the Farm Tools factory at **56 workers, capacity 440
tons**, inputs Pig Iron (−21) and Lumber (−1), output labelled *"This increases
agricultural output by 309 tons."*

**Derivations that close exactly:**

- Farm tools capacity 440 → demands 220 lumber + 220 pig iron (0.5/0.5 recipe).
- Lumber demand = 220 (farm tools) + 49 (charcoal) = 269; output 268 → **surplus −1 ✓**.
  This confirms **Charcoal = 1.0 Lumber**.
- Pig iron demand = 220, output 199 → **surplus −21 ✓**.
- Agricultural workers 309 = **309 acres** at 1 worker/acre.
- Tool usage capped at 1 ton/acre → 309 of the 399 farm tools used, **90 wasted =
  the reported surplus ✓**.
- Food 618 = 309 base + 309 from tools → **base yield 1.0 t/acre, tier-1 tools
  +1.0 t/ton ✓**.
- Total workforce 27+30+6+30+56+309 = **458** against a food requirement of **461** →
  **1.0 ton per person ✓**.

### 8.2 Screenshot derivation vs. in-game reading — they agree

Pig Iron was the one recipe that could not be read directly off the manual. Derived
from the p.12 screenshot alone:

- Charcoal surplus −8 → charcoal demand 57 → `pigIronCapacity × charcoalPerTon = 57`
- Pig iron output 199, charcoal-limited, all 49 charcoal consumed → `charcoalPerTon ≈ 0.246`
- Hence capacity ≈ 232, and iron ore demand 218 → `ironOrePerTon ≈ 0.94`

The in-game reading is **0.25 charcoal + 0.95 iron ore** — matching the derivation to
within rounding.

**The sim settles which is authoritative: the derived values.** Running the reference
state with 0.25 / 0.95 yields pig iron 196 against an observed 199, and an iron-ore
shortfall of −2.4 where the screenshot shows 0. With 0.246 / 0.94 every row closes to
under a ton. The in-game display is therefore a rounded rendering of the stored
coefficient, and `src/data.ts` defaults to the derived pair for that reason. This is a useful cross-validation: it means the §8.1 reference state
is internally consistent and can be trusted as a test fixture, and it means the
demand-is-proportional-to-capacity rule (§3.5) behaves as documented.

It also settles the open question that derivation raised. **Recipes are not
mass-conserving.** Across the confirmed table, input masses per ton of output range
from 0.75 (Gunpowder) to 1.85 (Low-Grade Steel); only 18 of 25 sum to exactly 1.0.
The pattern: raw→intermediate smelting steps lose mass on purpose (Iron 1.5,
Low-Grade Steel 1.85, High-Grade Steel 1.65), while assembly steps and both tool and
weapon tiers conserve it. Do not "normalise" these — the heavy ratios on the steels
are what make the industrial branch expensive to enter, which is the whole tension
in §3.3.

### 8.3 Productivity fit

Only **five** industries can be anchored to real data, and each has exactly **one**
(L, capacity) observation. With one data point you cannot solve for two parameters, so
in every case `a` is a *choice* and `k` follows from `k = capacity / L^a`. Change an
exponent and you must refit that row's `k` or it stops matching the fixture.

Verified: substituting the §3.4 table back into `k · L^a` reproduces all five observed
capacities exactly — 268, 218, 49, 232, 440.

**To recover the originals properly:** run the game under DOSBox and, for one industry,
drag the labour slider to two different positions, reading `Factory Size` each time.
Two (L, capacity) pairs over-determine both parameters:

    a = ln(cap₂/cap₁) / ln(L₂/L₁)
    k = cap₁ / L₁^a

Do this for one raw, one intermediate and two adjacent tool tiers and the whole
schedule falls out — the per-class rules in §3.4 then just interpolate the rest. This
is the single highest-value measurement left to take, because the exponent spread is
what drives the runaway-leader problem in §9.2.

---

### 8.4 Validated topological order

Generated from the confirmed recipe table and checked acyclic. Shallowest first; ties
are arbitrary. Use this as the allocation resolution order (§3.5).

| Depth | Commodities |
|---|---|
| 0 | Coal, Heavy Metal, Iron Ore, Light Metal, Lumber, Nitrate, Petroleum, Sulfur |
| 1 | Charcoal, High Explosives, High-Grade Steel, Iron, Low-Grade Steel, Pipe, Wire |
| 2 | Ball Bearing, Cannon, Electrics, Explosives, Gunpowder, Iron Plow, Pig Iron, Steam Engine |
| 3 | Combine, Diesel Engine, Farm Tools, Instruments, Irrigation, Musket, Rifle, Sword |
| 4 | Tank, Tractor |

Note that **dependency depth does not track tech tier**. Cannon lands at depth 2 while
Rifle is at depth 3, because Rifle needs Explosives (which needs Charcoal) whereas
Cannon's High Explosives route is shallower. Sword sits at depth 3 alongside Musket.
So the priority rule will sometimes favour a higher-tier weapon over a lower one. That
is a direct consequence of the confirmed recipes, not a modelling error — but it is
worth knowing before a player reports it as a bug.

## 9. Known design failures, and what to do instead

Crawford's verdict on his own game: *"a collection of clever, occasionally brilliant
ideas crammed together with insufficient integration ... the worst game I ever
designed."* He attributes it to shipping three months early to meet another
publisher's deadline. Since you are rebuilding rather than porting, these are the
things to actually fix.

### 9.1 Distrust never decays — this is the big one

> "Early in the game, the alliances would work well, but as the game progressed and
> players betrayed each other, the overall level of distrust built up so high that
> nobody would trust anybody enough to form an alliance; at that point, the game was
> won by the biggest brute in the world."

Unions were the **only** brake on runaway growth. Distrust accumulated monotonically,
so the brake disintegrated exactly when it was needed most.

Two structural causes, and the second is the deeper one:

- **No positive inflow.** Tally the sign of every affinity event in §6.2: attacks
  negative, winning attacks more negative, declaring a union negative, betrayal
  negative and permanent. The only positive is a founder liking you for joining.
  Meanwhile a union target takes a full-strength grievance against *every* joiner, so
  in an 8-player game one union poisons up to seven edges while creating one or two
  friendly ones. The collapse is arithmetic, not bad luck.
- **No relative term.** Crawford says he expected alliances to "constantly shift in
  response to the successes and failures of the different players" — but the model he
  built has no term for success or failure, only for grievance. The intended behaviour
  was never encoded. "The only thing worse than attacking another player's province is
  winning the attack" is a crude reach toward it, but it enters as history rather than
  as a live reading of who is dangerous now.

**Note that mere durability is the wrong target.** Make affinity simply persist and the
first successful bloc never dissolves; combined with the economies-of-scale pooling it
compounds and wins. That is the same terminal state with the sign flipped — "the biggest
brute" becomes "the first stable coalition." What you want is affinity that stays
**differentiated and responsive**: the spread between best and worst prospective partner
stays wide all game, while *who* occupies those slots keeps re-sorting.

**§6.4 is a worked replacement** implementing that: split volatile/durable channels,
saturating updates, live population-dislike and military-distrust terms, underdog
solidarity, founding-neighbour ties, and a cooperation dividend to supply the missing
positive inflow.

### 9.2 Runaway leader is structural

Superlinear productivity means the leader compounds. The design dialogue has Embert
flagging it directly — an unshakeable lead arrives *well before* 51% of resources.
Crawford's only counterweight was unions, and it failed. You need a second one.
Options: diminishing returns on very large economies, occupation costs that scale
with conquered population, or attrition on overextended borders.

Note the scorched-earth rule (§5.5) is already a partial brake — conquest destroys
the population that makes the prize valuable. Consider strengthening it before
adding new systems.

§5.3.1 adds a second: firepower is a flow rather than a stock, so military strength
has to be paid for every turn out of the labour that would otherwise feed people. An
armed nation cannot coast. That brakes military runaway specifically; it does nothing
about an economic leader compounding through superlinear productivity, which is the
larger half of the problem and still open.

### 9.3 The economy is opaque

> "The input/output charts of the economy should have shown the player the intricacies
> of a working economy in a way that was easy and fun."

The demand-driven hoarding rule (§3.5) and the pro-rata worker shuffle (§3.6) are
both defensible mechanically but were invisible in play. This is the single biggest
opportunity in a modern rebuild: show the flow graph live, show *why* a factory is
starved, preview a reallocation before committing. The mechanics don't need to change
— the player just needs to be able to see them.

### 9.4 Things Crawford cut that you may or may not want

Removed during development, mostly for good reasons: trade and money (worked, wasn't
fun); transportation and railroads; per-province factories; capital assets; infantry/
cavalry/artillery split; lakes and seaports. Each one was cut to protect the central
guns-vs-butter tension. Re-adding any of them means re-testing that tension.

---

## 10. Build order and status

1. **Economy sim, headless** — **done.** `src/` implements the commodity graph,
   productivity function, demand-driven allocation, agriculture and population, with
   every parameter measured rather than authored. Validated two ways: `npm test`
   asserts the §8.1 reference state and the §2.2 terrain readings, and
   `npm run validate` scores all 644 measurements (median error 1.2% above
   200 tons).
2. **Map generation** — **done.** `src/worldgen.ts`, seeded by continent name; see
   §2.0. Produces contiguous nations on a tiled continent with adjacency, roads,
   terrain, farmland and starting population, and feeds straight into the economy via
   `nationState()`. `npm run map` renders one to SVG.
3. **Military** — **done.** `src/military.ts`: continuous firepower, weapon
   distribution by prior concentration, two orders per province, the §5.5 formula,
   transfers-before-battles, sequential waves, scorched earth and the victory check.
   See §5.5.1.
4. **Turn loop** — **done.** `src/game.ts`, §1.2.1. Phases, orders, undo, autosave key,
   rankings, victory, and the couplings between the three subsystems.
5. **UI** — **done, first pass.** `web/`, bundled by esbuild into a single module with
   no runtime dependencies. Moved ahead of the AI deliberately: this is the subsystem
   the original lost on, and it is the only one whose defects are invisible to tests.
   Playing it found four bugs the 210 unit tests did not — see §10.1.
6. **AI opponents** — **first pass done.** `src/ai.ts`. [F] — nothing is recoverable
   about Crawford's AI beyond the union-declaration rule in §6.1, so this is design:
   a utility function over allocations for the economy, an influence map over the
   province graph for the military. §10.3 has what it does, what it got wrong on the
   way, and what it still cannot do.
7. **Diplomacy** — **done, and needs tuning.** The one piece deliberately left out is
   §6.2's live cocktail-party layout, where nations drift in and out of a forming union
   in response to each other; what is built is a blind vote in the same order (§6.5).
   `src/affinity.ts` implements §6.4 whole: both channels, the decay, the saturating
   updates, the founding-neighbour seed, the live terms and the underdog dividend, with
   the decision variable `W` exposed as
   `Game.willingnessFrom`. `src/union.ts` adds §6.1 on top — formation in order of
   weakness, the join rule, pooling, the attack restriction, and the diplomatic bill.
   §6.4's acceptance test is instrumented in `npm run soak`. What it reports is in
   §10.4, and it is not yet the curve §6.4 asks for.

Three oracles are available while you build: the DOS build under emulation, the §8.1
fixture, and the measurement CSVs via `npm run validate`.

### 10.1 What playing it in a browser found

`npm run dev` serves the app; the whole of the state is one `Game`, and each phase
renders its own panel. The §3.6 redistribution is now *previewable*, which is the point
of having built it: drag a factory's slider and every unlocked factory moves pro rata
before anything is committed, so the manual's warning that this "can completely
obliterate your carefully considered worker allocations" is something you watch happen
rather than something you discover afterwards.

Four defects surfaced from driving the real thing, none of which a unit test would have
caught, because all four were about what a player can see or do:

- **A march could be ordered from a province with no firepower.** The map accepted the
  click and the execution phase dutifully reported "Aishil sends 0 of 0", but the orders
  panel only listed armed provinces, so the order was invisible and uncancellable. Only
  armed provinces are selectable now.
- **The selection outline was being painted over.** Province fills are drawn early and
  the nation borders are separate lines drawn on top at more than four times the width,
  so the one outline the player needs to see was buried. Highlights are now a final
  overlay pass, and a test asserts that ordering.
- **An ordered march left no mark on the map.** You could read it in the table and
  nowhere else. Marches are now drawn capital to capital, red for an attack and dashed
  green for a reinforcement — which also makes visible that marching into your own
  province is a legal reinforcement rather than an attack.
- **Populations printed raw**, so a nation that had taken civilian losses read as
  "607.6216175606817 people".

#### 10.1.1 Second pass, from the first round of play notes

The first UI was legible but not usable for long. What the notes asked for, and what each
change turned out to need:

- **The map was mostly empty ocean.** Worldgen draws into a fixed 1000x700 field and the
  land never fills it, so `continentBounds()` crops the view to the coastline — about half
  the field on a typical continent. The renderer now takes a `view` rectangle, which also
  buys panning and zooming for almost nothing: the wheel and a drag rewrite the `viewBox`
  attribute directly rather than re-rendering, so it stays smooth. The ocean is drawn over
  the whole field rather than the view, so a pan never reveals bare page.
- **Clicking a province shows it**: who rules it, population, military power, and acres by
  terrain. In the orders phase a click both inspects and orders, which is why the inspected
  province is outlined differently from the one being ordered — you are often reading about
  one while ordering another.
- **The nation list** is built from `rankings()`, which now carries `land` and `acres` for
  the purpose. Clicking a nation gives its strength, population, provinces and territory.
  **Food output is withheld for every nation but your own**, as a national secret; it is
  the one number that would tell you exactly when a rival is about to grow.
- **What an army is armed with is public**, for every nation. Firepower is stored on
  provinces as a bare number (§5.1), so the weapon behind it survives only in the
  production that made it — which is why the production record is carried across the
  turn boundary rather than cleared with the rest: the armies standing on the map were
  armed last turn. It is shown rather than withheld because the secrecy rule above is
  narrow and reasoned. Food says when a rival is *about to* grow; a weapon type only
  describes strength the map is already displaying, and a tier tells you no more than
  the firepower total already does.
- **Execution replays the turn.** Each march travels from capital to capital and the map
  updates as it lands, because the ordering rules are invisible otherwise — that marching
  forces leave home before anything resolves (§5.6), and that waves on one province
  resolve in sequence. The replay is driven from the `TurnReport`, so it shows what
  actually happened rather than a re-simulation. A quiet turn skips it entirely.
- **The production panel expands to the full window.** It is the screen with the most
  numbers on it and the one a player spends longest in.
- **Resources are shown rounded down, never up** — a factory holding 16.7 tons has 16
  whole tons to give anyone. Applied to negatives too, so a 16.7-ton shortfall reads as
  -17: the whole tons you would have to find to cover it.
- **Both sliders got a number box, a pair of nudge buttons, and more width.** A slider
  alone was hopeless for fine work; in the narrow pane each pixel was several workers. The
  number box is now the precise instrument and the slider the coarse one, and the orders
  slider counts firepower rather than a percentage, so "send 14 of 26" is stated rather
  than inferred.

Four more defects surfaced while building it, all of them in the new controls:

- **The nudge buttons moved the allocation but not the display.** `refreshNumbers` skipped
  whichever control had focus, to avoid fighting someone mid-keystroke, and a nudge left
  focus in the number box. It now skips only the control actually being typed into.
- **A number box would keep a value the game had rejected.** `max` on a number input does
  not stop anyone typing past it, so typing 7 into a box capped at 5 showed 7 while the
  order was correctly 5. Values are clamped back on commit.
- **The replay announced the wrong phase.** `advance()` moves to rankings before the
  replay runs, so the panel read "a quiet turn — nothing marched" over the top of a
  battle. The shell now follows the replay rather than the phase while one is running.
- **A turn with no marches still paused.** The replay entered its animation state for a
  quarter second with nothing to show, disabling the advance button for no reason.

#### 10.1.2 Third pass, and two bug reports that were not what they looked like

The reports first. Both turned out to be about the *screen* rather than the model, which
is the pattern §10.1 keeps repeating.

- **"I add a worker to musket and the gunpowder surplus goes up."** Two causes, one real.
  The legitimate one is the model working: taking workers for muskets thins every other
  factory pro rata, so the consumers of a shared input want less of it and that input's
  surplus genuinely rises. The artefact was worker counts coming from a largest-remainder
  split of the whole workforce — asking for a share of `n / spare` did not reliably yield
  `n` workers, and when it missed, the spare worker landed on some unrelated factory. So
  pressing `+` on muskets could leave muskets unchanged and hand lumber a worker.
  `setWorkers` now nudges the share until the count asked for is the count given.
- **"Food surplus doesn't change with farm tools."** Food is wired to tool tonnage
  correctly — 0 workers gives 427 tons from bare land, 60 gives 656 — but `refreshNumbers`
  updated the factory rows and the totals and *not the `<tfoot>`*, so the food figures
  were frozen until something forced a full re-render. The food rows are now refreshed
  with everything else, and they show their composition: so much from the land, so much
  from so many tons of tools, against a cap of one ton per acre.

The rest of the pass:

- **Marches replay during the execution phase**, between *Execute orders* and *See
  rankings*, which needed the phase change described in §1.2.1. They run at half the
  first pass's speed: 840ms to cross, 560ms between.
- **A start screen** takes the continent, the player's nation name and the difficulty. The
  continent's name is still the seed, so the same name makes the same world.
- **Nations have names** — `Nation.name`, drawn from polities that existed before 600 BCE,
  seeded per continent so the opposition is stable, and with the player's own choice held
  out of the draw. The draw runs off its own seed (`<continent>/nations`), so naming a
  nation cannot reshape the land.
- **Commodities are labelled** as a player would read them: `iron-ore` shows as Iron Ore.
- **Production shows Size beside Output** — what a factory's workers could make against
  what it actually made. The gap is the input shortage, named in the next column.
- **Idle labour is a row in the table** rather than a note under it, which is where a
  player looks for it.
- **Conquest ends the game with a splash** naming the victor, and the end offers a new
  game or the door rather than another turn.
- The nudge buttons sit against the box they nudge; the slider gives way to the number
  box when the pane is narrow, because the slider is the control that needs width.

##### A balance finding, from trying to play a conquest

Scripted play to reach the victory screen instead found that **winning may not currently
be reachable**. A nation that takes three provinces sees its total firepower collapse from
300 to 49 and never recover: scorched earth (§5.5) guts the population of what it
captures, the survivors are the workforce, and firepower is a flow that has to be paid for
again every turn (§5.3.1). Forty turns of trying left the same twelve provinces of
sixteen. The two brakes on a runaway leader are each defensible, but together they may be
strong enough to stop anyone winning at all. Worth a decision before the AI is built,
since an AI will run into the same wall.

#### 10.1.3 Fourth pass

One report worth recording, and one that the levels answered.

- **"Lowering Sulfur by one also lowered Charcoal by one."** True, and the same root as
  the musket report in §10.1.2. The model stores labour as fractions (§1.2.1), so setting
  a share and rounding it back into whole workers could take a worker off a factory the
  player had not touched. The UI now moves **whole workers**: `moveWorkers` in
  `src/game.ts` gives the difference to, or takes it from, the other unlocked factories
  pro rata by largest remainder. Raising a factory lowers exactly one other; lowering it
  raises exactly one other; nothing else moves and the workforce is conserved. Shares are
  still what gets committed, and the round trip through `workersFor` is exact.
- **"Intermediate is missing Combine and Rifle; Expert is missing its components."** The
  production panel had a hardcoded list of twelve commodities and showed it at every
  level. It now shows the level's own set — see §1.1, which the readings turned out to
  settle.

The rest of the pass is presentational: the numeric columns are declared rather than
sized from content, so they stay together when the panel is expanded and the factory
names no longer jump when a lock redraws the table; the totals read `Population:`,
`Firepower:` and `Land:` on their own lines with the worker count dropped, since idle
labour is a row in the table now; Rankings shows only the standings; and selecting a
nation outlines everything it holds.

#### 10.1.4 Fifth pass

- **"Workers that moved to unspent labour cannot be allocated."** Real, and a return of
  something already fixed once in the terminal game. `moveWorkers` conserved whatever
  total it was handed, so the idle pool was never a source. With every other factory
  locked there is nobody to give released workers to, so lowering a factory stranded them
  — and nothing could draw them back. The function now takes the workforce as a budget:
  the target is capped by what the locked factories are *not* holding, so idle labour is
  spendable by whichever factory asks for it. Locked factories still cannot be raided.
- A highlighted nation is outlined in **white**, which is the one colour no nation fill
  or terrain mark uses. A single inspected province keeps its blue dashed outline, so the
  two readings of the map stay distinct.

#### 10.1.5 Sixth pass, and the economies of scale checked against the readings

**"Economies of scale seem too soft — can we verify against the original game data?"**
Checked, and the exponents are right. `test/calibration.test.ts` refits the committed
CSVs independently of `docs/calibrate.py` and compares the exponent — the one number §3.4
calls the foundation of the design — across 64 commodity/level pairs:

| | |
| --- | --- |
| mean error | 0.006 |
| median error | 0.000 |
| worst | 0.102, on Nitrate at intermediate |
| systematic bias | −0.006, i.e. none worth the name |

Doubling labour multiplies capacity by 2.18x for Lumber, 3.13x for Iron, 3.31x for
Combine and 5.11x for Tractor. The manual's promise holds.

So why does it *feel* soft? Because a tier-1 raw is soft, by measurement: Lumber's
exponent is 1.127, so going from 5 workers to 200 — forty times the labour — raises
output per worker only from 10.6 tons to 16.9. The steep exponents live at the top of the
tree (Tractor 2.35, Diesel Engine 2.53), and those only exist at expert and only pay at
populations you have to grow into. **The payoff for scale is meant to come from climbing
the tree, not from piling labour into lumber**, which is §3.4's stated purpose: tech
progression tied to population without a research tree. It is faithful, not soft.

The rest of the pass:

- **The conquest cost is bounded by the land**, §5.5.1 — the change that made winning
  reachable at all. Measured before and after in §5.5.1.
- Rounding is whole-number throughout: the allocatable workforce is floored in
  `workersFor`, so a fractional remainder can no longer appear as unspendable idle
  labour, and nothing in the production panel shows a fraction.
- The lock sits to the left of the factory it locks; a factory in deficit gets a banded
  row and a marked edge rather than one red number; the Skip button moved into the
  execution heading so it is reachable before the log rather than after it.

#### 10.1.6 Seventh pass

**A frontier is now at most two thirds road [F].** Roads were drawn without regard to
nations, so a national border could come out almost entirely paved — and since a road is
the difference between a 20-firepower threshold and a 50-firepower one (§5.5), such a
border is indefensible by construction. Nations are therefore settled before the roads
are laid, and each demoted frontier road is traded for an interior one so the continent
keeps the dialogue's "oh, only half".

**Two measures, because they are not the same thing.** The cap started as a bound on the
share of *frontier spokes* that are paved, which is the natural way to write it and the
wrong way to read it. A nation can sit comfortably under that and still have a road on
almost every border province, because one province can carry several frontier spokes:
Saturday/expert had Corinth at 6 of 7 border provinces with a road out while the
continent's frontier spokes were only 51% paved. What a player counts is provinces, so
both are bounded now, the second **per nation** rather than across the map.

Measured across 36 worlds and 168 nations: worst border-province share 62.5%, worst
frontier-spoke share 45.5%, overall road share unchanged at 50.0-51.6%.

Two consequences worth knowing. A nation with one or two border provinces can end up with
**no road out at all**, since two thirds of one province rounds down to none — it happened
to 2 of the 168, and it makes such a nation costly to attack and costly to attack from.
And internal road connectivity is untouched by all this: frontier spokes lie between
nations by definition, and moving troops between your own provinces is a transfer, which
§5.5 does not apply the road multiplier to.

**The + button and the slider could stop moving a factory while typing still worked.**
Not rare at all once looked for: 14 of 19 commodities at intermediate, 33 of 33 at
expert. The UI holds whole workers and stores them back as fractions of the workforce,
and those fractions re-add to 0.9999999999 often enough that the floor in `workersFor`
swallowed a worker. Largest remainder then decided *which* factory lost it, which is what
made the stall look random. An epsilon on that floor fixes it; 0 of 33 stall now.

The rest:

- **The game autosaves**, so a refresh resumes instead of starting over, and the start
  screen offers the save. `GameSnapshot` carries the world, turn and allocations but not
  the phase or the orders, so a resume lands at the start of the saved turn — half a turn
  of orders is not a state the game has a name for.
- **Exit sits at the far right of the footer**, as far from the button pressed every turn
  as the bar allows. It saves and returns to the start screen; with the autosave behind
  it, leaving costs nothing.
- **Victory waits for the marches to finish.** `advance()` resolves combat on the way
  into execution (§1.2.1), so the winner is known before the replay has drawn a single
  arrow — the splash was appearing over the top of the battle that won the game.
- **The march control is docked in the corner of the map**, naming both ends of the
  march, with a Done button. It first sat on the province it was ordering, which put it
  over the ground the player was trying to read and, on a small continent, over the
  target as well.

  **Placing an order ends the selection.** Keeping the province selected afterwards made
  the next click ambiguous: on a neighbour it quietly retargeted the march, anywhere else
  it started a new one, and nothing on screen said which. Now choosing a target finishes
  the order, and the map returns to its resting state — the next click on any armed
  province begins a fresh one. The control stays open on the order just placed so its
  size can still be set, and the hint says so in as many words. Done only puts the
  control away; the order stands and its arrow stays on the map. Retargeting is
  selecting the province again and picking a different neighbour, and cancelling is
  selecting it and clicking it a second time.
- Clicking a nation in the Rankings highlights its territory, as the nations list does.

#### 10.1.7 Affinity arrives early, because the UI asked for it

Showing a nation's affinity meant building §6.4, so diplomacy's first half landed ahead
of the AI. The model is implemented to the spec's own numbers and tested against them:
the four-profile table at N=8 reproduces to within 0.005, the underdog dividend settles
at the predicted 0.335 liking and 0.307 trust, and the tuning constraint holds — a
runaway leader's live penalty outweighs a 15-turn-old betrayal by more than 3x.

Played out, it behaves as designed. On Thule/expert at turn 1, Ur's founding neighbours
sit at +0.62 and the nations it does not touch at 0. By turn 11 Ur leads on population,
and Kuru's regard for it has fallen from +0.34 to +0.14 with nothing having *happened*
between them — that is live term 1 working. Meanwhile Kuru, Carthage and Tartessos have
slipped into the bottom half, and Kuru's liking for the other two has *risen* from 0.30
to 0.35 while every other tie decayed. Warmth fades, the leader is resented, the poor
draw together.

#### Firepower gets a compact form

Armies are the one quantity that can run past five digits — 268,510 in a turn is
reachable on a big expert economy — and the map has no room for that under a capital.
`compact()` in `src/format.ts` changes unit only when the mantissa would reach five
digits: 9999, then 10k, 2000k, 20m, 10b, 10t.

**Every quantity on screen is a whole number of things, rounded down.** Tons, people,
acres, workers and firepower are all counts, so none of them shows a fraction: 12.87
tons of iron is 12, and 4.2 firepower is 4.

The compact form is the one exception, and only because its digits are not fractions:
`10.43k` is ten thousand four hundred whole things, written in thousands. So firepower
carries up to two decimals *at and above the unit change* and none below it — `10.43k`,
`268.51k`, `456.99k`, but `26`, `999`, `9999`, and `10k`, `2000k`, `20m` where the
decimals would only be zeros. They are truncated rather than rounded, like everything
else, so 456,999 never reads `457k`.

The affinity panel is not an exception to this: `liking`, `trust` and `W` are positions
on a [−1, 1] scale (§6.4), not counts of anything, and recipe coefficients like
`0.246 per ton` are ratios. Neither is a quantity a nation holds.

`Intl.NumberFormat`'s compact notation is the more standard choice and was rejected on
purpose: it renders 1200 and 1249 both as "1.2K", and the difference between two armies
that size decides the battle between them. Four significant figures is the least this
game can carry.

Firepower only. Tons and workers stay exact, because balancing an economy needs the
difference between 1200 and 1249 and a battle does not, and the number inputs stay plain
numeric so they remain editable.

**Population is grouped instead of compacted** — 18,500, not 18k. It is the victory
metric (§1.3), and the standings are read by comparing them: 2,412,077 against 2,412,340
is a different fact from both of them reading "2412k". Commas explicitly rather than
`toLocaleString`, which would put full stops in for half the world.

#### A factory's recipe, on the factory

Clicking a factory's name opens what it needs and where its output goes: each input with
its coefficient, how much the factory *wanted* at this labour and how much actually
arrived, then each consumer with how much it wants and how much it takes.

This is the first place §3.5 is legible rather than merely documented. Lumber on a
typical opening reads: Charcoal wants 115 and takes 84, Farm Tools wants 92 and **takes
0**. The production table could only say that farm tools were short of lumber; this says
that charcoal drank the lot before farm tools were asked, which is the whole of the
priority rule in two lines of a table.

Raws name the terrain they draw on and its acreage; tools and weapons name what a ton is
worth in food or firepower.

**Expanded production keeps it on screen.** Expanding once hid the inspector along with
everything else, which put the recipe and the worker box that answers it on opposite
sides of a click. The inspector now takes a column of its own when it has something in
it, and production takes the rest — 1138px against 416px at 1600 wide — so a factory's
shortage and its slider are readable together. With nothing inspected, production still
gets the whole window.

**One question left open: should another nation's affinity be visible at all?** It is
shown for every nation at the moment. Most of it is inferable anyway, since the live
terms are computed from the public standings — but the stored channels are history, and
they say who has been attacked by whom and who has been poor together. Food output is
already a national secret on the same panel, and there is a case for this being one too,
or for showing rivals only the word and not the numbers. Worth settling when unions
arrive and the information is actually worth something.

### 10.3 The AI [F]

Two standard mechanisms, one per half, against a single objective: population is the
victory metric (§1.3), so people are the unit of account and firepower is valued for
what it protects and takes.

**The economy is a utility AI.** Candidate allocations are scored by a weighted sum —
growth, a garrison, parity with whoever is massed against you, and the force to carry
the cheapest crossing on your own frontier — and the best improving move is taken,
coarse steps first.

Growth carries the heaviest weight, because population is what the game is scored on
(§1.3) and it has to be able to defend itself against the military terms. Garrison and
parity are hard floors — one firepower per province is a garrison whether you post two
or ten — while growth and the conquest threshold keep paying a little past themselves,
so that once food is ample the margin splits between more food and more arms instead of
reverting wholly to one of them. A move may be a single worker, or a whole input tree bought at once
and proportioned the way the recipes need (§10.2), which is the only kind of move that
can open a cold chain. The weights encode the same intent a
priority list would, but they trade off rather than strictly outrank. Only improving
moves are accepted, which is the difference from `balanceAllocation` (§10.2): that one
chases the largest shortfall and can walk past a better allocation.

Each nation carries a **temperament** — militarism and a growth target, seeded per
continent so a world always faces the same opposition, like the nation names.

**The military is an influence map.** Every province gets a threat value (enemy
firepower, diffused) and an opportunity value (how good a place it is to attack *from*,
diffused). Marching is gradient ascent on opportunity, which produces concentration for
free: an inland province sees the best jumping-off point as uphill and goes there. Where
several provinces can together carry a target none could carry alone, they go together.

#### Three mistakes it took a stalemate to find

Each of these froze the game completely, and none would have shown up in a unit test.

- **Valuing the prize and ignoring the way in.** A road is worth four times a
  cross-country approach (§5.5), so opportunity has to be prize *per unit of force
  needed*. Without that, 53 firepower sat staring at a target it could never carry while
  the road in was held by a province with 3.
- **Marching up `opportunity - threat`.** Subtracting threat makes the border the least
  attractive ground on the map, because that is where the enemy is. One interior
  province ended up holding 132 of a nation's 194 firepower and never moving. Threat
  decides whether a province *holds*; it has no place in deciding where to send a
  reserve.
- **A utility that clamped shortfalls at zero.** A starving nation scored the same at
  -217 tons as at -80, so the whole region was a plateau and the hill climb did nothing
  for 140 turns. Saturate above, never below: less starving has to be visibly better.

A fourth, smaller: a combined assault needs `sum(effective) > defence + 10`, not ten per
wave. Each repulsed wave takes its strength off the defence, so only one bonus is ever
paid. Getting that wrong made the AI *worse* than not coordinating at all — 9 games
decided of 24 against 11 — and fixing it brought 12.

A fifth appeared only after the economy was fixed, and is the most instructive of them.
Both military terms — garrison and parity — are *met* at one firepower per province. An
AI that could not feed itself never reached that ceiling, so the gap went unnoticed; an
AI that could feed itself hit both ceilings cheaply and poured everything else into food.
Two efficient neighbours then sat on exactly enough to defend, neither could ever afford
an attack, and the board did not move for sixty turns. The utility had no term for
*offence*. It now scores the force that would carry the cheapest crossing on its frontier
(`Position.opening`), weighted by militarism so a peaceable nation still declines to use
it. The term rises as the neighbour arms, which is the arms race the game is named for.

#### A sixth mistake: the wrong things were expensive

Decomposing the score across the guns-and-butter split found three faults at once, and
all of them pushed the same way.

- **Growth was priced at a fortieth of a garrison.** As a fraction of population it was
  worth 0.026 where posting one firepower per province was worth 2.0, so a four-member
  union at Expert drove its food surplus from +102 to +1 — giving up all 47 people a
  turn it could have grown — to buy 32 firepower. The victory metric could not defend
  itself. It is now weighted at 3.0 and is the term the others trade against.
- **A famine the floor absorbs was charged as though it were real.** A nation sitting on
  its floor (§4.4.1) grows at zero however deep the shortfall goes, but the utility read
  the *surplus* and charged up to −4.59 for starving at nobody's expense — which is why
  every Expert nation sat at 7 to 10 firepower refusing to build. Reading growth instead
  of surplus fixes this for free, because `nextPopulation` already knows about the
  floor. A small `hunger` gradient on the raw surplus remains, because growth alone
  leaves the whole sub-floor region a plateau for the climb to get lost on.
- **Every need saturated hard.** The moment a garrison was posted the entire margin
  reverted to food, and the moment food met its target the entire margin reverted to
  arms. Growth and the conquest threshold now keep paying a log tail past themselves, so
  the two trade at the margin.

Measured over 30 turns at Expert on six continents, against the same runs before:

| | before | after |
| --- | --- | --- |
| Battles per game | 36 | **84** |
| Composition churn | 14% | **23%** |
| World population | x7.6 | **x9.5** |
| Games decided in 20 turns (all levels) | 3 of 12 | **6 of 12** |

More fighting *and* more growth, which is the tell that the two had been competing for
the same workers rather than trading honestly. Expert still decides no game inside 30
turns; §10.4 has the reason, and it is not this.

#### Where it stands

Across 24 games with every nation on the AI: **23 decided within 80 turns**, and the
board moved in all 24. Median 17 turns at beginner, 40 at intermediate. Before the
planner and the offence term it was 12 of 24. Militarism predicts the winner but does not
determine it, which is the intent.

#### Expert cannot feed itself, and that is not the AI's fault

Worldgen starts every nation at 1.4933 people per acre of farmland at all three levels
(§2), but the measured productivity parameters differ by level, and expert's tier-1
coefficients are far lower — 100 workers make 610 tons of farm tools at intermediate and
386 at expert (§3.4: advanced settings are "less efficient at smaller scales"). Solving
the staffing exactly (§10.2), the best any nation can reach alone:

| Level | Worst nation's best possible food surplus |
| --- | --- |
| Beginner | +127 |
| Intermediate | +43 |
| Expert | **-74** |

Higher tiers do not rescue it — at a starting nation's size iron plows and combines are
*worse* than farm tools, which is §3.4 working exactly as designed. So an expert nation
sits on the famine floor (§4.4.1) from turn one: it cannot starve and it cannot grow,
and the game is static for the human player just as much as for the AI. Intermediate is
marginal at +11.

#### …because expert is built around unions, and unions are the missing piece

**The Economic Union phase exists at Expert and nowhere else** (§1.1, §1.2.1). Expert is
also the only level where a nation cannot feed itself alone. That is not plausibly a
coincidence, and it reads §6.1's own words back at us: members' populations and terrain
pool into one economic unit, *"which, given superlinear productivity, is an enormous
efficiency gain. This is the whole point."*

At expert it is not an efficiency gain, it is survival. Pooling does not change the
population-to-farmland ratio, but the productivity exponent is above 1, so a bigger pool
feeds itself better at the same ratio.

**How much better was measured wrong, and the error was ours.** A first pass hill-climbed
the allocation and concluded that break-even took four to eight members — "two is not
enough" was stated here as a finding. It was a property of the search, not of the
economy. A cold chain yields nothing at any stage until every stage is staffed at once,
so no single-worker move improves anything and the climb stopped short of the chains that
mattered. With staffing solved exactly instead (§3.5, `src/planner.ts`) and every figure
verified back through `economy.resolve`, the food surplus a union of the *n* poorest
nations reaches is:

| Members | Thule | Kublai | Vashti | Nineveh |
| --- | --- | --- | --- | --- |
| 1 (alone) | −19 | −55 | −10 | −18 |
| 2 | −13 | −83 | **+22** | **+6** |
| 3 | **+2** | **+54** | **+225** | **+44** |
| 4 | **+21** | **+109** | **+371** | **+98** |

**Two is enough on ground that suits it; three is enough everywhere.** Which tool does it
is a property of the ground rather than the level: forest makes the farm-tools chain
cheap through lumber and charcoal, while mountains and coal favour iron plows, whose
tier-2 ton is worth two of food. Both were the right answer on two of the four continents
above, which is why the planner chooses per nation and not once.

Two structural facts fell out of chasing this, and both are worth keeping:

- **The starting population ratio is not a balance lever.** `baseYield`, `workersPerAcre`
  and `foodPerPerson` are all 1.0 (§4.1–§4.4), so the food a nation must buy with tools,
  `population − farmland`, is the *same number* as its spare workforce. Break-even is
  therefore exactly one ton of tier-1 food per spare worker, at every level and every
  nation size, and `populationPerFarmland` cancels out of it entirely. A sweep of that
  constant returned 0.00% growth at every value, which is what tipped it off.
- **An expert nation stagnates; it does not starve.** `POPULATION.floorPerAcre` and
  `WORLDGEN.populationPerFarmland` are the same measured 1.4933, so a nation's famine
  floor *is* its starting population. Even a 250-ton deficit costs one person and then
  holds forever. Expert is the tier where farming cannot grow you and only ground can —
  which is the Global Dilemma stated as cleanly as the design ever states it. (§4.4.1
  lists "does the floor track farmland or the starting population" as open; at the
  starting ratio the two coincide, so this does not settle it.)

So expert is not mis-tuned, and it is less incomplete than this section first claimed:
the human player and the AI can both reach growth by pooling two nations on half the
continents and three anywhere. Unions remain the missing piece for judging the level as a
whole, and the sequencing still matters — §6.1's rule that *the weakest player declares
the union* is exactly what a level where the weak cannot survive alone would need.
Whether affinity (§6.4) actually produces unions of two or three is the open question,
and it cannot be answered until step 7 is built.

Two caveats worth carrying into that work. There are no expert population readings in
§4.4.1 — all 29 are from Beginner and Intermediate — so the response is unverified at
that level. And a union lasts one turn (§6.1), so a nation that pools to eat has to pool
again next turn, which makes the acceptance test in §6.4 — a roughly flat rate of union
formation — a survival requirement at expert rather than a nicety.

### 10.2 Limits of `balanceAllocation`

Auto-balance is scaffolding, not the AI, and playing it exposed how far it is from one.
Two flaws were fixed because the UI exposes the function directly to the player:

- It could only ever top up a factory that was **already running**, so a chain stalled
  on an unstaffed input stayed stalled. Muskets want iron, iron had no share at all, and
  eighty passes shuffled lumber and charcoal without once touching iron.
- Nothing consumes a finished good, so its entire output read as surplus and it always
  looked like the richest donor in the economy — the balancer **drained the very factory
  the player had just asked for**, taking swords from 0.35 down to 0.07 and output from a
  peak of 59 tons to 35.

Two deeper flaws were left for step 6 and then turned out to be the more expensive ones:

- The search was greedy on a single largest shortfall and followed the limiting factor
  exactly one step, so it could not feed a cold chain with more than one missing input.
  Muskets need iron *and* gunpowder; iron needs coal; gunpowder needs sulfur. The whole
  chain has to open at once and the heuristic opened one link at a time.
- It was not monotone. Sword output over eighty passes went 47 → 58 → 70 → 45: it walked
  past a better allocation and kept going, because it optimised "surplus near zero"
  per §3.5's advice rather than any stated objective.

**Both are now gone, because the split is solved rather than searched.** Output is
`k * workers^a` per factory and recipes are fixed ratios, so the labour any target
tonnage costs can be computed outright, and it rises monotonically with the target: one
binary search gives the most a workforce can make (`src/planner.ts`). Auto-balance reads
the finished goods the player has staffed as the goods they want, divides the workforce
between them in proportion, and staffs each one's whole input tree to the largest tonnage
its share can pay for. Locked factories keep their labour and their output is credited
against what the chains need, so locking a working mine now helps the chains above it.

The measured difference at expert, on a two-nation union's food surplus:

| Continent | Nudging | Solved |
| --- | --- | --- |
| Thule | −73 | −13 |
| Kublai | −154 | −83 |
| Vashti | −77 | **+22** |
| Nineveh | −77 | **+6** |

A third flaw only showed up once the first two were fixed: seeded with a finished good on
its own, the nudge could not start **at all**. Nothing consumes a sword, so with only
swords staffed no factory had a surplus to donate and it gave up on the first pass. The
solver has no such state — a finished good on its own is the clearest possible statement
of what the player wants.

### 10.4 What unions do, measured

§6.1 implemented as written, with §6.4's affinity gating membership, produces unions
readily — and produces the same shape of union every turn.

Across 18 games at Expert, 30 turns each:

| | |
| --- | --- |
| Unions per turn | 2.00 early, 2.00 late — **flat**, which is what §6.4 asks for |
| Mean size | 3.9 of 8 nations |
| Nations attached | **94–99%** |
| Composition changed | **14–22% of turns** |
| World population over 30 turns | **x6 to x7.6** |
| Games decided in 30 turns | **0 of 6** |

The flat rate is the headline success: Crawford's failure is visibly a decay curve to
zero (§6.3), and this does not decay. The cooperation dividend and the saturating
updates do their job — distrust never ratchets shut.

**But the composition barely moves, and that is the failure mode §6.4 names**: "if the
rate holds but composition freezes, the underdog dividend is too strong relative to the
live terms." The board settles into two blocs of four and stays there. Raising the join
threshold hardly touches it — at `joinAt` 0.45, attachment only falls from 99% to 93% —
because the target of a union is by construction the founder's worst enemy, who is
usually the leader, whom the live terms make everyone dislike. So almost everyone
prefers almost any founder to almost any target, and joins.

Two consequences follow, and the second is the serious one:

- **Expert stops being a war.** With 99% of nations in a union, almost nobody is free to
  fight on their own account. No game reached a winner in 30 turns.
- **Growth runs away.** Pooling four Expert economies is worth x6–x7.6 world population
  in 30 turns, against nations that stagnate at their famine floor alone (§10.3). §6.3
  records unions as the *only* brake on runaway growth; implemented faithfully they are
  an accelerator instead.

None of this is a defect in the code — it is §6.1 doing exactly what it says, which is
the outcome §6.3 warns about arriving by a different road. The dials, in the order §6.4
suggests turning them: the underdog `trust` component first, then `joinAt`, then a cap
on union size, which is the one thing no source mentions and the one most likely to
restore the churn.

#### Relaxing the attack restriction changes almost nothing [F]

§6.1 says members may attack the union's target and *nobody else*, neutrals included.
Read literally that leaves a member whose target lies across the continent with no legal
attack at all, however hostile the neighbour on its own border. `canAttack` therefore
also permits attacking any nation in no union at all; blocs remain exclusive toward each
other, and members still may not touch each other.

**It was worth doing and it did not help.** The measured difference at Expert is inside
the noise:

| | §6.1 literal | relaxed |
| --- | --- | --- |
| Unions per turn | 2.00 | 2.03 |
| Attached | 93–99% | 94–99% |
| Composition churn | 15% | 14% |
| World population, 30 turns | x6–x7.5 | x6–x7.6 |
| Decided in 30 turns | 0 of 6 | 0 of 6 |

The reason is the attachment rate. A permission to attack "anyone unaligned" is worth
nothing when there is, on average, a tenth of a nation unaligned per turn. Raising
`joinAt` to 0.45 only brings attachment to 94%, and still decides nothing.

**So the funnel was never the binding constraint — universal membership is.** That
relocates the problem: the dial to reach for is not the attack rule or the join
threshold but whatever stops nine nations in ten joining something every single turn.
§6.4's own candidate is the underdog dividend; a cap on union size is the blunter one,
and is mentioned in no source.

#### Pooled terrain buys nothing by itself, and costs the modicum [F]

All four terrain types pool, and every raw in the union draws on the summed acreage, so
a member with no mountains can put labour into coal that another member's mountains
support. That much is §6.1 as written, and it is the reason a union can make petroleum
when no member could alone.

But raw capacity is `(base + m · acres) · L^a` (§2.2) and **the acreage term is linear**,
so pooling acres multiplies nothing: double the acres and double the workers and the
`m · acres` part simply scales through. The whole union gain is the labour exponent.
Terrain decides *what* a union can make, never *how much more* per worker.

There is a consequence worth stating plainly, because it looks like a bug when you meet
it. `base` is the design dialogue's "modicum of natural resources" — what you extract
with no favourable ground at all. One economic unit gets **one** modicum, where the
members separately had one each:

| Raw | `base` | union / separate, 4 members | pure labour gain `4^a` |
| --- | --- | --- | --- |
| Iron ore (nations with no mountains) | 0.53 | **1.21x** | 4.85x |
| Lumber | 0.75 | 2.86x | 4.81x |
| Sulfur | 0.02 | 10.65x | 11.03x |
| Petroleum | 0.00 | 21.39x | 22.08x |

Where the intercept is ~0 the union gets the full labour gain; where it dominates, four
nations pooling get 1.21x the iron ore for 4x the workers. Measured against food
surplus, giving each member's land its own modicum instead would be worth +40 to +131
tons on a two-union and +55 to +472 on a four-union — the difference between a
two-nation union starving and feeding itself on half the continents tested.

**Kept as one modicum per union, deliberately.** The intercept was fitted as a
per-economy floor across 53 readings, not as a property of any particular acre, so one
economy taking one floor is the reading the measurement supports. The alternative —
coefficients summing per member, `sum(base + m · acres_i)` — is defensible on the
grounds that merging should not destroy natural resources, and it would make pooling
cleanly equal to the labour exponent everywhere. It is a one-line change through the
`overrides` hook if the runaway growth above ever needs offsetting in the other
direction.

None of this is a defect in the code — it is §6.1 doing exactly what it says, which is
the outcome §6.3 warns about arriving by a different road. The dials, in the order §6.4
suggests turning them: the underdog `trust` component first, then `joinAt`, then a cap
on union size, which is the one thing no source mentions and the one most likely to
restore the churn.

### What is still unmeasured

The population response is now measured too (§4.4.1): 29 readings from the DOS build fix
all four constants, growth to a median 4.7% and decline to a median 0.0%. Two of the
manual's `[C]` claims about it did not survive contact with the data — growth is linear
with saturation rather than a square root, and an all-labour tier-1 start yields 14.5%
growth rather than the stated 30%.

Nothing in the economy is now unmeasured. Two smaller questions about population remain
open and are described in §4.4.1: whether the famine floor tracks farmland or the starting
population, and whether decline saturates at deficits deeper than any yet measured.

One smaller data gap, not blocking: Petroleum has only seven non-zero readings and is
the weakest fit in the table — the row to re-measure first.
