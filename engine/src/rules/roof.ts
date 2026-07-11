/**
 * Roof rules (§5.4.3).
 *
 * Roofs are the single biggest driver of a house's read. A flat/flush roof looks decapitated.
 * Thresholds are real; checkers are stubbed.
 */

import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.4.3, §5.7, §13) ────────────────────────────────────────────────────────────

/** Overhang: at least a 1-block eave with a detailed underside (§5.4.3). */
export const EAVE_OVERHANG_MIN = 1;

/** Minimum pitch ratio for a pitched roof (or `roof.type == "flat"` with a parapet check). */
export const ROOF_PITCH_RATIO_MIN = 0.5;

/** Add ≥1 dormer per roof face longer than ~8 blocks (rhythm + light). */
export const DORMER_FACE_LENGTH_MIN = 8;

/** Add ≥1 offset chimney breaking the ridge; this is its minimum offset from the ridge midpoint. */
export const CHIMNEY_OFFSET_MIN = 1;

/** Pitch → block choice (degrees): full blocks / stairs (default) / alternating slabs. */
export const PITCH_ANGLE_FULL_BLOCK = 63.4;
export const PITCH_ANGLE_STAIR_DEFAULT = 45;
export const PITCH_ANGLE_SLAB = 22.5;

// ── Checkers (stubbed) ────────────────────────────────────────────────────────────────────────

/** A roof is present (never a single-slab "roof line"). */
export const checkRoofPresent: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: roof.checkRoofPresent");
};

/** pitch_ratio ≥ 0.5, OR roof.type == "flat" satisfying the parapet check. */
export const checkPitch: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: roof.checkPitch");
};

/** eave_overhang ≥ 1 with a detailed underside; a flush roof fails. */
export const checkOverhang: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: roof.checkOverhang");
};

/** Ridge is capped; intersecting ridges on L/T/cross footprints share pitch/height, valleys knit. */
export const checkRidge: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: roof.checkRidge");
};

/** ≥1 dormer per roof face > ~8 blocks; ≥1 offset chimney breaking the ridge. */
export const checkDormersAndChimney: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: roof.checkDormersAndChimney");
};

/** All roof gates. */
export const roofRules: readonly RuleCheck[] = [
  checkRoofPresent,
  checkPitch,
  checkOverhang,
  checkRidge,
  checkDormersAndChimney,
];
