/**
 * Interior rules (§5.4.5).
 *
 * Most builds nail the shell and leave interiors as empty torch-lit boxes; the fixes are cheap in
 * blocks, high in perceived quality. Ceiling-height ranges are **per room function**, not per build.
 * Thresholds are real; checkers are stubbed.
 */

import type { RoomFunction } from "../model/module-graph.js";
import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.4.5, §5.7, §13) ────────────────────────────────────────────────────────────

/** Ceiling clear-height gate band (air blocks between floor surface and ceiling underside). */
export const CEILING_HEIGHT_MIN = 3;
export const CEILING_HEIGHT_MAX = 6;

/** Per-function ceiling-height targets (§5.4.5): cozy = 3, grand hall = 6+, basement = 2–3. */
export const CEILING_HEIGHT_BY_FUNCTION: Record<RoomFunction, [number, number]> = {
  foyer: [4, 5],
  hall: [5, 6],
  kitchen: [3, 4],
  living: [4, 5],
  bedroom: [3, 4],
  study: [3, 4],
  storage: [3, 4],
  cellar: [2, 3],
  stairwell: [4, 6],
  corridor: [3, 4],
};

/** Floor light level must be ≥ 8 to block mob spawns (§5.4.5). */
export const FLOOR_LIGHT_MIN = 8;

/** Furnished-tile ratio floor (§5.7/§13). */
export const FURNISHED_TILE_RATIO_MIN = 0.2;

/** Furniture density: keep 40–60% floor coverage; preserve negative space (§5.4.5). */
export const FLOOR_COVERAGE_MIN = 0.4;
export const FLOOR_COVERAGE_MAX = 0.6;

/** ≤ 3–4 distinct materials per room. */
export const MATERIALS_PER_ROOM_MAX = 4;

/** Visible light sources: at most 1 per this many surface blocks (§5.7/§13 — no lighting spam). */
export const VISIBLE_LIGHT_SURFACE_BLOCKS_PER_SOURCE = 25;

/** Exposed ceiling beams run every 2–3 blocks across the short span (§5.4.5). */
export const BEAM_SPACING_MIN = 2;
export const BEAM_SPACING_MAX = 3;

/** Recommended room footprints (min/max side), §5.4.5. */
export const ROOM_FOOTPRINTS: Partial<Record<RoomFunction, { min: [number, number]; max: [number, number] }>> = {
  bedroom: { min: [5, 5], max: [7, 7] },
  kitchen: { min: [5, 6], max: [7, 8] },
  living: { min: [7, 7], max: [9, 11] },
};

/** Cluster "lived-in" cues in odd numbers; 2–3 cues per room, no more (§5.4.5). */
export const LIVED_IN_CUES_MIN = 2;
export const LIVED_IN_CUES_MAX = 3;

// ── Checkers (stubbed) ────────────────────────────────────────────────────────────────────────

/** Ceiling height within the per-function band for every room. */
export const checkCeilingHeights: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkCeilingHeights (per RoomFunction band)");
};

/** Rooms hang off a circulation spine (never chained); footprints within recommended ranges. */
export const checkProgramAndCirculation: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkProgramAndCirculation");
};

/** furnished_tile_ratio ≥ 0.20 and 40–60% coverage; ≥1 functional cluster per room. */
export const checkFurnishingDensity: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkFurnishingDensity");
};

/** Floor light ≥ 8; visible light density ≤ 1/25; warm-by-default, mostly hidden. */
export const checkLighting: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkLighting");
};

/** Floors zoned (border/inset) and ceilings treated (beams/coffers) — never flat. */
export const checkFloorsAndCeilings: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkFloorsAndCeilings");
};

/** Fire sources boxed on all touching faces by non-flammable blocks. */
export const checkFireSafety: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M6: interior.checkFireSafety");
};

/** All interior gates. */
export const interiorRules: readonly RuleCheck[] = [
  checkCeilingHeights,
  checkProgramAndCirculation,
  checkFurnishingDensity,
  checkLighting,
  checkFloorsAndCeilings,
  checkFireSafety,
];
