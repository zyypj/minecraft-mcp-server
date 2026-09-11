/**
 * The voxel sculpture engine.
 *
 * A giant mascot in the middle of the map is the single element that gives a themed BedWars map its
 * identity, and it is the one thing plain geometry primitives cannot produce. Stacking a sphere on
 * a cylinder gives you a snowman; a sculpture needs volume, silhouette, and colour regions that
 * follow the form.
 *
 * Two independent paths, because they solve different problems:
 *
 *  1. **Part models.** A subject is declared as a tree of primitives in *normalized* space, so one
 *     model builds at any height. Parts carry material roles and paint order, mirrored across the
 *     centreline where the subject is symmetric. This is how the engine builds a mascot from a
 *     description.
 *  2. **Silhouette carving.** Given front / side / top masks, the sculpture is the intersection of
 *     their extrusions. This is the classical three-view carve, and it is what lets a builder drive
 *     an *exact* shape — traced from their own reference art or extracted from a schematic — rather
 *     than accepting whatever the parametric model produces.
 *
 * Both paths end in the same place: a voxel volume, optionally smoothed, in the map's palette.
 */

import { type Vec3, type Facing, region, vec } from "../core/vec.js";
import { type Prng } from "../core/prng.js";
import { AIR, type BlockSource, type PackedBlock, Volume, resolveSource } from "../core/volume.js";
import { smoothRegion } from "../ops/edit.js";
import { transformVolume } from "../ops/transform.js";
import { type OrientTransform } from "../mc18/rotation.js";

/** A point in the model's normalized space: `[0,1]` on each axis of the sculpture's bounding box. */
export type NormPoint = readonly [number, number, number];

export type PartShape =
  | { readonly kind: "ellipsoid"; readonly center: NormPoint; readonly radii: NormPoint }
  | { readonly kind: "box"; readonly min: NormPoint; readonly max: NormPoint }
  | {
      readonly kind: "capsule";
      readonly from: NormPoint;
      readonly to: NormPoint;
      readonly radius: number;
      /** Taper the radius toward `to`. 1 keeps it constant. */
      readonly endScale?: number;
    }
  | {
      readonly kind: "cone";
      readonly base: NormPoint;
      readonly baseRadius: number;
      readonly topRadius: number;
      readonly height: number;
    };

export interface SculpturePart {
  readonly name: string;
  readonly shape: PartShape;
  /** Material key, resolved against the caller's material map. */
  readonly material: string;
  /** Mirror this part across the sculpture's X centreline (for ears, eyes, limbs). */
  readonly mirrorX?: boolean;
  /**
   * Paint order. Higher wins where parts overlap, so an eye (order 10) survives being inside a head
   * (order 0). Parts are drawn in ascending order.
   */
  readonly order?: number;
  /** Skip this part below the given detail level. */
  readonly minDetail?: DetailLevel;
}

export type DetailLevel = "low" | "medium" | "high";

const DETAIL_RANK: Readonly<Record<DetailLevel, number>> = { low: 0, medium: 1, high: 2 };

export interface SculptureModel {
  readonly id: string;
  /** Relative proportions of the bounding box. Only the ratios matter; height drives the scale. */
  readonly aspect: { readonly width: number; readonly height: number; readonly depth: number };
  readonly parts: readonly SculpturePart[];
  /** Which way the model faces in its own space. Used to rotate it toward a target direction. */
  readonly facing?: Facing;
  /** Suggested material keys, for callers that want to know what to supply. */
  readonly materials?: readonly string[];
}

export interface SculptureOptions {
  readonly model: SculptureModel;
  /** Bottom-centre of the sculpture. */
  readonly anchor: Vec3;
  /** Target height in blocks; width and depth follow from the model's aspect. */
  readonly height: number;
  /** Material key -> block source. Missing keys fall back to `defaultMaterial`. */
  readonly materials: Readonly<Record<string, BlockSource>>;
  readonly defaultMaterial?: PackedBlock;
  readonly detail?: DetailLevel;
  /** Direction the finished sculpture should face. */
  readonly facing?: Facing;
  /** Smoothing passes over the finished form. 1 rounds the voxel stepping without losing features. */
  readonly smooth?: number;
  /** Deterministic surface irregularity, in `[0, 1]`. Small values stop it reading as machined. */
  readonly variation?: number;
  readonly prng?: Prng;
}

export interface SculptureResult {
  readonly blocksPlaced: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly size: Vec3;
  /** Blocks placed per part, so a caller can tell whether a feature actually landed. */
  readonly partCounts: Readonly<Record<string, number>>;
}

/**
 * Build a sculpture from a part model.
 *
 * The sculpture is rasterized into its own scratch volume first, then transformed and blitted.
 * That keeps the paint-order logic simple (later parts overwrite earlier ones without worrying
 * about what was already in the map) and makes rotation exact.
 */
export function buildVoxelSculpture(vol: Volume, opts: SculptureOptions): SculptureResult {
  const { model, anchor, height, materials } = opts;
  const detail = opts.detail ?? "high";
  const detailRank = DETAIL_RANK[detail];

  const scale = height / model.aspect.height;
  const width = Math.max(1, Math.round(model.aspect.width * scale));
  const depth = Math.max(1, Math.round(model.aspect.depth * scale));
  const h = Math.max(1, Math.round(height));

  // Parts are authored against the model's box but sized in height units, so a part near the edge
  // (an ear, a wing, a petal) routinely reaches outside the nominal footprint. Rasterize into a
  // padded scratch volume and crop afterwards rather than silently clipping the silhouette.
  const pad = Math.max(2, Math.ceil(h * 0.3));
  const scratch = Volume.of(width + pad * 2, h, depth + pad * 2);
  const partCounts: Record<string, number> = {};
  const fallback = opts.defaultMaterial ?? 0;

  const parts = [...model.parts]
    .filter((p) => DETAIL_RANK[p.minDetail ?? "low"] <= detailRank)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const part of parts) {
    const source = materials[part.material] ?? fallback;
    if (source === 0 && !materials[part.material]) continue;
    let count = rasterizePart(scratch, part.shape, source, width, h, depth, false, pad);
    if (part.mirrorX) count += rasterizePart(scratch, part.shape, source, width, h, depth, true, pad);
    partCounts[part.name] = (partCounts[part.name] ?? 0) + count;
  }

  if (opts.smooth && opts.smooth > 0) {
    // Threshold above 0.5 erodes more than it fills, which keeps thin features (ears, a muzzle)
    // from being rounded away entirely.
    smoothRegion(scratch, { iterations: opts.smooth, threshold: 0.56 });
  }

  if (opts.variation && opts.variation > 0 && opts.prng) {
    applySurfaceVariation(scratch, opts.variation, opts.prng);
  }

  const occupied = scratch.occupiedBounds();
  if (!occupied) {
    return { blocksPlaced: 0, bounds: { min: anchor, max: anchor }, size: vec(0, 0, 0), partCounts };
  }
  // Crop away the padding but keep the full height, so `height` still means what the caller asked.
  const cropped = scratch.crop({
    min: vec(occupied.min.x, 0, occupied.min.z),
    max: vec(occupied.max.x, h - 1, occupied.max.z),
  });

  const rotation = rotationFor(model.facing ?? "south", opts.facing ?? "south");
  const oriented = rotation.rotation === 0 ? cropped : transformVolume(cropped, rotation);

  const corner = vec(
    anchor.x - Math.floor(oriented.width / 2),
    anchor.y,
    anchor.z - Math.floor(oriented.length / 2),
  );
  const placed = vol.blit(oriented, corner, { ignoreAir: true });

  return {
    blocksPlaced: placed,
    bounds: {
      min: corner,
      max: vec(corner.x + oriented.width - 1, corner.y + oriented.height - 1, corner.z + oriented.length - 1),
    },
    size: oriented.size,
    partCounts,
  };
}

function rotationFor(from: Facing, to: Facing): OrientTransform {
  const order: Facing[] = ["north", "east", "south", "west"];
  const steps = (order.indexOf(to) - order.indexOf(from) + 4) % 4;
  return { rotation: (steps * 90) as 0 | 90 | 180 | 270 };
}

function rasterizePart(
  vol: Volume,
  shape: PartShape,
  source: BlockSource,
  width: number,
  height: number,
  depth: number,
  mirrored: boolean,
  pad: number,
): number {
  const toWorld = (p: NormPoint): Vec3 => {
    const nx = mirrored ? 1 - p[0] : p[0];
    return vec(pad + nx * (width - 1), p[1] * (height - 1), pad + p[2] * (depth - 1));
  };
  // Radii scale by *height* on all three axes, not by each axis's own extent. Scaling per-axis
  // would squash a sphere into an ellipse the moment the model's aspect is not cubic, which is
  // exactly what makes a mascot come out looking stretched.
  const unit = height - 1;
  const scaleRadii = (r: NormPoint): Vec3 => vec(r[0] * unit, r[1] * unit, r[2] * unit);

  switch (shape.kind) {
    case "ellipsoid": {
      const c = toWorld(shape.center);
      const r = scaleRadii(shape.radii);
      return fillEllipsoid(vol, c, r, source);
    }
    case "box": {
      const a = toWorld(shape.min);
      const b = toWorld(shape.max);
      return vol.fill(
        region(
          vec(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
          vec(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
        ),
        source,
      );
    }
    case "capsule": {
      const a = toWorld(shape.from);
      const b = toWorld(shape.to);
      // Radius is expressed as a fraction of the *height* so a capsule keeps its proportion when
      // the sculpture is stretched horizontally.
      const r0 = shape.radius * (height - 1);
      const r1 = r0 * (shape.endScale ?? 1);
      return fillCapsule(vol, a, b, r0, r1, source);
    }
    case "cone": {
      const base = toWorld(shape.base);
      const h = shape.height * (height - 1);
      const rb = shape.baseRadius * (height - 1);
      const rt = shape.topRadius * (height - 1);
      let placed = 0;
      for (let dy = 0; dy <= h; dy++) {
        const t = h === 0 ? 0 : dy / h;
        const r = rb + (rt - rb) * t;
        placed += fillEllipsoid(vol, vec(base.x, base.y + dy, base.z), vec(r, 0, r), source);
      }
      return placed;
    }
  }
}

function fillEllipsoid(vol: Volume, center: Vec3, radii: Vec3, source: BlockSource): number {
  const rx = Math.max(0.5, radii.x) + 0.5;
  const ry = Math.max(0.5, radii.y) + 0.5;
  const rz = Math.max(0.5, radii.z) + 0.5;
  let placed = 0;
  const y0 = Math.max(0, Math.floor(center.y - ry));
  const y1 = Math.min(vol.height - 1, Math.ceil(center.y + ry));
  const z0 = Math.max(0, Math.floor(center.z - rz));
  const z1 = Math.min(vol.length - 1, Math.ceil(center.z + rz));
  const x0 = Math.max(0, Math.floor(center.x - rx));
  const x1 = Math.min(vol.width - 1, Math.ceil(center.x + rx));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - center.y) / ry;
    for (let z = z0; z <= z1; z++) {
      const dz = (z - center.z) / rz;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - center.x) / rx;
        if (dx * dx + dy * dy + dz * dz > 1) continue;
        const p = vec(x, y, z);
        if (vol.setAt(p, resolveSource(source, p, vol))) placed++;
      }
    }
  }
  return placed;
}

function fillCapsule(
  vol: Volume,
  a: Vec3,
  b: Vec3,
  r0: number,
  r1: number,
  source: BlockSource,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const maxR = Math.max(r0, r1);
  let placed = 0;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - maxR - 1));
  const x1 = Math.min(vol.width - 1, Math.ceil(Math.max(a.x, b.x) + maxR + 1));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - maxR - 1));
  const y1 = Math.min(vol.height - 1, Math.ceil(Math.max(a.y, b.y) + maxR + 1));
  const z0 = Math.max(0, Math.floor(Math.min(a.z, b.z) - maxR - 1));
  const z1 = Math.min(vol.length - 1, Math.ceil(Math.max(a.z, b.z) + maxR + 1));
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // Closest point on the segment, then a radius interpolated along it.
        const px = x - a.x;
        const py = y - a.y;
        const pz = z - a.z;
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / lengthSq));
        const cx = a.x + dx * t;
        const cy = a.y + dy * t;
        const cz = a.z + dz * t;
        const r = r0 + (r1 - r0) * t + 0.5;
        const dist = Math.hypot(x - cx, y - cy, z - cz);
        if (dist > r) continue;
        const p = vec(x, y, z);
        if (vol.setAt(p, resolveSource(source, p, vol))) placed++;
      }
    }
  }
  return placed;
}

/**
 * Nudge surface cells in and out so the form does not read as a perfect mathematical solid.
 *
 * Deliberately tiny: it only removes isolated surface cells and fills single-cell dents, which
 * softens the machine-perfect look without touching the silhouette.
 */
function applySurfaceVariation(vol: Volume, amount: number, prng: Prng): void {
  const strength = Math.min(0.35, amount * 0.35);
  const removals: Vec3[] = [];
  for (const { pos } of vol.iterateSolid()) {
    let exposed = 0;
    if (vol.get(pos.x + 1, pos.y, pos.z) === AIR) exposed++;
    if (vol.get(pos.x - 1, pos.y, pos.z) === AIR) exposed++;
    if (vol.get(pos.x, pos.y, pos.z + 1) === AIR) exposed++;
    if (vol.get(pos.x, pos.y, pos.z - 1) === AIR) exposed++;
    if (vol.get(pos.x, pos.y + 1, pos.z) === AIR) exposed++;
    // Only cells sticking out on three or more sides are candidates: never punch into a flat face.
    if (exposed >= 3 && prng.chance(strength)) removals.push(pos);
  }
  for (const p of removals) vol.setAt(p, AIR);
}

// -- Silhouette carving --------------------------------------------------------------------------

/** A binary mask. `data[y * width + x]` is non-zero where the shape is solid. */
export interface Silhouette {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Build a silhouette from ASCII art. Any non-space, non-`.` character counts as solid. */
export function silhouetteFromAscii(rows: readonly string[]): Silhouette {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const data = new Uint8Array(width * height);
  rows.forEach((row, i) => {
    // Row 0 is the *top* of the image, so flip into Y-up voxel space.
    const y = height - 1 - i;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch !== " " && ch !== ".") data[y * width + x] = 1;
    }
  });
  return { width, height, data };
}

function sampleSilhouette(s: Silhouette, u: number, v: number): boolean {
  const x = Math.min(s.width - 1, Math.max(0, Math.round(u * (s.width - 1))));
  const y = Math.min(s.height - 1, Math.max(0, Math.round(v * (s.height - 1))));
  return s.data[y * s.width + x] !== 0;
}

export interface CarveOptions {
  /** Looking along -Z: the X/Y outline. Required — it defines the silhouette that must read. */
  readonly front: Silhouette;
  /** Looking along -X: the Z/Y outline. Without it the shape is a straight extrusion. */
  readonly side?: Silhouette;
  /** Looking down: the X/Z outline. */
  readonly top?: Silhouette;
  readonly anchor: Vec3;
  readonly height: number;
  /** Depth in blocks. Defaults to the side view's aspect, or a third of the width. */
  readonly depth?: number;
  readonly block: BlockSource;
  readonly facing?: Facing;
  readonly smooth?: number;
}

/**
 * Carve a sculpture as the intersection of two or three orthographic silhouettes.
 *
 * This is the technique a builder uses by hand: block out the front view, block out the side view,
 * keep what both agree on. With a top view as well the result is close to the true form for most
 * subjects. It is the path to use when the shape has to match a specific reference.
 */
export function carveFromSilhouettes(vol: Volume, opts: CarveOptions): SculptureResult {
  const front = opts.front;
  const h = Math.max(1, Math.round(opts.height));
  const width = Math.max(1, Math.round((front.width / front.height) * h));
  const depth = Math.max(
    1,
    Math.round(
      opts.depth ??
        (opts.side ? (opts.side.width / opts.side.height) * h : Math.max(3, width / 3)),
    ),
  );

  const scratch = Volume.of(width, h, depth);
  let placed = 0;
  for (let y = 0; y < h; y++) {
    const v = h === 1 ? 0 : y / (h - 1);
    for (let z = 0; z < depth; z++) {
      const w = depth === 1 ? 0.5 : z / (depth - 1);
      for (let x = 0; x < width; x++) {
        const u = width === 1 ? 0.5 : x / (width - 1);
        if (!sampleSilhouette(front, u, v)) continue;
        if (opts.side && !sampleSilhouette(opts.side, w, v)) continue;
        if (opts.top && !sampleSilhouette(opts.top, u, w)) continue;
        const p = vec(x, y, z);
        if (scratch.setAt(p, resolveSource(opts.block, p, scratch))) placed++;
      }
    }
  }

  if (opts.smooth && opts.smooth > 0) smoothRegion(scratch, { iterations: opts.smooth, threshold: 0.56 });

  const rotation = rotationFor("south", opts.facing ?? "south");
  const oriented = rotation.rotation === 0 ? scratch : transformVolume(scratch, rotation);
  const corner = vec(
    opts.anchor.x - Math.floor(oriented.width / 2),
    opts.anchor.y,
    opts.anchor.z - Math.floor(oriented.length / 2),
  );
  const written = vol.blit(oriented, corner, { ignoreAir: true });

  return {
    blocksPlaced: written,
    bounds: {
      min: corner,
      max: vec(corner.x + oriented.width - 1, corner.y + oriented.height - 1, corner.z + oriented.length - 1),
    },
    size: oriented.size,
    partCounts: { carved: placed },
  };
}

/**
 * Extract the silhouettes of an existing volume.
 *
 * The inverse operation: take a sculpture out of a reference schematic and reduce it to the three
 * views, which can then be rescaled and rebuilt at a different size in a different palette. This is
 * how "use the composition of that map but at three quarters the scale" becomes possible without
 * copying blocks.
 */
export function extractSilhouettes(vol: Volume): {
  front: Silhouette;
  side: Silhouette;
  top: Silhouette;
} {
  const front = new Uint8Array(vol.width * vol.height);
  const side = new Uint8Array(vol.length * vol.height);
  const top = new Uint8Array(vol.width * vol.length);
  for (const { pos } of vol.iterateSolid()) {
    front[pos.y * vol.width + pos.x] = 1;
    side[pos.y * vol.length + pos.z] = 1;
    top[pos.z * vol.width + pos.x] = 1;
  }
  return {
    front: { width: vol.width, height: vol.height, data: front },
    side: { width: vol.length, height: vol.height, data: side },
    top: { width: vol.width, height: vol.length, data: top },
  };
}
