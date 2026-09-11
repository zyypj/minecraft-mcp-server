# `@mcbuild/engine`

A deterministic build engine for **Minecraft 1.8.9**. Zero runtime dependencies.

The engine exists to move the level of abstraction. An agent should be deciding

> *a circular tower of radius 12 and height 35*
> *an eight-team BedWars map in the carousel style with a 34-block rush*

not enumerating the thirty thousand blocks that make one.

```
intent -> plan -> geometry ops -> voxel volume -> validation -> preview + .schematic
```

Nothing here talks to a Minecraft server. A build is a `Volume` in memory until something exports
it, which is what makes *look at it before it goes live* the default rather than an extra step.

---

## The rule that shapes everything

**Never resolve a complex build through thousands of individual block placements.** Always reach for
the highest-level operation that fits: domain generator, then structure, then geometry, then region
op. Single-block writes exist for final adjustments and nothing else.

That rule is why the module list below is shaped the way it is: each layer exists so the layer above
it can stay declarative.

---

## Layers

### `core/` — the voxel substrate

A block is `(id << 4) | data` packed into one `Uint16` cell. One array, not two: a cell is a plain
number, so comparisons, histograms and hashing are cheap and the two halves cannot drift apart. The
layout is `index = (y * length + z) * width + x` — byte-for-byte the MCEdit `.schematic` layout, so
export is a split rather than a transpose.

`Volume` also carries **nestable change journals**: every write can be recorded by several
recorders at once, which is what lets a map, a team island and a single roof each hold their own
exact inverse patch simultaneously.

Alongside it: a seeded `mulberry32` PRNG with labelled sub-streams, and gradient noise (fbm, ridged,
domain-warped) that drives every organic shape in the engine.

### `mc18/` — the 1.8 compatibility layer

- **`blocks.ts`** — the complete 1.8 registry, ids 0-197, with render classes and average texture
  colours. Ids not in this table did not exist in 1.8.
- **`material.ts`** — the `MaterialResolver`. In **strict** mode (the default) a post-1.8 block is an
  error naming the nearest legal substitute; in **substitute** mode it is mapped and reported. There
  is no third mode where a wrong block silently becomes grey.
- **`rotation.ts`** — data-value transforms for every orientation-carrying 1.8 family: stairs, the
  `2=north..5=east` set, doors, beds, rails including curves, vines, mushroom caps, axis pillars,
  banners. Rotating without this is the single most common way a copy-paste map generator looks
  broken.
- **`palette.ts`** — named material **roles** (`WALL_PRIMARY`, `TERRAIN_TOP`, `ROOF_PRIMARY`, ...),
  weighted mixes sampled from a *positional hash* so texture is stable under re-render, and ordered
  ramps for gradients.

### `schematic/` — legacy I/O

A self-contained NBT codec and a legacy MCEdit `.schematic` reader/writer. Output is always MCEdit
legacy, because that is what 1.8-era WorldEdit reads. Input also accepts Sponge `.schem` v2/v3 and
maps its modern names back onto 1.8, reporting every approximation.

Writing is byte-stable: identical logical content produces an identical file.

### `geom/` and `ops/` — shapes and region operations

Shapes are *predicates over cells*, rasterized over a bounding box. Shells are the predicate minus an
inset copy of itself, which gives even wall thickness — measurably better than eroding a filled
shape, which thins at the poles of a sphere.

Radii follow the WorldEdit convention (radius 3 spans 7 blocks), so numbers copied from an existing
workflow reproduce it.

Region ops: replace (orientation-insensitive), dithered gradients, hollow, outline, smooth, scatter,
surface paint, copy/paste/rotate/mirror, and radial instancing with symmetry measurement.

### `terrain/`, `structures/`, `sculpture/` — composition

- **Organic islands.** A warped-noise edge field, a tapered depth profile, 3D noise on the underside
  for overhangs, and a nearly flat top because gameplay needs a buildable plateau. A disc of grass on
  a cylinder of stone reads as programmer art no matter what is built on it.
- **Roofs** in nine styles, with the eave overhang that casts the shadow line reading as *built*.
- **Buildings** composed from named components: foundation, main volume, floor bands, openings,
  entrance, roof, interior. Every default exists to break a flat plane.
- **Voxel sculpture** by two independent paths: parametric part models (13 generic archetypes) and
  three-view silhouette carving. The archetypes are *forms*, not likenesses — for a specific
  character, trace it into silhouettes or extract it from your own reference schematic.

### `style/` — the Structure Knowledge Base

Reference schematics are **measured, not trained on**. Ingestion computes:

| Measurement | How |
|---|---|
| Palette | Block counts weighted by *surface exposure*, so interior fill does not dominate |
| Colours | Weighted k-means over visible blocks |
| Ramps | Co-adjacency lift plus monotone luminance ordering |
| Symmetry | Mirror and 2/3/4/5/6/8-fold rotational scores |
| Composition | Coarse-grid mass clustering, then radial / linear / grid / clustered classification, and a focal ratio |
| Terrain | Void ratio, edge roughness against a perfect disc, thickness, relief, height plateaus |
| Density | Fill, surface, decoration, stairs-and-slabs, glass |
| Motifs | Rotation-invariant chunk hashing, so eight copies of one pillar are one motif used eight times |

Everything is written as JSON a person can read, edit and disagree with. That is the practical
difference from a learned black box: when a generated map comes out wrong you can open
`palette.json`, see that the analyzer put `cobblestone` in `WALL_PRIMARY`, change it, and every later
build uses your choice.

Blending has three separate knobs, because they answer three different questions:

- **weights** — whose vocabulary (`carousel 0.7 / snoopy 0.3`)
- **fidelity** — how closely to follow the measurements
- **originality** — how much deliberate divergence to add on top

High fidelity with high originality is the interesting combination: unmistakably the same builder's
hand, definitely not the same map.

### `history/` — ids and time travel

`BuildGraph` gives every structure a **permanent id** and records the inverse patch of what it wrote,
the parameters it was built from, and its seed. That makes *redo only the roofs of the team islands*
a real operation rather than a rebuild.

`History` adds undo/redo on the same patches, plus named checkpoints (deflated full snapshots) and a
checkpoint diff that reports **per-block deltas** — "you added 4,200 pink wool and removed 3,100
quartz" describes a redesign in a way a cell count never does.

### `validate/` — the checks that a render cannot do

- **Constraints** as both a *write mask* (a generator physically cannot place blocks in a rush lane)
  and a *post-build check* (distances, symmetry, budgets).
- **Inspection**: floating masses, isolated blocks, sealed pockets, single-cell surface holes,
  suffocation risks, blocks that do not exist in 1.8.
- **Gameplay**: Dijkstra pathfinding over standable cells with Minecraft's own movement rules, and
  bridging cost computed separately for straight, diagonal and staircase placement — three different
  amounts of wool and three different amounts of exposure.

### `render/` — the eyes

A software rasterizer: own 4x4 matrices, own depth buffer, own PNG encoder. No GPU, no headless
browser, no native modules. Voxels become boxes sized by render class, faces of full cubes touching
other full cubes are culled, and each face gets a per-face brightness plus per-corner ambient
occlusion.

Five preset views, chosen because they answer the five questions a builder asks: `perspective`
(does the silhouette read?), `front` and `side` (are the heights right?), `top` (is the layout
balanced?), and `gameplay` — the plan view annotated with spawns, generators and rush distances,
which is the one that says whether a map is *competitive* rather than merely pretty.

### `domain/` — BedWars and duels

The BedWars generator runs in passes, and their order is the most important decision in the file:

```
 1 Gameplay layout   positions derived from rush distance and team count
 2 Terrain           islands sized to hold what pass 3 needs
 3 Major structures  bed platforms, spawn pads, shop areas
 4 Landmark          the focal sculpture
 5 Architecture      buildings, fitted around the gameplay furniture
 6 Paths
 7 Decoration        masked away from every clearance
 8 Details           generator pads, spawn clearing
 9 Gameplay checks   constraints, distances, symmetry
10 Structural checks floating blocks, sealed pockets, suffocation
```

Positions are fixed in pass 1 and every later pass is masked away from them, so a giant carousel
cannot eat a rush lane: the lane existed before the carousel did.

Two consequences worth knowing:

- **Ring radius is solved, not chosen.** For `n` teams on a circle, adjacent bases are
  `2 R sin(pi/n)` apart, so `R = rush / (2 sin(pi/n))`. `rushDistance` is therefore a real control
  over the whole map.
- **Team islands are instanced from one template.** Terrain noise is sampled in world coordinates,
  so islands generated in place would differ however carefully their seeds were matched. Built in a
  local frame and instanced, they are identical by construction. Position is exact on the ring;
  block orientation snaps to the nearest quarter turn, because 1.8 cannot express a 45-degree stair.
  The spawn is then nudged onto its exact ring position so rush distances come out with **zero
  spread**.

### `project/` — the build folder

```
builds/carousel_map_01/
  build.schematic     1.8 MCEdit, ready for //schem load
  manifest.json       name, version, dimensions, blocks, theme, seed, full spec
  build.json          the structure graph, with permanent ids
  palette.json        the palette it was built in
  analysis.json       gameplay report, inspection, violations
  README.md           the same, for a person
  preview/            perspective.png front.png side.png top.png gameplay.png
```

The manifest carries the seed and the whole spec, so a build is reproducible from the folder that
describes it.

---

## Using it

```ts
import { buildBedwarsMap, renderViews, writeBuildOutput } from "@mcbuild/engine";

const map = buildBedwarsMap({
  teams: 8,
  seed: 918271,
  theme: "carousel",
  rushDistance: 52,
  landmark: { archetype: "cartoon_dog", height: 44 },
});

console.log(map.analysis.rushDistance);  // { min: 56.1, max: 56.1, mean: 56.1, spread: 0 }
console.log(map.violations);             // []

writeBuildOutput({
  dir: "builds/carousel_01",
  name: "carousel_01",
  volume: map.volume,
  seed: map.seed,
  palette: map.palette,
  graph: map.graph,
  analysis: map.analysis,
  inspection: map.inspection,
  violations: map.violations,
});
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The test suite covers the schematic round-trip, transform correctness including block data, history
and the structure graph, style analysis, validation, and end-to-end generation — including a
determinism check that the same seed rebuilds the same map cell for cell.
