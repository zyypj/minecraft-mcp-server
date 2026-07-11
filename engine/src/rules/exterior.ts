/**
 * Exterior / massing rules (§5.4.1).
 *
 * Governing idea: **a plain box is slop** — one contour, one shadow, nothing for the eye to travel.
 * Break one volume into legible sub-volumes that vary in *two* dimensions.
 *
 * Thresholds below are exported named constants (real, load-bearing values). Checkers are stubbed.
 */

import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.4.1, §5.7, §13) ────────────────────────────────────────────────────────────

/** Silhouette must not fill more than 62% of its bounding box (else it reads as a solid box). */
export const BOUNDING_BOX_FILL_MAX = 0.62;

/** At least this many distinct silhouette height levels (§5.7). */
export const MIN_SILHOUETTE_HEIGHT_LEVELS = 3;

/** A focal element's frontal silhouette area must be ≥ this × the median per-bay frontal area. */
export const FOCAL_FRONTAL_AREA_RATIO_MIN = 1.5;

/** Decompose a single uniform-height rectangle into at least this many sub-volumes. */
export const MIN_SUBVOLUMES = 2;

/** The dominant volume must exceed the others by this factor in *both* height and footprint. */
export const DOMINANT_VOLUME_RATIO_MIN = 1.25;

/** Subordinate wings should be 60–80% of the main volume's height. */
export const SUBORDINATE_WING_HEIGHT_MIN = 0.6;
export const SUBORDINATE_WING_HEIGHT_MAX = 0.8;

/** Project/recess a bay by 1–2 blocks to create layered shadow. */
export const PROJECT_RECESS_MIN = 1;
export const PROJECT_RECESS_MAX = 2;

/** A tower/vertical accent must be taller than wide by at least this ratio. */
export const TOWER_ASPECT_RATIO_MIN = 2.5;

/** The golden ratio; main-to-wing height aims near φ:1, panels near 3:2 / 5:3 (§5.4.1). */
export const PHI = 1.618;

/** Preferred phi-family facade/footprint proportions (avoid 1:1 and 2:1 — static). */
export const PROPORTION_TARGETS: ReadonlyArray<readonly [number, number]> = [
  [3, 2],
  [5, 3],
];

/** Interior clear storey heights: cottage minimum, "quality" default (§5.4.1). */
export const STOREY_CLEAR_MIN = 3;
export const STOREY_CLEAR_DEFAULT = 4;

/** Exterior storey pitch = interior clear + at least this (room for sill + lintel). */
export const STOREY_PITCH_EXTRA_MIN = 2;

// ── Checkers (stubbed) ────────────────────────────────────────────────────────────────────────

/** IF a single uniform-height rectangle → require ≥2 sub-volumes differing in height AND depth. */
export const checkDecomposition: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: exterior.checkDecomposition");
};

/** One volume must dominate in both height and footprint (≥1.25×); wings 60–80% of main height. */
export const checkHierarchy: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: exterior.checkHierarchy");
};

/** At least one focal element with frontal area ≥ 1.5× median-bay frontal area (ortho render). */
export const checkFocalElement: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: exterior.checkFocalElement");
};

/** Bounding-box fill ≤ 0.62 and ≥3 silhouette height levels. */
export const checkSilhouette: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: exterior.checkSilhouette");
};

/** Storey heights within the per-style/function ranges, with the +2 exterior pitch allowance. */
export const checkStoreyHeights: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: exterior.checkStoreyHeights");
};

/** All exterior/massing gates. */
export const exteriorRules: readonly RuleCheck[] = [
  checkDecomposition,
  checkHierarchy,
  checkFocalElement,
  checkSilhouette,
  checkStoreyHeights,
];
