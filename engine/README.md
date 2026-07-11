# @mcbuild/engine — the Artistic Build Engine

> The deterministic, rule-driven core that turns a high-level brief into a validated,
> scored, in-memory voxel build. This package is the **Draftsman** of the four-role
> architecture (see `BUILD_ENGINE_PLAN.md` §1.3, §5). **Skeleton status:** types and the
> pipeline wiring are real; most pass/rule/heuristic bodies are stubbed (`throw new Error("TODO M5…")`).

## The art-director / engine split (§5.1)

The single most important design decision is a strict separation of concerns:

| Role | Who | Owns | Never does |
|---|---|---|---|
| **Art Director / Critic** | Claude (via MCP) | style, palette family, program, mood; reads rendered photos; issues *structured, high-level* edit ops | never names coordinates or places blocks |
| **Draftsman / Engine** | this package | 100% of massing, structure, detailing, palette resolution, rasterization, validation, scoring | never makes taste decisions |

The LLM and the engine communicate in a **typed vocabulary** — style tags, material roles,
module ids, and a fixed set of edit operations (`set_param`, `swap_palette`, `add_module`,
`remove_module`, `rerun_pass`; see `src/critique/edit-ops.ts`). The LLM chooses *from* this
vocabulary; it can never invent block placements. **The LLM informs choices; it never places blocks.**

The engine is **mostly deterministic**: given `(seed, brief, site)` it reproduces the exact
build. All variation flows through one seeded PRNG (`src/util/prng.ts`) with bounded ranges —
randomness adds *texture*, never *structure*.

## The 14-pass pipeline (§5.2)

Each pass is a near-pure function `state -> state` over a shared blackboard (the module graph +
the palette-indexed voxel buffer + parallel meta layers). Passes read earlier layers and write
their own; **nothing touches the live world until commit.** Every pass declares `reads` /
`writes` so the `PassDag` (`src/model/pass-dag.ts`) can run a *targeted* re-run of one pass over
a sub-region and correctly invalidate the transitive dependents via the `writtenBy` meta layer.

| # | Pass id | Produces |
|---|---|---|
| 0 | `program` | `Brief`: building type, room program, story, style tag, palette family, footprint |
| 1 | `site-survey` | buildable footprint, ground datum, terracing plan, entrance-facing dir |
| 2 | `massing` | abstract volume tree (boxes, storeys, wing adjacency) — no blocks yet |
| 3 | `shell` | load-bearing grid: corner posts, floor slabs, wall segments, bay spacing |
| 4 | `openings` | door/window placements (position, size, type) |
| 5 | `roof` | roof modules (gable/hip/mansard…), pitch, overhang, ridge, dormers |
| 6 | `facade-detail` | trim, string courses, quoins, pilasters, sills/lintels, timber framing |
| 7 | `palette` | concrete block ids + states for every abstract material role |
| 8 | `interior` | floor divisions, partition walls, stairs, room labels, light sources |
| 9 | `furniture` | furniture module instances placed & oriented |
| 10 | `landscaping` | terracing, retaining walls, path, garden, foundation skirt |
| 11 | `greeble` | weathering, moss/vines, cracked-block noise, hanging lanterns (density-capped) |
| 12 | `qa-score` | score vector + ranked defect list (geometry heuristics + vision critique) |
| 13 | *(targeted fixes)* | apply edit ops; re-run flagged passes until score ≥ threshold or budget spent |
| 14 | `commit-prep` | validated buffer → minimal change set for a batched FAWE flush |

> Pass 13 (targeted fixes) is not a `Pass` object — it is the critique/iterate loop that drives
> the `PassDag` re-run machinery (`src/critique`). The shipped `passes` array is the 0–12 + 14
> sequence of deterministic passes; the loop orchestrates them.

## Method selection per pass (§5.2)

Template + seeded jitter (passes 3–5, 9); shape/split grammars, CGA-style (passes 2, 6); WFC
(surface detail only, passes 6/11 — never load-bearing); constraint solving (passes 4, 8, 10 —
guarantees reachability, no overlap). **Pure ML / generative geometry is avoided** — opaque,
non-inspectable, produces slop.

## Package layout

```
src/
├─ model/
│  ├─ build-model.ts   BuildModel + MetaLayers, palette-indexed voxels, set() with provenance
│  ├─ module-graph.ts  the semantic build (Volume/Shell/Roof/Rooms/Features…)
│  └─ pass-dag.ts      Pass interface + PassDag runner with transitive-dependent invalidation
├─ passes/index.ts     the 14 passes as ordered Pass objects (stubbed run bodies)
├─ rules/              exterior · facade · roof · interior · grounding · palette · antislop
│                      (concrete thresholds as named constants + stubbed rule-checkers)
├─ styles/            StylePack schema + zod loader + tudor.json
├─ features/          the Feature Kit (generator + detector per motif)
├─ scorer/           rubric (7 weighted categories + PASS/REVISE/REGENERATE gate) + heuristics
├─ critique/         structured edit-op union + loop-budget / stall-terminal types
├─ util/prng.ts      seeded PRNG (mulberry32) + float / int-range / weighted-pick helpers
└─ index.ts          public exports + generateBuild(brief, site, style, seed) orchestrator
```

## Determinism contract

`generateBuild(brief, site, style, seed)` seeds exactly one PRNG. Two calls with equal arguments
produce a byte-identical `BuildModel`. This is what makes bugs reproducible, edits targeted, and
review meaningful — you can point at the *rule* that produced a flaw.
