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

### 1.2 Turn phases [C]

Strictly sequential; **no going back** once a phase is advanced.

0. **Economic Union** *(Expert only, runs before production)*
1. **Production** — allocate labor across factories
2. **Military Orders** — per province, set the marching fraction and its destination
3. **Military Execution** — friendly transfers resolve first, then battles
4. **Rankings** — standings by population; autosave; `Undo Turn` available *here only*

The autosave is keyed on continent name + level, which is why the shipped game
directory contains `KITTYCAT.B/.I` and `OLMI.B/.I`.

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

There is also a **guaranteed floor on every resource**, independent of terrain — an
explicit design decision, so that a badly-seeded start is not unwinnable:

> "we must not take it so far that a particularly unfortunate mortal would never be
> able to get his economy started ... Let us provide a modicum of natural resources to
> each mortal, augmented by a bounteous supply for those blessed with the proper
> terrain."

Reconciling those two statements: the endowment is additive per province with a
non-zero floor, and it acts as a **productivity multiplier** on the raw extraction
industries rather than as a hard output ceiling:

    capacity_raw = k_raw * f(endowment_raw) * L^a_raw        with f(0) > 0

**Only the eight raws take a terrain term.** Intermediates, tools and weapons consume
commodities rather than land, so their capacity is unmodified. Farmland is separate
again — it feeds acreage into §4, not this multiplier.

### 2.2 Terrain magnitude — measured

**No source gives a per-acre coefficient.** The manual says only "a lot more workers,"
ch24 says only "a fixed amount," and the design dialogue says only "a modicum ...
augmented by a bounteous supply." There is no number to recover; `f` must be measured
or chosen.

**The multiplier reading is confirmed in-game** [C]. In an Intermediate game, Lumber's
`Limiting Factor` reads `Labor` at *every* worker allocation, however far it is pushed.
The endowment therefore scales productivity; it is **not** a hard output ceiling, and
the formula above stands.

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

Twenty-one readings across all three difficulty levels; forest acreage read off the
province closeups. Refit any time with `docs/fit-terrain.py`.

| Level | Continent | Forest acres | L=10 | L=25 |
|---|---|---|---|---|
| Beginner | One | 0 | 89 | — |
| Beginner | trebolokhan *(1990 manual, L=27)* | terrain off | — | 268 |
| Intermediate | One | 0 | 29 | — |
| Intermediate | Six | 0 | 29 | — |
| Intermediate | Four | 9 | 39 | — |
| Intermediate | Seven | 17 | 51 | 144 |
| Intermediate | Two | 26 | 65 | — |
| Intermediate | Five | 50 | 101 | 288 |
| Expert | Eleven | 0 | 10 | 29 |
| Expert | Three | 8 | 21 | 58 |
| Expert | Four | 9 | 21 | 58 |
| Expert | Two | 20 | 37 | 103 |
| Expert | Five | 35 | 56 | 160 |
| Expert | One | 44 | 72 | 201 |

#### The exponent is measured: `a ≈ 1.13`

Eight same-continent worker pairs. Minimising within-pair disagreement gives
**`a = 1.1299`**. Independently, the 1990 manual screenshot (L = 27 → 268) with the
new Beginner reading (L = 10 → 89) gives **`a = 1.1098`** — two observations 36 years
apart on different continents, agreeing to 2%. My originally assumed 1.100 predicted
89.87 against an observed 89.

`a` shows **no trend with acreage**, which rules out the "terrain acts as extra
effective labour" model (`C = k(L + w·acres)^a`): under that, the apparent exponent
would fall as acreage rises. It does not.

#### `f` is LINEAR in acreage, with a floor

**This overturns the convexity conclusion I drew from the first three points.** That was
an artefact of the floor — with only 0, 9 and 26 acres, the 0-acre point sitting *above*
the trend made the first segment look shallow, which reads as convexity. Eleven
acreages across two levels show the real shape.

    y = C / L^1.1299 = max(floor_level, base_level + m * acres)

| Level | `base` | `m` per acre | `floor` | fit rmse | dof |
|---|---|---|---|---|---|
| Intermediate | 1.8673 | 0.1134 | 2.150 | 0.005 | 2 |
| Expert | 0.6421 | 0.1043 | 0.752 | 0.071 | 3 |
| Beginner | terrain disabled — flat `y = 6.599` | — | — | — | — |

Intermediate is near-exact: residuals **+0.004, −0.008, +0.004, −0.000** across 9–50
acres. Expert is 14× looser, which is discussed below.

**The floor is confirmed at both levels, and replicated.** Continents One and Six both
return exactly 29 at 0 acres Intermediate (0.00% spread), and Expert Eleven supplies the
0-acre Expert point. In both cases the 0-acre value sits *above* the extrapolated line:

    floor / base  =  1.151 (Intermediate)   1.171 (Expert)

So the floor is a **~16% markup over the zero-acre extrapolation at both levels** — the
design dialogue's *"modicum of natural resources to each mortal"* implemented as a
`max()`. It binds only in the first acre or two.

#### The level scaling

**The slope is level-independent; the base and floor are not.**

    slope  Int/Exp = 1.087   (~1, i.e. an acre is worth the same everywhere)
    base   Int/Exp = 2.908
    floor  Int/Exp = 2.859

Base and floor scale together by the same ~2.9. Against player count (Intermediate 4,
Expert 8) the candidates land as:

| Hypothesis | Predicted ratio | Predicted `base_Exp` | Error |
|---|---|---|---|
| `1/players` | 2.00 | 0.934 | 45% |
| **`1/players^1.5`** | **2.83** | **0.660** | **3%** |
| `1/players^2` | 4.00 | 0.467 | 27% |
| `1/(players−1)` | 2.33 | 0.800 | 25% |

`players^-1.5` fits to 3%, and 1.5 is a suspiciously clean exponent. **But this is two
data points against a one-parameter family — it is a hypothesis, not a result.** Player
count, map size, total province count and per-nation acreage all co-vary with difficulty
level, and nothing measured so far separates them.

Working values for implementation:

    m     = 0.11 per acre                      (level-independent)
    base  = 1.867 * (4 / players)^1.5          (calibrated at Intermediate)
    floor = 1.16 * base
    a     = 1.13

Beginner's terrain-off `y = 6.599` corresponds to ~42 Intermediate or ~57 Expert forest
acres, so **"terrain off" behaves like a well-endowed nation** — confirming the §3.4
fitted `k` values are optimistic baselines, not neutral ones.

#### The Expert scatter is consistent with ±1 acre of reading error

Expert's rmse is 0.071 against Intermediate's 0.005. Inverting the fitted line to ask
what acreage each reading *implies*:

| Read | Line implies | Δ |
|---|---|---|
| 8 | 8.63 | +0.63 |
| 9 | 8.63 | −0.37 |
| 20 | 20.00 | −0.00 |
| 35 | 33.94 | −1.06 |
| 44 | 44.80 | +0.80 |

Every discrepancy is under ±1.1 acres. The tell is continents **Three (8 acres) and Four
(9 acres) returning byte-identical output** — 21 at L=10 and 58 at L=25. At 0.104 per
acre, one acre should move L=10 output by ~1.4, which is more than integer rounding can
hide. Both readings are consistent with a true value near 8.6.

So the Expert looseness is most likely **measurement error in the acreage, not model
error** — and it would also explain why Intermediate, with larger outputs and fewer
readings, looks tighter. This matters for the next round: how acreage is obtained is now
the limiting factor on precision, not how many readings there are.

#### Still open

1. **What actually drives `base`?** Record **total acreage and province count** per
   nation alongside the forest acres. If `base` tracks nation size rather than player
   count, it is not a difficulty multiplier at all and the formula above is
   mis-specified. This is the highest-value remaining measurement.
2. **Is the acreage figure exact or counted?** If the province closeup prints a number,
   the Three/Four collision needs another explanation — possibly the endowment is
   quantised. If it is counted off map icons, ±1 is expected and the model is fine.
3. **A Beginner series is impossible** (terrain disabled), so the level scaling rests on
   two points. An Intermediate-vs-Expert comparison cannot be done on a shared map
   either: the same continent name yields different terrain at different levels, as
   continent One's 0 / 0 / 44 acres across the three levels shows.
4. **Do mountains and deserts behave the same?** Repeat against Iron Ore or Coal, and
   against Sulfur.
5. **Is `a ≈ 1.13` specific to Lumber?** Only Lumber is measured. See §3.4.

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

#### How `a` is assigned

**Two different rules, because two different things are going on.** Crawford's stated
rule is about *technological* advancement, not graph position, so:

- **Raws and intermediates** — exponent follows **graph depth**:
  `a = 1.100 + 0.025 × depth`. These form a chain of increasing processing
  complexity, so depth is the right proxy.
- **Tool and weapon tiers** — exponent follows **tech tier**:
  `a = 1.20 + 0.04 × (tier − 1)`, giving 1.20 → 1.36.

Do **not** use depth for the tiers. Depth and tier disagree there (§8.4): Cannon sits
at depth 2 but is weapon tier 4, and Sword at depth 3 is tier 1. Driving `a` off depth
would hand Sword a *larger* economy-of-scale exponent than Cannon, inverting the whole
technological progression. The split to remember: **depth governs allocation priority,
tier governs the exponent.**

The 0.04 step and the 1.36 ceiling are a deliberate choice, not a recovered value.
Crawford's design failed partly to runaway growth (§9.2), and the exponent spread is
the main dial controlling how hard the leader compounds. Widen it only with playtesting.

#### How `k` is assigned

- **Five industries are anchored** to the §8.1 reference state by
  `k = capacity / L^a`: Lumber, Iron Ore, Charcoal, Pig Iron, Farm Tools.
- **Tool and weapon tiers are derived** from the confirmed 342 t crossover (§4.3),
  anchored on the Farm Tools fit. Labour parity at the crossover requires
  `(342 / k_n)^(1/a_n) = (171 / k_{n+1})^(1/a_{n+1})`, so
  `k_{n+1} = 171 / (342 / k_n)^(a_{n+1}/a_n)`.
  Verified: the crossover lands at 45.4 / 79.4 / 136.4 / 230.7 workers for tiers
  1→2 / 2→3 / 3→4 / 4→5, identical on both sides of each step.
  Weapon tiers reuse the agricultural chain, which makes tier-1 guns and tier-1 butter
  an exactly even labour trade — thematically the right anchor for this game, but [F].
- **Everything else is a placeholder.** Intermediates use a per-depth base with a
  10% penalty per input beyond the first (`k = base_depth × 0.9^(inputs−1)`),
  bases back-fitted from Charcoal and Pig Iron. Unfitted raws are ranked by how bulky
  and common the material is. These are starting numbers to make the sim run, not
  recovered data.

| Industry | Class | `a` | `k` | 2× labor → | Source |
|---|---|---|---|---|---|
| Lumber | raw | **1.1285** | **6.5599** | 2.19× | **measured** (§2.2) |
| Sulfur | raw | 1.100 | 4.5000 | 2.14× | placeholder |
| Iron Ore | raw | 1.100 | 5.1716 | 2.14× | fitted (see caveat) |
| Coal | raw | 1.100 | 6.0000 | 2.14× | placeholder |
| Light Metal | raw | 1.100 | 4.0000 | 2.14× | placeholder |
| Nitrate | raw | 1.100 | 4.0000 | 2.14× | placeholder |
| Heavy Metal | raw | 1.100 | 3.5000 | 2.14× | placeholder |
| Petroleum | raw | 1.100 | 3.0000 | 2.14× | placeholder |
| Charcoal | depth 1 | 1.125 | 6.5279 | 2.18× | **fitted** |
| Pig Iron | depth 2 | 1.150 | 4.6430 | 2.22× | **fitted** |
| Gunpowder | depth 2 | 1.150 | 4.6430 | 2.22× | placeholder |
| Iron | depth 1 | 1.125 | 5.8751 | 2.18× | placeholder |
| Low-Grade Steel | depth 1 | 1.125 | 5.2876 | 2.18× | placeholder |
| Explosives | depth 2 | 1.150 | 4.1787 | 2.22× | placeholder |
| High-Grade Steel | depth 1 | 1.125 | 5.2876 | 2.18× | placeholder |
| High Explosives | depth 1 | 1.125 | 5.2876 | 2.18× | placeholder |
| Steam Engine | depth 2 | 1.150 | 4.6430 | 2.22× | placeholder |
| Wire | depth 1 | 1.125 | 6.5279 | 2.18× | placeholder |
| Pipe | depth 1 | 1.125 | 6.5279 | 2.18× | placeholder |
| Electrics | depth 2 | 1.150 | 4.6430 | 2.22× | placeholder |
| Ball Bearing | depth 2 | 1.150 | 4.6430 | 2.22× | placeholder |
| Diesel Engine | depth 3 | 1.175 | 2.9721 | 2.26× | placeholder |
| Instruments | depth 3 | 1.175 | 3.6693 | 2.26× | placeholder |
| Farm Tools | tool tier 1 | 1.200 | 3.5126 | 2.30× | **fitted** |
| Iron Plow | tool tier 2 | 1.240 | 1.5077 | 2.36× | crossover |
| Combine | tool tier 3 | 1.280 | 0.6328 | 2.43× | crossover |
| Irrigation | tool tier 4 | 1.320 | 0.2599 | 2.50× | crossover |
| Tractor | tool tier 5 | 1.360 | 0.1045 | 2.57× | crossover |
| Sword | weapon tier 1 | 1.200 | 3.5126 | 2.30× | crossover |
| Musket | weapon tier 2 | 1.240 | 1.5077 | 2.36× | crossover |
| Rifle | weapon tier 3 | 1.280 | 0.6328 | 2.43× | crossover |
| Cannon | weapon tier 4 | 1.320 | 0.2599 | 2.50× | crossover |
| Tank | weapon tier 5 | 1.360 | 0.1045 | 2.57× | crossover |

Ordering matches §3.2 (raws) then §3.3 (recipes). `Food` has no `k`/`a` — agricultural
labour is fixed at 1 worker/acre (§4.1) and yield comes from §4.2.

**The one measured exponent came in above its assumed class value.** Lumber is now
measured at `a = 1.1285` (§2.2), against the 1.100 this table assigned to every raw.
Its `k = 6.5599` is the mean of the two Beginner terrain-off estimates (6.6205 from
the new L=10 reading, 6.4989 from the manual's L=27 point), which is what `f = 1`
means here. Two
consequences:

- The raw baseline should probably be **1.13, not 1.10**, which shifts the whole
  depth rule up by ~0.03. I have not applied that to the other rows, because one
  measurement across eight raws does not justify moving seven untested numbers.
- Iron Ore's `k = 5.1716` is still fitted at the *assumed* `a = 1.100`. At
  `a = 1.1285` it refits to **4.6938**. Whichever exponent you adopt, refit `k`
  alongside it — they are not independent.

The cheap test is the §8.3 two-worker-count measurement repeated on one more raw, one
intermediate and one tool tier. If those also land ~0.03 high, shift the base of both
rules and refit every `k`.

The steep `k` collapse across tiers (3.51 → 0.10) is the intended shape, not an error:
an advanced tool is near-useless at small scale and dominant at large, which is exactly
what forces tech transitions to follow population growth.

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

Suggested form [I]:

    surplus = food - population
    if surplus >= 0: population += G * sqrt(surplus)
    else:            population -= D * sqrt(-surplus)

with `G` calibrated to the 30% boundary condition and `D > G` [F] to make famine
bite harder than plenty rewards.

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
  power brought against it. Scorched earth — a big conquest guts the prize.

### 5.6 Execution order [C]

1. All friendly transfers resolve **first** — so defensive reshuffling beats incoming
   attacks, and anticipating an attack is rewarded.
2. Then battles. **Multiple attacks on one province resolve in sequence**, so the
   first wave can soften a defender for the second.

This ordering is what generates the game's best tactics: attacking from several
directions; counter-attacking the enemy's stripped jumping-off province; screening
that counter-attack with reserves. It is cheap to implement and should be preserved
exactly.

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

---

## 7. Data model sketch

```ts
type CommodityId = string

interface Commodity {
  id: CommodityId
  priority: number                          // display order == allocation priority
  inputs: { id: CommodityId; perTon: number }[]
  k: number                                 // productivity coefficient
  a: number                                 // productivity exponent, > 1
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

## 10. Recommended build order

1. **Economy sim, headless.** Commodity graph, productivity function, demand-driven
   allocation, food and population. Assert against the §8.1 reference state — it is a
   complete, self-consistent test fixture. Get this right before drawing anything.
2. **Map generation.** Seeded by name. Provinces as the dual of a road graph.
3. **Military.** Continuous firepower, two orders per province, the §5.5 formula,
   transfers-before-battles.
4. **AI opponents.** [F] — nothing is recoverable about Crawford's AI beyond the
   union-declaration rule in §6.1.
5. **Diplomacy**, with the §9.1 fix in from the start.
6. **UI.** This is where the original lost, so budget accordingly.

Two independent oracles are available while you build: the DOSBox build of the
original, and the §8.1 fixture.
