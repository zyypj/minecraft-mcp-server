/**
 * Style blending, fidelity and originality.
 *
 * Three separate knobs, because they answer three different questions and conflating them is why
 * "make it like X but different" usually produces mush:
 *
 *  - **Blend weights** — *whose* vocabulary. `carousel 0.7 / snoopy 0.3` means the architecture and
 *    palette lean carousel while a third of the decoration language comes from snoopy.
 *  - **Fidelity** — *how closely* to follow the blended profile's measurements. At 0.2 the profile
 *    is a hint; at 1.0 the generator matches its edge roughness, decoration density, symmetry and
 *    focal ratio as exactly as it can.
 *  - **Originality** — *how much deliberate divergence* to introduce on top. High fidelity with high
 *    originality is the interesting combination: unmistakably the same builder's hand, definitely
 *    not the same map.
 *
 * Fidelity interpolates toward the profile; originality jitters afterwards. They are not opposites,
 * and the generator applies them in that order.
 */

import { type Prng, clamp01, lerp } from "../core/prng.js";
import { Palette, type PaletteJson, blendPalettes } from "../mc18/palette.js";
import type { CompositionProfile, DensityProfile, StyleProfile, SymmetryProfile, TerrainProfile } from "./profile.js";

export interface StyleWeight {
  readonly profile: StyleProfile;
  /** Relative weight; the set is normalized. */
  readonly weight: number;
}

/**
 * Blend several style profiles into one.
 *
 * Numeric traits interpolate. Categorical traits (layout kind, dominant symmetry) go to the heaviest
 * contributor rather than being averaged, because there is no meaningful midpoint between "radial"
 * and "linear" — picking one and letting the other contribute its palette and motifs is what a
 * person would do.
 */
export function blendStyleProfiles(inputs: readonly StyleWeight[], id = "blend"): StyleProfile {
  if (inputs.length === 0) throw new Error("blendStyleProfiles needs at least one profile");
  if (inputs.length === 1) return { ...inputs[0]!.profile, id };

  const total = inputs.reduce((sum, i) => sum + Math.max(0, i.weight), 0);
  if (total <= 0) throw new Error("blendStyleProfiles: weights must sum above zero");
  const normalized = inputs.map((i) => ({ profile: i.profile, weight: Math.max(0, i.weight) / total }));
  const dominant = [...normalized].sort((a, b) => b.weight - a.weight)[0]!.profile;

  const mix = (pick: (p: StyleProfile) => number): number =>
    Math.round(normalized.reduce((sum, i) => sum + pick(i.profile) * i.weight, 0) * 10000) / 10000;

  const symmetry: SymmetryProfile = {
    mirrorX: mix((p) => p.symmetry.mirrorX),
    mirrorZ: mix((p) => p.symmetry.mirrorZ),
    radial: Object.fromEntries(
      Object.keys(dominant.symmetry.radial).map((fold) => [
        fold,
        mix((p) => p.symmetry.radial[fold] ?? 0),
      ]),
    ),
    dominant: dominant.symmetry.dominant,
    dominantScore: mix((p) => p.symmetry.dominantScore),
  };

  const terrain: TerrainProfile = {
    voidRatio: mix((p) => p.terrain.voidRatio),
    edgeRoughness: mix((p) => p.terrain.edgeRoughness),
    meanThickness: mix((p) => p.terrain.meanThickness),
    surfaceRelief: mix((p) => p.terrain.surfaceRelief),
    heightLevels: Math.round(mix((p) => p.terrain.heightLevels)),
  };

  const density: DensityProfile = {
    fillRatio: mix((p) => p.density.fillRatio),
    surfaceRatio: mix((p) => p.density.surfaceRatio),
    decorationDensity: mix((p) => p.density.decorationDensity),
    detailBlockRatio: mix((p) => p.density.detailBlockRatio),
    glassRatio: mix((p) => p.density.glassRatio),
  };

  const composition: CompositionProfile = {
    ...dominant.composition,
    satelliteCount: Math.round(mix((p) => p.composition.satelliteCount)),
    satelliteRingRatio: mix((p) => p.composition.satelliteRingRatio),
    focalRatio: mix((p) => p.composition.focalRatio),
  };

  const palette = blendPaletteJson(normalized.map((n) => ({ json: n.profile.palette, weight: n.weight })), `${id}-palette`);

  return {
    ...dominant,
    id,
    name: normalized.map((n) => `${n.profile.name} ${Math.round(n.weight * 100)}%`).join(" + "),
    source: {
      files: normalized.flatMap((n) => n.profile.source.files),
      dimensions: dominant.source.dimensions,
      solidBlocks: normalized.reduce((s, n) => s + n.profile.source.solidBlocks, 0),
      substitutions: normalized.flatMap((n) => n.profile.source.substitutions),
    },
    palette,
    observations: dominant.observations,
    colors: dominant.colors,
    ramps: normalized.flatMap((n) => n.profile.ramps).slice(0, 6),
    symmetry,
    composition,
    terrain,
    density,
    motifs: normalized.flatMap((n) => n.profile.motifs).slice(0, 16),
    summary: [
      `Blend of ${normalized.map((n) => `${n.profile.name} (${Math.round(n.weight * 100)}%)`).join(", ")}.`,
      `Layout and dominant symmetry taken from ${dominant.name}; numeric traits interpolated.`,
      ...dominant.summary.slice(1),
    ],
  };
}

function blendPaletteJson(
  inputs: readonly { json: PaletteJson; weight: number }[],
  id: string,
): PaletteJson {
  let result = Palette.fromJson(inputs[0]!.json);
  let accumulated = inputs[0]!.weight;
  for (const next of inputs.slice(1)) {
    const share = accumulated + next.weight === 0 ? 0 : next.weight / (accumulated + next.weight);
    result = blendPalettes(result, Palette.fromJson(next.json), share, id);
    accumulated += next.weight;
  }
  return { ...result.toJson(), id };
}

/** How a plan asks for a style. */
export interface StyleDirective {
  /** Style ids with relative weights. A single entry means "just this style". */
  readonly styles: readonly { readonly id: string; readonly weight: number }[];
  /** How closely to follow the profile's measurements, in `[0, 1]`. Defaults to 0.75. */
  readonly fidelity?: number;
  /** How much deliberate divergence to introduce, in `[0, 1]`. Defaults to 0.4. */
  readonly originality?: number;
}

/**
 * A numeric trait resolved against a profile.
 *
 * `base` is the engine's own sensible default; `fromProfile` is what the reference measured.
 * Fidelity interpolates between them, then originality jitters the result. Both bounds are hard.
 */
export function resolveTrait(
  base: number,
  fromProfile: number | undefined,
  fidelity: number,
  originality: number,
  prng: Prng,
  bounds: { min: number; max: number },
): number {
  const target = fromProfile === undefined ? base : lerp(base, fromProfile, clamp01(fidelity));
  // Originality perturbs by up to 35% of the value — enough to change a map's character, not enough
  // to break the gameplay constraints the value feeds into.
  const jitter = target * 0.35 * clamp01(originality) * (prng.float() * 2 - 1);
  return Math.min(bounds.max, Math.max(bounds.min, target + jitter));
}

/**
 * Everything a generator needs to build in a style: the palette, the measurements, and the two
 * knobs, bundled so a planner takes one argument instead of six.
 */
export interface ResolvedStyle {
  readonly id: string;
  /** Absent when building without a reference; `trait` then falls back to the engine's defaults. */
  readonly profile?: StyleProfile;
  readonly palette: Palette;
  readonly fidelity: number;
  readonly originality: number;
  /** Resolve a trait against this style's profile, in one call. */
  trait(
    base: number,
    pick: (p: StyleProfile) => number | undefined,
    prng: Prng,
    bounds: { min: number; max: number },
  ): number;
}

export function resolveStyle(
  profiles: readonly StyleWeight[],
  directive: Pick<StyleDirective, "fidelity" | "originality">,
  paletteOverride?: Palette,
): ResolvedStyle {
  const profile = blendStyleProfiles(profiles);
  const fidelity = clamp01(directive.fidelity ?? 0.75);
  const originality = clamp01(directive.originality ?? 0.4);
  const palette = paletteOverride ?? Palette.fromJson(profile.palette);
  return {
    id: profile.id,
    profile,
    palette,
    fidelity,
    originality,
    trait(base, pick, prng, bounds) {
      return resolveTrait(base, pick(profile), fidelity, originality, prng, bounds);
    },
  };
}

/** A neutral style for when no reference is available — the engine's own defaults, unconstrained. */
export function defaultStyle(palette: Palette, id = "default"): ResolvedStyle {
  return {
    id,
    palette,
    fidelity: 0,
    originality: 0.4,
    trait(base, _pick, prng, bounds) {
      const jitter = base * 0.12 * (prng.float() * 2 - 1);
      return Math.min(bounds.max, Math.max(bounds.min, base + jitter));
    },
  };
}
