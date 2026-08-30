/**
 * Data-value transforms for rotation and mirroring.
 *
 * In 1.8 a block's orientation lives in its 4-bit data value, and every family encodes it
 * differently: stairs use `0=east,1=west,2=south,3=north`, ladders and chests use the
 * `2=north..5=east` set, doors count `0=east` upward, rails have ten states including four curves,
 * vines are a bitmask of attached sides. A rotate that ignores this produces a build where every
 * staircase faces the wrong way and every door opens into a wall — which is the single most common
 * way a copy-rotate-paste map generator looks broken.
 *
 * So orientation is decoded to a cardinal {@link Facing}, transformed once, and re-encoded per
 * family. Blocks with no orientation pass through untouched.
 */

import { type Facing, rotateFacing } from "../core/vec.js";
import { type PackedBlock, blockData, blockId, pack } from "../core/volume.js";

/** A rigid transform of the XZ plane: mirrors first, then a clockwise rotation about +Y. */
export interface OrientTransform {
  readonly rotation: 0 | 90 | 180 | 270;
  /** Reflect the X axis (`x -> -x`), swapping east and west. */
  readonly mirrorX?: boolean;
  /** Reflect the Z axis (`z -> -z`), swapping north and south. */
  readonly mirrorZ?: boolean;
}

export const IDENTITY_TRANSFORM: OrientTransform = { rotation: 0 };

export function isIdentity(t: OrientTransform): boolean {
  return t.rotation === 0 && !t.mirrorX && !t.mirrorZ;
}

/** Apply a transform to a cardinal direction. */
export function transformFacing(f: Facing, t: OrientTransform): Facing {
  let out = f;
  if (t.mirrorX) out = out === "east" ? "west" : out === "west" ? "east" : out;
  if (t.mirrorZ) out = out === "north" ? "south" : out === "south" ? "north" : out;
  return rotateFacing(out, t.rotation);
}

// -- Per-family encodings ------------------------------------------------------------------------

/** `2=north, 3=south, 4=west, 5=east` — ladders, wall signs, chests, furnaces, pistons, skulls. */
const FACING_2_5: readonly (Facing | null)[] = [null, null, "north", "south", "west", "east"];

/** `0=east, 1=west, 2=south, 3=north` — stairs. */
const STAIRS: readonly Facing[] = ["east", "west", "south", "north"];

/** `0=east, 1=south, 2=west, 3=north` — door lower halves. */
const DOOR: readonly Facing[] = ["east", "south", "west", "north"];

/** `0=south, 1=west, 2=north, 3=east` — beds, fence gates, pumpkins, tripwire hooks. */
const SOUTH_FIRST: readonly Facing[] = ["south", "west", "north", "east"];

/** `0=north, 1=east, 2=south, 3=west` — repeaters, comparators, cocoa. */
const NORTH_FIRST: readonly Facing[] = ["north", "east", "south", "west"];

/** `0=south, 1=north, 2=east, 3=west` — trapdoor hinge side. */
const TRAPDOOR: readonly Facing[] = ["south", "north", "east", "west"];

/** `1=east, 2=west, 3=south, 4=north` — torches and buttons (0 and 5 are floor/ceiling). */
const TORCH: readonly (Facing | null)[] = [null, "east", "west", "south", "north", null];

function remap(table: readonly (Facing | null)[], value: number, t: OrientTransform): number {
  const facing = table[value];
  if (!facing) return value;
  const next = transformFacing(facing, t);
  const index = table.indexOf(next);
  return index >= 0 ? index : value;
}

/** Rails: 0=NS, 1=EW, 2..5 ascending east/west/north/south, 6..9 curves SE/SW/NW/NE. */
function transformRail(value: number, t: OrientTransform, powered: boolean): number {
  const ASCENDING: readonly Facing[] = ["east", "west", "north", "south"];
  if (value === 0 || value === 1) {
    // A straight rail's axis flips only under an odd number of quarter turns.
    const flips = t.rotation === 90 || t.rotation === 270;
    return flips ? 1 - value : value;
  }
  if (value >= 2 && value <= 5) {
    const facing = ASCENDING[value - 2]!;
    return 2 + ASCENDING.indexOf(transformFacing(facing, t));
  }
  if (powered) return value; // Powered rails have no curve states.
  if (value >= 6 && value <= 9) {
    // Curves name the two sides they connect: SE, SW, NW, NE.
    const CURVES: readonly [Facing, Facing][] = [
      ["south", "east"],
      ["south", "west"],
      ["north", "west"],
      ["north", "east"],
    ];
    const [a, b] = CURVES[value - 6]!;
    const na = transformFacing(a, t);
    const nb = transformFacing(b, t);
    for (let i = 0; i < CURVES.length; i++) {
      const [ca, cb] = CURVES[i]!;
      if ((ca === na && cb === nb) || (ca === nb && cb === na)) return 6 + i;
    }
  }
  return value;
}

/** Vines: bit 1=south, 2=west, 4=north, 8=east. */
function transformVine(value: number, t: OrientTransform): number {
  const BITS: readonly [number, Facing][] = [
    [1, "south"],
    [2, "west"],
    [4, "north"],
    [8, "east"],
  ];
  let out = 0;
  for (const [bit, facing] of BITS) {
    if ((value & bit) === 0) continue;
    const next = transformFacing(facing, t);
    out |= BITS.find(([, f]) => f === next)![0];
  }
  return out;
}

/**
 * Mushroom-block cap faces, laid out as a 3x3 grid of which sides carry cap texture:
 * `1=NW 2=N 3=NE / 4=W 5=centre 6=E / 7=SW 8=S 9=SE`. Values 0, 10, 14, 15 are uniform.
 */
function transformMushroom(value: number, t: OrientTransform): number {
  if (value < 1 || value > 9) return value;
  // Grid offsets in (dx, dz) with north at -z.
  const CELLS: readonly [number, number][] = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  let [dx, dz] = CELLS[value - 1]!;
  if (t.mirrorX) dx = -dx;
  if (t.mirrorZ) dz = -dz;
  const turns = t.rotation / 90;
  for (let i = 0; i < turns; i++) {
    // Clockwise about +Y: (dx, dz) -> (-dz, dx).
    [dx, dz] = [-dz, dx];
  }
  const index = CELLS.findIndex(([cx, cz]) => cx === dx && cz === dz);
  return index >= 0 ? index + 1 : value;
}

/** Axis-pillar data (logs, hay, quartz pillar): swap the X and Z axis codes on a quarter turn. */
function transformAxis(data: number, axisMask: number, xValue: number, zValue: number, t: OrientTransform): number {
  const flips = t.rotation === 90 || t.rotation === 270;
  if (!flips) return data;
  const axis = data & axisMask;
  if (axis === xValue) return (data & ~axisMask) | zValue;
  if (axis === zValue) return (data & ~axisMask) | xValue;
  return data;
}

/**
 * Transform a packed block's data value. Ids with no orientation return unchanged, so this is safe
 * to call on every cell of a volume.
 */
export function transformBlock(block: PackedBlock, t: OrientTransform): PackedBlock {
  if (isIdentity(t) || block === 0) return block;
  const id = blockId(block);
  const data = blockData(block);

  switch (id) {
    // Stairs.
    case 53:
    case 67:
    case 108:
    case 109:
    case 114:
    case 128:
    case 134:
    case 135:
    case 136:
    case 156:
    case 163:
    case 164:
    case 180:
      return pack(id, (data & 0b1100) | remap(STAIRS, data & 0b11, t));

    // Ladder / wall sign / chests / furnaces / dispenser / dropper / hopper / skull / end frame.
    case 54:
    case 61:
    case 62:
    case 65:
    case 68:
    case 130:
    case 144:
    case 146:
    case 177:
      return pack(id, (data & 0b1000) | remap(FACING_2_5, data & 0b111, t));
    case 23:
    case 158:
      // Dispenser/dropper keep a "triggered" flag in bit 3.
      return pack(id, (data & 0b1000) | remap(FACING_2_5, data & 0b111, t));
    case 154:
      // Hopper: 0 is "facing down", which rotation does not touch; bit 3 is the enabled flag.
      return pack(id, (data & 0b1000) | remap(FACING_2_5, data & 0b111, t));
    case 120:
      return pack(id, (data & 0b0100) | remap(SOUTH_FIRST, data & 0b11, t));

    // Pistons and the piston head/extension.
    case 29:
    case 33:
    case 34:
      return pack(id, (data & 0b1000) | remap(FACING_2_5, data & 0b111, t));

    // Torches, buttons, levers.
    case 50:
    case 75:
    case 76:
      return pack(id, remap(TORCH, data & 0b111, t) | (data & 0b1000));
    case 77:
    case 143:
      return pack(id, (data & 0b1000) | remap(TORCH, data & 0b111, t));
    case 69: {
      const powered = data & 0b1000;
      const orient = data & 0b111;
      if (orient >= 1 && orient <= 4) return pack(id, powered | remap(TORCH, orient, t));
      // 5 and 6 are floor levers along the Z and X axes respectively.
      if ((orient === 5 || orient === 6) && (t.rotation === 90 || t.rotation === 270)) {
        return pack(id, powered | (orient === 5 ? 6 : 5));
      }
      return block;
    }

    // Doors: the upper half stores the hinge, not a facing, so it must not be rotated.
    case 64:
    case 71:
    case 193:
    case 194:
    case 195:
    case 196:
    case 197:
      if (data & 0b1000) return block;
      return pack(id, (data & 0b0100) | remap(DOOR, data & 0b11, t));

    // Beds, fence gates, pumpkins, tripwire hooks.
    case 26:
      return pack(id, (data & 0b1100) | remap(SOUTH_FIRST, data & 0b11, t));
    case 107:
    case 183:
    case 184:
    case 185:
    case 186:
    case 187:
      return pack(id, (data & 0b1100) | remap(SOUTH_FIRST, data & 0b11, t));
    case 86:
    case 91:
      return pack(id, remap(SOUTH_FIRST, data & 0b11, t));
    case 131:
      return pack(id, (data & 0b1100) | remap(SOUTH_FIRST, data & 0b11, t));

    // Repeaters, comparators, cocoa.
    case 93:
    case 94:
    case 149:
    case 150:
    case 127:
      return pack(id, (data & 0b1100) | remap(NORTH_FIRST, data & 0b11, t));

    // Trapdoors.
    case 96:
    case 167:
      return pack(id, (data & 0b1100) | remap(TRAPDOOR, data & 0b11, t));

    // Anvils: low two bits are the facing, high two the damage stage.
    case 145:
      return pack(id, (data & 0b1100) | remap(SOUTH_FIRST, data & 0b11, t));

    // Rails.
    case 66:
      return pack(id, transformRail(data, t, false));
    case 27:
    case 28:
    case 157:
      return pack(id, (data & 0b1000) | transformRail(data & 0b111, t, true));

    // Vines.
    case 106:
      return pack(id, transformVine(data, t));

    // Mushroom blocks.
    case 99:
    case 100:
      return pack(id, transformMushroom(data, t));

    // Axis pillars: logs (0=y, 4=x, 8=z), hay/bone, quartz pillar (2=y, 3=x, 4=z).
    case 17:
    case 162:
    case 170:
      return pack(id, transformAxis(data, 0b1100, 4, 8, t));
    case 155:
      return pack(id, transformAxis(data, 0b111, 3, 4, t));

    // Standing banners and signs use 16 rotation steps rather than four.
    case 63:
    case 176: {
      const steps = (t.rotation / 90) * 4;
      let v = data;
      if (t.mirrorX) v = (16 - v) % 16; // Reflecting X negates the angle about the north axis.
      if (t.mirrorZ) v = (24 - v) % 16; // Reflecting Z negates it about the east axis.
      return pack(id, (v + steps) & 0xf);
    }

    default:
      return block;
  }
}
