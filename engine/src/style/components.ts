/**
 * Component extraction: pulling reusable pieces out of a reference.
 *
 * A style profile says *what* a reference is like. A component library says *what it is made of* —
 * this roof, this pillar, this island shape, this prop — as schematics that can be pasted,
 * recoloured and varied. Between the two, "build a map inspired by X" stops meaning "hallucinate
 * something vaguely similar" and starts meaning "assemble X's own vocabulary into a new layout".
 *
 * Extraction is deliberately conservative about what it claims. A component is a connected mass
 * that survives a size filter, classified by measurable properties (footprint, height, aspect ratio,
 * how much of it is terrain material) into a small set of kinds. It does not try to name things.
 */

import { type Region, region, vec } from "../core/vec.js";
import { AIR, Volume } from "../core/volume.js";
import { blockName, renderClass } from "../mc18/blocks.js";
import { measureMirrorSymmetry } from "../ops/symmetry.js";
import { findMassClusters } from "./analyze.js";

export type StyleComponentKind =
  | "island" // a terrain mass, wide and mostly natural material
  | "landmark" // the dominant tall mass
  | "building" // a walled structure with a roof
  | "tower" // tall and narrow
  | "prop" // small decorative object
  | "bridge" // long, thin, low
  | "unknown";

export interface ExtractedComponent {
  readonly id: string;
  readonly kind: StyleComponentKind;
  readonly volume: Volume;
  readonly source: Region;
  readonly blockCount: number;
  readonly size: { readonly width: number; readonly height: number; readonly length: number };
  /** Mirror symmetry of the component itself, which decides whether it can be safely mirrored. */
  readonly symmetry: number;
  /** Share of the component that is terrain-like material. */
  readonly terrainShare: number;
  readonly dominantBlocks: readonly string[];
}

export interface ExtractOptions {
  /** Coarse cell size for the clustering pass. */
  readonly clusterCell?: number;
  /** Ignore components smaller than this many blocks. */
  readonly minBlocks?: number;
  readonly maxComponents?: number;
  /** Pad the extracted region so an island keeps the air around its silhouette. */
  readonly padding?: number;
}

const TERRAIN_LIKE = new Set([
  "grass",
  "dirt",
  "coarse_dirt",
  "podzol",
  "stone",
  "cobblestone",
  "andesite",
  "granite",
  "diorite",
  "gravel",
  "sand",
  "red_sand",
  "sandstone",
  "clay",
  "mycelium",
  "snow",
  "end_stone",
  "netherrack",
]);

/**
 * Split a reference into reusable components.
 *
 * Uses the same coarse-grid clustering as the style analyzer, so the components correspond exactly
 * to the masses the profile describes — a caller can line up "mass_3 is the landmark" with the
 * component it extracted.
 */
export function extractComponents(vol: Volume, opts: ExtractOptions = {}): ExtractedComponent[] {
  const minBlocks = opts.minBlocks ?? 400;
  const padding = opts.padding ?? 1;
  const clusters = findMassClusters(vol, opts.clusterCell ?? 6);
  const out: ExtractedComponent[] = [];

  const tallest = clusters.reduce((max, c) => Math.max(max, c.height), 0);

  for (const cluster of clusters) {
    if (cluster.blockCount < minBlocks) continue;
    const box = region(
      vec(cluster.bounds.min.x - padding, cluster.bounds.min.y - padding, cluster.bounds.min.z - padding),
      vec(cluster.bounds.max.x + padding, cluster.bounds.max.y + padding, cluster.bounds.max.z + padding),
    );
    let cropped: Volume;
    try {
      cropped = vol.crop(box);
    } catch {
      continue;
    }
    // Re-crop to what is actually solid: the coarse grid over-reports by up to a cell on each side.
    const tight = cropped.occupiedBounds();
    if (!tight) continue;
    const component = cropped.crop({
      min: vec(Math.max(0, tight.min.x - padding), Math.max(0, tight.min.y - padding), Math.max(0, tight.min.z - padding)),
      max: vec(
        Math.min(cropped.width - 1, tight.max.x + padding),
        Math.min(cropped.height - 1, tight.max.y + padding),
        Math.min(cropped.length - 1, tight.max.z + padding),
      ),
    });

    const hist = component.histogram();
    let terrainCells = 0;
    let total = 0;
    const dominant: { name: string; count: number }[] = [];
    for (const [block, count] of hist) {
      const name = blockName(block);
      total += count;
      if (TERRAIN_LIKE.has(name)) terrainCells += count;
      dominant.push({ name, count });
    }
    dominant.sort((a, b) => b.count - a.count);
    const terrainShare = total === 0 ? 0 : terrainCells / total;

    out.push({
      id: `component_${out.length}`,
      kind: classify(component, terrainShare, cluster.height, tallest),
      volume: component,
      source: box,
      blockCount: total,
      size: { width: component.width, height: component.height, length: component.length },
      symmetry: Math.round(measureMirrorSymmetry(component, "x") * 1000) / 1000,
      terrainShare: Math.round(terrainShare * 1000) / 1000,
      dominantBlocks: dominant.slice(0, 4).map((d) => d.name),
    });
    if (opts.maxComponents && out.length >= opts.maxComponents) break;
  }

  return out;
}

function classify(
  vol: Volume,
  terrainShare: number,
  clusterHeight: number,
  tallest: number,
): StyleComponentKind {
  const footprint = vol.width * vol.length;
  const aspect = Math.max(vol.width, vol.length) / Math.max(1, Math.min(vol.width, vol.length));
  const slenderness = vol.height / Math.max(1, Math.sqrt(footprint));

  if (footprint < 60 && vol.height < 12) return "prop";
  if (aspect > 5 && vol.height < 8) return "bridge";
  if (terrainShare > 0.55 && slenderness < 0.8) return "island";
  if (clusterHeight >= tallest * 0.8 && slenderness > 1.2) return "landmark";
  if (slenderness > 1.6) return "tower";
  if (hasRoofSignature(vol)) return "building";
  return "unknown";
}

/**
 * Does this component look like it has a roof?
 *
 * Two cheap signals that together are surprisingly reliable: stairs or slabs concentrated in the
 * upper third, and a footprint that narrows as it rises. Both are true of pitched roofs and of
 * almost nothing else.
 */
function hasRoofSignature(vol: Volume): boolean {
  const upperStart = Math.floor(vol.height * 0.6);
  let upperDetail = 0;
  let upperSolid = 0;
  const areaByLayer = new Int32Array(vol.height);
  for (const { pos, block } of vol.iterateSolid()) {
    areaByLayer[pos.y] = areaByLayer[pos.y]! + 1;
    if (pos.y < upperStart) continue;
    upperSolid++;
    const cls = renderClass(block);
    if (cls === "stairs" || cls === "slab") upperDetail++;
  }
  const detailRatio = upperSolid === 0 ? 0 : upperDetail / upperSolid;

  // Narrowing: compare the mean area of the upper third against the middle third.
  const third = Math.max(1, Math.floor(vol.height / 3));
  const mean = (from: number, to: number): number => {
    let sum = 0;
    let n = 0;
    for (let y = from; y < to && y < vol.height; y++) {
      sum += areaByLayer[y]!;
      n++;
    }
    return n === 0 ? 0 : sum / n;
  };
  const middle = mean(third, third * 2);
  const upper = mean(third * 2, vol.height);
  const narrows = middle > 0 && upper / middle < 0.7;

  return detailRatio > 0.12 || narrows;
}

/**
 * Strip a component down to its shape, discarding materials.
 *
 * Useful when a component should contribute its *form* to a new map without dragging the reference's
 * palette along: paste the mask, then fill it from the target style's palette.
 */
export function toShapeMask(vol: Volume, fill: number): Volume {
  const out = new Volume({ size: vol.size });
  for (let i = 0; i < vol.cells.length; i++) out.cells[i] = vol.cells[i] === AIR ? AIR : fill;
  return out;
}
