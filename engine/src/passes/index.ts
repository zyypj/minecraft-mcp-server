/**
 * The 14-pass pipeline (§5.2).
 *
 * Each pass is a near-pure function `state -> state` over the shared blackboard, declaring the
 * `LayerTag`s it reads and writes so the {@link PassDag} can wire dependencies and run targeted
 * re-runs. This file assembles the ordered pass list with correct `reads`/`writes`; every `run`
 * body is a clearly-marked stub.
 *
 * Method selection per pass (§5.2): template + seeded jitter (shell/openings/roof/furniture);
 * shape/split grammars (massing/facade-detail); WFC on surface detail only (facade-detail/greeble);
 * constraint solving (openings/interior/landscaping). Pure ML/generative geometry is avoided.
 *
 * Note: plan pass 13 ("targeted fixes") is not a `Pass` object — it is the critique/iterate loop
 * (`../critique`) driving `PassDag.rerun`. The list below is the deterministic passes 0–12 + 14
 * (`commit-prep`); their array index is each pass's ordinal (what `MetaLayers.writtenBy` stores).
 */

import type { Pass, PassName, BuildState } from "../model/pass-dag.js";

/** Helper: a stubbed pass whose `run` throws with a milestone tag. */
function stub(
  id: PassName,
  reads: Pass["reads"],
  writes: Pass["writes"],
  milestone: string,
  summary: string,
): Pass {
  return {
    id,
    reads,
    writes,
    run(_state: BuildState): void {
      throw new Error(`TODO ${milestone}: ${id} pass — ${summary}`);
    },
  };
}

/** 0 — Program / brief. LLM-authored spec constrained to schema; deterministic defaults fill gaps. */
export const programPass: Pass = stub(
  "program",
  [],
  ["brief"],
  "M5a",
  "resolve the LLM intent into a validated Brief (building type, room program, footprint, style tag)",
);

/** 1 — Site read & grounding survey. Heightmap analysis; datum = min/median height under footprint. */
export const siteSurveyPass: Pass = stub(
  "site-survey",
  ["brief"],
  ["site"],
  "M5a",
  "read heightmap/biome/slope; compute buildable footprint, ground datum, terracing plan, entrance-facing dir",
);

/** 2 — Massing. Split grammar; φ-family proportioning; seeded dimension jitter. */
export const massingPass: Pass = stub(
  "massing",
  ["brief", "site"],
  ["massing"],
  "M5a",
  "build the abstract volume tree (boxes, storeys, wing adjacency) — no blocks yet",
);

/** 3 — Structure / shell. Column-grid solver; reserve opening-free surfaces; per-style thickness. */
export const shellPass: Pass = stub(
  "shell",
  ["massing"],
  ["shell"],
  "M5a",
  "lay the load-bearing grid: corner posts, floor slabs, wall segments, bay spacing",
);

/** 4 — Openings. Rhythm/alignment constraint solve; windows face view/sun, door faces path. */
export const openingsPass: Pass = stub(
  "openings",
  ["shell", "brief"],
  ["openings"],
  "M5a",
  "place doors/windows (position, size, type) with column alignment and equal spacing",
);

/** 5 — Roof. Roof grammar keyed to style; pitch from footprint aspect; eave modules. */
export const roofPass: Pass = stub(
  "roof",
  ["shell", "massing"],
  ["roof"],
  "M5a",
  "generate roof modules (gable/hip/mansard…), pitch, overhang, ridge, dormers",
);

/** 6 — Facade detailing. Split-grammar subdivision (floors→bays→tiles→trim); depth variation. */
export const facadeDetailPass: Pass = stub(
  "facade-detail",
  ["shell", "openings", "roof"],
  ["facade"],
  "M5b",
  "add trim, string courses, quoins, pilasters, sills/lintels, timber framing; manufacture depth",
);

/** 7 — Palette resolution. Palette lookup + seeded weighted variation (texture noise). */
export const palettePass: Pass = stub(
  "palette",
  ["massing", "shell", "openings", "roof", "facade"],
  ["palette"],
  "M5b",
  "bind abstract material roles → concrete block ids/states with weighted variation and tonal ramps",
);

/** 8 — Interior. Room program; circulation spine; ceiling height by function; light ≥ 8. */
export const interiorPass: Pass = stub(
  "interior",
  ["shell", "openings", "brief"],
  ["interior"],
  "M6",
  "divide floors, add partitions/stairs, label rooms, place light sources",
);

/** 9 — Furniture / fixtures. Per-room templates with clearance; orient toward focal point. */
export const furniturePass: Pass = stub(
  "furniture",
  ["interior"],
  ["furniture"],
  "M6",
  "instance and orient furniture clusters around each room's focal point",
);

/** 10 — Landscaping / grounding. Blend base into terrain; A* path to edge; planting scatter. */
export const landscapingPass: Pass = stub(
  "landscaping",
  ["site", "shell", "massing"],
  ["landscape"],
  "M5b",
  "terrace/retain into slope, add foundation skirt, path, garden per groundingMode",
);

/** 11 — Detail / greeble. WFC or seeded scatter over eligible surfaces; density-capped. */
export const greeblePass: Pass = stub(
  "greeble",
  ["palette", "facade", "roof", "landscape"],
  ["greeble"],
  "M5b",
  "scatter weathering/moss/vines/cracks/lanterns within the §5.6 coverage cap",
);

/** 12 — QA / score. Geometry heuristics (+ later vision critique) → score vector + defect list. */
export const qaScorePass: Pass = stub(
  "qa-score",
  ["massing", "shell", "openings", "roof", "facade", "palette", "interior", "furniture", "landscape", "greeble"],
  ["score"],
  "M5a",
  "run geometry heuristics and produce the score vector + ranked defect list",
);

/** 14 — Commit prep. Diff voxels vs world → minimal change set (gravity-safe ordering). */
export const commitPrepPass: Pass = stub(
  "commit-prep",
  ["palette", "greeble", "score"],
  ["commit"],
  "M5a",
  "diff the validated buffer into a minimal, gravity-safe change set for a batched FAWE flush",
);

/**
 * The canonical, ordered pipeline. **Array index == pass ordinal** (the value stored in
 * `MetaLayers.writtenBy`). The critique/iterate loop (plan pass 13) sits on top and is not listed.
 */
export const PIPELINE_PASSES: readonly Pass[] = [
  programPass, // 0
  siteSurveyPass, // 1
  massingPass, // 2
  shellPass, // 3
  openingsPass, // 4
  roofPass, // 5
  facadeDetailPass, // 6
  palettePass, // 7
  interiorPass, // 8
  furniturePass, // 9
  landscapingPass, // 10
  greeblePass, // 11
  qaScorePass, // 12
  commitPrepPass, // 13 (plan pass 14 — commit)
];

/** Pass name → ordinal, derived from {@link PIPELINE_PASSES}. */
export const PASS_ORDINAL: Readonly<Record<PassName, number>> = Object.fromEntries(
  PIPELINE_PASSES.map((p, i) => [p.id, i]),
) as Record<PassName, number>;
