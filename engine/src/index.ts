/**
 * `@mcbuild/engine` — the Artistic Build Engine (§5).
 *
 * Public surface: the build model + module graph, the pass DAG and the 14 passes, the rule system
 * and thresholds, the scoring rubric + geometry heuristics, the Feature Kit, the style-pack system,
 * the critique edit-op vocabulary, and the seeded PRNG — plus the top-level {@link generateBuild}
 * orchestrator.
 *
 * The engine is the **Draftsman** (§1.3): it owns all geometry and never makes taste decisions. The
 * LLM art director drives it through the typed edit-op vocabulary in `critique/edit-ops.ts`.
 */

// ── Re-exports (public API) ─────────────────────────────────────────────────────────────────────

export * from "./util/prng.js";
export * from "./model/build-model.js";
export * from "./model/module-graph.js";
export * from "./model/pass-dag.js";
export * from "./passes/index.js";

export * from "./rules/rule-types.js";
export * from "./rules/exterior.js";
export * from "./rules/facade.js";
export * from "./rules/roof.js";
export * from "./rules/interior.js";
export * from "./rules/grounding.js";
export * from "./rules/palette.js";
export * from "./rules/antislop.js";

export * from "./scorer/rubric.js";
export * from "./scorer/heuristics.js";

export * from "./critique/edit-ops.js";
export * from "./features/feature-kit.js";
export * from "./styles/index.js";

// ── Orchestrator ─────────────────────────────────────────────────────────────────────────────

import { Prng } from "./util/prng.js";
import { BuildModel, type Dims, type Facing } from "./model/build-model.js";
import { PassDag, type BuildState } from "./model/pass-dag.js";
import {
  type Brief,
  type BuildSite,
  type Build,
  type MaterialRoles,
} from "./model/module-graph.js";
import { PIPELINE_PASSES } from "./passes/index.js";
import type { StylePack } from "./styles/style-pack.js";
import type { ScoreVector } from "./scorer/rubric.js";

/** What {@link generateBuild} returns once the pipeline (eventually) runs to completion. */
export interface GenerateBuildResult {
  /** The rasterized, validated voxel buffer (no world write has occurred). */
  model: BuildModel;
  /** The semantic module graph. */
  graph: Build;
  /** The final score vector, present after the QA pass. */
  score?: ScoreVector;
  /** The seed used (echoed for reproducibility / seed-escalation). */
  seed: number;
}

/** Initial abstract role bindings (§5.3) — resolved to concrete blocks by the palette pass. */
function initialMaterialRoles(): MaterialRoles {
  return {
    WALL_PRIMARY: { role: "base" },
    TRIM: { role: "detail" },
    // Roof material is resolved from `style.roof.material` at pass 7; "secondary" is a placeholder slot.
    ROOF: { role: "secondary" },
    ACCENT: { role: "accent" },
    GLASS: { role: "glass" },
  };
}

/** Construct the initial blackboard graph the massing pass will flesh out. */
function initialGraph(brief: Brief, site: BuildSite, style: StylePack, seed: number, dims: Dims): Build {
  return {
    meta: { seed, style: style.id, brief },
    site: {
      footprintPoly: [],
      datumY: site.anchor.baseY,
      orientation: site.anchor.facing,
      terrainOps: [],
    },
    root: {
      id: "root",
      role: "main",
      transform: { origin: { x: 0, y: 0, z: 0 }, size: dims, rotation: 0 },
      materialRoles: initialMaterialRoles(),
      children: [],
      features: [],
    },
  };
}

/**
 * The deterministic build orchestrator (§5.1, §5.2).
 *
 * Given `(brief, site, style, seed)` it seeds exactly one PRNG, allocates the voxel buffer sized to
 * the site footprint, assembles the shared blackboard, and runs the {@link PassDag} over all 14
 * passes. Two calls with equal arguments must produce a byte-identical `BuildModel` (the determinism
 * contract, §5.1).
 *
 * SKELETON: the wiring below is real, but the passes throw `TODO` — so this currently throws at the
 * `program` pass rather than returning a finished build. Nothing writes to the world; commit is a
 * separate step (`commit-prep` pass → protocol `applyDiff`).
 */
export function generateBuild(
  brief: Brief,
  site: BuildSite,
  style: StylePack,
  seed: number,
): GenerateBuildResult {
  const prng = new Prng(seed);

  const dims: Dims = {
    w: site.footprint.width,
    h: site.footprint.height,
    l: site.footprint.length,
  };
  const facing: Facing = site.anchor.facing;

  const model = new BuildModel({ dims, origin: site.anchor.origin, facing });
  const graph = initialGraph(brief, site, style, seed, dims);

  const state: BuildState = {
    model,
    graph,
    brief,
    site,
    style,
    prng,
    currentPass: null,
    currentPassOrdinal: 0,
    defects: [],
  };

  const dag = new PassDag([...PIPELINE_PASSES]);
  dag.run(state); // TODO M5a+: passes are stubbed — this throws at the `program` pass for now.

  return { model: state.model, graph: state.graph, score: state.score, seed };
}
