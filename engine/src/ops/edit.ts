/**
 * Region-level edits: replace, gradient, hollow, outline, smooth, erode, scatter.
 *
 * These are the operations a builder reaches for after the massing exists — the ones that turn a
 * correct-but-flat shape into something with texture and depth. Every one of them is a whole-region
 * operation, because the alternative (an agent emitting one `set_block` per cell) is exactly the
 * failure mode this engine exists to remove.
 */

import { type Region, type Vec3, NEIGHBORS_26, NEIGHBORS_6, vec } from "../core/vec.js";
import { type Noise } from "../core/noise.js";
import { type Prng, clamp01 } from "../core/prng.js";
import {
  AIR,
  type BlockSource,
  type Mask,
  type PackedBlock,
  Volume,
  clipToVolume,
  resolveSource,
} from "../core/volume.js";
import { isSolidCube, materialKey } from "../mc18/blocks.js";

// -- Replace -------------------------------------------------------------------------------------

/** Which existing blocks an operation should act on. */
export type BlockFilter = PackedBlock | readonly PackedBlock[] | ((b: PackedBlock) => boolean);

/**
 * Compile a filter to a predicate. Numeric filters match on *material*, ignoring orientation bits,
 * so "replace all oak stairs with spruce stairs" does not silently miss the ones facing north.
 */
export function toPredicate(filter: BlockFilter): (b: PackedBlock) => boolean {
  if (typeof filter === "function") return filter;
  if (typeof filter === "number") {
    const key = materialKey(filter);
    return (b) => materialKey(b) === key || b === filter;
  }
  const keys = new Set(filter.map(materialKey));
  const exact = new Set(filter);
  return (b) => exact.has(b) || keys.has(materialKey(b));
}

export interface ReplaceOptions {
  readonly region?: Region;
  readonly from: BlockFilter;
  readonly to: BlockSource;
  readonly mask?: Mask;
}

/** Replace every block matching `from` with `to`. */
export function replaceBlocks(vol: Volume, opts: ReplaceOptions): number {
  const matches = toPredicate(opts.from);
  return vol.fill(opts.region ?? vol.bounds, opts.to, (p, current, v) => {
    if (!matches(current)) return false;
    return opts.mask ? opts.mask(p, current, v) : true;
  });
}

/** Convenience: the "everything that is not air" filter. */
export const ANY_SOLID: BlockFilter = (b) => b !== AIR;

// -- Gradients -----------------------------------------------------------------------------------

export interface GradientStop {
  readonly block: PackedBlock;
  /** Position along the gradient in `[0, 1]`. */
  readonly at: number;
}

export type GradientAxis = "x" | "y" | "z" | "radial" | "spherical";

export type DitherMode = "none" | "ordered" | "noise";

export interface GradientOptions {
  readonly region?: Region;
  /** Two or more stops. Order is normalized, so callers need not pre-sort. */
  readonly stops: readonly GradientStop[];
  readonly axis?: GradientAxis;
  /** Centre for `radial` / `spherical`. Defaults to the region centre. */
  readonly center?: Vec3;
  /**
   * How to break the seam between two stops. `ordered` uses a Bayer matrix, which reads as a
   * deliberate hand-placed checker fade; `noise` reads as weathering. `none` gives hard bands.
   */
  readonly dither?: DitherMode;
  /** Width of the blended band as a fraction of the gap between stops, in `[0, 1]`. */
  readonly blend?: number;
  readonly noise?: Noise;
  readonly mask?: Mask;
  /** Only recolour existing blocks matching this filter; air is skipped either way. */
  readonly only?: BlockFilter;
}

/** 4x4x4 ordered-dither thresholds, derived by bit-interleaving the three coordinates. */
function bayer3(x: number, y: number, z: number): number {
  const ix = ((x % 4) + 4) % 4;
  const iy = ((y % 4) + 4) % 4;
  const iz = ((z % 4) + 4) % 4;
  let v = 0;
  for (let bit = 0; bit < 2; bit++) {
    v = (v << 3) | (((ix >> (1 - bit)) & 1) << 2) | (((iy >> (1 - bit)) & 1) << 1) | ((iz >> (1 - bit)) & 1);
  }
  // 6 bits of ordering -> a threshold in [0, 1).
  return v / 64;
}

/**
 * Paint a gradient across a region.
 *
 * A gradient is what makes a large surface read as intentional rather than as one flat fill, and it
 * is the single most transferable thing extracted from a reference schematic (a style's block ramp
 * survives even when its shapes do not). Blocks are chosen by comparing a dither threshold against
 * the fractional position between the two surrounding stops, so transitions interleave instead of
 * banding.
 */
export function buildGradient(vol: Volume, opts: GradientOptions): number {
  const stops = [...opts.stops].sort((a, b) => a.at - b.at);
  if (stops.length === 0) throw new Error("buildGradient needs at least one stop");
  if (stops.length === 1) {
    return replaceBlocks(vol, {
      region: opts.region ?? vol.bounds,
      from: opts.only ?? ANY_SOLID,
      to: stops[0]!.block,
      mask: opts.mask,
    });
  }

  const r = clipToVolume(opts.region ?? vol.bounds, vol);
  if (!r) return 0;
  const axis = opts.axis ?? "y";
  const dither = opts.dither ?? "ordered";
  const blend = clamp01(opts.blend ?? 1);
  const center =
    opts.center ??
    vec((r.min.x + r.max.x) / 2, (r.min.y + r.max.y) / 2, (r.min.z + r.max.z) / 2);
  const only = opts.only ? toPredicate(opts.only) : (b: PackedBlock) => b !== AIR;

  const span = {
    x: Math.max(1, r.max.x - r.min.x),
    y: Math.max(1, r.max.y - r.min.y),
    z: Math.max(1, r.max.z - r.min.z),
  };
  const maxRadial = Math.max(
    1,
    Math.hypot(Math.max(center.x - r.min.x, r.max.x - center.x), Math.max(center.z - r.min.z, r.max.z - center.z)),
  );
  const maxSpherical = Math.max(
    1,
    Math.hypot(
      Math.max(center.x - r.min.x, r.max.x - center.x),
      Math.max(center.y - r.min.y, r.max.y - center.y),
      Math.max(center.z - r.min.z, r.max.z - center.z),
    ),
  );

  const positionOf = (p: Vec3): number => {
    switch (axis) {
      case "x":
        return (p.x - r.min.x) / span.x;
      case "y":
        return (p.y - r.min.y) / span.y;
      case "z":
        return (p.z - r.min.z) / span.z;
      case "radial":
        return Math.hypot(p.x - center.x, p.z - center.z) / maxRadial;
      case "spherical":
        return Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) / maxSpherical;
    }
  };

  return vol.fill(
    r,
    (p) => {
      const t = clamp01(positionOf(p));
      let hi = 0;
      while (hi < stops.length - 1 && stops[hi + 1]!.at < t) hi++;
      const lower = stops[hi]!;
      const upper = stops[Math.min(hi + 1, stops.length - 1)]!;
      if (upper === lower) return lower.block;
      const gap = upper.at - lower.at;
      const local = gap <= 0 ? 1 : clamp01((t - lower.at) / gap);
      // Narrow the blend band around the midpoint so `blend` < 1 keeps distinct zones.
      const mixed = blend <= 0 ? (local < 0.5 ? 0 : 1) : clamp01((local - 0.5) / blend + 0.5);
      let threshold: number;
      if (dither === "none") threshold = 0.5;
      else if (dither === "noise" && opts.noise) threshold = opts.noise.white3(p.x, p.y, p.z);
      else threshold = bayer3(p.x, p.y, p.z);
      return mixed > threshold ? upper.block : lower.block;
    },
    (p, current, v) => {
      if (!only(current)) return false;
      return opts.mask ? opts.mask(p, current, v) : true;
    },
  );
}

// -- Surface operations --------------------------------------------------------------------------

/** True when a cell is solid and touches at least one air cell across a face. */
export function isSurfaceCell(vol: Volume, p: Vec3): boolean {
  if (vol.getAt(p) === AIR) return false;
  for (const n of NEIGHBORS_6) {
    if (vol.get(p.x + n.x, p.y + n.y, p.z + n.z) === AIR) return true;
  }
  return false;
}

/** Hollow out a region: clear every solid cell that is fully enclosed by solids. */
export function hollowOut(vol: Volume, r?: Region, thickness = 1): number {
  const box = clipToVolume(r ?? vol.bounds, vol);
  if (!box) return 0;
  const t = Math.max(1, Math.floor(thickness));
  // A cell survives if it is within `t` of any air cell (in the 26-neighbourhood sense).
  const keep = new Uint8Array(vol.cellCount);
  for (const p of vol.iterate(box)) {
    if (vol.getAt(p) === AIR) continue;
    if (isSurfaceCell(vol, p)) keep[vol.index(p.x, p.y, p.z)] = 1;
  }
  for (let layer = 1; layer < t; layer++) {
    const next = new Uint8Array(keep);
    for (const p of vol.iterate(box)) {
      const i = vol.index(p.x, p.y, p.z);
      if (keep[i] || vol.getAt(p) === AIR) continue;
      for (const n of NEIGHBORS_6) {
        const q = vec(p.x + n.x, p.y + n.y, p.z + n.z);
        if (vol.containsPoint(q) && keep[vol.index(q.x, q.y, q.z)]) {
          next[i] = 1;
          break;
        }
      }
    }
    keep.set(next);
  }
  let cleared = 0;
  for (const p of vol.iterate(box)) {
    const i = vol.index(p.x, p.y, p.z);
    if (vol.cells[i] !== AIR && !keep[i]) {
      if (vol.setAt(p, AIR)) cleared++;
    }
  }
  return cleared;
}

/** Keep only the surface shell of a region, replacing the interior with `fillWith` (default air). */
export function outlineRegion(vol: Volume, r: Region, block: BlockSource): number {
  const box = clipToVolume(r, vol);
  if (!box) return 0;
  const onFace = (p: Vec3): boolean =>
    p.x === box.min.x ||
    p.x === box.max.x ||
    p.y === box.min.y ||
    p.y === box.max.y ||
    p.z === box.min.z ||
    p.z === box.max.z;
  return vol.fill(box, block, (p) => onFace(p));
}

/** Just the four vertical faces of a region — the classic `//walls`. */
export function regionWalls(vol: Volume, r: Region, block: BlockSource): number {
  const box = clipToVolume(r, vol);
  if (!box) return 0;
  return vol.fill(
    box,
    block,
    (p) => p.x === box.min.x || p.x === box.max.x || p.z === box.min.z || p.z === box.max.z,
  );
}

// -- Smoothing and erosion -----------------------------------------------------------------------

export interface SmoothOptions {
  readonly region?: Region;
  readonly iterations?: number;
  /**
   * Fraction of the 26-neighbourhood that must be solid for an air cell to become solid (and, in
   * reverse, for a solid cell to survive). 0.5 is a plain majority filter.
   */
  readonly threshold?: number;
  readonly mask?: Mask;
}

/**
 * Majority-filter smoothing over the solid/air field.
 *
 * This is a *terrain* smoother, not a blur: it decides occupancy from the neighbourhood and then
 * fills newly-solid cells with the most common nearby material, which keeps an island's grass cap
 * and stone underside separated instead of averaging them into a mush.
 */
export function smoothRegion(vol: Volume, opts: SmoothOptions = {}): number {
  const box = clipToVolume(opts.region ?? vol.bounds, vol);
  if (!box) return 0;
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 1));
  const threshold = opts.threshold ?? 0.5;
  let changed = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const writes: { p: Vec3; block: PackedBlock }[] = [];
    for (const p of vol.iterate(box)) {
      let solid = 0;
      const counts = new Map<PackedBlock, number>();
      for (const n of NEIGHBORS_26) {
        const b = vol.get(p.x + n.x, p.y + n.y, p.z + n.z);
        if (b === AIR) continue;
        solid++;
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      const ratio = solid / NEIGHBORS_26.length;
      const current = vol.getAt(p);
      if (current === AIR && ratio > threshold) {
        let best: PackedBlock = AIR;
        let bestCount = 0;
        for (const [b, c] of counts) if (c > bestCount) [best, bestCount] = [b, c];
        if (best !== AIR) writes.push({ p, block: best });
      } else if (current !== AIR && ratio < 1 - threshold) {
        writes.push({ p, block: AIR });
      }
    }
    for (const w of writes) {
      if (opts.mask && !opts.mask(w.p, vol.getAt(w.p), vol)) continue;
      if (vol.setAt(w.p, w.block)) changed++;
    }
  }
  return changed;
}

// -- Scatter -------------------------------------------------------------------------------------

export interface ScatterOptions {
  readonly region?: Region;
  /** Chance per eligible cell, in `[0, 1]`. */
  readonly density: number;
  readonly block: BlockSource;
  readonly prng: Prng;
  /** Where a scattered block may go. Defaults to air directly above a solid cell. */
  readonly placement?: (p: Vec3, vol: Volume) => boolean;
  /** Minimum spacing between placements, in blocks. 0 allows adjacency. */
  readonly spacing?: number;
}

/**
 * Scatter decoration across a region.
 *
 * Decoration density is one of the numbers that separates a professional map from a generated one:
 * too little reads as unfinished, too much reads as noise, and clumping reads as a bug. The default
 * placement rule (air with a solid block beneath) plus optional minimum spacing covers flowers,
 * props and surface detail without the caller writing a loop.
 */
export function scatter(vol: Volume, opts: ScatterOptions): number {
  const box = clipToVolume(opts.region ?? vol.bounds, vol);
  if (!box) return 0;
  const placement =
    opts.placement ??
    ((p: Vec3, v: Volume) => v.getAt(p) === AIR && isSolidCube(v.get(p.x, p.y - 1, p.z)));
  const spacing = Math.max(0, Math.floor(opts.spacing ?? 0));
  const placed: Vec3[] = [];
  let changed = 0;
  for (const p of vol.iterate(box)) {
    if (!opts.prng.chance(opts.density)) continue;
    if (!placement(p, vol)) continue;
    if (spacing > 0) {
      let tooClose = false;
      for (const q of placed) {
        if (
          Math.abs(q.x - p.x) <= spacing &&
          Math.abs(q.z - p.z) <= spacing &&
          Math.abs(q.y - p.y) <= spacing
        ) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
    }
    if (vol.setAt(p, resolveSource(opts.block, p, vol))) {
      changed++;
      if (spacing > 0) placed.push(p);
    }
  }
  return changed;
}

/** Replace the topmost solid block of every column in a region — a surface "paint" pass. */
export function paintSurface(
  vol: Volume,
  r: Region,
  block: BlockSource,
  opts: { depth?: number; only?: BlockFilter } = {},
): number {
  const box = clipToVolume(r, vol);
  if (!box) return 0;
  const depth = Math.max(1, Math.floor(opts.depth ?? 1));
  const only = opts.only ? toPredicate(opts.only) : () => true;
  let changed = 0;
  for (let z = box.min.z; z <= box.max.z; z++) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      let found = -1;
      for (let y = box.max.y; y >= box.min.y; y--) {
        if (vol.get(x, y, z) !== AIR) {
          found = y;
          break;
        }
      }
      if (found < 0) continue;
      for (let d = 0; d < depth; d++) {
        const y = found - d;
        if (y < box.min.y) break;
        if (!only(vol.get(x, y, z))) continue;
        if (vol.plot(vec(x, y, z), block)) changed++;
      }
    }
  }
  return changed;
}
