/**
 * Geometric primitives — the layer that lets a plan say "a circular tower of radius 12 and height
 * 35" instead of naming thirty thousand coordinates.
 *
 * Everything here funnels through {@link rasterize}: a shape is a *predicate over cells*, and
 * rasterizing is walking that predicate's bounding box. Shells (`hollow`) are the same predicate
 * minus an inset copy of itself, which produces a clean, even-thickness wall — measurably better
 * than eroding a filled shape, which thins out at the poles of a sphere and at shallow angles.
 *
 * Radii follow the WorldEdit convention: a "radius 3" circle spans 7 blocks, because the test uses
 * `radius + 0.5`. That is what a Minecraft builder means by radius, and matching it means numbers
 * copied from an existing build reproduce it.
 */

import { type Region, type Vec3, region, vec } from "../core/vec.js";
import { type BlockSource, type Mask, type Volume } from "../core/volume.js";

/** A shape as a predicate over cell centres, in the same coordinate space as the volume. */
export type SolidTest = (x: number, y: number, z: number) => boolean;

/** Independent radii per axis. A scalar radius expands to equal radii. */
export interface Radii {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function radii(r: number | Partial<Radii>): Radii {
  if (typeof r === "number") return { x: r, y: r, z: r };
  return { x: r.x ?? 0, y: r.y ?? 0, z: r.z ?? 0 };
}

/** Options shared by every shape builder. */
export interface ShapeOptions {
  readonly block: BlockSource;
  readonly mask?: Mask;
  /** Draw only a shell of this thickness (in blocks) instead of a solid. */
  readonly hollow?: boolean;
  /** Shell thickness when `hollow`. Defaults to 1. */
  readonly thickness?: number;
}

/** Walk a bounding box, writing `block` wherever `test` holds. Returns cells changed. */
export function rasterize(
  vol: Volume,
  bounds: Region,
  test: SolidTest,
  src: BlockSource,
  mask?: Mask,
): number {
  return vol.fill(bounds, src, (p, current, v) => {
    if (!test(p.x, p.y, p.z)) return false;
    return mask ? mask(p, current, v) : true;
  });
}

/** Combine a solid test with an inset copy of itself to make a shell. */
function shell(outer: SolidTest, inner: SolidTest): SolidTest {
  return (x, y, z) => outer(x, y, z) && !inner(x, y, z);
}

/** Bounding box of an ellipsoid, padded by one cell so the `+0.5` test never clips. */
function ellipsoidBounds(center: Vec3, r: Radii): Region {
  return region(
    vec(Math.floor(center.x - r.x - 1), Math.floor(center.y - r.y - 1), Math.floor(center.z - r.z - 1)),
    vec(Math.ceil(center.x + r.x + 1), Math.ceil(center.y + r.y + 1), Math.ceil(center.z + r.z + 1)),
  );
}

/** `true` inside an axis-aligned ellipsoid. Radii of 0 collapse that axis to a single layer. */
export function ellipsoidTest(center: Vec3, r: Radii): SolidTest {
  const rx = r.x + 0.5;
  const ry = r.y + 0.5;
  const rz = r.z + 0.5;
  return (x, y, z) => {
    const dx = (x - center.x) / rx;
    const dy = r.y <= 0 ? (y === Math.round(center.y) ? 0 : 2) : (y - center.y) / ry;
    const dz = (z - center.z) / rz;
    return dx * dx + dy * dy + dz * dz <= 1;
  };
}

// -- Boxes ---------------------------------------------------------------------------------------

/** A filled or hollow rectangular box. */
export function buildBox(vol: Volume, r: Region, opts: ShapeOptions): number {
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  if (!opts.hollow) return vol.fill(r, opts.block, opts.mask);
  const inner: Region = {
    min: vec(r.min.x + t, r.min.y + t, r.min.z + t),
    max: vec(r.max.x - t, r.max.y - t, r.max.z - t),
  };
  const isInner: SolidTest = (x, y, z) =>
    x >= inner.min.x &&
    x <= inner.max.x &&
    y >= inner.min.y &&
    y <= inner.max.y &&
    z >= inner.min.z &&
    z <= inner.max.z;
  return rasterize(vol, r, (x, y, z) => !isInner(x, y, z), opts.block, opts.mask);
}

/**
 * A wall: a vertical slab between two horizontal points, `thickness` blocks wide and `height` tall.
 * The workhorse for arena perimeters and building shells.
 */
export interface WallOptions extends ShapeOptions {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly height: number;
  /** Wall thickness measured perpendicular to the run. Defaults to 1. */
  readonly width?: number;
}

export function buildWall(vol: Volume, opts: WallOptions): number {
  const { from, to, height } = opts;
  const width = Math.max(1, Math.floor(opts.width ?? 1));
  const baseY = from.y;
  let changed = 0;
  // Trace the horizontal run once, then extrude every traced column upward.
  const columns = plotLine2D(from.x, from.z, to.x, to.z);
  const half = (width - 1) / 2;
  // Perpendicular direction of the run, used to give the wall its thickness.
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;
  for (const [cx, cz] of columns) {
    for (let w = 0; w < width; w++) {
      const off = w - half;
      const x = Math.round(cx + px * off);
      const z = Math.round(cz + pz * off);
      for (let y = 0; y < height; y++) {
        if (vol.plot(vec(x, baseY + y, z), opts.block, opts.mask)) changed++;
      }
    }
  }
  return changed;
}

// -- Lines ---------------------------------------------------------------------------------------

/** 2D Bresenham on the XZ plane. */
export function plotLine2D(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const out: [number, number][] = [];
  let x = Math.round(x0);
  let z = Math.round(z0);
  const ex = Math.round(x1);
  const ez = Math.round(z1);
  const dx = Math.abs(ex - x);
  const dz = Math.abs(ez - z);
  const sx = x < ex ? 1 : -1;
  const sz = z < ez ? 1 : -1;
  let err = dx - dz;
  for (;;) {
    out.push([x, z]);
    if (x === ex && z === ez) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
  }
  return out;
}

/** 3D line as a list of cells (integer DDA — no gaps, one cell per major-axis step). */
export function plotLine3D(a: Vec3, b: Vec3): Vec3[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return [vec(Math.round(a.x), Math.round(a.y), Math.round(a.z))];
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push(vec(Math.round(a.x + dx * t), Math.round(a.y + dy * t), Math.round(a.z + dz * t)));
  }
  return out;
}

export interface LineOptions extends ShapeOptions {
  readonly from: Vec3;
  readonly to: Vec3;
  /** Radius of the brush swept along the line. 0 gives a single-cell line. */
  readonly radius?: number;
}

export function buildLine(vol: Volume, opts: LineOptions): number {
  const r = Math.max(0, opts.radius ?? 0);
  let changed = 0;
  const seen = new Set<number>();
  for (const p of plotLine3D(opts.from, opts.to)) {
    if (r === 0) {
      if (vol.plot(p, opts.block, opts.mask)) changed++;
      continue;
    }
    const test = ellipsoidTest(p, radii(r));
    for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++)
      for (let z = Math.floor(p.z - r); z <= Math.ceil(p.z + r); z++)
        for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
          if (!test(x, y, z)) continue;
          if (!vol.inBounds(x, y, z)) continue;
          const idx = vol.index(x, y, z);
          if (seen.has(idx)) continue;
          seen.add(idx);
          if (vol.plot(vec(x, y, z), opts.block, opts.mask)) changed++;
        }
  }
  return changed;
}

// -- Circles, spheres, cylinders -----------------------------------------------------------------

export interface CircleOptions extends ShapeOptions {
  readonly center: Vec3;
  readonly radius: number | Partial<Pick<Radii, "x" | "z">>;
  /** Filled disc (default) or just the ring. */
  readonly filled?: boolean;
}

/** A flat disc or ring on the XZ plane at `center.y`. */
export function buildCircle(vol: Volume, opts: CircleOptions): number {
  const r =
    typeof opts.radius === "number"
      ? radii({ x: opts.radius, y: 0, z: opts.radius })
      : radii({ x: opts.radius.x ?? 0, y: 0, z: opts.radius.z ?? 0 });
  const filled = opts.filled ?? true;
  const outer = ellipsoidTest(opts.center, r);
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const test = filled
    ? outer
    : shell(outer, ellipsoidTest(opts.center, { x: r.x - t, y: 0, z: r.z - t }));
  const bounds = ellipsoidBounds(opts.center, r);
  return rasterize(
    vol,
    { min: vec(bounds.min.x, opts.center.y, bounds.min.z), max: vec(bounds.max.x, opts.center.y, bounds.max.z) },
    test,
    opts.block,
    opts.mask,
  );
}

export interface SphereOptions extends ShapeOptions {
  readonly center: Vec3;
  readonly radius: number | Partial<Radii>;
}

export function buildSphere(vol: Volume, opts: SphereOptions): number {
  const r = radii(opts.radius);
  const outer = ellipsoidTest(opts.center, r);
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const test = opts.hollow
    ? shell(outer, ellipsoidTest(opts.center, { x: r.x - t, y: r.y - t, z: r.z - t }))
    : outer;
  return rasterize(vol, ellipsoidBounds(opts.center, r), test, opts.block, opts.mask);
}

export interface CylinderOptions extends ShapeOptions {
  /** Centre of the *base* layer. */
  readonly base: Vec3;
  readonly radius: number | Partial<Pick<Radii, "x" | "z">>;
  readonly height: number;
  /** Cap the ends when hollow. A hollow tower usually wants `false` (open floor and roof). */
  readonly capped?: boolean;
}

export function buildCylinder(vol: Volume, opts: CylinderOptions): number {
  const r =
    typeof opts.radius === "number"
      ? radii({ x: opts.radius, y: 0, z: opts.radius })
      : radii({ x: opts.radius.x ?? 0, y: 0, z: opts.radius.z ?? 0 });
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const height = Math.max(1, Math.floor(opts.height));
  const y0 = opts.base.y;
  const y1 = y0 + height - 1;
  const flat = (rx: number, rz: number): SolidTest => {
    const inner = ellipsoidTest(vec(opts.base.x, 0, opts.base.z), { x: rx, y: 0, z: rz });
    return (x, _y, z) => inner(x, 0, z);
  };
  const outer = flat(r.x, r.z);
  let test: SolidTest = outer;
  if (opts.hollow) {
    const wall = shell(outer, flat(r.x - t, r.z - t));
    test = opts.capped
      ? (x, y, z) => (y < y0 + t || y > y1 - t ? outer(x, y, z) : wall(x, y, z))
      : wall;
  }
  const b = ellipsoidBounds(opts.base, r);
  return rasterize(vol, { min: vec(b.min.x, y0, b.min.z), max: vec(b.max.x, y1, b.max.z) }, test, opts.block, opts.mask);
}

export interface ConeOptions extends ShapeOptions {
  readonly base: Vec3;
  readonly baseRadius: number;
  /** 0 gives a true cone; anything larger gives a frustum (a truncated cone). */
  readonly topRadius?: number;
  readonly height: number;
  /** Ease the taper instead of interpolating linearly — reads as a spire rather than a party hat. */
  readonly curve?: "linear" | "concave" | "convex";
}

export function buildCone(vol: Volume, opts: ConeOptions): number {
  const height = Math.max(1, Math.floor(opts.height));
  const y0 = opts.base.y;
  const top = opts.topRadius ?? 0;
  const curve = opts.curve ?? "linear";
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const radiusAt = (y: number): number => {
    let u = height === 1 ? 0 : (y - y0) / (height - 1);
    if (curve === "concave") u = u * u;
    else if (curve === "convex") u = 1 - (1 - u) * (1 - u);
    return opts.baseRadius + (top - opts.baseRadius) * u;
  };
  const at = (rScale: number): SolidTest => (x, y, z) => {
    const r = radiusAt(y) - rScale;
    if (r < 0) return false;
    const rr = r + 0.5;
    const dx = (x - opts.base.x) / rr;
    const dz = (z - opts.base.z) / rr;
    return dx * dx + dz * dz <= 1;
  };
  const test = opts.hollow ? shell(at(0), at(t)) : at(0);
  const maxR = Math.max(opts.baseRadius, top);
  return rasterize(
    vol,
    region(
      vec(Math.floor(opts.base.x - maxR - 1), y0, Math.floor(opts.base.z - maxR - 1)),
      vec(Math.ceil(opts.base.x + maxR + 1), y0 + height - 1, Math.ceil(opts.base.z + maxR + 1)),
    ),
    test,
    opts.block,
    opts.mask,
  );
}

export interface PyramidOptions extends ShapeOptions {
  readonly base: Vec3;
  /** Half-width of the base. A `size` of 5 gives an 11x11 footprint. */
  readonly size: number;
  readonly height?: number;
}

export function buildPyramid(vol: Volume, opts: PyramidOptions): number {
  const height = Math.max(1, Math.floor(opts.height ?? opts.size + 1));
  const y0 = opts.base.y;
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const half = (inset: number): SolidTest => (x, y, z) => {
    const layer = y - y0;
    if (layer < 0 || layer >= height) return false;
    const s = opts.size - (opts.size * layer) / Math.max(1, height - 1) - inset;
    if (s < 0) return false;
    return Math.abs(x - opts.base.x) <= s + 0.5 && Math.abs(z - opts.base.z) <= s + 0.5;
  };
  const test = opts.hollow ? shell(half(0), half(t)) : half(0);
  return rasterize(
    vol,
    region(
      vec(opts.base.x - opts.size - 1, y0, opts.base.z - opts.size - 1),
      vec(opts.base.x + opts.size + 1, y0 + height - 1, opts.base.z + opts.size + 1),
    ),
    test,
    opts.block,
    opts.mask,
  );
}

export interface TorusOptions extends ShapeOptions {
  readonly center: Vec3;
  /** Distance from the centre to the middle of the tube. */
  readonly majorRadius: number;
  /** Thickness of the tube itself. */
  readonly minorRadius: number;
  /** Axis the ring lies around. `y` gives a ring lying flat, like a carousel roof rim. */
  readonly axis?: "x" | "y" | "z";
}

export function buildTorus(vol: Volume, opts: TorusOptions): number {
  const { center, majorRadius: R, minorRadius: r } = opts;
  const axis = opts.axis ?? "y";
  const test: SolidTest = (x, y, z) => {
    const dx = x - center.x;
    const dy = y - center.y;
    const dz = z - center.z;
    let planar: number;
    let axial: number;
    if (axis === "y") {
      planar = Math.hypot(dx, dz);
      axial = dy;
    } else if (axis === "x") {
      planar = Math.hypot(dy, dz);
      axial = dx;
    } else {
      planar = Math.hypot(dx, dy);
      axial = dz;
    }
    const d = planar - R;
    return d * d + axial * axial <= (r + 0.5) * (r + 0.5);
  };
  const reach = R + r + 1;
  return rasterize(
    vol,
    region(
      vec(center.x - reach, center.y - reach, center.z - reach),
      vec(center.x + reach, center.y + reach, center.z + reach),
    ),
    test,
    opts.block,
    opts.mask,
  );
}

// -- Arches and curves ---------------------------------------------------------------------------

export interface ArchOptions extends ShapeOptions {
  /** One springing point of the arch (where it meets its support). */
  readonly from: Vec3;
  /** The other springing point. Must share `y` with `from`. */
  readonly to: Vec3;
  /** Peak height above the springing line. */
  readonly rise: number;
  /** Depth of the arch band along its own axis. */
  readonly depth?: number;
  /** Thickness of the arch band, measured radially. */
  readonly band?: number;
  readonly profile?: "round" | "pointed" | "catenary" | "segmental";
}

/**
 * An arch spanning two points. The four profiles cover the shapes that actually appear in themed
 * Minecraft builds: `round` for classical, `pointed` for gothic, `catenary` for a hanging-cable
 * curve (which is also the correct shape for a suspension bridge), `segmental` for a shallow arc.
 */
export function buildArch(vol: Volume, opts: ArchOptions): number {
  const { from, to, rise } = opts;
  const depth = Math.max(1, Math.floor(opts.depth ?? 1));
  const band = Math.max(1, Math.floor(opts.band ?? 1));
  const profile = opts.profile ?? "round";
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const span = Math.hypot(dx, dz);
  if (span < 1) return 0;
  const ux = dx / span;
  const uz = dz / span;
  const px = -uz;
  const pz = ux;

  /** Height of the arch centreline at normalized position `u` in [-1, 1] across the span. */
  const heightAt = (u: number): number => {
    const a = Math.abs(u);
    switch (profile) {
      case "round":
        return rise * Math.sqrt(Math.max(0, 1 - a * a));
      case "segmental":
        return rise * (1 - a * a);
      case "pointed":
        // Two circular arcs struck from the opposite springing point: the gothic construction.
        return rise * (1 - a) * (1 + 0.6 * (1 - a));
      case "catenary": {
        const k = 2.2;
        return (rise * (Math.cosh(k) - Math.cosh(k * u))) / (Math.cosh(k) - 1);
      }
    }
  };

  let changed = 0;
  const seen = new Set<number>();
  const steps = Math.ceil(span * 2);
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const u = s * 2 - 1;
    const cx = from.x + dx * s;
    const cz = from.z + dz * s;
    const cy = from.y + heightAt(u);
    for (let d = 0; d < depth; d++) {
      const offset = d - (depth - 1) / 2;
      for (let b = 0; b < band; b++) {
        const x = Math.round(cx + px * offset);
        const z = Math.round(cz + pz * offset);
        const y = Math.round(cy) - b;
        if (!vol.inBounds(x, y, z)) continue;
        const idx = vol.index(x, y, z);
        if (seen.has(idx)) continue;
        seen.add(idx);
        if (vol.plot(vec(x, y, z), opts.block, opts.mask)) changed++;
      }
    }
  }
  return changed;
}

export interface HelixOptions extends ShapeOptions {
  readonly center: Vec3;
  readonly radius: number;
  readonly height: number;
  /** Full turns over the whole height. Negative reverses the handedness. */
  readonly turns: number;
  /** Width of the ribbon, measured radially. */
  readonly width?: number;
}

/** A spiral ribbon — spiral staircases, carousel banding, ramps around a tower. */
export function buildHelix(vol: Volume, opts: HelixOptions): number {
  const width = Math.max(1, Math.floor(opts.width ?? 1));
  const height = Math.max(1, Math.floor(opts.height));
  let changed = 0;
  const steps = Math.ceil(Math.abs(opts.turns) * opts.radius * 8) + height;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const angle = s * opts.turns * Math.PI * 2;
    const y = opts.center.y + Math.round(s * (height - 1));
    for (let w = 0; w < width; w++) {
      const r = opts.radius - w;
      const x = Math.round(opts.center.x + Math.cos(angle) * r);
      const z = Math.round(opts.center.z + Math.sin(angle) * r);
      if (vol.plot(vec(x, y, z), opts.block, opts.mask)) changed++;
    }
  }
  return changed;
}

// -- Polygons ------------------------------------------------------------------------------------

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

/** Even-odd point-in-polygon on the XZ plane. */
export function polygonTest(points: readonly Point2[]): (x: number, z: number) => boolean {
  return (x, z) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i]!;
      const b = points[j]!;
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  };
}

export interface PolygonPrismOptions extends ShapeOptions {
  readonly points: readonly Point2[];
  readonly baseY: number;
  readonly height: number;
}

/** Extrude a 2D polygon vertically. The general fallback for any footprint a shape cannot express. */
export function buildPolygonPrism(vol: Volume, opts: PolygonPrismOptions): number {
  if (opts.points.length < 3) return 0;
  const inside = polygonTest(opts.points);
  const t = Math.max(1, Math.floor(opts.thickness ?? 1));
  const test: SolidTest = opts.hollow
    ? (x, _y, z) => inside(x, z) && !isDeepInside(inside, x, z, t)
    : (x, _y, z) => inside(x, z);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of opts.points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return rasterize(
    vol,
    region(
      vec(Math.floor(minX), opts.baseY, Math.floor(minZ)),
      vec(Math.ceil(maxX), opts.baseY + opts.height - 1, Math.ceil(maxZ)),
    ),
    test,
    opts.block,
    opts.mask,
  );
}

/** True when every cell within `t` of `(x,z)` is also inside — i.e. not part of the shell. */
function isDeepInside(
  inside: (x: number, z: number) => boolean,
  x: number,
  z: number,
  t: number,
): boolean {
  for (let dz = -t; dz <= t; dz++)
    for (let dx = -t; dx <= t; dx++) if (!inside(x + dx, z + dz)) return false;
  return true;
}

/** Vertices of a regular n-gon, useful for hexagonal towers and octagonal mid islands. */
export function regularPolygon(
  center: Point2,
  radius: number,
  sides: number,
  rotationDegrees = 0,
): Point2[] {
  const out: Point2[] = [];
  const phase = (rotationDegrees * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    out.push({ x: center.x + Math.cos(a) * radius, z: center.z + Math.sin(a) * radius });
  }
  return out;
}
