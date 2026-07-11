/**
 * Grounding / landscaping rules (§5.4.6).
 *
 * "Floating box on flat grass" is slop — ground contact is where believability is won. **Grounding
 * is style-conditioned via `groundingMode`**: `grounded | stilted | terraced | cantilever`. The gate
 * reads `style.massing.groundingMode` and applies the matching check family.
 *
 * Thresholds are real; checkers are stubbed.
 */

import type { GroundingMode } from "../styles/style-pack.js";
import type { RuleCheck, RuleContext, RuleResult } from "./rule-types.js";

// ── Thresholds (§5.4.6, §5.7, §13) ────────────────────────────────────────────────────────────

/** `grounded`: fraction of the wall-base perimeter that must touch ground. */
export const PERIMETER_GROUND_CONTACT_RATIO_MIN = 0.85;

/** `grounded`: seam transition width (blocks of blend, not a clean 90° line). */
export const TRANSITION_WIDTH_MIN = 2;

/** `grounded`: the transition must cover at least this fraction of the perimeter. */
export const TRANSITION_PERIMETER_COVERAGE_MIN = 0.7;

/** `grounded`: no vertical cut face taller than this at the seam. */
export const MAX_VERTICAL_CUT_AT_SEAM = 2;

/** `stilted`: minimum number of support columns/piles reaching the ground datum. */
export const STILTED_MIN_SUPPORTS = 4;

/** `cantilever`: no unsupported floating overhang deeper than this (blocks). */
export const CANTILEVER_MAX_UNSUPPORTED_DEPTH = 2;

// ── Checkers (stubbed, style-conditioned) ─────────────────────────────────────────────────────

/** `grounded`: contact ratio ≥ 0.85, transition ≥ 2 over ≥70% perimeter, no >2 cut face. */
export const checkGrounded: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5a: grounding.checkGrounded");
};

/** `stilted`: ≥N ground-reaching supports and a detailed (braced) underside — contact ratio N/A. */
export const checkStilted: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: grounding.checkStilted");
};

/** `terraced`: each terrace grounds independently into the slope with retaining walls. */
export const checkTerraced: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: grounding.checkTerraced");
};

/** `cantilever`: projecting mass is visibly supported (brackets/lower mass/counterweight). */
export const checkCantilever: RuleCheck = (_ctx: RuleContext): RuleResult => {
  throw new Error("TODO M5b: grounding.checkCantilever");
};

/** Dispatch table: pick the check family for the active grounding mode (§5.4.6). */
export const GROUNDING_CHECK_BY_MODE: Record<GroundingMode, RuleCheck> = {
  grounded: checkGrounded,
  stilted: checkStilted,
  terraced: checkTerraced,
  cantilever: checkCantilever,
};

/** Run the grounding gate for the context's style (real dispatch, stubbed leaves). */
export const checkGrounding: RuleCheck = (ctx: RuleContext): RuleResult => {
  return GROUNDING_CHECK_BY_MODE[ctx.style.massing.groundingMode](ctx);
};
