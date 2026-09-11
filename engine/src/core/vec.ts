/**
 * Integer 3D vector + axis-aligned region primitives.
 *
 * Everything in the engine works in **local build space**: `(0,0,0)` is the minimum corner of the
 * volume being built. World placement happens exactly once, at paste/commit time, by adding a world
 * origin. Keeping geometry origin-relative is what makes rotate/mirror/copy/paste and schematic
 * export all agree without a coordinate-convention argument at every call site.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => vec(a.x * k, a.y * k, a.z * k);
export const floorVec = (a: Vec3): Vec3 => vec(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z));
export const roundVec = (a: Vec3): Vec3 => vec(Math.round(a.x), Math.round(a.y), Math.round(a.z));
export const eq = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
export const key = (a: Vec3): string => `${a.x},${a.y},${a.z}`;

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
/** Distance ignoring Y — the metric that actually matters for BedWars rush routes. */
export const distanceXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** The 6 face-adjacent offsets, in a fixed order so traversals are deterministic. */
export const NEIGHBORS_6: readonly Vec3[] = Object.freeze([
  vec(1, 0, 0),
  vec(-1, 0, 0),
  vec(0, 1, 0),
  vec(0, -1, 0),
  vec(0, 0, 1),
  vec(0, 0, -1),
]);

/** The 26 offsets of a 3x3x3 shell (face + edge + corner), fixed order. */
export const NEIGHBORS_26: readonly Vec3[] = Object.freeze(
  (() => {
    const out: Vec3[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) out.push(vec(dx, dy, dz));
    return out;
  })(),
);

// ── Regions ─────────────────────────────────────────────────────────────────────────────────────

/** An inclusive axis-aligned box. `min <= max` on every axis is an invariant, enforced by ctors. */
export interface Region {
  readonly min: Vec3;
  readonly max: Vec3;
}

export function region(a: Vec3, b: Vec3): Region {
  return {
    min: vec(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
    max: vec(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
  };
}

/** Region from a minimum corner plus a positive size. */
export function regionFromSize(origin: Vec3, size: Vec3): Region {
  return region(origin, vec(origin.x + size.x - 1, origin.y + size.y - 1, origin.z + size.z - 1));
}

export const regionSize = (r: Region): Vec3 =>
  vec(r.max.x - r.min.x + 1, r.max.y - r.min.y + 1, r.max.z - r.min.z + 1);

export const regionVolume = (r: Region): number => {
  const s = regionSize(r);
  return s.x * s.y * s.z;
};

export const regionCenter = (r: Region): Vec3 =>
  vec((r.min.x + r.max.x) / 2, (r.min.y + r.max.y) / 2, (r.min.z + r.max.z) / 2);

export const contains = (r: Region, p: Vec3): boolean =>
  p.x >= r.min.x &&
  p.x <= r.max.x &&
  p.y >= r.min.y &&
  p.y <= r.max.y &&
  p.z >= r.min.z &&
  p.z <= r.max.z;

export const intersects = (a: Region, b: Region): boolean =>
  a.min.x <= b.max.x &&
  a.max.x >= b.min.x &&
  a.min.y <= b.max.y &&
  a.max.y >= b.min.y &&
  a.min.z <= b.max.z &&
  a.max.z >= b.min.z;

export function intersection(a: Region, b: Region): Region | null {
  if (!intersects(a, b)) return null;
  return {
    min: vec(Math.max(a.min.x, b.min.x), Math.max(a.min.y, b.min.y), Math.max(a.min.z, b.min.z)),
    max: vec(Math.min(a.max.x, b.max.x), Math.min(a.max.y, b.max.y), Math.min(a.max.z, b.max.z)),
  };
}

export function union(a: Region, b: Region): Region {
  return {
    min: vec(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
    max: vec(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
  };
}

export function expand(r: Region, by: number): Region {
  return {
    min: vec(r.min.x - by, r.min.y - by, r.min.z - by),
    max: vec(r.max.x + by, r.max.y + by, r.max.z + by),
  };
}

/** Iterate a region in Y-major, then Z, then X — the same order the schematic layout uses. */
export function* iterateRegion(r: Region): Generator<Vec3> {
  for (let y = r.min.y; y <= r.max.y; y++)
    for (let z = r.min.z; z <= r.max.z; z++)
      for (let x = r.min.x; x <= r.max.x; x++) yield vec(x, y, z);
}

// ── Facing ──────────────────────────────────────────────────────────────────────────────────────

/** Cardinal facing. The engine's canonical forward is `south` (+Z), matching Minecraft convention. */
export type Facing = "north" | "east" | "south" | "west";

export const FACINGS: readonly Facing[] = Object.freeze(["north", "east", "south", "west"]);

/** Unit direction vector for a facing (+Z = south, +X = east — Minecraft's axes). */
export function facingVector(f: Facing): Vec3 {
  switch (f) {
    case "north":
      return vec(0, 0, -1);
    case "south":
      return vec(0, 0, 1);
    case "east":
      return vec(1, 0, 0);
    case "west":
      return vec(-1, 0, 0);
  }
}

/** Degrees of clockwise (looking down from +Y) rotation needed to turn `from` into `to`. */
export function facingDelta(from: Facing, to: Facing): 0 | 90 | 180 | 270 {
  const d = (FACINGS.indexOf(to) - FACINGS.indexOf(from) + 4) % 4;
  return (d * 90) as 0 | 90 | 180 | 270;
}

export function rotateFacing(f: Facing, degrees: number): Facing {
  const steps = (((Math.round(degrees / 90) % 4) + 4) % 4);
  return FACINGS[(FACINGS.indexOf(f) + steps) % 4]!;
}
