/**
 * Facade / depth / detailing rules (§5.4.2, §5.6, §5.7).
 *
 * Cardinal sin: a flat, single-material, single-block-thick wall — no shadow, no scale cue, betrays
 * the shell. Note: **flatness of *plane* is the enemy, not uniformity of a *base* material** — a
 * clean plaster gable is correct. The flatness check targets geometric off-plane %; the same-block
 * run cap applies to `secondary`/`accent` roles, not `base`.
 *
 * Thresholds are real constants; checkers are stubbed. Wall-thickness is read from the StylePack.
 */

import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.4.2, §5.7, §13) ────────────────────────────────────────────────────────────

/** Default wall thickness when a style does not override `massing.wallThickness`. */
export const DEFAULT_WALL_THICKNESS = 2;

/** Every window/door reveal needs ≥2 blocks of depth so openings can recess (§5.4.2 exception). */
export const MIN_REVEAL_DEPTH = 2;

/** A wall run longer than this without a break must gain a pilaster/column/buttress or ±1 offset. */
export const WALL_RUN_BREAK_MAX = 5;

/** Insert articulation every 3–5 blocks. */
export const ARTICULATION_INTERVAL_MIN = 3;
export const ARTICULATION_INTERVAL_MAX = 5;

/** THE flatness check: ≥15% of a facade's cells must be off the base plane (geometric, per facade). */
export const MIN_OFF_PLANE_RATIO = 0.15;

/** Same-block run cap on `secondary`/`accent` roles (base plane is exempt). */
export const SAME_BLOCK_RUN_CAP = 8;

/**
 * Variant clustering: Moran's I on the variant field per facade must be ≥ this (clustered, not
 * salt-and-pepper) — replaces the meaningless "autocorrelation > 0" (§5.7). Guards TV-static noise.
 */
export const MORANS_I_MIN = 0.15;

/** Glazing (window/wall) ratio gate band (§5.7/§13). Design guidance is 20–40% (§5.4.2). */
export const GLAZING_RATIO_MIN = 0.1;
export const GLAZING_RATIO_MAX = 0.35;

/** Opening reveal recess depth (§5.4.2 — the highest-value depth trick). */
export const OPENING_RECESS_DEPTH = 1;

/** Tripartite zoning (§5.4.2): heavier plinth rows, body, oversailing cornice. */
export const PLINTH_ROWS_MIN = 1;
export const PLINTH_ROWS_MAX = 2;
export const CORNICE_ROWS = 1;

/** Door height gate (§5.7/§13 scale check). */
export const DOOR_HEIGHT_MIN = 2;
export const DOOR_HEIGHT_MAX = 3;

// ── Checkers (stubbed) ────────────────────────────────────────────────────────────────────────

/** wall_thickness ≥ style.massing.wallThickness AND every opening has reveal depth ≥ 2. */
export const checkThicknessAndReveals: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkThicknessAndReveals (reads style.massing.wallThickness)");
};

/** pct_facade_cells_off_base_plane ≥ 0.15 per facade. */
export const checkFlatness: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkFlatness");
};

/** No wall run > 5 without a break; articulation every 3–5 blocks; one window per bay. */
export const checkArticulation: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkArticulation");
};

/** Every facade divides into plinth / body / cornice. */
export const checkTripartiteZoning: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkTripartiteZoning");
};

/** Continuous string/belt course at each floor line for >1-storey builds. */
export const checkStringCourses: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkStringCourses");
};

/** Corner quoins present, alternating up the corner. */
export const checkQuoins: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkQuoins");
};

/** Openings framed (sill/lintel/jambs), column-aligned, equally spaced; glazing within band. */
export const checkOpenings: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkOpenings");
};

/** Same-block run ≤ 8 on secondary/accent roles (base exempt). */
export const checkSameBlockRuns: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkSameBlockRuns");
};

/** The entrance is promoted to a focal point (enlarged/framed/raised/flanked). */
export const checkEntranceFocal: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: facade.checkEntranceFocal");
};

/** All facade/depth/detailing gates. */
export const facadeRules: readonly RuleCheck[] = [
  checkThicknessAndReveals,
  checkFlatness,
  checkArticulation,
  checkTripartiteZoning,
  checkStringCourses,
  checkQuoins,
  checkOpenings,
  checkSameBlockRuns,
  checkEntranceFocal,
];
