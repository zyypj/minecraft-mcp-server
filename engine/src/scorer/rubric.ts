/**
 * The quality scoring rubric (§5.7).
 *
 * Seven weighted categories, each 0..1, summed to 100. Categories are usable pre-render (geometry
 * sub-scores) and post-render (vision sub-scores); the fused category is `0.5*geo + 0.5*vision`
 * where both exist. A hard-fail applies a ×0.5 multiplicative penalty so one egregious defect caps
 * the category. **Weights reflect that palette and depth are the two fastest reads of quality.**
 *
 * The weights, band thresholds, fusion math, and PASS/REVISE/REGENERATE gate are REAL. The
 * per-category geo/vision *inputs* come from `heuristics.ts` (geometry) and the vision critic and
 * are stubbed upstream.
 */

import type { EditOp } from "../critique/edit-ops.js";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Categories + weights (CORRECTED weights, §5.7)
// ────────────────────────────────────────────────────────────────────────────────────────────

export type RubricCategory =
  | "depth"
  | "palette"
  | "silhouette"
  | "coherence"
  | "roof"
  | "grounding"
  | "interior";

/** Category weights (sum = 100). Palette and depth carry the most weight (§5.7). */
export const RUBRIC_WEIGHTS: Readonly<Record<RubricCategory, number>> = {
  depth: 20,
  palette: 20,
  silhouette: 16,
  coherence: 14,
  roof: 12,
  grounding: 10,
  interior: 8,
};

/** Canonical category order (weight-descending, then plan order) for stable reporting. */
export const RUBRIC_CATEGORIES: readonly RubricCategory[] = [
  "depth",
  "palette",
  "silhouette",
  "coherence",
  "roof",
  "grounding",
  "interior",
];

/** Multiplicative penalty applied to a category with a hard-fail (§5.7). */
export const HARD_FAIL_MULTIPLIER = 0.5;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Bands + gate thresholds (§5.7)
// ────────────────────────────────────────────────────────────────────────────────────────────

export type Band = "portfolio" | "solid" | "mediocre" | "slop";

export const BAND_PORTFOLIO_MIN = 85; // 85–100 portfolio-grade
export const BAND_SOLID_MIN = 70; //     70–84 solid / shippable
export const BAND_MEDIOCRE_MIN = 50; //  50–69 mediocre (visible slop)
//                                     <50 slop

/** Gate verdict (§5.7). */
export type Verdict = "PASS" | "REVISE" | "REGENERATE";

/** total ≥ 70 → PASS; 50–69 → REVISE; any hard-fail OR total < 50 → REGENERATE. */
export const PASS_THRESHOLD = 70;
export const REGENERATE_THRESHOLD = 50;

/** Per-sub-score vision floor: the vision gate requires each score ≥ 0.6 (§13). */
export const VISION_SUBSCORE_MIN = 0.6;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Score shapes
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface CategoryScore {
  category: RubricCategory;
  /** Geometry sub-score 0..1 (cheap, deterministic; authoritative on binary facts). */
  geo?: number;
  /** Vision sub-score 0..1 (subjective qualities; dominant on harmony/texture/focal read). */
  vision?: number;
  /** Fused, hard-fail-penalized score 0..1. */
  score: number;
  /** Whether a hard-fail capped this category. */
  hardFail: boolean;
  /** Worst 1–3 actionable heuristics for this category (§5.7 feedback strings). */
  feedback: string[];
}

export interface ScoreVector {
  categories: Record<RubricCategory, CategoryScore>;
  /** Weighted total 0..100. */
  total: number;
  band: Band;
  verdict: Verdict;
  /** Categories that hit a hard-fail. */
  hardFails: RubricCategory[];
}

/** A ranked defect (QA output, §5.2/§5.7) — feeds the critique loop's edit-op mapping. */
export interface Defect {
  category: RubricCategory;
  /** Id of the heuristic/rule that produced it, e.g. "facade.flatness". */
  heuristicId: string;
  severity: "hard" | "soft";
  /** Actionable message, e.g. "Depth 0.41 — 92% of the south facade is on one plane…". */
  message: string;
  measured?: number;
  threshold?: number;
  /** The structured edit op that would address it, when one exists (§5.8). */
  suggestedEditOp?: EditOp;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Fusion + gate (real)
// ────────────────────────────────────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Fuse a category's geometry and vision sub-scores (§5.7): mean where both exist, otherwise the one
 * that does; then apply the ×0.5 hard-fail penalty. Neither present → 0.
 */
export function fuseCategory(
  geo: number | undefined,
  vision: number | undefined,
  hardFail: boolean,
): number {
  let base: number;
  if (geo !== undefined && vision !== undefined) base = 0.5 * geo + 0.5 * vision;
  else if (geo !== undefined) base = geo;
  else if (vision !== undefined) base = vision;
  else base = 0;
  if (hardFail) base *= HARD_FAIL_MULTIPLIER;
  return clamp01(base);
}

/** Build a {@link CategoryScore} from raw sub-scores. */
export function makeCategoryScore(
  category: RubricCategory,
  parts: { geo?: number; vision?: number; hardFail?: boolean; feedback?: string[] },
): CategoryScore {
  const hardFail = parts.hardFail ?? false;
  return {
    category,
    geo: parts.geo,
    vision: parts.vision,
    score: fuseCategory(parts.geo, parts.vision, hardFail),
    hardFail,
    feedback: parts.feedback ?? [],
  };
}

/** Weighted total 0..100 from the seven category scores (real). */
export function computeTotal(categories: Record<RubricCategory, CategoryScore>): number {
  let total = 0;
  for (const c of RUBRIC_CATEGORIES) {
    total += categories[c].score * RUBRIC_WEIGHTS[c];
  }
  return total;
}

/** Band for a 0..100 total (§5.7). */
export function bandFor(total: number): Band {
  if (total >= BAND_PORTFOLIO_MIN) return "portfolio";
  if (total >= BAND_SOLID_MIN) return "solid";
  if (total >= BAND_MEDIOCRE_MIN) return "mediocre";
  return "slop";
}

/**
 * The PASS/REVISE/REGENERATE gate (§5.7, REAL): any hard-fail OR total < 50 → REGENERATE;
 * 50–69 → REVISE; ≥ 70 → PASS.
 */
export function gate(total: number, hasHardFail: boolean): Verdict {
  if (hasHardFail || total < REGENERATE_THRESHOLD) return "REGENERATE";
  if (total < PASS_THRESHOLD) return "REVISE";
  return "PASS";
}

/** Assemble a full {@link ScoreVector} from the seven category scores (real aggregation). */
export function makeScoreVector(categories: Record<RubricCategory, CategoryScore>): ScoreVector {
  const total = computeTotal(categories);
  const hardFails = RUBRIC_CATEGORIES.filter((c) => categories[c].hardFail);
  return {
    categories,
    total,
    band: bandFor(total),
    verdict: gate(total, hardFails.length > 0),
    hardFails,
  };
}
