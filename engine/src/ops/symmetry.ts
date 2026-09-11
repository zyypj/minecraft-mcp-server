/**
 * Symmetry and instancing.
 *
 * A competitive map is symmetric by definition — every team must get the same island — and the
 * cheapest way to guarantee that is to author one instance and replicate it. This module is the
 * difference between generating eight islands (eight chances to differ) and generating one island
 * eight times (symmetric by construction, and one eighth of the work).
 *
 * ## The 45-degree problem
 *
 * An eight-team map places islands every 45 degrees, but 1.8 block data only encodes four
 * orientations. There is no way to rotate a staircase by 45 degrees. So instancing separates the
 * two: **position** is exact on the circle, while **block orientation** snaps to the nearest
 * quarter turn. That is what human builders do too, and it is why an eight-team map's islands sit
 * on a true octagon while their buildings all face one of four ways.
 */

import { type Vec3, vec } from "../core/vec.js";
import { type Prng } from "../core/prng.js";
import { type Mask, Volume } from "../core/volume.js";
import { type OrientTransform } from "../mc18/rotation.js";
import { type Clipboard, pasteClipboard, transformVolume } from "./transform.js";

/** One placement produced by a distribution. */
export interface Instance {
  readonly index: number;
  /** Exact position of the instance's anchor, in volume coordinates. */
  readonly position: Vec3;
  /** Angle from the distribution centre, in degrees, measured clockwise from north. */
  readonly angleDegrees: number;
  /** The quarter-turn actually applied to block data. */
  readonly rotation: 0 | 90 | 180 | 270;
}

export type RotationMode =
  /** Snap each instance's block data to the nearest quarter turn facing the centre. */
  | "quantized"
  /** Leave every instance in the source orientation. */
  | "none"
  /** Rotate by exactly 90 degrees per step; only correct when `count` divides 4. */
  | "exact";

export interface DistributeOptions {
  readonly center: Vec3;
  readonly count: number;
  readonly radius: number;
  /** Angle of the first instance, in degrees clockwise from north. */
  readonly startAngleDegrees?: number;
  readonly rotationMode?: RotationMode;
  /** Y of the placements. Defaults to `center.y`. */
  readonly y?: number;
  /** Position instances by the clipboard anchor rather than its minimum corner. */
  readonly byAnchor?: boolean;
  readonly ignoreAir?: boolean;
  readonly mask?: Mask;
  /**
   * Per-instance mutation applied to a *copy* of the clipboard before pasting. This is where
   * procedural variation lives: four diamond islands of the same design that differ in their
   * decoration are far more convincing than four identical ones.
   */
  readonly vary?: (volume: Volume, instance: Omit<Instance, "rotation">, prng: Prng) => void;
  readonly prng?: Prng;
}

/** Compute the placements a distribution would produce, without writing anything. */
export function planRadialInstances(opts: DistributeOptions): Instance[] {
  const { center, count, radius } = opts;
  if (count < 1) return [];
  const start = opts.startAngleDegrees ?? 0;
  const mode = opts.rotationMode ?? "quantized";
  const y = opts.y ?? center.y;
  const out: Instance[] = [];
  for (let i = 0; i < count; i++) {
    const angle = start + (360 / count) * i;
    const rad = (angle * Math.PI) / 180;
    // Angle 0 points north (-Z) and increases clockwise, so east is 90.
    const x = center.x + Math.sin(rad) * radius;
    const z = center.z - Math.cos(rad) * radius;
    let rotation: 0 | 90 | 180 | 270 = 0;
    if (mode === "exact") {
      rotation = (((Math.round(angle / 90) % 4) + 4) % 4 * 90) as 0 | 90 | 180 | 270;
    } else if (mode === "quantized") {
      rotation = (((Math.round(angle / 90) % 4) + 4) % 4 * 90) as 0 | 90 | 180 | 270;
    }
    out.push({
      index: i,
      position: vec(Math.round(x), y, Math.round(z)),
      angleDegrees: angle,
      rotation,
    });
  }
  return out;
}

/**
 * Paste `count` copies of a clipboard around a circle.
 *
 * Returns the instances actually placed, so a caller building a BedWars map can record where each
 * team island ended up and hand those coordinates to the gameplay analyzer.
 */
export function distributeRadially(
  target: Volume,
  clip: Clipboard,
  opts: DistributeOptions,
): Instance[] {
  const instances = planRadialInstances(opts);
  for (const instance of instances) {
    let source = clip;
    if (opts.vary) {
      const copy = clip.volume.clone();
      opts.vary(copy, instance, (opts.prng ?? defaultPrngError()).fork(`instance-${instance.index}`));
      source = { volume: copy, anchor: clip.anchor, source: clip.source };
    }
    const transform: OrientTransform = { rotation: instance.rotation };
    pasteClipboard(target, source, instance.position, {
      transform,
      ignoreAir: opts.ignoreAir ?? true,
      byAnchor: opts.byAnchor ?? true,
      mask: opts.mask,
    });
  }
  return instances;
}

function defaultPrngError(): never {
  throw new Error("distributeRadially: `vary` requires a `prng` so variation stays reproducible");
}

export interface RadialSymmetryOptions {
  readonly center: Vec3;
  /** Number of sectors. 4 gives quarter symmetry, 8 gives the classic eight-team layout. */
  readonly count: number;
  /** The wedge to replicate, as a half-angle in degrees around `startAngleDegrees`. */
  readonly startAngleDegrees?: number;
  readonly ignoreAir?: boolean;
}

/**
 * Replicate one angular sector of a volume around its centre.
 *
 * Unlike {@link distributeRadially} this works on content already in the volume: build the first
 * sector however you like, then fan it out. Cells are sampled from the source sector by rotating
 * the *destination* position backwards, which avoids the holes a forward scatter leaves when the
 * rotation is not a quarter turn.
 */
export function radialSymmetry(vol: Volume, opts: RadialSymmetryOptions): number {
  const { center, count } = opts;
  if (count < 2) return 0;
  const sector = 360 / count;
  const start = opts.startAngleDegrees ?? 0;
  const written: { p: Vec3; block: number }[] = [];

  for (const p of vol.iterate()) {
    const dx = p.x - center.x;
    const dz = p.z - center.z;
    if (dx === 0 && dz === 0) continue;
    let angle = (Math.atan2(dx, -dz) * 180) / Math.PI - start;
    angle = ((angle % 360) + 360) % 360;
    const sectorIndex = Math.floor(angle / sector);
    if (sectorIndex === 0) continue; // The source sector stays as authored.

    // Rotate this destination cell back into the source sector and sample there.
    const backRad = (-sectorIndex * sector * Math.PI) / 180;
    const cos = Math.cos(backRad);
    const sin = Math.sin(backRad);
    const sx = center.x + dx * cos - dz * sin;
    const sz = center.z + dx * sin + dz * cos;
    const block = vol.get(Math.round(sx), p.y, Math.round(sz));
    if (block === 0 && (opts.ignoreAir ?? true)) continue;
    written.push({ p, block });
  }

  let changed = 0;
  for (const w of written) if (vol.setAt(w.p, w.block)) changed++;
  return changed;
}

export interface MirrorInPlaceOptions {
  readonly axis: "x" | "z";
  /** Coordinate of the mirror plane. Cells on the source side are copied to the other side. */
  readonly at: number;
  /** Which side is the source. `low` copies from below the plane to above it. */
  readonly source?: "low" | "high";
  readonly ignoreAir?: boolean;
}

/**
 * Mirror one half of a volume onto the other, in place.
 *
 * The direct expression of "make this map symmetric": build the west half, mirror it east. Block
 * data is transformed, so stairs and doors on the mirrored side face correctly.
 */
export function mirrorInPlace(vol: Volume, opts: MirrorInPlaceOptions): number {
  const sourceLow = (opts.source ?? "low") === "low";
  const transform: OrientTransform = {
    rotation: 0,
    mirrorX: opts.axis === "x",
    mirrorZ: opts.axis === "z",
  };
  // Reflecting inside the volume is the same as reflecting the whole volume and copying back only
  // the destination half, which keeps the block-data transform in one place.
  const reflected = transformVolume(vol, transform);
  let changed = 0;
  for (const p of vol.iterate()) {
    const coord = opts.axis === "x" ? p.x : p.z;
    const onSourceSide = sourceLow ? coord < opts.at : coord > opts.at;
    if (onSourceSide || coord === opts.at) continue;
    const block = reflected.getAt(p);
    if (block === 0 && (opts.ignoreAir ?? false)) continue;
    if (vol.setAt(p, block)) changed++;
  }
  return changed;
}

/** Measure how symmetric a volume is about a plane, as a ratio in `[0, 1]`. */
export function measureMirrorSymmetry(vol: Volume, axis: "x" | "z", at?: number): number {
  const plane = at ?? (axis === "x" ? (vol.width - 1) / 2 : (vol.length - 1) / 2);
  let compared = 0;
  let matched = 0;
  for (const p of vol.iterate()) {
    const coord = axis === "x" ? p.x : p.z;
    if (coord > plane) continue;
    const mirroredCoord = Math.round(2 * plane - coord);
    const q = axis === "x" ? vec(mirroredCoord, p.y, p.z) : vec(p.x, p.y, mirroredCoord);
    if (!vol.containsPoint(q)) continue;
    const a = vol.getAt(p);
    const b = vol.getAt(q);
    if (a === 0 && b === 0) continue; // Empty space on both sides says nothing about symmetry.
    compared++;
    if (a === b) matched++;
  }
  return compared === 0 ? 1 : matched / compared;
}

/**
 * Measure `count`-fold rotational symmetry about a vertical axis, as a ratio in `[0, 1]`.
 *
 * `mode` matters more than it looks. On a BedWars map the eight team islands are geometrically
 * identical but deliberately *different colours*, so a block-exact comparison scores a perfectly
 * fair map at around 60%. `"occupancy"` compares only solid-versus-air, which is the question the
 * fairness check is actually asking.
 */
export function measureRadialSymmetry(
  vol: Volume,
  center: Vec3,
  count: number,
  mode: "blocks" | "occupancy" = "blocks",
): number {
  if (count < 2) return 1;
  const step = (2 * Math.PI) / count;
  let compared = 0;
  let matched = 0;
  for (const p of vol.iterate()) {
    const a = vol.getAt(p);
    if (a === 0) continue;
    const dx = p.x - center.x;
    const dz = p.z - center.z;
    const cos = Math.cos(step);
    const sin = Math.sin(step);
    const qx = Math.round(center.x + dx * cos - dz * sin);
    const qz = Math.round(center.z + dx * sin + dz * cos);
    if (!vol.inBounds(qx, p.y, qz)) continue;
    compared++;
    const b = vol.get(qx, p.y, qz);
    if (mode === "occupancy" ? b !== 0 : b === a) matched++;
  }
  return compared === 0 ? 1 : matched / compared;
}
