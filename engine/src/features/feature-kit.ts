/**
 * The Feature Kit (§5.5) — the honest core of "styles as data".
 *
 * Palette/proportion/openings are data; **signature features are code**. Each signature feature is
 * a {@link Feature}: a `generatorPass` that produces the motif on the module graph/buffer, and a
 * `detector` that returns 0..1 confidence the motif is present. Detectors drive the "3+ tells" gate
 * (§5.5): a build reads as its style only if ≥3 of its signature features are detected.
 *
 * Most features are parameterized and shared across styles, so a *new* style that composes existing
 * kit features is data-only; only a *genuinely new motif* needs a new `Feature`. This file ships a
 * few STUBBED kit features (generator + detector bodies throw / return placeholders) plus a real
 * registry and a real "count detected features" helper.
 */

import type { BuildModel } from "../model/build-model.js";
import type { BuildState } from "../model/pass-dag.js";
import type { StylePack } from "../styles/style-pack.js";

/** The context a feature generator runs in — the shared pipeline blackboard. */
export type FeatureContext = BuildState;

/** A signature feature: generator + detector + the params a style must supply (§5.5). */
export interface Feature {
  /** Stable id referenced by `StylePack.signatureFeatures` (e.g. "half-timber-framing"). */
  id: string;
  /** Human-readable name for tooling / critique strings. */
  displayName: string;
  /** CODE: produce the motif on the module graph / voxel buffer. */
  generatorPass: (ctx: FeatureContext) => void;
  /** CODE: 0..1 confidence the motif is present in the finished model. */
  detector: (model: BuildModel) => number;
  /** Params the style pack must provide for the generator (validated at style-load / build time). */
  requiredParams: string[];
}

/** Confidence at or above which a feature counts as "detected / present" for the 3+ tells gate. */
export const FEATURE_DETECTION_THRESHOLD = 0.5;

/** Minimum number of detected signature features for a build to read as its style (§5.5). */
export const MIN_SIGNATURE_FEATURES = 3;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Stubbed kit features
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `jetty(depth)` — a jettied (overhanging) upper floor (§5.5). Tudor's "jettied-upper-floor".
 */
export const jetty: Feature = {
  id: "jettied-upper-floor",
  displayName: "Jettied upper floor",
  requiredParams: ["depth"],
  generatorPass(_ctx: FeatureContext): void {
    throw new Error("TODO M5b: jetty.generatorPass — overhang the upper storey by `depth`, brace the underside");
  },
  detector(_model: BuildModel): number {
    // TODO M5b: measure upper-storey wall plane projecting beyond the lower plane by ~`depth`.
    return 0;
  },
};

/**
 * `halfTimberGrid(spacing, member)` — exposed half-timber framing over a plaster infill (§5.5).
 * Tudor's "half-timber-framing".
 */
export const halfTimberGrid: Feature = {
  id: "half-timber-framing",
  displayName: "Half-timber framing",
  requiredParams: ["spacing", "member"],
  generatorPass(_ctx: FeatureContext): void {
    throw new Error("TODO M5b: halfTimberGrid.generatorPass — lay a timber grid (posts/rails/braces) over infill");
  },
  detector(_model: BuildModel): number {
    // TODO M5b: detect a regular contrasting timber lattice over a base-material infill on facades.
    return 0;
  },
};

/**
 * `dormer(kind, count)` — dormer windows breaking a roof face (§5.4.3, §5.5). Shared across many
 * roofed styles.
 */
export const dormer: Feature = {
  id: "dormer",
  displayName: "Dormer windows",
  requiredParams: ["kind", "count"],
  generatorPass(_ctx: FeatureContext): void {
    throw new Error("TODO M5a: dormer.generatorPass — add `count` `kind` dormers on eligible roof faces");
  },
  detector(_model: BuildModel): number {
    // TODO M5a: detect roof-piercing gabled/hipped boxes with glazing on faces > ~8 blocks.
    return 0;
  },
};

// ────────────────────────────────────────────────────────────────────────────────────────────
// Registry (real)
// ────────────────────────────────────────────────────────────────────────────────────────────

const KIT: readonly Feature[] = [jetty, halfTimberGrid, dormer];

/** id → Feature for all shipped kit features. */
export const FEATURE_KIT: ReadonlyMap<string, Feature> = new Map(KIT.map((f) => [f.id, f]));

/** Look up a kit feature by id, or `undefined` if it is a not-yet-implemented motif. */
export function getFeature(id: string): Feature | undefined {
  return FEATURE_KIT.get(id);
}

/**
 * Resolve a style's `signatureFeatures` into concrete {@link Feature}s, separating implemented kit
 * features from ids that still need a novel generator+detector (budget: ~1 code unit each, §5.5).
 */
export function resolveSignatureFeatures(style: StylePack): {
  resolved: Feature[];
  missing: string[];
} {
  const resolved: Feature[] = [];
  const missing: string[] = [];
  for (const id of style.signatureFeatures) {
    const f = getFeature(id);
    if (f) resolved.push(f);
    else missing.push(id);
  }
  return { resolved, missing };
}

/**
 * Count how many of the given features are detected in the model (confidence ≥ threshold).
 * Drives the §5.5 "3+ tells" hard gate. Real aggregation over (stubbed) detectors.
 */
export function countDetectedFeatures(
  model: BuildModel,
  features: readonly Feature[],
  threshold: number = FEATURE_DETECTION_THRESHOLD,
): number {
  let n = 0;
  for (const f of features) if (f.detector(model) >= threshold) n++;
  return n;
}
