# Minecraft Artistic Build Engine — Overarching Architecture & Design Plan

> [!NOTE]
> **Status update.** This document is the original design proposal, which targeted Minecraft 1.21.x
> with a Paper plugin committing blocks into a live world.
>
> The engine that was actually built took a different direction, chosen deliberately: it targets
> **Minecraft 1.8.9**, runs **entirely offline**, and produces `.schematic` files plus preview
> images rather than writing to a server. The renderer is a software rasterizer in-tree rather than
> a headless-browser stack, and the whole engine has zero runtime dependencies.
>
> Much of the thinking below still applies and was carried across — the four-role separation, passes
> over a shared blackboard, palette-by-role, style packs as data, the anti-slop rules, the
> validate-before-commit discipline. See [`engine/README.md`](engine/README.md) for what exists.


**Status:** Design proposal, pre-implementation. Review the Open Questions (§11) before M1 begins.
**Scope:** Convert the existing Mineflayer player-bot MCP server into a **server-plugin-based artistic build engine** with a camera feedback loop and a data-driven anti-slop rule system.

> Notation: `->` means "produces / becomes", `>=`/`<=` are thresholds, `x` is multiply, `phi` is the golden ratio (~1.618). Angles in degrees. All block names are Java Edition 1.21.x ids.

---

## 1. Vision & Goals

### 1.1 The problem with today

The current system joins a Minecraft world as a *character* and places blocks one at a time through `bot.placeBlock`. Every placement is gated by four physical constraints — pathfinding proximity, a valid reference block + face, line-of-sight, and inventory stock. This is the wrong abstraction for a build engine: it is slow (network-tick-bound, one block per action), brittle (fails on any of the four gates), and cannot touch blocks the avatar can't physically reach.

Worse, the *artistic* output is thin. Builds today are produced by loosely mapping input photos into voxels. They "vaguely resemble" the reference but read as **voxelized images, not builds** — flat single-material walls, boxy silhouettes, no roof overhang, no grounding, empty interiors. They don't feel like something a skilled Minecraft player made. **That is the core failure we are solving.**

### 1.2 The redesign in one sentence

> Stop *playing* the game and start *editing the world*: a Paper server plugin commits blocks directly, a deterministic engine composes the geometry from real architectural rules, a renderer gives the LLM eyes, and the LLM acts as art director in a render -> critique -> refine loop.

### 1.3 The four roles (guiding philosophy)

The architecture is organized around a strict separation of concerns. **This division is the single most important design decision** — it is what stops slop, because the LLM never gets to dump an unfiltered voxel image into the world.

| Role | Who | Responsibility | Never does |
|---|---|---|---|
| **Art Director / Critic** | Claude (via MCP) | Chooses style, palette family, program, mood; reads rendered photos; issues *structured, high-level* edits | Never names coordinates or places blocks by position |
| **Draftsman / Engine** | Deterministic build engine (Node/TS) | Owns 100% of massing, structure, detailing, palette resolution, rasterization, validation | Never makes taste decisions |
| **Committer** | Paper plugin (Java) | Writes `BlockData` directly into the world; region locks; snapshots; schematics; region extraction | Never renders images (it can't — no GPU/assets) |
| **Eyes** | Renderer service (Node) | Turns extracted block data into multi-angle PNGs for the LLM | Never touches the world |

The LLM and engine communicate in a **typed vocabulary** — style tags, material roles, module ids, and a fixed set of edit operations (`set_param`, `swap_palette`, `add_module`, `remove_module`, `rerun_pass`). The LLM chooses *from* this vocabulary; it cannot invent block placements. **The LLM informs choices; it never places blocks.**

### 1.4 Goals

1. **Direct, WorldEdit-style building.** Give the system a region; it fills blocks directly — no inventory, pathfinding, or line-of-sight.
2. **Minecraft-native artistry.** Encode real builder knowledge (massing, facades, roofs, palettes, interiors, grounding, detailing) so output feels hand-built, not photo-traced.
3. **The camera feedback loop.** The plugin extracts, a renderer photographs from canonical angles, the LLM critiques, the engine repairs — iterate until the build scores "not slop".
4. **The anti-slop mandate.** A measurable quality rubric gates every build. Obvious slop is rejected *pre-render* by cheap deterministic geometry checks; subjective slop is caught *post-render* by vision critique.
5. **Data-driven styles — with an honest caveat.** Palette, proportion, massing, and openings for a new style ship as **JSON** (a style pack), and the LLM edits *style packs*, not raw blocks. **But the thing that makes a style recognizable — its signature features (half-timbering, jetties, upturned eaves) — is code, not data.** Each signature feature needs a *generator* (produces it) and a *detector* (verifies it). We mitigate this with a shared **parameterized Feature Kit** (§5.5) that most styles compose from, so a *new* style is usually data-only; only a *genuinely new architectural motif* needs new code. We will not oversell "styles are pure JSON".

### 1.5 Non-goals (v1)

- **Photorealism inside the iterate loop** (deterministic flat lighting diffs better than pretty renders); a Chunky beauty pass is a final-presentation stretch (§6.5).
- **Survival mechanics** — inventory/crafting/furnaces/flight are deleted.
- **The LLM authoring block coordinates** — it directs; it never places.
- **Reference-image reproduction** — the v1 pipeline generates *style-conditioned original* buildings from a brief; it has no path that reproduces a *specific* input photo/building. **Decided (§11 #1): generation-only for v1**; reproduction stays a separate future subsystem, not a parameter.
- **Long-term player-bot support** — the bot backend is retained behind a flag as a fallback through M5, then retired (§9), *not* deleted the moment the plugin works.

---

## 2. What Changes From Today

The redesign **inverts control**: instead of a client that plays the game, we run a plugin that edits the world, with the MCP server keeping its LLM-facing role but swapping its backend from Mineflayer to a socket client.

| Concern | Today (player-bot) | Redesign (plugin build engine) |
|---|---|---|
| **World effector** | Mineflayer client joins as a character | Paper server plugin edits chunks directly |
| **Block placement** | `bot.placeBlock`, one at a time | Bulk `fillRegion` / `setBlocks` via FAWE, chunk-parallel |
| **Placement gates** | Pathfinding + reference face + LOS + inventory | None — direct `BlockData` writes |
| **Speed** | Network-tick-bound, ~1 block/action | Thousands of blocks/tick, batched across ticks |
| **Reach** | Only blocks the avatar can navigate to | Any block in a locked region |
| **Geometry source** | Photo -> voxel mapping | Deterministic multi-pass parametric engine |
| **Artistic quality** | Emergent, "resembles photo", sloppy | Rule-driven, style-pack-parameterized, scored |
| **Visual feedback** | None (bot is blind to its own build) | Multi-angle renders -> LLM vision critique loop |
| **Undo / iteration** | None | Engine `worldDiff` inverse patches + snapshots |
| **Persistence** | None | Sponge `.schem` save/load |
| **MCP tool surface** | place/dig/move/fly/inventory/craft/furnace/chat | region/palette/generate/camera/critique/schematic/undo |
| **Backend deps** | mineflayer, pathfinder, minecraft-data | WebSocket RPC client -> Java plugin; FAWE; renderer |
| **Config** | `--host/--port/--username` (MC server) | `--plugin-url/--token` (RPC endpoint) |

**What survives from the current repo** (verified against source): the MCP bootstrap (`McpServer` + `StdioServerTransport`), the `ToolFactory` zod-validate + connection-gate + response-envelope pattern, `logger.ts`, `stdio-filter.ts`, `coordinate-utils.ts`, the `MessageStore` ring-buffer pattern, and the yargs config pattern. **What is deleted**: `bot-connection.ts` (-> `plugin-connection.ts`) and the survival surface — `position`, `flight`, `inventory`, `entity`, `crafting`, `furnace` tool modules. **What inverts**: `block-tools` keeps its *concept* (place/query/find) while its *implementation* flips from navigate-and-place to direct bulk region edit.

---

## 3. Target Architecture

### 3.1 Components

**(a) Java Paper plugin — the Committer.**
Paper (Java 21, the latest stable MC 1.21.x that Paper + FAWE ship for — §11 #2). Responsibilities: register + lock working regions (WorldEdit-style selection); execute bulk edits through a `WorldEditor` interface (`FaweWorldEditor` default, `BukkitWorldEditor` fallback); take/restore world snapshots; load/save `.schem`; **extract** region data for the renderer; host the embedded RPC server. Two important corrections baked in:

- **Threading is backend-specific (§3.4), not "always main thread".** Raw-Bukkit writes must run on the main thread; FAWE deliberately does *not* — it edits chunk sections off-thread and relights. Do not wrap FAWE in the main-thread executor.
- **The plugin is not the undo authority.** Build-level undo is owned by the engine's `worldDiff` inverse patches (§7.4); FAWE is used only as the *write mechanism*, so two histories can't desync.
- **No NMS if avoidable.** If the plugin only uses Bukkit API + FAWE API, drop `paperweight-userdev` entirely (it adds mapping/build complexity for nothing). Confirm at M1.
- **Shade & relocate.** Embedding an HTTP/WS server (Javalin -> Jetty/Jackson) in a Bukkit plugin requires a `shadowJar` relocation of Jetty/Jackson to avoid classloader clashes with the server and other plugins.

**(b) Node MCP server — the LLM interface + orchestrator.**
Evolves the current repo. Keeps the ToolFactory/zod/stdio spine; replaces `BotConnection` with `PluginConnection` (a WebSocket RPC client). Exposes the new tool surface (§4) to Claude, hosts the build engine, drives the renderer, and orchestrates the render -> critique loop.

**(c) The Artistic Build Engine — a Node/TS library.**
The centerpiece (§5). A staged, mostly-deterministic, seeded parametric pipeline that turns high-level intent (style, program, site) into a validated in-memory voxel build model, scored against the anti-slop rubric before any world write.

**(d) The Camera / Renderer service — a Node service.**
The plugin *cannot* render (a headless server JVM has no GPU, no OpenGL, and — critically — no client render assets: block models, textures, and blockstate mappings all live in the client jar). So the plugin only *extracts* region data (`.schem` or compact JSON); the **renderer** meshes it and photographs it Node-side. **The renderer produces images and the MCP relays them as base64 to Claude — the plugin never serves images it didn't render.**

### 3.2 Data-flow diagram

```
                       +--------------------------------------------+
                       |            CLAUDE (Art Director)           |
                       |  picks style/palette/program; reads photos |
                       |  emits high-level intent + edit ops        |
                       +----------------+-------------^-------------+
                             MCP tools  |             | image content
                             (stdio)    |             | + critique
                       +----------------v-------------+-------------+
                       |        NODE MCP SERVER (orchestrator)      |
                       |  ToolFactory . PluginConnection (WS RPC)   |
                       |  +--------------------------------------+  |
                       |  |      ARTISTIC BUILD ENGINE (lib)     |  |
                       |  |  brief->massing->shell->roof->facade |  |
                       |  |  ->palette->interior->ground->QA     |  |
                       |  |  in-memory voxel BuildModel + scorer |  |
                       |  +--------------------------------------+  |
                       |                 | drives (in-process)      |
                       |                 v                          |
                       |  +--------------------------------------+  |
                       |  |   RENDERER SERVICE (Node)            |  |
                       |  |   schem/json -> mesh (real MC models)|  |
                       |  |   headless Chromium + three.js       |  |
                       |  |   5-shot review preset -> PNGs       |  |
                       |  +------------------^-------------------+  |
                       +----+----------------|---------------------+
             JSON-RPC 2.0   |                | .schem / compact JSON
             over WebSocket  |               | (captureRegion extract)
        (fillRegion,        v                |
         selectRegion, +----+-----------------+------------+
         snapshot,     |         JAVA PAPER PLUGIN         |
         captureRegion,|  RPC server (Javalin: HTTP + WS)  |
         undo)         |  WorldEditor iface:              |
                       |    FaweWorldEditor (off-thread)  |
                       |    BukkitWorldEditor (main+budget)|
                       |  region locks . snapshots        |
                       |  captureRegion -> .schem/JSON ----+
                       +---------------+------------------+
                                       | BlockData writes (physics=false)
                                       v
                               +----------------+
                               | MINECRAFT WORLD|  (chunks, block states)
                               +----------------+
```

### 3.3 RPC protocol summary

**Transport:** Javalin (embedded Jetty) inside the plugin — HTTP for one-shot RPCs, WebSocket for the long-running iterative session (streamed `job.progress` events). Bind `127.0.0.1` by default; bearer-token auth; JSON-RPC 2.0 framing. This mirrors the battle-tested **GDMC-HTTP** pattern (external process <-> in-game world over a localhost socket) but modernized with JSON-RPC, WebSocket streaming, FAWE-backed bulk ops, and snapshots. **Rendering is *not* a plugin RPC** — the plugin serves region *data*; the Node renderer draws it.

**Envelope:** `{ "jsonrpc":"2.0", "id":..., "method":..., "params":{...} }`. Coordinates are integer `{x,y,z}`; `region = {min, max, world}`.

**Job model:** every mutating RPC returns a `jobId` immediately and executes async (FAWE worker or main-thread queue), streaming `{ "method":"job.progress", "params":{jobId, done, total} }` over WS so the socket stays responsive during multi-minute builds.

**Shared `options`** (mirrors GDMC flags): `{ physics:false, updateLighting:true, notifyClients:true, spawnDrops:false, budgetPerTick? }`. `notifyClients` must default true or placed blocks stay invisible to connected players.

| Method | Params | Returns |
|---|---|---|
| `authenticate` | `{token}` | `{ok, serverVersion, dataVersion, faweAvailable}` |
| `selectRegion` | `{region, name?}` | `{selectionId, blockCount, dimensions}` (locks region) |
| `getRegionInfo` | `{selectionId\|region}` | `{dimensions, biome, groundLevel, heightmap, paletteHistogram}` |
| `getBlocks` | `{region}` | `{blocks:[...]}` or compact RLE |
| `setBlocks` | `{world, blocks:[{x,y,z,data}], options}` | `{jobId, changed}` |
| `fillRegion` | `{region, pattern, mask?, options}` | `{jobId}` (FAWE weighted `Pattern` + `Mask`) |
| `pasteSchematic` | `{schematicId, at, rotate?, mirror?, ignoreAir?, options}` | `{jobId, pastedBounds}` |
| `saveSchematic` | `{region, name}` | `{schematicId, bytesRef}` |
| `captureRegion` | `{region, format:'schem'\|'json'}` | `{schematicId\|jsonRef}` (fed to the renderer) |
| `applyDiff` | `{diff, options}` | `{jobId}` (commit an engine change set) |
| `undoDiff` | `{diffId}` | `{jobId, restored}` (apply stored inverse patch) |
| `snapshot` / `restoreSnapshot` | `{region}` / `{snapshotId}` | `{snapshotId}` / `{restored}` |
| `getJob` | `{jobId}` | `{state, progress, changed, error?}` |
| `dryRun` | `{editMethod, params}` | `{wouldChange, bounds, conflicts, warnings}` |
| `releaseRegion` | `{selectionId}` | `{}` |

### 3.4 The threading model (split by backend — this is the whole ballgame)

There are **two** execution models, and conflating them causes deadlocks and lost performance:

- **`BukkitWorldEditor` (fallback):** world mutation must run on the **main server thread**. Network handlers accept RPCs off-thread and never touch the world; they submit an `EditJob` to a `MainThreadExecutor.submit(location, task)`, await a `CompletableFuture`, and serialize the result back. Large jobs **self-reschedule** (drain a bounded queue, `budgetPerTick` blocks/tick) so a 2M-block fill spreads over ticks instead of freezing the server. A **TPS guard** auto-throttles below a floor.
- **`FaweWorldEditor` (default):** FAWE's whole reason to exist is that it **does not** use the Bukkit API and **does not** marshal to the main thread — it edits chunk sections directly off-thread and relights/resends. The model here is: submit the `EditSession` off-thread, **await its future**, and **hold the region lock until the future completes**. Do **not** tick-budget FAWE yourself and do **not** wrap it in `MainThreadExecutor` — that would defeat its performance and risk deadlock.

`MainThreadExecutor` has a Bukkit impl (`getScheduler().runTask`) and, later, a Folia impl (`RegionScheduler`). **This one abstraction is the entire cost of Folia-readiness — pay it now, don't require Folia.** In both models, edits are serialized per region behind a region lock so two RPCs can't interleave.

---

## 4. The MCP Tool Surface (new)

Kebab-case names, per repo convention `factory.registerTool("name", {zodSchema}, handler)`. Grouped by function.

**Region / site tools**
- `give-selection-wand` — give the operator a WorldEdit-style wand and enter selection-listen mode (human fences off a site).
- `get-current-selection` — read back the human's `{type, pos1, pos2, min, max, dimensions, volume}`.
- `describe-region` — enrich a selection with biome, per-corner ground Y (slope), surface palette, collisions, water/lava, adjacency.
- `define-build-site` — persist a named, reserved `BuildSite` from `{min/max or origin+size, baseY, facing, biome, clearMode}`.
- `list-build-sites` / `release-build-site` — registry lifecycle.

**Palette / style tools**
- `list-styles` — enumerate available style packs (Tudor, Nordic, Elven, Desert...).
- `get-style-pack` / `set-style-pack` — read/select the active style pack for a site.
- `resolve-palette` — bind abstract material roles -> concrete blocks for a style x biome, returning the palette for LLM review.
- `edit-palette` — LLM swaps a role's block list or copper-oxidation stage; validated against palette rules (§5.6).

**Generate / build tools**
- `generate-build` — run the full engine pipeline (brief -> passes -> validated buffer) into an in-memory `BuildModel`; no world write. Returns model id + score.
- `refine-build` — apply a structured edit list (`set_param`, `swap_palette`, `add_module`, `remove_module`, `rerun_pass`) to an existing model.
- `validate-build` — run deterministic geometry checks; returns per-cell diagnostics.
- `score-build` — run the quality rubric (geometry sub-scores) on the current model.
- `commit-build` — flush the model to the world in one batched transaction (with `dryRun` flag); records the inverse `worldDiff`.

**Camera tools** (these call the Node renderer, not the plugin)
- `photograph-region` — render the `review` preset (5 shots) -> base64 PNGs + per-image sidecars.
- `photograph-detail` — targeted close-up / interior / cutaway shots (v2).

**Critique-loop tools**
- `critique-build` — feed renders to the vision rubric; returns scored, categorized, actionable feedback fused with geometry scores.
- `iterate-build` — one turn of render -> critique -> refine -> re-render; loops to threshold or budget (§5.9).

**Schematic / undo tools**
- `export-schematic` (`.schem` / `.nbt`) . `import-schematic` (load + rotate to `facing` + paste at anchor) . `undo-build` / `redo-build` (engine `worldDiff`) . `snapshot-region` / `restore-snapshot`.

---

## 5. The Artistic Build Engine (the centerpiece)

This is where quality lives. The plugin's block-writing speed does not make builds good — this rule pipeline sitting above `fillRegion` does. It is the largest, richest part of the system.

### 5.1 Design philosophy

**Compose top-down, never copy pixels.** Good builds are composed from a *program* (what the building is for) down through massing, structure, and detail — the same decomposition human builders and real architects use. A pixel-copier has no such structure and produces slop the moment context changes.

The engine is a **mostly-deterministic, rule-driven, seeded parametric core** with an **LLM art director on top**. Three principles:

1. **Mostly deterministic.** Given `(seed, brief, site)` the engine reproduces the exact build. Bugs are reproducible, edits targeted, review meaningful — you can point at the *rule* that produced a flaw. The opposite of an ML black box.
2. **Controlled randomness.** All variation flows through one seeded PRNG with bounded ranges (dimension jitter, weighted palette sampling, greeble density). **Randomness adds texture, never structure.** Never let a stochastic method decide load-bearing geometry.
3. **Skeleton + detailing hybrid.** Grammar/parametric passes build a correct skeleton (massing -> shell -> openings -> roof) with hard guarantees; WFC/scatter passes add organic detail on top where mistakes are cheap and cosmetic.

This mirrors the **GDMC** (Generative Design in Minecraft) community's convergence: deterministic terrain-adaptive generators evaluated by human-style rubrics (Adaptability, Functionality, Narrative, Aesthetics).

**Governing aesthetic for exteriors:** *a good exterior is light and shadow made from geometry.* Every rule exists to cast a shadow, break a plane, or vary a silhouette. Flatness is the enemy — a surface the sun hits evenly reads as "unfinished". The engine manufactures depth, rhythm, and hierarchy from cheap block operations. **And palette is the fastest, cheapest thing to get wrong:** two builds with identical geometry can read as "pro" vs "noob" almost entirely on block selection — which is why palette carries real weight in the rubric (§5.8) and gets its own system (§5.6).

### 5.2 The multi-pass build pipeline

Each pass is a near-pure function `state -> state` over a shared blackboard (the module graph + voxel buffer + metadata). Passes read earlier layers and write their own; **nothing touches the live world until commit.** This staging lets you inspect and fix before anything is irreversible, and a failure is localized and re-runnable.

| # | Pass | Input | Output | Rules / methods applied |
|---|---|---|---|---|
| 0 | **Program / brief** | LLM intent (style, function, size, seed), site query | `Brief`: building type, room program, story, style tag, palette family, footprint | LLM-authored spec constrained to schema; deterministic defaults fill gaps |
| 1 | **Site read & grounding survey** | Region heightmap, biome, water, slope, orientation | Buildable footprint, ground datum, terracing plan, entrance-facing dir | Heightmap analysis; slope thresholds; foundation datum = min/median height under footprint |
| 2 | **Massing** | Brief footprint, site plan | Abstract volume tree (boxes, storey count, wing adjacency) — no blocks yet | §5.4.1 massing rules + split grammar; phi-family proportioning; seeded dimension jitter |
| 3 | **Structure / shell** | Volume tree | Load-bearing grid: corner posts, floor slabs, wall segments, bay spacing | Column-grid solver; reserve opening-free surfaces; wall thickness per style (§5.4.2) |
| 4 | **Openings** | Wall segments, program, orientation | Door/window placements (position, size, type) | §5.4.2 rhythm/alignment; windows face view/sun, door faces path; floor-line alignment |
| 5 | **Roof** | Top of shell, storey heights, style | Roof modules (gable/hip/mansard...), pitch, overhang, ridge, dormers | §5.4.3 roof grammar keyed to style; pitch from footprint aspect; eave modules |
| 6 | **Facade detailing** | Walls + openings + eave | Trim, string courses, quoins, pilasters, sills/lintels, timber framing | §5.4.2 split-grammar subdivision (floors->bays->tiles->trim); depth variation |
| 7 | **Palette resolution** | Style tag, biome, all placed modules (material-abstract) | Concrete `Block` ids + states for every role | §5.6 palette lookup + seeded weighted variation (texture noise) |
| 8 | **Interior** | Room graph, shell, openings | Floor divisions, partition walls, stairs, room labels, light sources | §5.4.5 room program; circulation spine; ceiling height by function; light >=8 |
| 9 | **Furniture / fixtures** | Labeled rooms | Furniture module instances placed & oriented | §5.4.5 per-room templates with clearance; orient toward focal point |
| 10 | **Landscaping / grounding** | Site plan, footprint edge, entrance | Terrain edits (terracing, retaining walls), path, garden, foundation skirt | §5.4.6 blend base into terrain; A* path to edge; planting scatter |
| 11 | **Detail / greeble** | Whole buffer | Weathering, moss/vines, cracked-block noise, hanging lanterns | WFC or seeded scatter over eligible surfaces; density-capped |
| 12 | **QA / score** | Buffer + rendered orbit photos | Score vector + ranked defect list | §5.8 geometry heuristics + §5.9 LLM critique of renders |
| 13 | **Targeted fixes** | Defect list | Patched modules / re-run of flagged passes | Apply edit ops; loop to 12 until score >= threshold or budget spent |
| 14 | **Commit** | Validated buffer | Blocks written to world via batched flush | Single FAWE transaction; store inverse `worldDiff` |

**Method selection per pass:** template + seeded jitter (passes 3-5, 9); shape/split grammars, CGA-style (passes 2, 6); WFC (surface detail only, passes 6/11 — never load-bearing, it can contradict/fail); constraint solving (passes 4, 8, 10 — guarantees reachability, no overlap). **Pure ML/generative geometry is avoided** — opaque, non-inspectable, produces slop.

**Pass dependency DAG + invalidation (required for targeted re-runs).** "Re-run only pass 6 on one wall" is only correct if downstream dependents are also recomputed: pass 7 (palette) and pass 11 (greeble) both read pass 6's cells. Every pass declares `reads: passId[]` and `writes: layerTag[]`; the engine maintains a DAG. A targeted re-run of pass P over a sub-region **invalidates every voxel written by P's transitive dependents inside that region** (via the `writtenBy` meta layer) and re-runs those passes over exactly those cells. Without this, targeted edits silently leave stale palette/greeble behind.

### 5.3 The build model, module graph, and dry-run/validate/commit

Two coupled structures. The **module graph** is the semantic build (what things *are*, still editable); the **voxel buffer** is the rasterized build (what blocks go where, validated before commit).

**Module graph (parameterized, abstract materials until pass 7):**
```
Build
├─ meta { seed, style, palette_ref, brief, score }
├─ Site { footprint_poly, datum_y, orientation, terrain_ops[] }
└─ root: Volume
   ├─ transform { origin, size, rotation }
   ├─ material_roles { WALL_PRIMARY, TRIM, ROOF, ACCENT, GLASS }  # abstract until pass 7
   ├─ children: Volume[]                     # wings, storeys (from split grammar)
   ├─ Shell
   │  ├─ WallSegment[] { plane, bay_index, reserved_for_opening }
   │  │   └─ Opening? { type, size, block_template }
   │  ├─ FloorSlab[]
   │  └─ FacadeDetail[] { kind: quoin|trim|sill|pilaster, anchor }
   ├─ Roof { kind, pitch, overhang, ridge, Dormer[] }
   ├─ Features: FeatureInstance[]            # signature features (§5.5), each with generator+detector
   └─ Rooms: RoomGraph { Room[] {label,bbox,lights,doors}, Furniture[] }
```
A `Window` module is `{style,w,h,sill_y}` and expands to blocks *only* at rasterization — restyle by swapping the expander, not re-authoring geometry. Everything carries *roles* until pass 7, so one build reskins across biomes for free (supports "adaptability"). Repeated modules are references + transforms (instancing).

**Voxel buffer (dense, palette-indexed, mirrors `.schem` layout so serialization is trivial):**
```ts
interface BuildModel {
  dims:{w,h,l}; origin:Vec3; facing:Facing;
  palette:string[]; paletteIndex:Map<string,number>;
  voxels:Uint16Array;                 // index = x + z*w + y*w*l  (== .schem Data order)
  blockEntities:Map<number,NBT>; entities:EntitySpec[];
  meta:MetaLayers; dirty:boolean;
}
interface MetaLayers {               // parallel arrays; every pass stamps provenance
  writtenBy:Uint8Array;              // voxel -> pass id that wrote it (drives DAG invalidation)
  moduleTag:Uint16Array;             // voxel -> component ("roof","wall-3")
  roomLabel:Uint16Array;             // voxel -> room ("kitchen","exterior")
  layerTag:Uint8Array;               // foundation|wall|floor|roof|trim|glazing|decor
  protect:Uint8Array;                // bitflags: LOCKED (pass may not overwrite), VOID (must stay empty)
}
```
Each pass calls `model.set(x,y,z,state,{passId,moduleTag,roomLabel,layerTag})` — updates `voxels` *and* all meta layers atomically, respecting `protect.LOCKED`. The metadata is the key idea: later passes and the scorer reason about *who wrote what* (the openings pass places a door only on exterior-facing `wall` cells; a refine op targets "just the roof" via `moduleTag`).

**Dry-run / validate / commit:**
- **Validate** (cheap, in-memory): watertight shell (flood-fill from exterior finds leaks), no floating/buried structure vs datum, no self-intersecting modules (ownership conflicts), every room reachable + lit, gravity-affected blocks supported, no cells on `protect.VOID` or outside the region mask. Returns *localized* diagnostics ("leak at room kitchen, north wall, y=68").
- **Dry-run** = run passes + validators + score + render, skip the world write. Return the diff.
- **Commit** = diff `voxels` against world state -> minimal change set -> one batched FAWE transaction (gravity-safe ordering: foundations first) -> record inverse `worldDiff` for undo.

### 5.4 Rule categories

Each rule is stated so the engine can check it (IF/THEN, algorithm-checkable where possible). **Thresholds that vary by style are read from the active StylePack, not hard-coded globally** (§5.5, §5.8).

#### 5.4.1 Exterior / massing rules

Governing idea: **a plain box is slop** — one contour, one shadow, nothing for the eye to travel. Break one volume into legible sub-volumes.

- **Decompose.** IF footprint is a single rectangle at uniform height -> decompose into >=2 sub-volumes (L/T/wing) differing in **height AND depth** (vary two dimensions, not one). Footprint preference, best->worst: main-mass-plus-wings ~ L ~ cross > U > T > rectangle > box.
- **Hierarchy.** One volume dominates in *both* height and footprint (>=1.25x the others); subordinate wings 60-80% of main height. Equal volumes read as a diagram.
- **Focal element.** At least one element (entrance bay, tower, gable) has a **frontal silhouette area >= 1.5x the median per-bay frontal area**, measured on the primary-facade orthographic render (px^2) — not a hand-wavy voxel metric.
- **Project & recess.** Push a bay forward 1-2 blocks (entrance bay, stair tower); pull a section back (loggia). Creates attractive layers.
- **Verticality.** Add a tower / gable / chimney / stair-turret to any horizontal build; towers taller than wide by >=2.5:1. (The `verticality` style knob, 0-1, maps to P(a vertical accent is added per eligible mass) and its target height ratio.)
- **Proportion.** Aim wing footprints and facade panels at 3:2 or 5:3 (phi-family), main-to-wing height ~ phi:1 (e.g. 8-high main, 5-high wing). Avoid 1:1 and 2:1 (static).
- **Storey heights.** Interior clear: 3 = cottage minimum, 4 = "quality" default, 5-6+ = halls. Exterior storey pitch = clear + >=2 (room for sill + lintel), often with a belt course between floors.

#### 5.4.2 Facade / depth / detailing rules

Cardinal sin: a flat, single-material, single-block-thick wall (no shadow, no scale cue, betrays the shell).

- **Thickness (per style, with a reveal exception).** `wallThickness` is a **StylePack parameter** (see §5.5), not a global constant. Even styles whose *nominal* wall is 1 thick (e.g. Tudor plaster infill) must provide **>=2 blocks of depth at every window/door reveal** so openings can recess — fake it: only the reveals need real depth. The rubric reads the per-style value; it never fails a style for being 1-thick if that style declares it and satisfies the reveal rule.
- **Vertical articulation.** IF any wall run > 5 blocks without a break -> insert a pilaster/column/buttress or a +-1 project/recess every 3-5 blocks. Pilasters divide the facade into **bays** — one window per bay.
- **Tripartite zoning (base / body / cornice).** Every facade divides vertically: a heavier projecting **plinth** (bottom 1-2 rows), the **body** (lightest, largest, carries windows), and an oversailing **cornice** (top row of stairs/slabs). IF missing -> add.
- **String / belt courses.** IF >1 storey -> run a continuous contrasting band at each floor line at a constant Y around the whole build (reads storeys, adds a shadow line, ties volumes).
- **Corner quoins.** Mark corners with a heavier/contrasting block, alternating up the corner.
- **Openings — depth is the highest-value trick.** Recess glass/door 1 block for a reveal shadow (requires the 2-thick reveal). Frame every opening: sill (top-stair/slab below), lintel (contrasting head course), jambs (trapdoors/log posts), muntins on wide windows. Enforce vertical column alignment (equal X across floors) and equal spacing; flag any misaligned opening. Glazing 20-40% of wall (non-shopfront).
- **Texturing (anti-flatness).** Never one block over a whole surface — see §5.6. Note: **flatness of *plane* is the enemy, not uniformity of a *base* material** — a clean plaster gable is correct. The rubric's flatness check targets geometric off-plane %, and the same-block-run cap applies to `secondary`/`accent` roles, not `base` (§5.8).
- **Entrance as focal point.** IF the main door is a bare 1x2 opening flush in the rhythm -> promote it: enlarge/heighten, project or recess a porch bay, raise on 1-3 steps, frame with columns + lintel/pediment, flank with lanterns, align a larger window/gable/tower above it.

#### 5.4.3 Roof rules

Roofs are the single biggest driver of a house's read. A flat/flush roof looks decapitated.

- **Pitch by block choice.** 63.4deg = stacked full blocks (spires, Nordic, chateaux); **45deg = stairs (default)**; 22.5deg = alternating slabs (Mediterranean/modern). IF pitch undefined -> default 45deg. Never a single-slab "roof line".
- **Form by footprint.** Gable (simplest good roof; the gable end is a facade feature), hip (formal), mansard/gambrel (rustic/French, holds dormers). IF footprint is L/T/cross -> generate intersecting ridges of matched pitch/height, knit valleys with corner stairs/slabs.
- **Overhang is mandatory.** IF flat OR 0-overhang on a pitched style -> add >=1-block eave with a detailed underside (top-stairs, or slab + trapdoor soffit) and a ridge cap. A flush roof is the roof equivalent of a flat wall. (Intentional flat/parapet styles declare `roof.type:"flat"` and satisfy a parapet check instead.)
- **Dormers & chimneys.** Add >=1 dormer per roof face longer than ~8 blocks (rhythm + light, stops a dead triangle); add >=1 *offset* chimney breaking the ridge, capped with a slab lip.
- **Material.** Blend, don't use one block (dark oak stairs + spruce + a stripe; or deepslate + blackstone; or weathered copper for patina). Streak vertically to suggest tile courses.

#### 5.4.4 Palette & color rules -> see §5.6.

#### 5.4.5 Interior rules

Most builds nail the shell and leave interiors as empty torch-lit boxes. The fixes are cheap in blocks, high in perceived quality.

- **Scale by function.** `ceilingHeight` = air blocks between floor surface and ceiling underside. Cozy rooms = **3**; grand halls **6+**; basements 2-3. The range is **per room function**, not per build — a hall at 6 and a bedroom at 3 in the same build must *both* pass. A build feels designed when ceiling height *varies by room function*.
- **Program the volume.** Named rooms off a 2-3-wide **circulation spine** (never chain rooms like train cars); a foyer/mudroom; social below, private above, utility in cellar/attic; connected by a real staircase. Room footprints: bedroom 5x5-7x7, kitchen 5x6-7x8, living 7x7-9x11, small rooms 3x3-4x5.
- **Partitions & palette.** Interior walls are thinner and softer than the shell; reuse the exterior wood + one masonry accent + 1-2 interior-only soft materials (plaster/wool/carpet/bookshelves). <=3-4 materials per room. Floors one tone warmer/darker than walls; ceilings one lighter.
- **Furniture = stairs/slabs/trapdoors/signs/fences/item-frames**, built in **clusters/use-zones around a focal point** (fireplace, big window, four-poster, kitchen range), not scattered.
- **Floors & ceilings are never flat.** Floors get a border/inset/material-change to zone the space; ceilings get **exposed beams** (stripped logs/fences/inverted stairs every 2-3 blocks, running the short span) or coffers.
- **Walls get treatment.** Wainscoting / chair-rail (a lower band + inverted-stair cap), door/window trim, >=1 piece of item-frame/painting art, deepened window reveals.
- **Lighting is sparse, warm-by-default, mostly hidden.** Keep floor light >=8 (block mobs). Hide the working light behind trapdoors, under carpets, in coves; the light you *see* is a fixture (lantern/candle/fire). Cool light (soul/sea lanterns) only for utility/accent. No torch-spam, no bare glowstone, no uniform glare.
- **Fire safety.** Any fire source (campfire/netherrack) is boxed on all touching faces by non-flammable blocks — never planks/wool/logs.
- **Density 40-60% floor coverage.** Keep centers and paths clear; preserve negative space; cluster in odd numbers; 2-3 "lived-in" cues per room, no more.

> **Render-fidelity caveat (interiors).** Neither the MVP renderer nor the fallback reliably draws NBT-bearing decoration — item-frame contents, painting art, banner patterns, sign text, chiseled-bookshelf fill. The vision critic therefore **cannot see interior "art"**. v1 policy: stub these as neutral placeholders in the mesher and **exclude them from vision scoring** (geometry checks still count "an item-frame exists"); revisit in v2. This is why interior review is a stretch (§9, §12).

**5.4.5b — Furniture catalog (piece -> recipe -> footprint), abbreviated:**

| Piece | Recipe | Footprint |
|---|---|---|
| Chair | 1 stair (+ signs/trapdoors as arms/back) | 1x1 |
| Sofa | 2-4 stairs in a row, ends turned in | 3-4x1 |
| Dining table | fence posts + top-slab/trapdoor run | 3-5x1 |
| Desk | slab/block run + trapdoor front panel | 2-3x1 |
| Bed (upgraded) | vanilla bed + banner/trapdoor headboard + nightstands | 2x1 (+sides) |
| Kitchen counter | half-slabs + trapdoor cabinet fronts | run x1 |
| Stove | smoker/furnace in counter + front trapdoors | 1-2x1 |
| Sink | cauldron in counter + lever/hook tap | 1x1 |
| Bookshelf | chiseled bookshelf, mixed fill | run x1 |
| Fireplace | brick/stone surround + campfire (smoke) | 2-3x1 |
| Chandelier | chains -> fence/lantern hub | 1x1-3x3 |
| Rug | carpet field + border color | 2x3-4x5 |
| Wainscoting | lower band + inverted-stair chair rail | wall run |

#### 5.4.6 Grounding / landscaping rules

"Floating box on flat grass" is slop — pro builders spend most of their time on terrain because ground contact is where believability is won. **Grounding is style-conditioned via `groundingMode` (§5.5): `grounded | stilted | terraced | cantilever`.**

- **`grounded`** (default): IF the wall base meets flat ground at a clean 90deg seam -> ground it. Apply several: project a **plinth**; reveal a **foundation** above grade; add a **stair skirt/batter**; **terrace** into slope with retaining walls; **scatter** planters/bushes/flowers/grass/path/rocks/moss across the seam (never a clean geometric line); run a **path** from the entrance widening into a plaza. Gate: `perimeter_ground_contact_ratio >= 0.85`; transition width >=2 over >=70% of perimeter; no vertical cut face >2 tall at the seam.
- **`stilted`** (Venetian, Elven-canopy, cliffside, boathouse): the ground-contact ratio does **not** apply. Instead require **>=N support columns/piles reaching the ground datum**, and that the underside is detailed (bracing, cross-beams), not a flat floating slab.
- **`terraced`**: build steps into the slope; each terrace grounds independently.
- **`cantilever`**: a projecting mass must be visually supported (brackets, a lower mass, or a counterweight volume) — no unsupported floating overhang > 2 blocks deep.

#### 5.4.7 Anti-slop rules

The 18 failure modes are enforced as hard gates and score penalties (§5.8, §13). The most damaging, in short: flat mono-*plane* walls, sub-spec wall depth, plain-box massing, cobble/plank spam, no roof overhang, ungrounded builds, no depth/detailing, over-symmetry *for asymmetric styles*, wrong scale, clashing palette, garish colors, empty interiors, abrupt terrain, uniform random noise ("TV static"), pixel-art-of-a-photo (1-deep), misused decorative-as-structural blocks, lighting spam, no focal point.

### 5.5 The style-pack system

Palette, proportion, massing, and openings are **data**; **signature features are code** behind a shared kit. The LLM edits style packs (never raw blocks). A build reads as its style only if **3+ of its signature features are present** — the engine treats these as required passes, not optional flourishes. `forbiddenBlocks` stops other styles' hero blocks from bleeding in. **Weighted block lists drive texture variation** (sampling `cobblestone`/`mossy_cobblestone`/`stone_bricks` at 5:2:1 breaks the flat single-block wall).

**The Feature abstraction (this is the honest core of "styles as data").** Each signature feature is not a string — it is:
```ts
interface Feature {
  id: string;                       // "half-timber-framing"
  generatorPass: (ctx) => void;     // CODE: produces the motif on the module graph/buffer
  detector: (model) => number;      // CODE: 0..1 confidence the motif is present (drives the "3+ tells" gate)
  requiredParams: string[];         // params the style must supply
}
```
Most features are **parameterized and shared** across styles via a **Feature Kit** — e.g. `jetty(depth)`, `halfTimberGrid(spacing, member)`, `dormer(kind,count)`, `colonnade(spacing,order)`, `batter(angle)`, `upturnedEave(rise)`, `crenellation`, `stringCourse`, `quoins`. A *new* style that composes existing kit features is **data-only**. A *genuinely new motif* needs a new `Feature` (generator + detector) — budget ~one code unit per novel motif. Realistic launch scope: ~15-20 kit features covering the launch styles, ~40-55 detector/generator pairs total if every style added unique motifs (we deliberately reuse to stay near the low end).

**Schema (abbreviated):**
```typescript
interface StylePack {
  id: string; displayName: string;
  palette: {                            // each role = weighted block list, sampled per-block
    base: WeightedBlock[]; secondary: WeightedBlock[]; accent: WeightedBlock[];
    detail: WeightedBlock[]; glass: WeightedBlock[]; light: WeightedBlock[];
    organic: WeightedBlock[]; path: WeightedBlock[]; foundation: WeightedBlock[];
  };
  colorCentroids?: LabColor[];          // Lab centroids the exposed-block histogram should cluster near
  roof: { type:"gable"|"hip"|"flat"|"mansard"|"spire"|"tiered-hip"|"turf"|"bowed-gable";
          pitchRatio:number; overhang:number; material:WeightedBlock[];
          ridgeStyle?:string; tiers?:number; cornerUpturn?:boolean; };
  massing: { symmetry:"strict"|"balanced"|"asymmetric"|"organic";
             footprintShapes:string[];
             floorHeight:number;
             wallThickness:number;       // gate reads THIS (with the §5.4.2 reveal exception)
             groundingMode:"grounded"|"stilted"|"terraced"|"cantilever";
             storeys:[number,number]; verticality:number; jetty?:number; batter?:number; };
  openings: { windowRhythm:string; windowSpacing:number; windowShape:string;
              recessDepth:number; framing:string; shutters?:boolean; doorStyle:string; };
  detailDensity:number;                  // = P(a greeble-eligible cell gets a detail), clamped to §5.6 coverage
  signatureFeatures:string[];            // ids into the Feature Kit (each has generator+detector)
  landscaping: { ground:WeightedBlock[]; vegetation:WeightedBlock[]; props:string[];
                 pathStyle:string; density:number; waterFeature?:boolean; };
  forbiddenBlocks:string[]; forbiddenFeatures?:string[];
}
interface WeightedBlock { block:string; weight:number; }
```

**Unitless knobs have defined transfer functions** (no more mystery 0-1 dials): `detailDensity` = probability a greeble-eligible surface cell receives a detail, clamped to the §5.6 40-60% coverage rule; `verticality` = P(a vertical accent is added) x target height ratio; `landscaping.density` = planting scatter probability per seam cell. `pitchRatio` -> stair placement: 0 = slab flat/parapet; 0.5 ~ one stair-up per 2 run (pagoda); 1.0 = classic 45deg stair stack; 2.0+ = spire.

**Filled example — Tudor (corrected to pass its own gates):**
```json
{
  "id":"tudor","displayName":"Medieval Tudor",
  "palette":{
    "base":[{"block":"white_concrete","weight":5},{"block":"bone_block","weight":3}],
    "secondary":[{"block":"cobblestone","weight":4},{"block":"mossy_cobblestone","weight":2}],
    "accent":[{"block":"dark_oak_log","weight":5},{"block":"stripped_dark_oak_wood","weight":4}],
    "detail":[{"block":"dark_oak_stairs","weight":3},{"block":"dark_oak_trapdoor","weight":3}],
    "glass":[{"block":"glass_pane","weight":6},{"block":"brown_stained_glass_pane","weight":1}],
    "light":[{"block":"lantern","weight":5}],
    "foundation":[{"block":"cobblestone","weight":5},{"block":"mossy_cobblestone","weight":2}]
  },
  "colorCentroids":[[92,0,6],[28,8,18],[52,-1,3]],
  "roof":{"type":"gable","pitchRatio":1.25,"overhang":1,
          "material":[{"block":"dark_oak_stairs","weight":5},{"block":"deepslate_tile_stairs","weight":2}]},
  "massing":{"symmetry":"asymmetric","footprintShapes":["rect","L","irregular"],
             "floorHeight":4,"wallThickness":2,"groundingMode":"grounded",
             "storeys":[2,3],"verticality":0.5,"jetty":1},
  "openings":{"windowRhythm":"grouped","windowSpacing":3,"windowShape":"diamond",
              "recessDepth":1,"framing":"log","shutters":true,"doorStyle":"double"},
  "detailDensity":0.55,
  "signatureFeatures":["half-timber-framing","jettied-upper-floor","tall-brick-chimney",
                       "leaded-diamond-windows","irregular-wonky-walls"],
  "forbiddenBlocks":["quartz_block","prismarine","sea_lantern","glass","iron_block",
                     "sandstone","purpur_block"],
  "forbiddenFeatures":["flat-roof","curtain-wall","strict-symmetry","cantilever"]
}
```
> Note the corrections vs the first draft: `wallThickness` is **2** (reveals recess; §5.4.2), `detailDensity` **0.55** (inside the 40-60% coverage rule), `colorCentroids` are machine-checkable **Lab** values (not the human strings `"cream-white"` etc.), and `groundingMode` is explicit. **CI test:** assert every shipped style pack passes every hard gate *by construction*.

**Launch style packs:** Medieval/Tudor, Rustic Cottage, Elven/Fantasy, Nordic/Viking, Japanese/Pagoda, Mediterranean, Modern, Desert/Adobe, Gothic/Dark, Steampunk/Industrial, Mesa/Badlands.

### 5.6 The palette system

Every block has a **job**, not just a color.

- **60-30-10 tiering:** base ~60% (carries silhouette, low-noise), secondary ~30% (depth/contrast), accent <=10% (the pop), plus a detail slot (trace) and glass+light + organic slots. **Base + secondary + accent are required; trim and detail must be non-empty before a build is "finished".**
- **4-7 distinct blocks total** (fewer reads flat, more fragments) — *unless* the extras form one contiguous light->dark **tonal ramp**, which the eye reads as a single material.
- **Tonal gradients = "shading without shaders".** Pick a contiguous slice of a value ramp (e.g. `smooth_stone -> andesite -> stone -> cobbled_deepslate`) and distribute by simulated light direction (top/south lighter, bottom/north darker). Copper is a built-in warm->cool ramp (`copper -> exposed -> weathered -> oxidized`); expose `copper_stage` as a parameter.
- **Texture-frequency (noise) harmony.** Tag each block `noise` 0-3. **Never place two `noise>=3` blocks adjacent** unless same weathering family. Reward clean-base + busy-accent. Match grain (geometric grids with geometric; organic noise with organic).
- **Warm/cool + saturation.** Commit to one dominant **temperature**; the opposite appears only in <=10% accent; neutrals bridge. Default **earthy + low saturation** for base/secondary; high saturation only in accent/detail/light, capped ~10%. Oversaturation is Minecraft's most common failure.
- **Material semantics + biome fit.** Blocks carry cultural read (cobblestone = primitive/foundation, deepslate = cold/ancient, terracotta = sun-baked, copper = nautical/fantasy). Prefer materials plausibly sourced from the build's biome; cross-biome imports stay a motivated minority.
- **Anti-patterns (reject/penalize):** cobblestone-spam, plain-oak-plank boxes, rainbow syndrome, too many wood types (restrict to one wood value-ramp + at most one contrast wood), netherrack/crimson/warped/purpur in naturalistic overworld builds, quartz/concrete base on rustic/medieval, texture static, saturation mismatch, no trim/no depth.

**The per-block attribute database (an explicit, owned deliverable — not free).** Selection and adjacency rules operate on abstract attributes, so every used block state needs `{role, noise:0-3, temperature, saturation, material_semantic}`. That is ~1000+ block states of metadata. **Bootstrap** `temperature`/`saturation` automatically from the **average color of each block's texture** in the atlas the renderer already loads (convert to Lab, derive hue-temperature and chroma); hand-correct outliers; hand-author `role`/`noise`/`material_semantic` for the ~300 blocks builders actually use, defaulting the long tail. This is a scoped work item with an owner and a phase (M5b), not an afterthought.

### 5.7 Quality scoring rubric

Seven weighted categories, each 0-1, summed to 100. **Usable pre-render (geometry sub-scores) and post-render (vision sub-scores); final category = `0.5*geo + 0.5*vision` where both exist.** A hard-fail applies a `x0.5` multiplicative penalty so one egregious defect caps the category. **Weights reflect that palette and depth are the two fastest reads of quality** (this resolves the earlier draft's contradiction where palette was called "70% of the read" yet weighted lowest):

| Category | Weight | Measures | From failures |
|---|---:|---|---|
| Depth / Detail | 20 | Off-plane articulation, wall depth at reveals, texture intention, true 3D form | 1, 2, 7, 14, 15 |
| Palette / Color | 20 | Material discipline, hierarchy, saturation restraint, centroid match | 4, 10, 11 |
| Silhouette / Massing | 16 | Outline interest, height variation, non-boxiness, focal hierarchy | 3, 8, 18 |
| Coherence | 14 | Scale correctness, material logic, style/symmetry conformance | 9, 16, 8 |
| Roof | 12 | Presence, pitch, overhang/eaves, ridge | 5 |
| Grounding | 10 | Foundation/terrain blend per groundingMode, no floating | 6, 13 |
| Interior | 8 | Furnished ratio, room function, motivated lighting (geometry only in v1) | 12, 17 |

**Bands:** 85-100 portfolio-grade . 70-84 solid/shippable . 50-69 mediocre (visible slop) . <50 slop.
**Gate:** any hard-fail OR total <50 -> `REGENERATE`; 50-69 -> `REVISE` (targeted fixes); >=70 -> `PASS`.
**Feedback:** emit the worst 1-3 heuristics per category as actionable strings, e.g. *"Depth 0.41 — 92% of the south facade is on one plane; add pilasters/recessed windows to reach >=15% off-plane."*

**Geometry vs vision division of labor.** Geometry checks are cheap deterministic gates — run first, reject obvious slop pre-render to save render/vision cost. Geometry is authoritative on binary facts (thickness, floating, roof presence); vision dominates on subjective qualities (harmony, texture intention, focal read).

**Representative geometry heuristics (style-conditioned where noted):**
- `bounding_box_fill_ratio <= 0.62`; `>=3` silhouette height-levels; focal element `>= 1.5x` median-bay frontal area (from ortho render).
- `wall_thickness >= style.massing.wallThickness` (default 2) **and** reveal depth `>=2` at every opening.
- `pct_facade_cells_off_base_plane >= 0.15` per facade — **this is the flatness check** (geometric off-plane %, *not* material uniformity).
- Same-block run cap `<= 8` applies to **`secondary`/`accent` roles only**; a uniform `base` plane is exempt (a clean plaster gable is correct).
- Variant clustering: **Moran's I `>= 0.15`** on the variant field per facade (clustered, not salt-and-pepper) — replaces the meaningless "autocorrelation > 0".
- `eave_overhang >= 1`; `roof_pitch_ratio >= 0.5` (or `roof.type=="flat"` with a parapet check).
- Grounding: applies per `groundingMode` — `grounded` needs `perimeter_ground_contact_ratio >= 0.85`; `stilted` needs `>=N` ground-reaching supports instead.
- Palette: `distinct_exposed_material_count in [3,7]`; exposed-block color histogram clusters near `style.colorCentroids` (mean Lab distance below threshold); `{cobblestone,oak_planks}` share `<= 0.40`; `high_saturation_ratio <= 0.10`.
- Scale: `door_height in [2,3]`; `ceiling_height in [3,6]` **per room by function**; `window/wall in [0.10,0.35]`.
- Symmetry: **style-conditioned** — `symmetry:"asymmetric"` requires `mirror_symmetry_score < 0.95`; `"strict"` requires `> 0.9`; `"balanced"` a mid band. The gate reads `style.massing.symmetry`; it never fails a legitimately symmetric Georgian/temple/Modern build.

### 5.8 The critique / feedback loop

```
brief -> passes 1-11 -> voxel buffer -> RENDER (5-shot orbit + top-down)
                            |
                 +----------+------------+
                 v                        v
        HEURISTIC SCORER          LLM CRITIC (reads photos)
      (watertight, lit,          (massing/palette/depth/roof/
       grounded, symmetry,        grounding/scale/lighting +
       proportion, no-float)      "biggest weakness")
                 |                        |
                 +-----------+------------+
                             v
                 FUSE -> score vector + ranked defect list
                             |
              score >= threshold OR budget spent OR stalled?
              +--------------+-----------------+
             yes                              no
              |                                |
           COMMIT                 map defect -> a structured edit op
        (FAWE flush + worldDiff)   apply -> re-rasterize (DAG) -> re-render
```

- **Render, don't describe** — the critic judges photos because that's how humans catch obvious errors.
- **Two scorers fused** — heuristics veto hard faults with certainty; the LLM catches soft faults (bland facade, weak silhouette).
- **Targeted, budgeted edits** — each iteration re-runs only affected passes (via the DAG, §5.2), not a full regeneration.
- **Loop budget (explicit).** Default: **max 4 iterations**, **max 8 vision calls** per build. Incremental edits use a **single targeted shot** (re-render only the affected sub-box, `768x768`); a **full 5-shot review** runs only at iteration start and when a single shot is ambiguous. Renders are cached by region hash. These numbers are the primary cost/latency lever and live in config.
- **Loop-stall terminal behavior (defined).** If the critic reports a defect that **no** edit op can express (e.g. "composition feels awkward" with nothing in `{set_param, swap_palette, add_module, remove_module, rerun_pass}` that addresses it), the engine is deterministic and would re-derive the identical build — an infinite stall. Terminal rule: (1) first stall on a given score -> **escalate to a new seed** (re-run massing) once; (2) still stalled or out of budget -> **accept-and-ship the best-scoring buffer so far**, surfacing the unresolved critique to the user rather than looping. Never silently spin.
- **Everything before commit is free and reversible** because it lives in the buffer.

---

## 6. The Camera & Visual Feedback Loop

### 6.1 The load-bearing constraint

**A Paper/Spigot server cannot produce images.** A headless server JVM holds only block-state data — no GPU, no OpenGL, and critically *no client render assets* (block models, textures, blockstate mappings live in the client jar). So "the plugin takes a photo" is impossible. The plugin's role is strictly **data extraction**; all rendering happens Node-side. This eliminates the real-client and photographer-bot paths (they re-add the player session the redesign removes).

### 6.2 Recommended renderer (hardened against the native-GL risk)

**Render from data, not a live session.** The plugin's `captureRegion` returns a Sponge `.schem` (or compact JSON for tight loops); a Node **Renderer Service** meshes it with **real Minecraft block models/textures** — extracted from the **pinned version's client `.jar`** at build time (the authoritative source; `minecraft-data` supplies block-state semantics, and the nearest published `minecraft-assets` is a rendering-only fallback) — and photographs it. Getting stairs/slabs/fences/logs-with-axis right is the hard part and is exactly what makes a build read as native — so a real-model renderer is mandatory; a cube raycaster would make the LLM critique *rendering artifacts* as build flaws.

The one genuine risk is the **offscreen WebGL context in Node** (`headless-gl`/`node-canvas-webgl`/`gl`) — a notoriously fragile native module, worst of all on Windows. So the primary path avoids native GL:

- **Primary renderer: headless Chromium via Puppeteer.** Run three.js (prismarine-viewer's rendering core, or deepslate's `StructureRenderer`) inside headless Chrome, which supplies WebGL through **SwiftShader** (software rasterizer, no native build, works on Windows out of the box). Screenshot arbitrary orbit/ortho cameras. Portable and reliable; a bit slower than GPU.
- **Optional speed path: `headless-gl`.** Behind the *same* schematic contract, for when a fast native GL context is available (Linux CI / container). Purely an optimization — never the only path.
- **True independent fallback: Chunky (JVM).** A *different runtime* with *no Node-GL dependency*, so it fails independently of the whole Chromium/GL stack. Doubles as the beauty-pass (§6.5). If the Node render stack ever breaks, Chunky still yields images.

**This makes the two fallbacks fail independently** — the earlier "prismarine primary + deepslate fallback" both depended on the same native GL module, which did not de-risk the thing that actually breaks. Puppeteer/SwiftShader (Node/Chromium) and Chunky (JVM) share nothing.

### 6.3 Camera capture spec

Frame to the region bounding box: `center=(min+max)/2`, `radius=0.5*||max-min||`, `dist=radius/sin(fov/2)*1.15` (box fills ~80% of frame).

**`review` preset (default, 5 shots):**

| Shot | Type | Azimuth | Elevation |
|---|---|---|---|
| orbit_NE | perspective | 45deg | 35deg |
| orbit_SE | perspective | 135deg | 35deg |
| orbit_SW | perspective | 225deg | 35deg |
| orbit_NW | perspective | 315deg | 35deg |
| top_ortho | **orthographic** | — | 90deg |

FOV ~35deg (mild). **Fixed deterministic lighting** (sun at a fixed 45/60deg vector, full-bright floor, no day-night cycle, no shadows in MVP) — consistency matters more than realism so the LLM attributes change to *edits*, not lighting drift. Flat neutral background, optional ground plane at `min.y`. **768x768 per shot** (matches vision-model tiling, small base64); 1024^2 for detail shots. **Determinism contract:** identical `(region, preset, version)` => byte-stable PNGs, so before/after diffs are meaningful.

**v2 add-ons:** `detail` (auto-aimed at highest block-entropy cluster), `interior` (camera inside the box, roof-culled — harder than any exterior orbit, so it is deferred), `cutaway` (cross-section slice).

### 6.4 How photos return + the iterate loop

Each render returns N `image/png` base64 blocks in one MCP tool result, plus a text sidecar per image (shot name, azimuth/elevation, region dims, block count) for spatial grounding. The loop: **render** current region -> **critique** (vision rubric seeded from §5.4, top-down shot for layout/symmetry) -> **edit** -> **re-render** only the affected sub-box -> **terminate** on rubric threshold, budget, or stall (§5.8). Gate full 5-shot renders behind ambiguity/iteration-start to control token cost.

### 6.5 Stretch: Chunky beauty pass

For final presentation only: plugin emits `.schem` -> import into a throwaway Chunky world region -> headless `chunky -render` -> photoreal PNG with GI, soft shadows, AO. Minutes per render, never inside the tight loop — a handful of hero shots at the end. (Also the independent-fallback renderer of §6.2.)

---

## 7. Region, Build-Site & Schematic Model

### 7.1 Selection semantics (WorldEdit model, reused)

LLMs and humans share the WorldEdit mental model, so we reuse it. Selection types: **cuboid** (default), **polygonal** (2D verts + Y-range), **cylinder/ellipsoid**. **Internally normalize every selection to `(AABB, mask)`** — a bounding cuboid plus a per-voxel membership predicate (always-true for cuboid; polygon/ellipse test otherwise). The build model always allocates the AABB; the mask marks writable cells.

**Non-rectangular masks vs the rectangular grammar (an explicit rule, not a surprise).** The massing grammar assumes rect/L/cross footprints, but a polygonal site would clip generated geometry incoherently. Policy: the massing pass **fits the largest inscribed axis-aligned rectangle(s)** inside the mask and builds the primary structure there; leftover mask area becomes **landscaping/terracing/garden**, never clipped walls. If the inscribed rect is below a minimum footprint, the tool **rejects the site** with guidance ("selection too irregular for a building; select a rectangular-ish area >= WxL"). Cylinders map to round-tower templates where a style supports them, else the inscribed-rect rule applies.

**The `//wand` flow (human-in-the-loop):** `give-selection-wand` puts the session into selection-listen mode; the plugin catches `PlayerInteractEvent` left/right clicks as pos1/pos2; `get-current-selection` reads it back as structured data — **the human draws, the plugin reports the selection back for the LLM to consume.**

### 7.2 The BuildSite structure

A **BuildSite** is a named, reserved region — the persistent contract between "where" and "what", distinct from the transient voxel buffer written into it.

```ts
interface BuildSite {
  id:string; name:string;
  region:{ type:'cuboid'|'poly'|'cylinder'; min:Vec3; max:Vec3; mask?:RegionMask; };
  anchor:{ origin:Vec3; baseY:number; facing:'north'|'east'|'south'|'west'; };
  footprint:{ width:number; length:number; height:number };
  terrain:TerrainProfile;      // sampled ONCE at define time: heightmap, surfacePalette, slope, water
  context:{ biome:string; adjacency:Adjacency; reserved:boolean; };
  currentBuildVersion:number;
}
```

Anchor + facing are separate from region: the region is the *box*; the anchor is the *coordinate frame*. Rotating a build 90deg changes local->world mapping but not the box — rotation is a pure transform on the buffer. `terrain` is sampled once so passes plan foundations against a slope without per-block world queries. `reserved` prevents overlapping concurrent builds.

### 7.3 Schematic format choice

**Adopt Sponge `.schem` v3 internally (with a v2 export shim) as the canonical persisted format.** Reasons: (1) its dense palette + varint `Data` array maps 1:1 onto the in-memory buffer (near-zero serialization); (2) it carries entities, tile-entity NBT, biomes, and `DataVersion` for cross-version safety; (3) it's the interchange standard every builder tool reads; (4) no size cap. The v3 layout nests `Blocks`/`Biomes` compounds (`Palette` map + varint `Data`, indexed `x + z*W + y*W*L`) — **the same indexing as our voxel buffer.**

Provide **`.nbt` export** (vanilla structure blocks, auto-tiling past the ~48^3 cap) for mod-free servers, and optional **`.litematic`** for client-side assisted building. Do *not* make `.nbt` canonical — its sparse-list model and size cap fight the dense buffer.

### 7.4 Versioning / undo / iterate-in-place (single undo authority)

Each committed build is an immutable **version snapshot** on the BuildSite; iterate by branching, not mutating. Each `BuildVersion` stores the model (or a compressed `.schem` blob), a **`worldDiff` inverse patch** (the exact set of before-states the commit overwrote), a parent pointer, and a score.

**The engine's `worldDiff` is the single source of truth for build-level undo** — FAWE is only the *write mechanism* (`applyDiff`/`undoDiff` RPCs), never a second history. This avoids the desync that two competing undo systems (FAWE history vs engine patch) would suffer the moment surrounding terrain changes between commits. **Undo** = apply the stored inverse patch (exact even if terrain around the build changed); **redo** = re-apply forward. **Iterate in place** = clone the model -> new version with `parent` set -> passes edit only unprotected cells -> validate + score as dry-run -> commit only if score improves or human approves. Keep the last *k* full buffers in memory; spill older to `.schem` on disk.

---

## 8. Repository / Project Structure

Monorepo: Node (MCP + engine + renderer) and Java (plugin) coexist, tied by a shared language-neutral protocol package. pnpm workspaces for Node + Gradle for Java, orchestrated by Turborepo/Make.

```
minecraft-build-mcp/                     # repo root (renamed)
├─ pnpm-workspace.yaml . turbo.json . README.md
│
├─ protocol/                             # SHARED CONTRACT (language-neutral)
│  ├─ schema/                            #   JSON Schema source of truth
│  │  ├─ region.schema.json  rpc.blocks.json  rpc.world.json  worlddiff.json
│  ├─ ts/                                #   generated TS types + zod (-> mcp, engine)
│  └─ java/                              #   generated records (-> plugin)
│
├─ mcp/                                  # NODE MCP SERVER (evolved from today's src/)
│  ├─ src/
│  │  ├─ main.ts                         #   ADAPT (bootstrap)
│  │  ├─ tool-factory.ts                 #   KEEP (generalized Connection dep + image response)
│  │  ├─ plugin-connection.ts            #   REPLACES bot-connection.ts (WS RPC client)
│  │  ├─ config.ts  logger.ts  event-buffer.ts  stdio-filter.ts
│  │  └─ tools/
│  │     ├─ coordinate-utils.ts          #   KEEP (+ region helpers)
│  │     ├─ region-tools.ts  block-tools.ts  build-tools.ts
│  │     ├─ render-tools.ts  world-tools.ts  schematic-tools.ts
│  └─ test/                              #   ava specs
│
├─ engine/                               # ARTISTIC BUILD ENGINE (Node/TS library)
│  ├─ src/
│  │  ├─ rules/ { exterior, facade, roof, interior, grounding, palette, antislop }.ts
│  │  ├─ features/                       #   the Feature Kit: generator+detector per motif
│  │  ├─ styles/                         #   style-pack JSON (tudor, nordic, elven, ...)
│  │  ├─ blocks/ block-attributes.json   #   the per-block attribute DB (§5.6), part-generated
│  │  ├─ model/ { build-model, module-graph, voxel-buffer, meta-layers, pass-dag }.ts
│  │  ├─ passes/                         #   the 14 pipeline passes
│  │  ├─ scorer/                         #   geometry heuristics + rubric
│  │  ├─ critique/                       #   vision-fusion + edit-op translation
│  │  └─ index.ts
│  └─ test/
│
├─ renderer/                             # CAMERA / PHOTO service (Node)
│  ├─ src/ { schem-loader, mesher, camera, poses, capture, puppeteer-host }.ts
│  └─ test/                              #   golden-image compares
│
├─ plugin/                               # JAVA PAPER PLUGIN
│  ├─ build.gradle.kts                   #   shadowJar (relocate Jetty/Jackson); paperweight only if NMS needed
│  ├─ src/main/java/.../
│  │  ├─ BuildEnginePlugin.java          #   onEnable: start RPC, register cmds
│  │  ├─ rpc/                            #   Javalin HTTP+WS, JSON-RPC 2.0
│  │  ├─ world/                          #   WorldEditor iface: Fawe / Bukkit impls
│  │  │  └─ MainThreadExecutor.java      #   Bukkit + (later) Folia RegionScheduler
│  │  ├─ region/                         #   selection registry, locks, snapshots
│  │  └─ capture/                        #   captureRegion -> .schem/JSON
│  ├─ src/main/resources/{plugin.yml, config.yml}
│  └─ src/test/java/                     #   JUnit + real-Paper integration harness (not MockBukkit for FAWE)
│
└─ tools/codegen/                        # protocol schema -> ts + java
```

---

## 9. Phased Roadmap (M0-M6)

Guiding principle: keep the Node MCP + ToolFactory/zod/stdio spine alive the entire time; swap the world-effector underneath it. **Keep `--backend=bot` selectable through M5** so we never delete the only working end-to-end path before the artistic engine has proven value. Each phase keeps a runnable artifact. (Effort bands are rough T-shirt sizes, not commitments.)

| Phase | Goal | What works when done | Testable via | Effort |
|---|---|---|---|---|
| **M0** | Extract the reusable spine (no behavior change) | Bot still builds one block at a time; `ToolFactory` depends on a `Connection` interface; repo is a pnpm workspace | Existing ava suite passes unchanged | S |
| **M1** | Stand up plugin + protocol, in parallel with the bot | Paper plugin exposes an RPC endpoint doing batched writes (Bukkit main-thread first; FAWE off-thread next); `protocol/` codegen to TS+Java. Bot MCP untouched | JUnit + a **real-Paper** RPC integration test places blocks (MockBukkit can't cover FAWE/NMS) | M |
| **M2** | `PluginConnection` + first plugin-backed tools (flagged) | `region-tools` + adapted `block-tools` (`set-block`/`fill-region`/`get-block`/`find-blocks`) call the plugin via FAWE; both backends selectable (`--backend=plugin\|bot`) | ava drives `fill-region` against a test plugin | M |
| **M3** | Retire the player-bot *surface* (keep the connection) | Plugin is the default backend; `flight/position/inventory/crafting/furnace/entity` tool modules deleted; config swapped to plugin endpoint. **`--backend=bot` remains behind a flag** | ava suite green against plugin by default | S |
| **M4** | Camera / renderer loop | `captureRegion` + renderer service (Puppeteer/SwiftShader) + `render-tools` return MCP **image** content; LLM requests a photo of a region from named poses | Golden-image compare on a fixed test build | L |
| **M5a** | Engine skeleton -> committed build (one style, no palette variation) | region + prompt -> massing -> shell -> roof -> commit for a single style; proportion + silhouette + roof + grounding rulesets + geometry gate | Engine unit tests assert rule invariants; integration test builds into a test world | L |
| **M5b** | Palette system + remaining exterior rules + block-attribute DB | Full palette resolution (weighted, tonal ramps, centroids), facade detailing, Feature Kit v1, block-attribute DB. **Now retire `--backend=bot`** (engine has cleared the "good vs slop" corpus gate at least once) | "good vs slop" regression corpus gates the ruleset | L |
| **M6** | Closed-loop critique + iteration + interiors | M4 photos wired into `engine/critique`: render -> score -> refine -> re-apply (DAG-aware); interior/furniture passes (geometry-scored); full 7-category rubric; loop budget + stall handling | Critique scores improve across iterations on fixtures | L |

---

## 10. Tech Stack & Key Dependencies

| Layer | Choice | Justification |
|---|---|---|
| Plugin platform | **Paper**, Java 21, latest stable MC 1.21.x supported by Paper + FAWE (§11 #2), Gradle | Standard, best FAWE support; `paperweight-userdev` only if raw NMS is actually needed |
| Plugin descriptor | `plugin.yml`, `api-version: 1.21`, `softdepend: [WorldEdit, FastAsyncWorldEdit]` | Simplicity + Spigot fallback for v1 (migrate to `paper-plugin.yml` if dependency ordering demands) |
| Edit engine | **FAWE `EditSession`** (default, off-thread) behind a `WorldEditor` interface; raw-Bukkit `setBlockData(physics=false)` fallback (main-thread + budget) | `.schem`, chunk-parallel bulk, weighted `Pattern`/`Mask`; note the two threading models (§3.4) |
| Undo authority | **Engine `worldDiff` inverse patches** (FAWE = write mechanism only) | Single history; no FAWE-vs-engine desync |
| Threading | `MainThreadExecutor` (Bukkit + Folia impls) for Bukkit path; FAWE awaited off-thread | Correct writes per backend; Folia-ready at one interface's cost |
| Bridge | **Javalin (embedded Jetty): HTTP + WebSocket**, JSON-RPC 2.0, bearer token, localhost bind, job/progress streaming | Long-running builds need streaming; GDMC-HTTP-proven pattern, modernized. **shadowJar-relocate Jetty/Jackson** |
| Renderer | **Puppeteer + headless Chromium (SwiftShader) + three.js** (prismarine-viewer/deepslate core); `headless-gl` optional speed path; **Chunky** independent fallback + beauty pass | Portable (Windows-safe), no native GL build; real block models; two independent render stacks |
| Assets | Block models/blockstates/textures **extracted from the matching client `.jar`** at build time + `minecraft-data` semantics; nearest `minecraft-assets` as fallback | Real models for stairs/slabs/fences at the *latest* patch without waiting on lagging npm packages (§11 #2) |
| Persistence | **Sponge `.schem` v3** (v2 shim; `.nbt`/`.litematic` export) via `prismarine-nbt` | Interchange standard; maps 1:1 onto buffer; carries NBT/biomes/DataVersion |
| Node MCP | `@modelcontextprotocol/sdk`, zod, yargs, vec3; **keep** ToolFactory/stdio spine; **drop** mineflayer/pathfinder from the default build path | Minimal disruption to MCP surface; swap only the backend |
| Engine | Pure TS: seeded PRNG, split-grammar + parametric passes, Feature Kit, WFC lib (surface detail only) | Deterministic, inspectable, testable without Minecraft |
| Testing | ava (Node), JUnit + **real-Paper integration harness** (FAWE path), shared protocol contract tests, golden-image (renderer), "good vs slop" corpus (engine) | Each side of the boundary independently testable |

---

## 11. Decisions

Most sub-decisions have a recommended default baked in (Paper; FAWE-with-fallback; Java; `plugin.yml`; Puppeteer renderer; Javalin; `.schem` v3; flat-deterministic lighting; LLM-as-art-director; engine-owned undo; style-conditioned gates). The five below genuinely reshape the plan. **Nathan's calls, confirmed 2026-07-11:**

1. **Generation vs reproduction — DECIDED: generation-only.** v1 builds from a style + program brief (pass 0 is an LLM-authored spec, no image input). No reference-photo reproduction. Reproduction stays out of scope as a distinct future subsystem (image -> massing/proportion/palette extraction feeding pass 0), not a v1 parameter. *Note: this is a clean break from today's photo-tracing behavior — intentional, since composing-from-rules is the core anti-slop lever.*
2. **Version pin — DECIDED: target the latest MC patch** (not the older tool-intersection patch). We track the newest stable 1.21.x that **Paper + FAWE** ship for (they follow releases within days–weeks); the plugin, `.schem` `DataVersion`, and protocol pin to that exact patch. **The risk this creates is on the renderer**, because the npm asset packages (`minecraft-assets`) lag. Mitigation (now a first-class M4 task): **extract block models/blockstates/textures directly from the matching client `.jar`** for the pinned version at build time (the client jar is the authoritative source), with the nearest published `minecraft-assets` version as a rendering-only fallback. Block models change rarely within a major version, so the fallback is usually visually correct even when a patch is brand-new. See §3.1, §10, §12.
3. **Renderer host / OS — DECIDED: Windows-native, Puppeteer + Chromium SwiftShader.** No native GL build, runs on Nathan's Windows box directly. The `headless-gl` container path stays an *optional* speed path only; not required.
4. **"Styles as data" — DECIDED: data + shared Feature Kit.** A new style is data-only for palette/proportion/openings; signature features are code (generator + detector) but most styles compose from a shared ~15–20-feature kit (§5.5). Only a genuinely novel motif needs new code. Goal #5 (§1.4) is worded to match this honestly.
5. **Gate conditioning — standing recommendation (not separately asked): style-conditioned gates** (§5.7): symmetry/grounding/thickness read from the active StylePack so formal-symmetric and stilted styles both pass. Low-risk; assumed accepted. Flag if you'd rather ship a narrower universal-gate launch set instead.

---

## 12. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Renderer / native GL** — offscreen-GL native modules break on Windows/new Node | High | **Primary path is Puppeteer + Chromium SwiftShader (no native build, Windows-safe)**; `headless-gl` only as an optional container speed path; **Chunky (JVM) as a truly independent fallback** so the two don't share a failure mode. Spike the whole chain before M4 commits |
| **Block-model coverage for 1.21.x** — stairs/slabs/trapdoors/panes are what make a build native and what cube renderers get wrong | High | Real-model renderer (prismarine-viewer/deepslate), *not* a voxel raycaster; golden-image tests on stairs/slabs/trapdoor detailing or the LLM critiques rendering artifacts as build flaws |
| **FAWE threading misuse** — wrapping FAWE in the main-thread executor deadlocks / kills its perf | High | §3.4: FAWE is awaited **off-thread**; only `BukkitWorldEditor` uses `MainThreadExecutor` + `budgetPerTick`. Document and code-review this boundary |
| **FAWE untestable with MockBukkit** — the whole edit path could be untested until integration | Med | Stand up a **real Paper test server** (container) for the FAWE/NMS path from M1; MockBukkit only for pure-API logic |
| **Main-thread edit perf (Bukkit path)** — a big fill kills TPS | Med | `budgetPerTick` + self-rescheduling drain; **TPS guard** throttles below a floor; hard size caps in `config.yml`; prefer FAWE |
| **Version compat** — targeting the *latest* patch means npm asset packages lag | High | Track the latest patch Paper + FAWE support (§11 #2); **extract renderer assets from the matching client `.jar`** rather than waiting on `minecraft-assets` (block models change rarely within a major, so the nearest-version fallback is visually safe); `.schem` `DataVersion` for cross-version paste; verify FAWE coordinates at build time |
| **Engine produces generic output** — the "AI slop" the project fights | High | `forbiddenBlocks` per style; require 3+ *detected* signature features; weighted texture variation; geometry rubric rejects flat/boxy pre-render; vision loop repairs subjective blandness; "good vs slop" regression corpus gates rulesets |
| **Style-coherence is code, not data** — signature features are the hidden scope | High | First-class `Feature` (generator+detector) + shared Feature Kit; reuse across styles; honest scoping (~15-20 kit features at launch); detectors drive the "3+ tells" gate |
| **Per-block attribute DB scope** — ~1000+ states of metadata | Med | Bootstrap `temperature`/`saturation` from texture average color (Lab); hand-author the ~300 common blocks; default the tail; owned in M5b |
| **Iterate-loop cost/latency** — 5-shot vision calls x N iterations dominate cost | Med | Explicit budget (max 4 iters, max 8 vision calls); single targeted shot for incremental edits; full review only at start/ambiguity; render cache by region hash |
| **Loop stall** — critic reports an unaddressable defect; deterministic engine re-derives the same build | Med | Defined terminal behavior (§5.8): one seed-escalation, then accept-and-ship best score with the critique surfaced — never spin |
| **Interior visibility in renders** — NBT decoration (frames/paintings/banners/signs) isn't rendered | Med | Stub as placeholders; exclude from vision scoring in v1; geometry still counts presence; roof-culled interior shot deferred to v2 |
| **Direct world writes are destructive** — a bad `fillRegion` nukes spawn | High | Region locks + world allowlist + global bounding box; engine `worldDiff` undo + `snapshot`/`restoreSnapshot`; `dryRun` on every mutating RPC; auto-snapshot above a block threshold; localhost bind + bearer token |
| **Image transport ownership** — who serves images | Low | Renderer produces -> MCP relays base64 to Claude; the plugin never serves images it didn't render |
| **Scope creep** — the engine is unbounded | Med | Phased roadmap with a testable artifact each phase; styles are data; ship 5-shot review + core exterior rulesets at M5 before interiors/detailing at M6; edit budget bounds the loop |

---

## 13. Success Criteria — what "not slop" means measurably

A build ships when it clears both the deterministic gate and the vision gate.

**Deterministic (geometry) gate — all must pass (style-conditioned where noted):**
- Massing: `bounding_box_fill_ratio <= 0.62`; `>=3` silhouette height-levels; `>=1` focal element `>= 1.5x` median-bay frontal area (from the ortho render).
- Depth: `wall_thickness >= style.wallThickness` (default 2) with `>=2` reveal depth at every opening; `pct_facade_cells_off_base_plane >= 0.15` per facade; same-block run `<= 8` on `secondary`/`accent` roles (base exempt); Moran's I `>= 0.15` on variant placement.
- Roof: present, `pitch_ratio >= 0.5` (or `roof.type=="flat"` + parapet), `eave_overhang >= 1`, ridge capped.
- Grounding: per `groundingMode` — `grounded` -> `perimeter_ground_contact_ratio >= 0.85` + transition >=2 over >=70% of perimeter + no floating underside; `stilted` -> `>=N` ground-reaching supports; etc.
- Palette: `distinct_exposed_material_count in [3,7]`; exposed histogram clusters near `style.colorCentroids`; `{cobblestone,oak_planks}` share `<= 0.40`; `high_saturation_ratio <= 0.10`; trim + detail slots non-empty.
- Interior (geometry only in v1): `furnished_tile_ratio >= 0.20`; `>=1` functional cluster per room; `visible_light_source_density <= 1 per 25` surface blocks.
- Scale: `door_height in [2,3]`; `ceiling_height in [3,6]` per room by function; `window/wall in [0.10,0.35]`.
- Coherence: `mirror_symmetry` conforms to `style.massing.symmetry`; `>=3` of the active style's signature features **detected**; zero `forbiddenBlocks` used.

**Vision gate — LLM scores each >=0.6, weighted total >=70/100:**
Silhouette read (interesting outline, clear focal point), palette harmony (deliberate hierarchy, no garish saturation), depth & shadow (facade casts varied shadows, not a sticker), texture intention (bands/gradients/weathering, not TV-static), roof believability (pitch + eave shadow), grounding realism (sits in terrain, not pasted-on), scale plausibility, lighting quality (motivated, not spammed), and an overall verdict of **solid or better**.

**Headline target:** total score >=70 ("solid/shippable") with **zero hard-fails**, and — the true bar — a Minecraft builder looking at the renders would call it *built*, not *generated*: it reads as this specific style, sits in its landscape, casts real shadows, and rewards a look inside. Portfolio-grade (>=85) is the stretch goal for hero builds pushed through the Chunky beauty pass.

---

## Appendix A — The 18 slop failure modes -> fix -> check

| # | Failure mode | Why it's slop | Fix | Automated check |
|---|---|---|---|---|
| 1 | Flat mono-plane wall | No shadow, no scale cue | Off-plane articulation, pilasters, recesses | `pct_facade_cells_off_base_plane >= 0.15` |
| 2 | Sub-spec wall depth | Betrays a hollow shell | Per-style thickness + 2-deep reveals | `wall_thickness >= style value`, reveal `>=2` |
| 3 | Plain box massing | One contour, boring | Decompose into >=2 varied sub-volumes | `fill_ratio <= 0.62`, `>=3` height levels |
| 4 | Cobble/plank spam | Reads "default/unfinished" | Palette discipline, tonal ramps | `{cobblestone,oak_planks}` share `<= 0.40` |
| 5 | No roof overhang / flat | Decapitated look | Pitch + `>=1` eave + ridge cap | `pitch_ratio >= 0.5`, `eave_overhang >= 1` |
| 6 | Floating build | Pasted-on, no weight | Ground per `groundingMode` | contact ratio / support count |
| 7 | No depth/detailing | Blocky, cheap | Facade detailing pass | off-plane % + detail coverage |
| 8 | Over-symmetry (asym styles) | Diagram, not building | Style-conditioned symmetry | `mirror_symmetry` vs `style.symmetry` |
| 9 | Wrong scale | Uncanny | Scale gates by function | door/ceiling/window ratios |
| 10 | Clashing palette | Visual noise | 60-30-10 + noise harmony | material count, adjacency, centroids |
| 11 | Garish saturation | Toy-like | Earthy default, capped accent | `high_saturation_ratio <= 0.10` |
| 12 | Empty interior | Lifeless | Program + furniture clusters | `furnished_tile_ratio >= 0.20` |
| 13 | Abrupt terrain | No believability | Landscaping/terracing pass | transition width / contact |
| 14 | Uniform random noise | "TV static" | Clustered variation | Moran's I `>= 0.15` |
| 15 | Pixel-art-of-a-photo (1-deep) | Ignores 3D form | Top-down composition + depth | depth layers `>=2` |
| 16 | Decorative-as-structural | Reads wrong | Material semantics | role/semantic checks |
| 17 | Lighting spam | Flat, gamey | Sparse, hidden, warm | `visible_light_density <= 1/25` |
| 18 | No focal point | Eye wanders | Promote entrance/tower | focal frontal-area ratio `>= 1.5x` |

---

*This plan intentionally over-specifies the artistic rule system (§5) and the two hardest feasibility areas (rendering §6, plugin threading §3.4), because those are where the project succeeds or turns back into slop. Everything here is a proposal to refine — start with the five Open Questions in §11.*
