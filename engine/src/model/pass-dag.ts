/**
 * The pass DAG (§5.2).
 *
 * Each pass is a near-pure function `state -> state` over a shared blackboard (the module graph +
 * the palette-indexed voxel buffer + parallel meta layers). Passes declare which blackboard
 * `LayerTag`s they read and write, so the engine can:
 *
 *   1. run the whole pipeline in order, and
 *   2. **re-run one pass over a sub-region** and correctly recompute every *transitive dependent*
 *      that read what it wrote — otherwise a targeted edit silently leaves stale palette / greeble
 *      behind (§5.2).
 *
 * The dependency-graph computation and the mechanical region invalidation are REAL. The per-pass
 * `run` bodies live in `../passes` and are stubbed; the *recompute* step of a targeted re-run is
 * therefore only as real as those bodies.
 */

import { NO_PASS, type BuildModel, type Region } from "./build-model.js";
import type { Build, Brief, BuildSite } from "./module-graph.js";
import type { StylePack } from "../styles/style-pack.js";
import type { Prng } from "../util/prng.js";
import type { Defect, ScoreVector } from "../scorer/rubric.js";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Layer tags + pass identity
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The blackboard layers passes read/write. Dependency edges are derived from these: pass B depends
 * on pass A when B reads a layer A writes and A runs before B.
 */
export type LayerTag =
  | "brief"
  | "site"
  | "massing"
  | "shell"
  | "openings"
  | "roof"
  | "facade"
  | "palette"
  | "interior"
  | "furniture"
  | "landscape"
  | "greeble"
  | "score"
  | "commit";

/** Canonical pass identities (names). The numeric *ordinal* (for `writtenBy`) is the pipeline index. */
export type PassName =
  | "program"
  | "site-survey"
  | "massing"
  | "shell"
  | "openings"
  | "roof"
  | "facade-detail"
  | "palette"
  | "interior"
  | "furniture"
  | "landscaping"
  | "greeble"
  | "qa-score"
  | "commit-prep";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Pass + blackboard state
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The shared blackboard threaded through every pass. Passes mutate it in place (the plan's
 * "state -> state" over a shared blackboard); `run` returns void.
 */
export interface BuildState {
  /** The rasterized voxel buffer + provenance meta layers. */
  model: BuildModel;
  /** The semantic module graph (progressively filled: massing builds the volume tree). */
  graph: Build;
  brief: Brief;
  site: BuildSite;
  style: StylePack;
  /** The single seeded PRNG all controlled randomness flows through (§5.1). */
  prng: Prng;

  /** Name of the pass currently running (set by the {@link PassDag}). */
  currentPass: PassName | null;
  /** Ordinal of the pass currently running — pass this to `model.set({ passId })`. */
  currentPassOrdinal: number;
  /** When set (targeted re-run), passes should confine work to this sub-box. */
  activeRegion?: Region;

  /** Ranked defect list accumulated by QA. */
  defects: Defect[];
  /** Latest score vector, once QA has run. */
  score?: ScoreVector;
}

/** A pipeline pass (§5.2). */
export interface Pass {
  id: PassName;
  /** Blackboard layers this pass consumes. */
  reads: LayerTag[];
  /** Blackboard layers this pass produces. */
  writes: LayerTag[];
  /** Execute the pass, mutating `state` in place. Confine to `state.activeRegion` when set. */
  run(state: BuildState): void;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// PassDag
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs an ordered list of passes and supports targeted re-runs with transitive-dependent
 * invalidation. The pass order defines each pass's ordinal (its index), which is what
 * `MetaLayers.writtenBy` stores.
 */
export class PassDag {
  readonly passes: readonly Pass[];
  private readonly ordinalByName: Map<PassName, number>;
  /** Adjacency: pass name → names of its *direct* dependents (passes reading what it writes). */
  private readonly dependents: Map<PassName, PassName[]>;

  constructor(passes: Pass[]) {
    if (passes.length > 254) {
      // 255 is reserved as NO_PASS in the Uint8 writtenBy layer.
      throw new Error("PassDag: at most 254 passes (writtenBy is a Uint8)");
    }
    this.passes = passes;
    this.ordinalByName = new Map(passes.map((p, i) => [p.id, i]));
    this.dependents = this.computeDependents(passes);
  }

  /** Ordinal (writtenBy value) for a pass name. */
  ordinalOf(name: PassName): number {
    const ord = this.ordinalByName.get(name);
    if (ord === undefined) throw new Error(`PassDag: unknown pass ${name}`);
    return ord;
  }

  // ── Dependency graph (real) ───────────────────────────────────────────────────────────────

  private computeDependents(passes: Pass[]): Map<PassName, PassName[]> {
    const map = new Map<PassName, PassName[]>();
    for (const p of passes) map.set(p.id, []);
    for (let a = 0; a < passes.length; a++) {
      const A = passes[a] as Pass;
      const writes = new Set<LayerTag>(A.writes);
      for (let b = a + 1; b < passes.length; b++) {
        const B = passes[b] as Pass;
        if (B.reads.some((r) => writes.has(r))) {
          (map.get(A.id) as PassName[]).push(B.id);
        }
      }
    }
    return map;
  }

  /** Direct dependents of a pass (passes that read a layer it writes and run after it). */
  directDependents(name: PassName): PassName[] {
    return [...(this.dependents.get(name) ?? [])];
  }

  /**
   * All transitive dependents of a pass, returned in pipeline order (real graph traversal). This is
   * the set of passes a targeted re-run of `name` must recompute (§5.2).
   */
  transitiveDependents(name: PassName): PassName[] {
    const seen = new Set<PassName>();
    const stack = [...this.directDependents(name)];
    while (stack.length) {
      const n = stack.pop() as PassName;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of this.directDependents(n)) if (!seen.has(d)) stack.push(d);
    }
    return this.passes.map((p) => p.id).filter((id) => seen.has(id));
  }

  // ── Full run ──────────────────────────────────────────────────────────────────────────────

  /** Run every pass in order over the whole model. */
  run(state: BuildState): void {
    for (const pass of this.passes) {
      this.invoke(pass, state, undefined);
    }
  }

  // ── Targeted re-run with invalidation ───────────────────────────────────────────────────────

  /**
   * Re-run one pass (and its transitive dependents) over a sub-region. Wires the §5.2 structure:
   *   1. compute the affected passes (this pass + transitive dependents), in order;
   *   2. **invalidate** every voxel in `region` written by any affected pass (via `writtenBy`);
   *   3. recompute those passes over exactly that region.
   *
   * Step 2 is real; step 3 is only as real as the (currently stubbed) pass bodies.
   */
  rerun(name: PassName, region: Region, state: BuildState): void {
    const affected: PassName[] = [name, ...this.transitiveDependents(name)];
    const affectedOrdinals = new Set(affected.map((n) => this.ordinalOf(n)));

    this.invalidateRegion(state.model, affectedOrdinals, region);

    // Recompute in pipeline order, confined to the region.
    for (const pass of this.passes) {
      if (affected.includes(pass.id)) this.invoke(pass, state, region);
    }
  }

  /**
   * Clear every cell in `region` whose `writtenBy` ordinal is in `ordinals` (real, mechanical).
   * Locked cells are preserved by {@link BuildModel.clear}.
   */
  invalidateRegion(model: BuildModel, ordinals: Set<number>, region: Region): void {
    model.forEachInRegion(region, (x, y, z, i) => {
      const wb = model.meta.writtenBy[i] as number;
      if (wb !== NO_PASS && ordinals.has(wb)) model.clear(x, y, z);
    });
  }

  private invoke(pass: Pass, state: BuildState, region: Region | undefined): void {
    state.currentPass = pass.id;
    state.currentPassOrdinal = this.ordinalOf(pass.id);
    state.activeRegion = region;
    pass.run(state);
    state.currentPass = null;
    state.activeRegion = undefined;
  }
}
