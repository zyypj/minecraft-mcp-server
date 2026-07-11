/**
 * Anti-slop rules (§5.4.7, Appendix A).
 *
 * The 18 failure modes are enforced as hard gates and score penalties. This module catalogs them
 * with their fix + automated check and aggregates the hard gates. The catalog is real data; the
 * aggregate checker is stubbed (it delegates to the per-domain rule modules).
 */

import { mergeResults, type RuleCheck, type RuleContext, type RuleResult } from "./rule-types.js";
import { exteriorRules } from "./exterior.js";
import { facadeRules } from "./facade.js";
import { roofRules } from "./roof.js";
import { paletteRules } from "./palette.js";
import { checkGrounding } from "./grounding.js";

/** The 18 canonical slop failure modes (Appendix A). Ordinal matches the plan's numbering. */
export enum SlopFailure {
  FlatMonoPlaneWall = 1,
  SubSpecWallDepth = 2,
  PlainBoxMassing = 3,
  CobblePlankSpam = 4,
  NoRoofOverhang = 5,
  FloatingBuild = 6,
  NoDepthDetailing = 7,
  OverSymmetry = 8,
  WrongScale = 9,
  ClashingPalette = 10,
  GarishSaturation = 11,
  EmptyInterior = 12,
  AbruptTerrain = 13,
  UniformRandomNoise = 14,
  PixelArtOfPhoto = 15,
  DecorativeAsStructural = 16,
  LightingSpam = 17,
  NoFocalPoint = 18,
}

export interface SlopFailureSpec {
  id: SlopFailure;
  name: string;
  why: string;
  fix: string;
  /** Short description of the automated check (the actual threshold lives in the domain module). */
  check: string;
  /** Whether this failure is a hard gate (caps its rubric category with a ×0.5 penalty). */
  hard: boolean;
}

/** The failure catalog (Appendix A), used to render diagnostics and drive the hard gates. */
export const SLOP_FAILURES: Readonly<Record<SlopFailure, SlopFailureSpec>> = {
  [SlopFailure.FlatMonoPlaneWall]: { id: SlopFailure.FlatMonoPlaneWall, name: "Flat mono-plane wall", why: "No shadow, no scale cue", fix: "Off-plane articulation, pilasters, recesses", check: "pct_facade_cells_off_base_plane >= 0.15", hard: true },
  [SlopFailure.SubSpecWallDepth]: { id: SlopFailure.SubSpecWallDepth, name: "Sub-spec wall depth", why: "Betrays a hollow shell", fix: "Per-style thickness + 2-deep reveals", check: "wall_thickness >= style value; reveal >= 2", hard: true },
  [SlopFailure.PlainBoxMassing]: { id: SlopFailure.PlainBoxMassing, name: "Plain box massing", why: "One contour, boring", fix: "Decompose into >=2 varied sub-volumes", check: "fill_ratio <= 0.62; >=3 height levels", hard: true },
  [SlopFailure.CobblePlankSpam]: { id: SlopFailure.CobblePlankSpam, name: "Cobble/plank spam", why: "Reads default/unfinished", fix: "Palette discipline, tonal ramps", check: "{cobblestone,oak_planks} share <= 0.40", hard: true },
  [SlopFailure.NoRoofOverhang]: { id: SlopFailure.NoRoofOverhang, name: "No roof overhang / flat", why: "Decapitated look", fix: "Pitch + >=1 eave + ridge cap", check: "pitch_ratio >= 0.5; eave_overhang >= 1", hard: true },
  [SlopFailure.FloatingBuild]: { id: SlopFailure.FloatingBuild, name: "Floating build", why: "Pasted-on, no weight", fix: "Ground per groundingMode", check: "contact ratio / support count", hard: true },
  [SlopFailure.NoDepthDetailing]: { id: SlopFailure.NoDepthDetailing, name: "No depth/detailing", why: "Blocky, cheap", fix: "Facade detailing pass", check: "off-plane % + detail coverage", hard: false },
  [SlopFailure.OverSymmetry]: { id: SlopFailure.OverSymmetry, name: "Over-symmetry (asym styles)", why: "Diagram, not building", fix: "Style-conditioned symmetry", check: "mirror_symmetry vs style.symmetry", hard: false },
  [SlopFailure.WrongScale]: { id: SlopFailure.WrongScale, name: "Wrong scale", why: "Uncanny", fix: "Scale gates by function", check: "door/ceiling/window ratios", hard: true },
  [SlopFailure.ClashingPalette]: { id: SlopFailure.ClashingPalette, name: "Clashing palette", why: "Visual noise", fix: "60-30-10 + noise harmony", check: "material count, adjacency, centroids", hard: false },
  [SlopFailure.GarishSaturation]: { id: SlopFailure.GarishSaturation, name: "Garish saturation", why: "Toy-like", fix: "Earthy default, capped accent", check: "high_saturation_ratio <= 0.10", hard: true },
  [SlopFailure.EmptyInterior]: { id: SlopFailure.EmptyInterior, name: "Empty interior", why: "Lifeless", fix: "Program + furniture clusters", check: "furnished_tile_ratio >= 0.20", hard: false },
  [SlopFailure.AbruptTerrain]: { id: SlopFailure.AbruptTerrain, name: "Abrupt terrain", why: "No believability", fix: "Landscaping/terracing pass", check: "transition width / contact", hard: false },
  [SlopFailure.UniformRandomNoise]: { id: SlopFailure.UniformRandomNoise, name: "Uniform random noise", why: "TV static", fix: "Clustered variation", check: "Moran's I >= 0.15", hard: false },
  [SlopFailure.PixelArtOfPhoto]: { id: SlopFailure.PixelArtOfPhoto, name: "Pixel-art-of-a-photo (1-deep)", why: "Ignores 3D form", fix: "Top-down composition + depth", check: "depth layers >= 2", hard: true },
  [SlopFailure.DecorativeAsStructural]: { id: SlopFailure.DecorativeAsStructural, name: "Decorative-as-structural", why: "Reads wrong", fix: "Material semantics", check: "role/semantic checks", hard: false },
  [SlopFailure.LightingSpam]: { id: SlopFailure.LightingSpam, name: "Lighting spam", why: "Flat, gamey", fix: "Sparse, hidden, warm", check: "visible_light_density <= 1/25", hard: false },
  [SlopFailure.NoFocalPoint]: { id: SlopFailure.NoFocalPoint, name: "No focal point", why: "Eye wanders", fix: "Promote entrance/tower", check: "focal frontal-area ratio >= 1.5x", hard: false },
};

/** The subset of failures wired as hard gates (a build with any of these → REGENERATE, §5.7). */
export const HARD_GATE_FAILURES: readonly SlopFailure[] = Object.values(SLOP_FAILURES)
  .filter((s) => s.hard)
  .map((s) => s.id);

/**
 * Run every hard anti-slop gate by delegating to the domain rule modules (§5.4). Real aggregation;
 * the individual checks are stubbed. Returns a merged result whose violations feed the rubric's
 * hard-fail penalties and the ranked defect list.
 */
export const runAntiSlopGates: RuleCheck = (ctx: RuleContext): RuleResult => {
  const checks: RuleCheck[] = [...exteriorRules, ...facadeRules, ...roofRules, ...paletteRules, checkGrounding];
  return mergeResults(checks.map((c) => c(ctx)));
};
