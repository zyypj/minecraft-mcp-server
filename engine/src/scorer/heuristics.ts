/**
 * Geometry heuristics (§5.7, §13).
 *
 * Cheap, deterministic measurements over the voxel buffer that feed the *geometry* sub-scores of
 * the rubric and gate obvious slop pre-render. Geometry is authoritative on binary facts
 * (thickness, floating, roof presence); vision dominates on subjective qualities.
 *
 * Every heuristic returns a typed {@link HeuristicResult}. The measurement bodies are STUBBED
 * (`value: NaN`, `implemented: false`) — but the **style-conditioning is wired**: symmetry,
 * grounding, wall-thickness, and centroid heuristics read their targets/thresholds from the active
 * {@link StylePack} so the returned `threshold` is already correct.
 */

import type { BuildModel, Facing } from "../model/build-model.js";
import type { StylePack, MaterialRoleName, Symmetry } from "../styles/style-pack.js";
import type { RubricCategory } from "./rubric.js";
import {
  BOUNDING_BOX_FILL_MAX,
  MIN_SILHOUETTE_HEIGHT_LEVELS,
  FOCAL_FRONTAL_AREA_RATIO_MIN,
} from "../rules/exterior.js";
import {
  MIN_OFF_PLANE_RATIO,
  MIN_REVEAL_DEPTH,
  SAME_BLOCK_RUN_CAP,
  MORANS_I_MIN,
  GLAZING_RATIO_MIN,
  GLAZING_RATIO_MAX,
  DEFAULT_WALL_THICKNESS,
  DOOR_HEIGHT_MIN,
  DOOR_HEIGHT_MAX,
} from "../rules/facade.js";
import { EAVE_OVERHANG_MIN, ROOF_PITCH_RATIO_MIN } from "../rules/roof.js";
import {
  PERIMETER_GROUND_CONTACT_RATIO_MIN,
  STILTED_MIN_SUPPORTS,
} from "../rules/grounding.js";
import {
  DISTINCT_MATERIAL_COUNT_MIN,
  DISTINCT_MATERIAL_COUNT_MAX,
  COBBLE_PLANK_SHARE_MAX,
  HIGH_SATURATION_RATIO_MAX,
  CENTROID_LAB_DISTANCE_MAX,
} from "../rules/palette.js";
import {
  FURNISHED_TILE_RATIO_MIN,
  VISIBLE_LIGHT_SURFACE_BLOCKS_PER_SOURCE,
  CEILING_HEIGHT_MIN,
  CEILING_HEIGHT_MAX,
} from "../rules/interior.js";

/** The typed result every heuristic returns. */
export interface HeuristicResult {
  /** Stable id, e.g. "depth.flatness.south". */
  id: string;
  category: RubricCategory;
  /** Measured value. `NaN` in the stub until implemented. */
  value: number;
  /** The gate threshold this value is compared against (already style-conditioned where relevant). */
  threshold?: number;
  /** Whether the value satisfies the threshold. `undefined` while unimplemented. */
  pass?: boolean;
  /** `false` until the measurement body is implemented. */
  implemented: boolean;
  note?: string;
}

/** Build a not-yet-implemented placeholder result (keeps the type contract usable in the skeleton). */
function todo(
  id: string,
  category: RubricCategory,
  threshold: number | undefined,
  milestone: string,
): HeuristicResult {
  return { id, category, value: NaN, threshold, pass: undefined, implemented: false, note: `TODO ${milestone}` };
}

// ── Silhouette / massing (§5.7) ───────────────────────────────────────────────────────────────

export function boundingBoxFillRatio(_model: BuildModel): HeuristicResult {
  return todo("silhouette.fill", "silhouette", BOUNDING_BOX_FILL_MAX, "M5a");
}

export function silhouetteHeightLevels(_model: BuildModel): HeuristicResult {
  return todo("silhouette.levels", "silhouette", MIN_SILHOUETTE_HEIGHT_LEVELS, "M5a");
}

export function focalFrontalAreaRatio(_model: BuildModel): HeuristicResult {
  return todo("silhouette.focal", "silhouette", FOCAL_FRONTAL_AREA_RATIO_MIN, "M5a");
}

// ── Depth / detail (§5.7) — wall thickness is STYLE-CONDITIONED ──────────────────────────────────

/** wall_thickness ≥ style.massing.wallThickness (default 2). Threshold read from the StylePack. */
export function wallThickness(_model: BuildModel, style: StylePack): HeuristicResult {
  const threshold = style.massing.wallThickness ?? DEFAULT_WALL_THICKNESS;
  return todo("depth.wallThickness", "depth", threshold, "M5b");
}

/** Reveal depth ≥ 2 at every opening. */
export function revealDepth(_model: BuildModel): HeuristicResult {
  return todo("depth.reveal", "depth", MIN_REVEAL_DEPTH, "M5b");
}

/** pct_facade_cells_off_base_plane per facade — THE flatness check. */
export function pctFacadeCellsOffBasePlane(_model: BuildModel, facing: Facing): HeuristicResult {
  return todo(`depth.flatness.${facing}`, "depth", MIN_OFF_PLANE_RATIO, "M5b");
}

/** Longest same-block run on a `secondary`/`accent` role (base exempt). */
export function sameBlockRunMax(_model: BuildModel, role: MaterialRoleName): HeuristicResult {
  return todo(`depth.run.${role}`, "depth", SAME_BLOCK_RUN_CAP, "M5b");
}

/** Moran's I on the variant field per facade (clustered, not salt-and-pepper). */
export function moransI(_model: BuildModel, facing: Facing): HeuristicResult {
  return todo(`depth.moransI.${facing}`, "depth", MORANS_I_MIN, "M5b");
}

/** window/wall ratio (also a scale cue). */
export function windowWallRatio(_model: BuildModel): HeuristicResult {
  const r = todo("depth.glazing", "depth", GLAZING_RATIO_MAX, "M5b");
  r.note = `${r.note}; band [${GLAZING_RATIO_MIN}, ${GLAZING_RATIO_MAX}]`;
  return r;
}

// ── Roof (§5.7) ─────────────────────────────────────────────────────────────────────────────────

export function eaveOverhang(_model: BuildModel): HeuristicResult {
  return todo("roof.overhang", "roof", EAVE_OVERHANG_MIN, "M5a");
}

export function roofPitchRatio(_model: BuildModel): HeuristicResult {
  return todo("roof.pitch", "roof", ROOF_PITCH_RATIO_MIN, "M5a");
}

// ── Grounding (§5.7) — STYLE-CONDITIONED by groundingMode ────────────────────────────────────────

/**
 * Grounding measurement, conditioned on `style.massing.groundingMode`:
 * `grounded` → perimeter_ground_contact_ratio (threshold 0.85);
 * `stilted`  → count of ground-reaching supports (threshold N);
 * others measured by their own rule family.
 */
export function groundingMeasure(_model: BuildModel, style: StylePack): HeuristicResult {
  const mode = style.massing.groundingMode;
  const threshold =
    mode === "grounded"
      ? PERIMETER_GROUND_CONTACT_RATIO_MIN
      : mode === "stilted"
        ? STILTED_MIN_SUPPORTS
        : undefined;
  const r = todo(`grounding.${mode}`, "grounding", threshold, "M5a");
  return r;
}

// ── Palette (§5.7) — centroid distance is STYLE-CONDITIONED ──────────────────────────────────────

export function distinctExposedMaterialCount(_model: BuildModel): HeuristicResult {
  const r = todo("palette.count", "palette", DISTINCT_MATERIAL_COUNT_MAX, "M5b");
  r.note = `${r.note}; band [${DISTINCT_MATERIAL_COUNT_MIN}, ${DISTINCT_MATERIAL_COUNT_MAX}]`;
  return r;
}

export function cobblePlankShare(_model: BuildModel): HeuristicResult {
  return todo("palette.cobblePlank", "palette", COBBLE_PLANK_SHARE_MAX, "M5b");
}

export function highSaturationRatio(_model: BuildModel): HeuristicResult {
  return todo("palette.saturation", "palette", HIGH_SATURATION_RATIO_MAX, "M5b");
}

/** Mean Lab distance of the exposed-block histogram to style.colorCentroids (style-conditioned). */
export function centroidLabDistance(_model: BuildModel, style: StylePack): HeuristicResult {
  const has = (style.colorCentroids?.length ?? 0) > 0;
  const r = todo("palette.centroid", "palette", CENTROID_LAB_DISTANCE_MAX, "M5b");
  if (!has) r.note = `${r.note}; style declares no colorCentroids (skip)`;
  return r;
}

// ── Coherence / scale (§5.7) — symmetry is STYLE-CONDITIONED ─────────────────────────────────────

/** Door height gate band [2,3]. */
export function doorHeights(_model: BuildModel): HeuristicResult {
  const r = todo("coherence.doorHeight", "coherence", DOOR_HEIGHT_MAX, "M5a");
  r.note = `${r.note}; band [${DOOR_HEIGHT_MIN}, ${DOOR_HEIGHT_MAX}]`;
  return r;
}

/**
 * Mirror-symmetry score, conditioned on `style.massing.symmetry`:
 * `asymmetric` requires < 0.95; `strict` requires > 0.9; `balanced` a mid band. The gate never
 * fails a legitimately symmetric Georgian/temple/Modern build.
 */
export function mirrorSymmetryScore(_model: BuildModel, style: StylePack): HeuristicResult {
  const sym: Symmetry = style.massing.symmetry;
  const threshold = sym === "strict" ? 0.9 : sym === "asymmetric" ? 0.95 : undefined;
  const r = todo(`coherence.symmetry.${sym}`, "coherence", threshold, "M5a");
  r.note = `${r.note}; conditioned on symmetry="${sym}"`;
  return r;
}

// ── Interior (§5.7, geometry only in v1) ─────────────────────────────────────────────────────────

export function furnishedTileRatio(_model: BuildModel): HeuristicResult {
  return todo("interior.furnished", "interior", FURNISHED_TILE_RATIO_MIN, "M6");
}

export function visibleLightDensity(_model: BuildModel): HeuristicResult {
  const r = todo("interior.lightDensity", "interior", 1 / VISIBLE_LIGHT_SURFACE_BLOCKS_PER_SOURCE, "M6");
  r.note = `${r.note}; max 1 per ${VISIBLE_LIGHT_SURFACE_BLOCKS_PER_SOURCE} surface blocks`;
  return r;
}

export function ceilingHeights(_model: BuildModel): HeuristicResult {
  const r = todo("interior.ceiling", "interior", CEILING_HEIGHT_MAX, "M6");
  r.note = `${r.note}; per-function band [${CEILING_HEIGHT_MIN}, ${CEILING_HEIGHT_MAX}]`;
  return r;
}

// ── Aggregation ────────────────────────────────────────────────────────────────────────────────

/** Run all geometry heuristics for a model+style (real dispatch; stubbed leaves). */
export function runGeometryHeuristics(model: BuildModel, style: StylePack): HeuristicResult[] {
  const facings: Facing[] = ["north", "east", "south", "west"];
  return [
    boundingBoxFillRatio(model),
    silhouetteHeightLevels(model),
    focalFrontalAreaRatio(model),
    wallThickness(model, style),
    revealDepth(model),
    ...facings.map((f) => pctFacadeCellsOffBasePlane(model, f)),
    ...facings.map((f) => moransI(model, f)),
    sameBlockRunMax(model, "secondary"),
    sameBlockRunMax(model, "accent"),
    windowWallRatio(model),
    eaveOverhang(model),
    roofPitchRatio(model),
    groundingMeasure(model, style),
    distinctExposedMaterialCount(model),
    cobblePlankShare(model),
    highSaturationRatio(model),
    centroidLabDistance(model, style),
    doorHeights(model),
    mirrorSymmetryScore(model, style),
    furnishedTileRatio(model),
    visibleLightDensity(model),
    ceilingHeights(model),
  ];
}

/**
 * Reduce raw heuristics to per-category geometry sub-scores (0..1). Stubbed: the reduction policy
 * (weighting individual heuristics within a category, hard-fail detection) lands with the real
 * measurement bodies.
 */
export function geometrySubScores(
  _model: BuildModel,
  _style: StylePack,
): Record<RubricCategory, number> {
  throw new Error("TODO M5b: heuristics.geometrySubScores — reduce HeuristicResult[] to category sub-scores");
}
