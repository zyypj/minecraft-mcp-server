/**
 * The shape of what the engine learns from a reference schematic.
 *
 * A deliberate framing note: this is a **Structure Knowledge Base**, not training. Nothing here is
 * a model with weights. Reading a schematic *measures* it — which blocks it uses and how visibly,
 * how symmetric it is, how its masses are distributed, what shape its islands are, how dense its
 * decoration is — and writes those measurements to disk as JSON a person can read, edit and argue
 * with. Generation then *consults* those measurements.
 *
 * That distinction matters practically, not just honestly: a measured profile can be inspected when
 * a generated map comes out wrong, hand-corrected, versioned, and blended with another. A learned
 * black box can do none of those things.
 */

import { type PaletteJson } from "../mc18/palette.js";

/** One block's presence in a reference, with the visibility that decides whether it defines a style. */
export interface BlockObservationJson {
  readonly block: string;
  readonly count: number;
  /** Share of all solid cells. */
  readonly share: number;
  /** Share of this block's own cells that are on a visible surface. */
  readonly exposure: number;
  /** Share of the reference's *visible* surface this block accounts for. */
  readonly surfaceShare: number;
  readonly color: string;
}

export interface ColorCluster {
  readonly color: string;
  /** Share of the visible surface within this cluster. */
  readonly share: number;
  /** Representative blocks, most common first. */
  readonly blocks: readonly string[];
}

/**
 * An ordered material progression detected in the reference.
 *
 * Detected from co-adjacency plus a monotone luminance ordering: blocks that sit next to each other
 * far more often than chance and get steadily lighter or darker are a gradient someone built on
 * purpose. This is the most portable thing a style has — it survives into a map that shares none of
 * the reference's shapes.
 */
export interface DetectedRamp {
  readonly name: string;
  readonly blocks: readonly string[];
  /** How strongly the chain's members prefer each other's company, in `[0, 1]`. */
  readonly strength: number;
}

export interface SymmetryProfile {
  /** Mirror-symmetry score about the X centre plane, in `[0, 1]`. */
  readonly mirrorX: number;
  readonly mirrorZ: number;
  /** Rotational symmetry scores keyed by fold count. */
  readonly radial: Readonly<Record<string, number>>;
  /** The strongest symmetry found, as a human-readable label. */
  readonly dominant: string;
  readonly dominantScore: number;
}

export interface MassCluster {
  readonly id: string;
  /** Centre of the cluster in reference coordinates. */
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  readonly bounds: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number };
    readonly max: { readonly x: number; readonly y: number; readonly z: number };
  };
  readonly blockCount: number;
  /** Horizontal radius, from the footprint area. */
  readonly radius: number;
  readonly height: number;
  /** Distance from the reference's horizontal centre. */
  readonly distanceFromCentre: number;
}

export type LayoutKind = "radial" | "linear" | "grid" | "clustered" | "single";

export interface CompositionProfile {
  readonly layout: LayoutKind;
  /** How confident the layout classification is, in `[0, 1]`. */
  readonly layoutConfidence: number;
  /** Number of satellite masses around the centre, for a radial layout. */
  readonly satelliteCount: number;
  /** Mean radius of the satellite ring, relative to the map's half-extent. */
  readonly satelliteRingRatio: number;
  /** Largest mass volume divided by the median mass volume. Above ~4 means a real landmark. */
  readonly focalRatio: number;
  /** The dominant mass, if one stands out. */
  readonly landmark?: MassCluster;
  readonly clusters: readonly MassCluster[];
}

export interface TerrainProfile {
  /** Share of columns in the bounding box that contain nothing — how much void the map shows. */
  readonly voidRatio: number;
  /** Perimeter-to-area ratio of the footprint, normalized so a perfect circle is 0. */
  readonly edgeRoughness: number;
  /** Mean depth of solid material below each surface column. */
  readonly meanThickness: number;
  /** Standard deviation of surface height across occupied columns. */
  readonly surfaceRelief: number;
  /** Distinct height plateaus in the surface histogram. */
  readonly heightLevels: number;
}

export interface DensityProfile {
  /** Solid cells divided by bounding-box volume. */
  readonly fillRatio: number;
  /** Share of solid cells that are on a visible surface — how hollow the build is. */
  readonly surfaceRatio: number;
  /** Share of solid cells that are decoration-class (plants, props, thin blocks). */
  readonly decorationDensity: number;
  /** Share of solid cells that are stairs or slabs — a proxy for detailing effort. */
  readonly detailBlockRatio: number;
  /** Share of solid cells that are translucent (glass, ice) — a strong style marker. */
  readonly glassRatio: number;
}

/** A repeated arrangement of blocks, found by hashing fixed-size chunks. */
export interface Motif {
  readonly hash: string;
  readonly size: number;
  readonly occurrences: number;
  /** Whether the repeats include rotated copies rather than only translated ones. */
  readonly rotated: boolean;
  readonly dominantBlocks: readonly string[];
}

export interface StyleProfile {
  readonly id: string;
  readonly name: string;
  readonly schemaVersion: 1;
  readonly minecraftVersion: "1.8.9";
  readonly source: {
    readonly files: readonly string[];
    readonly dimensions: { readonly width: number; readonly height: number; readonly length: number };
    readonly solidBlocks: number;
    /** Post-1.8 blocks the reader had to approximate when ingesting. */
    readonly substitutions: readonly { readonly from: string; readonly to: string; readonly count: number }[];
  };
  readonly palette: PaletteJson;
  readonly observations: readonly BlockObservationJson[];
  readonly colors: readonly ColorCluster[];
  readonly ramps: readonly DetectedRamp[];
  readonly symmetry: SymmetryProfile;
  readonly composition: CompositionProfile;
  readonly terrain: TerrainProfile;
  readonly density: DensityProfile;
  readonly motifs: readonly Motif[];
  /** Short human-readable statements a planner can act on. */
  readonly summary: readonly string[];
}
