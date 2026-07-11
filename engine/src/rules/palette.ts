/**
 * Palette & color rules (§5.6).
 *
 * Every block has a *job*, not just a color. Palette is the fastest, cheapest thing to get wrong —
 * two builds with identical geometry read "pro" vs "noob" almost entirely on block selection.
 * Thresholds are real; checkers are stubbed.
 */

import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.6, §5.7, §13) ──────────────────────────────────────────────────────────────

/** 60-30-10 tiering: base ~60% (silhouette), secondary ~30% (depth), accent ≤10% (the pop). */
export const PALETTE_TIER_SHARES = { base: 0.6, secondary: 0.3, accent: 0.1 } as const;

/** Distinct exposed material count gate band (§5.7). Design guidance is 4–7 (§5.6). */
export const DISTINCT_MATERIAL_COUNT_MIN = 3;
export const DISTINCT_MATERIAL_COUNT_MAX = 7;

/** Combined share of the two "default/unfinished" blocks must stay low (§5.6 anti-pattern). */
export const COBBLE_PLANK_SHARE_MAX = 0.4;
export const COBBLE_PLANK_BLOCKS: readonly string[] = ["cobblestone", "oak_planks"];

/** High-saturation blocks capped as a fraction of exposed surface (oversaturation is #1 failure). */
export const HIGH_SATURATION_RATIO_MAX = 0.1;

/** Opposite-temperature blocks appear only in ≤10% accent; commit to one dominant temperature. */
export const OPPOSITE_TEMPERATURE_RATIO_MAX = 0.1;

/** Texture-frequency (noise) tag threshold: never place two noise≥3 blocks adjacent (§5.6)… */
export const NOISE_HIGH_THRESHOLD = 3;
/** …unless they belong to the same weathering family (e.g. the copper oxidation ramp). */
export const NOISE_ADJACENCY_EXEMPT_FAMILIES: readonly string[] = ["copper"];

/**
 * Max mean CIE Lab distance between the exposed-block color histogram and the style's
 * `colorCentroids` (§5.6). Tunable; ~ΔE units. Below this = clusters near the intended palette.
 */
export const CENTROID_LAB_DISTANCE_MAX = 20;

/** The copper oxidation ramp exposed as `copper_stage` (a built-in warm→cool ramp, §5.6). */
export const COPPER_RAMP: readonly string[] = [
  "copper_block",
  "exposed_copper",
  "weathered_copper",
  "oxidized_copper",
];

/** 4–7 distinct blocks is only relaxed if the extras form one contiguous light→dark tonal ramp. */
export const TONAL_RAMP_MAX_LEN = 6;

/**
 * The §5.6 detail/greeble coverage rule: `detailDensity` (and greeble scatter) is clamped to
 * 40–60% of eligible cells. Style packs declare `detailDensity` inside this band by construction.
 */
export const DETAIL_COVERAGE_MIN = 0.4;
export const DETAIL_COVERAGE_MAX = 0.6;

// ── Checkers (stubbed) ────────────────────────────────────────────────────────────────────────

/** distinct_exposed_material_count within [3,7] (unless a single contiguous tonal ramp). */
export const checkMaterialCount: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkMaterialCount");
};

/** 60-30-10 tiering respected; base + secondary + accent present; trim + detail non-empty. */
export const checkTiering: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkTiering");
};

/** {cobblestone, oak_planks} combined share ≤ 0.40 (anti cobble/plank spam). */
export const checkCobblePlankSpam: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkCobblePlankSpam");
};

/** high_saturation_ratio ≤ 0.10; one dominant temperature, opposite ≤10% accent. */
export const checkSaturationAndTemperature: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkSaturationAndTemperature");
};

/** Never two noise≥3 blocks adjacent unless same weathering family. */
export const checkNoiseHarmony: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkNoiseHarmony");
};

/** Exposed-block histogram clusters near style.colorCentroids (mean Lab distance below threshold). */
export const checkColorCentroids: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkColorCentroids (reads style.colorCentroids)");
};

/** Zero forbiddenBlocks used (§5.5). */
export const checkForbiddenBlocks: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: palette.checkForbiddenBlocks (reads style.forbiddenBlocks)");
};

/** All palette gates. */
export const paletteRules: readonly RuleCheck[] = [
  checkMaterialCount,
  checkTiering,
  checkCobblePlankSpam,
  checkSaturationAndTemperature,
  checkNoiseHarmony,
  checkColorCentroids,
  checkForbiddenBlocks,
];
