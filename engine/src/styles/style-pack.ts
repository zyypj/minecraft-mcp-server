/**
 * The style-pack system (§5.5).
 *
 * Palette, proportion, massing, and openings are **data** (this schema); **signature features are
 * code** behind a shared Feature Kit (`../features/feature-kit.ts`). The LLM art director edits
 * style packs, never raw blocks. A build reads as its style only if **3+ of its signature features
 * are detected** — the engine treats those as required passes, not optional flourishes.
 *
 * This file defines the schema types EXACTLY per §5.5, a zod validator, and `loadStylePack`
 * (validates + returns a typed pack). The validator is a REAL implementation.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Leaf types
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A block with a sampling weight. Weighted lists drive texture variation (§5.5, §5.6). */
export interface WeightedBlock {
  block: string;
  weight: number;
}

/**
 * A CIE L*a*b* color, `[L, a, b]`. Style packs cluster the exposed-block color histogram near
 * these centroids (§5.6) — machine-checkable, unlike the human strings ("cream-white") of the
 * first draft.
 */
export type LabColor = [L: number, a: number, b: number];

/** The nine palette role slots (§5.6). Each block has a *job*, not just a color. */
export type MaterialRoleName =
  | "base"
  | "secondary"
  | "accent"
  | "detail"
  | "glass"
  | "light"
  | "organic"
  | "path"
  | "foundation";

/** Roof forms the grammar can generate (§5.5). */
export type RoofType =
  | "gable"
  | "hip"
  | "flat"
  | "mansard"
  | "spire"
  | "tiered-hip"
  | "turf"
  | "bowed-gable";

/** Massing symmetry class; the symmetry gate is conditioned on this (§5.7). */
export type Symmetry = "strict" | "balanced" | "asymmetric" | "organic";

/** How a build meets the ground; the grounding gate is conditioned on this (§5.4.6, §5.5). */
export type GroundingMode = "grounded" | "stilted" | "terraced" | "cantilever";

// ────────────────────────────────────────────────────────────────────────────────────────────
// StylePack schema (types EXACTLY per §5.5)
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface StylePalette {
  base: WeightedBlock[];
  secondary: WeightedBlock[];
  accent: WeightedBlock[];
  detail: WeightedBlock[];
  glass: WeightedBlock[];
  light: WeightedBlock[];
  organic: WeightedBlock[];
  path: WeightedBlock[];
  foundation: WeightedBlock[];
}

export interface StyleRoof {
  type: RoofType;
  /** rise/run. Transfer function → stair placement: 0=flat/parapet, 1.0=45° stack, 2.0+=spire. */
  pitchRatio: number;
  overhang: number;
  material: WeightedBlock[];
  ridgeStyle?: string;
  tiers?: number;
  cornerUpturn?: boolean;
}

export interface StyleMassing {
  symmetry: Symmetry;
  footprintShapes: string[];
  floorHeight: number;
  /** The gate reads THIS value (with the §5.4.2 reveal exception), not a global constant. */
  wallThickness: number;
  groundingMode: GroundingMode;
  /** Inclusive `[min, max]` storey count. */
  storeys: [number, number];
  /** 0..1: P(a vertical accent is added) × target height ratio (§5.5 transfer function). */
  verticality: number;
  /** Jettied-upper-floor overhang in blocks. */
  jetty?: number;
  /** Battered (inward-sloping) wall angle. */
  batter?: number;
}

export interface StyleOpenings {
  windowRhythm: string;
  windowSpacing: number;
  windowShape: string;
  recessDepth: number;
  framing: string;
  shutters?: boolean;
  doorStyle: string;
}

export interface StyleLandscaping {
  ground: WeightedBlock[];
  vegetation: WeightedBlock[];
  props: string[];
  pathStyle: string;
  /** 0..1: planting scatter probability per seam cell (§5.5 transfer function). */
  density: number;
  waterFeature?: boolean;
}

/** A complete style pack (§5.5). */
export interface StylePack {
  id: string;
  displayName: string;
  palette: StylePalette;
  colorCentroids?: LabColor[];
  roof: StyleRoof;
  massing: StyleMassing;
  openings: StyleOpenings;
  /** 0..1: P(a greeble-eligible cell gets a detail), clamped to the §5.6 40–60% coverage rule. */
  detailDensity: number;
  /** Ids into the Feature Kit; each has a generator + detector. */
  signatureFeatures: string[];
  landscaping: StyleLandscaping;
  forbiddenBlocks: string[];
  forbiddenFeatures?: string[];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// zod validator (real)
// ────────────────────────────────────────────────────────────────────────────────────────────

const weightedBlockSchema = z.object({
  block: z.string().min(1),
  weight: z.number().positive(),
});

const labColorSchema = z.tuple([z.number(), z.number(), z.number()]);

const paletteSchema = z.object({
  // base + secondary + accent + detail must be non-empty before a build is "finished" (§5.6).
  base: z.array(weightedBlockSchema).min(1),
  secondary: z.array(weightedBlockSchema).min(1),
  accent: z.array(weightedBlockSchema).min(1),
  detail: z.array(weightedBlockSchema).min(1),
  glass: z.array(weightedBlockSchema),
  light: z.array(weightedBlockSchema),
  organic: z.array(weightedBlockSchema),
  path: z.array(weightedBlockSchema),
  foundation: z.array(weightedBlockSchema),
});

const roofSchema = z.object({
  type: z.enum([
    "gable",
    "hip",
    "flat",
    "mansard",
    "spire",
    "tiered-hip",
    "turf",
    "bowed-gable",
  ]),
  pitchRatio: z.number().min(0),
  overhang: z.number().min(0),
  material: z.array(weightedBlockSchema).min(1),
  ridgeStyle: z.string().optional(),
  tiers: z.number().int().positive().optional(),
  cornerUpturn: z.boolean().optional(),
});

const massingSchema = z.object({
  symmetry: z.enum(["strict", "balanced", "asymmetric", "organic"]),
  footprintShapes: z.array(z.string()).min(1),
  floorHeight: z.number().int().positive(),
  wallThickness: z.number().int().positive(),
  groundingMode: z.enum(["grounded", "stilted", "terraced", "cantilever"]),
  storeys: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  verticality: z.number().min(0).max(1),
  jetty: z.number().min(0).optional(),
  batter: z.number().min(0).optional(),
});

const openingsSchema = z.object({
  windowRhythm: z.string(),
  windowSpacing: z.number().positive(),
  windowShape: z.string(),
  recessDepth: z.number().min(0),
  framing: z.string(),
  shutters: z.boolean().optional(),
  doorStyle: z.string(),
});

const landscapingSchema = z.object({
  ground: z.array(weightedBlockSchema),
  vegetation: z.array(weightedBlockSchema),
  props: z.array(z.string()),
  pathStyle: z.string(),
  density: z.number().min(0).max(1),
  waterFeature: z.boolean().optional(),
});

/** The full zod schema for a {@link StylePack}. */
export const stylePackSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    palette: paletteSchema,
    colorCentroids: z.array(labColorSchema).optional(),
    roof: roofSchema,
    massing: massingSchema,
    openings: openingsSchema,
    detailDensity: z.number().min(0).max(1),
    signatureFeatures: z.array(z.string()),
    landscaping: landscapingSchema,
    forbiddenBlocks: z.array(z.string()),
    forbiddenFeatures: z.array(z.string()).optional(),
  })
  .superRefine((pack, ctx) => {
    // storeys must be a well-ordered range.
    if (pack.massing.storeys[0] > pack.massing.storeys[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["massing", "storeys"],
        message: "storeys must be [min, max] with min <= max",
      });
    }
  });

// Compile-time drift guard: a hand-written StylePack must be assignable to the schema's inferred
// output type. Erased at runtime; fails the type-check if the interface and schema diverge.
type _Inferred = z.infer<typeof stylePackSchema>;
const _driftGuard: (p: StylePack) => _Inferred = (p) => p;
void _driftGuard;

/** Result of a non-throwing validation. */
export type StylePackParseResult =
  | { ok: true; pack: StylePack }
  | { ok: false; error: z.ZodError };

/** Validate without throwing. Prefer this when surfacing errors to the LLM/user. */
export function parseStylePack(input: unknown): StylePackParseResult {
  const res = stylePackSchema.safeParse(input);
  if (res.success) return { ok: true, pack: res.data as StylePack };
  return { ok: false, error: res.error };
}

/**
 * Validate and return a typed {@link StylePack}, throwing a readable error on failure.
 * This is the single entry point every shipped and LLM-authored pack passes through.
 */
export function loadStylePack(input: unknown): StylePack {
  const res = parseStylePack(input);
  if (!res.ok) {
    throw new Error(`Invalid StylePack: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return res.pack;
}

/** Type guard form. */
export function isStylePack(input: unknown): input is StylePack {
  return stylePackSchema.safeParse(input).success;
}
