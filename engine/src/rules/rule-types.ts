/**
 * Shared types for the rule system (§5.4).
 *
 * Each rule is stated IF/THEN and algorithm-checkable where possible. Rules are **gates** — they
 * return violations — as opposed to `scorer/heuristics.ts`, which returns graded measurements.
 * Thresholds that vary by style are read from the active {@link StylePack}, never hard-coded
 * globally (§5.4, §5.5, §5.8).
 */

import type { BuildModel, Region, Facing } from "../model/build-model.js";
import type { StylePack } from "../styles/style-pack.js";

/** Severity of a rule violation. A `hard` violation caps its rubric category with a ×0.5 penalty. */
export type Severity = "hard" | "soft";

/** One localized rule violation (§5.3: diagnostics must be localized, e.g. "north wall, y=68"). */
export interface RuleViolation {
  /** Stable rule id, e.g. "facade.flatness". */
  rule: string;
  severity: Severity;
  /** Human-readable, actionable message (feeds critique feedback strings, §5.7). */
  message: string;
  /** Optional localization for targeted fixes. */
  where?: { region?: Region; facing?: Facing; moduleTag?: string; roomLabel?: string };
  /** Optional measured value vs threshold, for reporting. */
  measured?: number;
  threshold?: number;
}

/** Result of running a rule or rule group. */
export interface RuleResult {
  pass: boolean;
  violations: RuleViolation[];
}

/** Everything a rule checker needs. `region` narrows a check to a sub-box (targeted validation). */
export interface RuleContext {
  model: BuildModel;
  style: StylePack;
  region?: Region;
}

/** A single rule checker. */
export type RuleCheck = (ctx: RuleContext) => RuleResult;

/** Convenience: a passing result. */
export const OK: RuleResult = { pass: true, violations: [] };

/** Convenience constructor for a failing result from one violation. */
export function fail(v: RuleViolation): RuleResult {
  return { pass: false, violations: [v] };
}

/** Merge several rule results into one (pass iff all pass). */
export function mergeResults(results: RuleResult[]): RuleResult {
  const violations = results.flatMap((r) => r.violations);
  return { pass: violations.length === 0, violations };
}
