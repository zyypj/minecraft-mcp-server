/**
 * Roofs.
 *
 * A roof is the fastest read on whether a build was made by a person. Flat-topped boxes are the
 * signature of generated architecture; a pitched roof with an eave overhang casts a shadow line
 * that immediately says "built". The themed BedWars maps this engine targets lean hard on roofs —
 * the little coloured houses on a Snoopy or Carousel map are almost entirely roof.
 *
 * ## Stair orientation
 *
 * 1.8 stairs encode facing in the low two bits as `0=east, 1=west, 2=south, 3=north`, with bit 2
 * flipping the block upside down. The convention used throughout this module is that a stair's
 * full-height side is on its facing side, so a slope that *descends* toward the east is built from
 * stairs facing **west** — uphill. Every roof style routes through {@link stairsFacing} so that
 * convention lives in exactly one place.
 */

import { type Facing, type Region, type Vec3, regionSize, vec } from "../core/vec.js";
import { type Prng } from "../core/prng.js";
import { AIR, type BlockSource, type PackedBlock, type Volume, blockId, pack, resolveSource } from "../core/volume.js";
import { renderClass } from "../mc18/blocks.js";
import { type Palette } from "../mc18/palette.js";
import { buildCone, buildCylinder, buildSphere } from "../geom/shapes.js";

const STAIR_FACING_BITS: Readonly<Record<Facing, number>> = {
  east: 0,
  west: 1,
  south: 2,
  north: 3,
};

/**
 * Orient a stair block so its full-height side points `towards`.
 *
 * Non-stair blocks pass through unchanged, so a caller can hand this a plain block for a style that
 * roofs in wool and get a sensible result instead of a corrupted data value.
 */
export function stairsFacing(block: PackedBlock, towards: Facing, upsideDown = false): PackedBlock {
  if (renderClass(block) !== "stairs") return block;
  return pack(blockId(block), STAIR_FACING_BITS[towards] | (upsideDown ? 0b100 : 0));
}

/** Slab variants: 1.8 puts a slab on the upper half of its cell when data bit 3 is set. */
export function slabTop(block: PackedBlock, top: boolean): PackedBlock {
  if (renderClass(block) !== "slab") return block;
  return top ? (block | 0x8) : (block & ~0x8);
}

export type RoofStyle =
  | "gable"
  | "hip"
  | "pyramid"
  | "cone"
  | "dome"
  | "flat"
  | "tent"
  | "pagoda"
  | "barrel";

export interface RoofOptions {
  /** Footprint the roof covers. Its `min.y`/`max.y` are ignored; use `baseY`. */
  readonly footprint: Region;
  /** Y of the wall top the roof sits on. The first roof layer is placed at `baseY`. */
  readonly baseY: number;
  readonly style: RoofStyle;
  readonly palette: Palette;
  /** Blocks the eaves project beyond the footprint. 1-2 is what produces the shadow line. */
  readonly overhang?: number;
  /** Rise per block of horizontal run. 1 gives 45 degrees; 0.5 a shallow roof. */
  readonly pitch?: number;
  /** Maximum height, clamping a steep pitch on a wide footprint. */
  readonly maxHeight?: number;
  /** Ridge direction for gable roofs. Defaults to the footprint's long axis. */
  readonly ridgeAxis?: "x" | "z";
  /** Fill the volume under the roof surface (solid) rather than leaving an attic. */
  readonly solid?: boolean;
  /** Number of tiers for `tent` / `pagoda`. */
  readonly tiers?: number;
  readonly prng?: Prng;
  /** Add a contrasting ridge/trim line along the roof's top edge. */
  readonly ridgeTrim?: boolean;
}

export interface RoofResult {
  readonly height: number;
  readonly ridgeY: number;
  readonly blocksPlaced: number;
}

/** Build a roof over a footprint. */
export function buildRoof(vol: Volume, opts: RoofOptions): RoofResult {
  const overhang = Math.max(0, Math.floor(opts.overhang ?? 1));
  const pitch = opts.pitch ?? 0.75;
  const primary = opts.palette.source("ROOF_PRIMARY", { scale: 4 });
  const secondary = opts.palette.source("ROOF_SECONDARY", { scale: 4 });
  const trim = opts.palette.primary("TRIM");

  const eaves: Region = {
    min: vec(opts.footprint.min.x - overhang, opts.baseY, opts.footprint.min.z - overhang),
    max: vec(opts.footprint.max.x + overhang, opts.baseY, opts.footprint.max.z + overhang),
  };
  const size = regionSize(eaves);
  const halfX = (size.x - 1) / 2;
  const halfZ = (size.z - 1) / 2;
  const cx = (eaves.min.x + eaves.max.x) / 2;
  const cz = (eaves.min.z + eaves.max.z) / 2;

  let placed = 0;
  const put = (p: Vec3, src: BlockSource): void => {
    if (vol.plot(p, src)) placed++;
  };

  switch (opts.style) {
    case "flat": {
      // A flat roof still needs an edge: a slab parapet one block proud reads as intentional.
      placed += vol.fill({ min: eaves.min, max: vec(eaves.max.x, opts.baseY, eaves.max.z) }, primary);
      const parapet = slabTop(opts.palette.primary("TRIM"), false);
      for (let x = eaves.min.x; x <= eaves.max.x; x++) {
        put(vec(x, opts.baseY + 1, eaves.min.z), parapet);
        put(vec(x, opts.baseY + 1, eaves.max.z), parapet);
      }
      for (let z = eaves.min.z; z <= eaves.max.z; z++) {
        put(vec(eaves.min.x, opts.baseY + 1, z), parapet);
        put(vec(eaves.max.x, opts.baseY + 1, z), parapet);
      }
      return { height: 1, ridgeY: opts.baseY + 1, blocksPlaced: placed };
    }

    case "gable": {
      const axis = opts.ridgeAxis ?? (size.x >= size.z ? "x" : "z");
      const halfSpan = axis === "x" ? halfZ : halfX;
      const height = Math.min(opts.maxHeight ?? Infinity, Math.max(1, Math.round(halfSpan * pitch)));
      for (let z = eaves.min.z; z <= eaves.max.z; z++) {
        for (let x = eaves.min.x; x <= eaves.max.x; x++) {
          const across = axis === "x" ? Math.abs(z - cz) : Math.abs(x - cx);
          const layer = Math.round(height * (1 - across / Math.max(0.001, halfSpan)));
          const y = opts.baseY + Math.max(0, layer);
          // Uphill direction points toward the ridge.
          const towards: Facing =
            axis === "x" ? (z < cz ? "south" : "north") : x < cx ? "east" : "west";
          const onRidge = Math.abs(across - 0) < 0.75;
          put(vec(x, y, z), (p, v) => stairsFacing(resolveSource(primary, p, v), towards));
          if (onRidge && opts.ridgeTrim !== false) put(vec(x, y + 1, z), slabTop(trim, false));
          if (opts.solid) {
            for (let fy = opts.baseY; fy < y; fy++) put(vec(x, fy, z), secondary);
          } else {
            // Close the gable ends so the attic is not open to the sky from the side.
            const atEnd = axis === "x" ? x === eaves.min.x || x === eaves.max.x : z === eaves.min.z || z === eaves.max.z;
            if (atEnd) for (let fy = opts.baseY; fy < y; fy++) put(vec(x, fy, z), secondary);
          }
        }
      }
      return { height, ridgeY: opts.baseY + height, blocksPlaced: placed };
    }

    case "hip":
    case "pyramid": {
      const halfSpan = Math.min(halfX, halfZ);
      const height = Math.min(opts.maxHeight ?? Infinity, Math.max(1, Math.round(halfSpan * pitch)));
      for (let z = eaves.min.z; z <= eaves.max.z; z++) {
        for (let x = eaves.min.x; x <= eaves.max.x; x++) {
          const dx = Math.abs(x - cx);
          const dz = Math.abs(z - cz);
          // A hip roof rises with the Chebyshev distance from the ridge line, so the four planes
          // meet along clean diagonal hips.
          const inset = Math.min(halfX - dx, halfZ - dz);
          const layer = Math.min(height, Math.round(inset * pitch));
          const y = opts.baseY + Math.max(0, layer);
          const towards: Facing =
            halfX - dx < halfZ - dz
              ? x < cx
                ? "east"
                : "west"
              : z < cz
                ? "south"
                : "north";
          put(vec(x, y, z), (p, v) => stairsFacing(resolveSource(primary, p, v), towards));
          if (opts.solid) for (let fy = opts.baseY; fy < y; fy++) put(vec(x, fy, z), secondary);
        }
      }
      return { height, ridgeY: opts.baseY + height, blocksPlaced: placed };
    }

    case "cone": {
      const radius = Math.max(halfX, halfZ);
      const height = Math.min(opts.maxHeight ?? Infinity, Math.max(2, Math.round(radius * pitch * 1.6)));
      placed += buildCone(vol, {
        base: vec(Math.round(cx), opts.baseY, Math.round(cz)),
        baseRadius: radius,
        topRadius: 0,
        height,
        block: primary,
        hollow: !opts.solid,
        thickness: 1,
        curve: "convex",
      });
      return { height, ridgeY: opts.baseY + height, blocksPlaced: placed };
    }

    case "dome": {
      const radius = Math.max(halfX, halfZ);
      const height = Math.min(opts.maxHeight ?? Infinity, Math.max(2, Math.round(radius * pitch)));
      placed += buildSphere(vol, {
        center: vec(Math.round(cx), opts.baseY, Math.round(cz)),
        radius: { x: radius, y: height, z: radius },
        block: primary,
        hollow: !opts.solid,
        thickness: 1,
        mask: (p) => p.y >= opts.baseY,
      });
      return { height, ridgeY: opts.baseY + height, blocksPlaced: placed };
    }

    case "barrel": {
      // A half-cylinder lying along the long axis — the shape of a fairground stall roof.
      const axis = opts.ridgeAxis ?? (size.x >= size.z ? "x" : "z");
      const halfSpan = axis === "x" ? halfZ : halfX;
      const height = Math.min(opts.maxHeight ?? Infinity, Math.max(2, Math.round(halfSpan * pitch * 1.3)));
      for (let z = eaves.min.z; z <= eaves.max.z; z++) {
        for (let x = eaves.min.x; x <= eaves.max.x; x++) {
          const across = (axis === "x" ? z - cz : x - cx) / Math.max(0.001, halfSpan);
          const layer = Math.round(height * Math.sqrt(Math.max(0, 1 - across * across)));
          put(vec(x, opts.baseY + layer, z), primary);
          if (opts.solid) for (let fy = opts.baseY; fy < opts.baseY + layer; fy++) put(vec(x, fy, z), secondary);
        }
      }
      return { height, ridgeY: opts.baseY + height, blocksPlaced: placed };
    }

    case "tent":
    case "pagoda": {
      // Stacked shrinking tiers, each with its own eave. This is the shape that reads as "themed
      // park building" and it is what most carousel and fairground structures actually are.
      const tiers = Math.max(2, Math.floor(opts.tiers ?? 3));
      const radius = Math.max(halfX, halfZ);
      const tierHeight = Math.max(2, Math.round((radius * pitch) / tiers) + 1);
      let y = opts.baseY;
      let r = radius;
      for (let tier = 0; tier < tiers; tier++) {
        const source = tier % 2 === 0 ? primary : secondary;
        // Eave lip: one ring wider than the tier itself, which is the upturned edge.
        placed += buildCylinder(vol, {
          base: vec(Math.round(cx), y, Math.round(cz)),
          radius: r + (opts.style === "pagoda" ? 1 : 0),
          height: 1,
          block: source,
        });
        placed += buildCone(vol, {
          base: vec(Math.round(cx), y, Math.round(cz)),
          baseRadius: r,
          topRadius: Math.max(0, r - tierHeight),
          height: tierHeight,
          block: source,
          hollow: !opts.solid,
          curve: opts.style === "pagoda" ? "concave" : "linear",
        });
        y += tierHeight;
        r = Math.max(1, r - Math.round(radius / tiers));
        if (r <= 1) break;
      }
      return { height: y - opts.baseY, ridgeY: y, blocksPlaced: placed };
    }
  }
}

/**
 * Trim the eave line with slabs or stairs one block below the roof edge.
 *
 * Optional, but it is the detail that separates "a roof" from "a roof someone finished": the eave
 * band reads as fascia board and deepens the shadow under the overhang.
 */
export function trimEaves(vol: Volume, footprint: Region, y: number, palette: Palette): number {
  const trim = slabTop(palette.primary("TRIM"), true);
  let placed = 0;
  for (let x = footprint.min.x; x <= footprint.max.x; x++) {
    for (const z of [footprint.min.z, footprint.max.z]) {
      if (vol.get(x, y, z) === AIR && vol.get(x, y + 1, z) !== AIR && vol.plot(vec(x, y, z), trim)) placed++;
    }
  }
  for (let z = footprint.min.z; z <= footprint.max.z; z++) {
    for (const x of [footprint.min.x, footprint.max.x]) {
      if (vol.get(x, y, z) === AIR && vol.get(x, y + 1, z) !== AIR && vol.plot(vec(x, y, z), trim)) placed++;
    }
  }
  return placed;
}
