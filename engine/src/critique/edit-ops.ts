/**
 * The structured edit-op vocabulary and the critique loop's budget / stall behavior (§5.8).
 *
 * The LLM art director never places blocks — it chooses from this fixed set of edit operations, and
 * the engine translates a ranked defect into one of them (§1.3, §5.8). The loop is budgeted and has
 * a *defined* terminal behavior so a deterministic engine never spins on an unaddressable critique.
 *
 * The edit-op union and budget/stall types are real; `defectToEditOp` and `applyEditOp` are stubbed,
 * while `decideTerminal` (the stall/terminal state machine) is a REAL implementation.
 */

import type { Region } from "../model/build-model.js";
import type { PassName } from "../model/pass-dag.js";
import type { MaterialRoleName, WeightedBlock } from "../styles/style-pack.js";
import type { Defect } from "../scorer/rubric.js";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Edit-op union (§1.3, §5.8)
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Adjust a scalar/enum knob on the brief or style pack (e.g. `massing.verticality`). */
export interface SetParamOp {
  op: "set_param";
  /** Dotted path into the brief or active style pack. */
  path: string;
  value: number | string | boolean;
}

/** Swap a palette role's block list, or advance the copper oxidation stage. */
export interface SwapPaletteOp {
  op: "swap_palette";
  role: MaterialRoleName;
  /** New weighted block list for the role (mutually exclusive with `copperStage`). */
  blocks?: WeightedBlock[];
  /** Copper oxidation stage 0–3 (unoxidized→oxidized), for copper-ramp roles. */
  copperStage?: 0 | 1 | 2 | 3;
}

/** Module kinds the LLM may request the engine to add. */
export type AddableModule =
  | "wing"
  | "tower"
  | "porch"
  | "dormer"
  | "chimney"
  | "pilaster"
  | "string-course"
  | "quoins"
  | "plinth";

/** Add a module to the graph (engine decides exact geometry). */
export interface AddModuleOp {
  op: "add_module";
  module: AddableModule;
  params?: Record<string, number | string | boolean>;
  /** Volume the module attaches to (defaults to the main mass). */
  targetVolumeId?: string;
}

/** Remove a previously added module by id. */
export interface RemoveModuleOp {
  op: "remove_module";
  moduleId: string;
}

/** Re-run one pass, optionally over a sub-region (drives {@link PassDag.rerun}). */
export interface RerunPassOp {
  op: "rerun_pass";
  pass: PassName;
  region?: Region;
}

/** The fixed set of edit operations the LLM chooses from (§1.3). */
export type EditOp = SetParamOp | SwapPaletteOp | AddModuleOp | RemoveModuleOp | RerunPassOp;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Loop budget (§5.8)
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The iterate loop's cost/latency lever — the primary knob, lives in config (§5.8). */
export interface LoopBudget {
  /** Max refine iterations per build. */
  maxIterations: number;
  /** Max vision (render+critique) calls per build. */
  maxVisionCalls: number;
  /** Pixel size of a single targeted re-render (affected sub-box only). */
  targetedShotSize: number;
  /** Pixel size of a full 5-shot review render. */
  reviewShotSize: number;
}

/** Defaults from §5.8: max 4 iterations, max 8 vision calls, 768² shots. */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxIterations: 4,
  maxVisionCalls: 8,
  targetedShotSize: 768,
  reviewShotSize: 768,
};

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stall / terminal behavior (§5.8)
// ────────────────────────────────────────────────────────────────────────────────────────────

/** What the loop should do next. */
export type TerminalDecision =
  /** Keep iterating: apply the mapped edit op, re-rasterize, re-render. */
  | "continue"
  /** Stalled once: escalate to a new seed and re-run massing (allowed exactly once). */
  | "seed-escalate"
  /** Stop: accept-and-ship the best-scoring buffer so far, surfacing any unresolved critique. */
  | "accept-best";

/** Mutable state of one build's critique loop. */
export interface LoopState {
  iteration: number;
  visionCalls: number;
  /** Best rubric total (0..100) seen so far. */
  bestScore: number;
  /** Reference/handle to the best-scoring buffer, to ship on `accept-best`. */
  bestModelRef?: string;
  /** Whether the one-time seed escalation has already been spent. */
  seedEscalated: boolean;
}

/** Signals the caller derives from the latest critique before asking for a terminal decision. */
export interface LoopSignals {
  /** The build cleared the rubric gate (≥70, zero hard-fails). */
  passed: boolean;
  /**
   * The loop is stalled: either the critic's defect maps to no edit op, or the last applied edit
   * did not improve the score — a deterministic engine would re-derive the identical build.
   */
  stalled: boolean;
}

/**
 * The §5.8 terminal state machine (REAL). Order matters:
 *  1. a passing build ships immediately;
 *  2. exhausted budget → ship the best;
 *  3. a stall → escalate the seed once, otherwise ship the best;
 *  4. otherwise keep iterating.
 * Never returns "continue" when it would spin.
 */
export function decideTerminal(
  state: LoopState,
  budget: LoopBudget,
  signals: LoopSignals,
): TerminalDecision {
  if (signals.passed) return "accept-best";
  if (state.iteration >= budget.maxIterations || state.visionCalls >= budget.maxVisionCalls) {
    return "accept-best";
  }
  if (signals.stalled) return state.seedEscalated ? "accept-best" : "seed-escalate";
  return "continue";
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Defect → edit-op translation (stubbed)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Map a ranked defect to the single structured edit op that best addresses it (§5.8). Returns
 * `null` when nothing in the vocabulary can express a fix — that `null` is what makes the loop
 * "stalled" and triggers {@link decideTerminal}'s seed-escalate / accept-best path.
 */
export function defectToEditOp(_defect: Defect): EditOp | null {
  throw new Error("TODO M6: critique.defectToEditOp");
}

/** Apply a structured edit op to the build state (drives targeted DAG re-runs). */
export function applyEditOp(_op: EditOp): void {
  throw new Error("TODO M6: critique.applyEditOp");
}
