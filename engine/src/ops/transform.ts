/**
 * Copy, paste, rotate and mirror.
 *
 * These are the operations that turn "design one team island" into "an eight-team map": a build is
 * authored once and instanced. That only works if orientation-carrying blocks travel correctly, so
 * every transform routes its cells through {@link transformBlock}.
 *
 * Rotation is clockwise about +Y as seen from above, with +X east and +Z south — the same sense as
 * WorldEdit's `//rotate 90`, so numbers carried over from an existing workflow behave identically.
 */

import { type Region, type Vec3, regionSize, vec } from "../core/vec.js";
import { type Mask, Volume } from "../core/volume.js";
import { type OrientTransform, isIdentity, transformBlock } from "../mc18/rotation.js";

/** A copied region plus the point inside it that callers position by. */
export interface Clipboard {
  readonly volume: Volume;
  /**
   * Offset from the clipboard's minimum corner to its reference point. Copying with an explicit
   * anchor and pasting at that anchor puts the build back exactly where it came from.
   */
  readonly anchor: Vec3;
  /** Where the copy came from, kept for provenance in build manifests. */
  readonly source?: Region;
}

/** Copy a region out of a volume. */
export function copyRegion(vol: Volume, r: Region, anchor?: Vec3): Clipboard {
  const volume = vol.crop(r);
  return {
    volume,
    anchor: anchor ? vec(anchor.x - r.min.x, anchor.y - r.min.y, anchor.z - r.min.z) : vec(0, 0, 0),
    source: r,
  };
}

export interface PasteOptions {
  /** Skip air cells in the source, leaving whatever is already there. WorldEdit's `-a`. */
  readonly ignoreAir?: boolean;
  readonly transform?: OrientTransform;
  readonly mask?: Mask;
  /** Position `at` against the clipboard anchor rather than its minimum corner. */
  readonly byAnchor?: boolean;
}

/** Paste a clipboard into a volume, applying an optional rotation/mirror on the way in. */
export function pasteClipboard(
  target: Volume,
  clip: Clipboard,
  at: Vec3,
  opts: PasteOptions = {},
): number {
  const transform = opts.transform;
  const source = transform && !isIdentity(transform) ? transformVolume(clip.volume, transform) : clip.volume;
  let corner = at;
  if (opts.byAnchor) {
    const anchor = transform && !isIdentity(transform)
      ? transformPoint(clip.anchor, clip.volume.size, transform)
      : clip.anchor;
    corner = vec(at.x - anchor.x, at.y - anchor.y, at.z - anchor.z);
  }
  return target.blit(source, corner, { ignoreAir: opts.ignoreAir ?? false, mask: opts.mask });
}

/** The dimensions a volume ends up with after a transform (quarter turns swap X and Z). */
export function transformedSize(size: Vec3, t: OrientTransform): Vec3 {
  return t.rotation === 90 || t.rotation === 270 ? vec(size.z, size.y, size.x) : size;
}

/**
 * Map a source cell to its destination cell under a transform.
 *
 * Mirrors are applied first, then the rotation, matching {@link transformBlock}'s contract so
 * geometry and block data never disagree about the order.
 */
export function transformPoint(p: Vec3, size: Vec3, t: OrientTransform): Vec3 {
  let x = t.mirrorX ? size.x - 1 - p.x : p.x;
  let z = t.mirrorZ ? size.z - 1 - p.z : p.z;
  let w = size.x;
  let l = size.z;
  for (let turn = 0; turn < t.rotation / 90; turn++) {
    // Clockwise about +Y: (x, z) -> (l - 1 - z, x); the footprint's axes swap with it.
    const nx = l - 1 - z;
    const nz = x;
    x = nx;
    z = nz;
    [w, l] = [l, w];
  }
  return vec(x, p.y, z);
}

/** Rotate and/or mirror a whole volume into a new one. */
export function transformVolume(vol: Volume, t: OrientTransform): Volume {
  if (isIdentity(t)) return vol.clone();
  const size = vol.size;
  const outSize = transformedSize(size, t);
  const out = new Volume({ size: outSize, origin: vol.origin });
  for (let y = 0; y < vol.height; y++) {
    for (let z = 0; z < vol.length; z++) {
      for (let x = 0; x < vol.width; x++) {
        const cell = vol.cells[vol.index(x, y, z)]!;
        if (cell === 0) continue;
        const d = transformPoint(vec(x, y, z), size, t);
        out.cells[out.index(d.x, d.y, d.z)] = transformBlock(cell, t);
      }
    }
  }
  return out;
}

/** Rotate a volume clockwise about +Y. */
export function rotateVolume(vol: Volume, degrees: number): Volume {
  const normalized = ((Math.round(degrees / 90) % 4) + 4) % 4;
  return transformVolume(vol, { rotation: (normalized * 90) as 0 | 90 | 180 | 270 });
}

/** Mirror a volume across an axis. `y` flips it upside down without touching block data. */
export function mirrorVolume(vol: Volume, axis: "x" | "y" | "z"): Volume {
  if (axis === "y") {
    const out = new Volume({ size: vol.size, origin: vol.origin });
    for (let y = 0; y < vol.height; y++)
      for (let z = 0; z < vol.length; z++)
        for (let x = 0; x < vol.width; x++)
          out.cells[out.index(x, vol.height - 1 - y, z)] = vol.cells[vol.index(x, y, z)]!;
    return out;
  }
  return transformVolume(vol, { rotation: 0, mirrorX: axis === "x", mirrorZ: axis === "z" });
}

/**
 * Rotate/mirror a region *in place* inside a larger volume.
 *
 * Only square footprints can rotate in place by a quarter turn; anything else would need a
 * different region to land in, and silently resizing the caller's region is worse than refusing.
 */
export function transformRegionInPlace(
  vol: Volume,
  r: Region,
  t: OrientTransform,
  opts: { ignoreAir?: boolean } = {},
): number {
  const size = regionSize(r);
  const quarterTurn = t.rotation === 90 || t.rotation === 270;
  if (quarterTurn && size.x !== size.z) {
    throw new Error(
      `Cannot rotate a ${size.x}x${size.z} region by ${t.rotation} degrees in place: ` +
        "a quarter turn swaps the X and Z extents, so the footprint must be square. " +
        "Copy the region and paste the rotated clipboard somewhere with room instead.",
    );
  }
  const clip = copyRegion(vol, r);
  const rotated = transformVolume(clip.volume, t);
  if (!opts.ignoreAir) vol.fill(r, 0);
  return vol.blit(rotated, r.min, { ignoreAir: opts.ignoreAir ?? false });
}
