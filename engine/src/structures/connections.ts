/**
 * Bridges, paths and stairways — the things that connect islands and make a map traversable.
 *
 * On a BedWars map these are gameplay objects first and scenery second: a bridge is a rush route,
 * and its width, railing height and whether it can be broken from below all matter more than how it
 * looks. So the generators here expose the gameplay parameters directly (`width`, `railing`,
 * `supportSpacing`) and treat the decoration as a layer on top.
 */

import { type Vec3, distanceXZ, vec } from "../core/vec.js";
import { clamp01, smoothstep } from "../core/prng.js";
import { AIR, type BlockSource, type Volume, resolveSource } from "../core/volume.js";
import { type Palette } from "../mc18/palette.js";
import { plotLine2D } from "../geom/shapes.js";
import { slabTop } from "./roof.js";

export type BridgeStyle = "flat" | "arched" | "suspension" | "covered";

export interface BridgeOptions {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly palette: Palette;
  /** Walkable width in blocks. 3 is the standard BedWars connector; 5 reads as a main route. */
  readonly width?: number;
  readonly style?: BridgeStyle;
  /** Height of the side railing. 0 leaves the deck open (and therefore knockable-off). */
  readonly railing?: number;
  /** Peak rise above the straight line, for `arched` and `suspension`. */
  readonly rise?: number;
  /** Drop a support pier every this many blocks down to whatever is below. 0 disables. */
  readonly supportSpacing?: number;
  /** How far down a support may search for ground before giving up. */
  readonly supportDepth?: number;
}

export interface BridgeResult {
  readonly blocksPlaced: number;
  /** The walkable centreline, which the pathfinding analyzer consumes directly. */
  readonly deck: readonly Vec3[];
  readonly length: number;
}

/** Build a bridge between two points. */
export function buildBridge(vol: Volume, opts: BridgeOptions): BridgeResult {
  const {
    from,
    to,
    palette,
    width = 3,
    style = "flat",
    railing = 1,
    supportSpacing = 0,
    supportDepth = 40,
  } = opts;

  const deckSource = palette.source("PATH", { scale: 3 });
  const railSource = palette.source("TRIM");
  const supportSource = palette.source("SUPPORT", { scale: 3 });

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const span = Math.hypot(dx, dz);
  if (span < 1) return { blocksPlaced: 0, deck: [], length: 0 };
  const rise = opts.rise ?? (style === "arched" || style === "suspension" ? Math.max(2, Math.round(span * 0.08)) : 0);

  const columns = plotLine2D(from.x, from.z, to.x, to.z);
  const perpX = -dz / span;
  const perpZ = dx / span;
  const half = (width - 1) / 2;

  let placed = 0;
  const deck: Vec3[] = [];

  columns.forEach((col, i) => {
    const [cx, cz] = col;
    const t = columns.length <= 1 ? 0 : i / (columns.length - 1);
    // Interpolate the endpoints' heights, then add the arch profile on top.
    const baseY = from.y + (to.y - from.y) * t;
    const u = t * 2 - 1;
    const arch = style === "arched" ? rise * (1 - u * u) : style === "suspension" ? rise * (1 - Math.abs(u)) : 0;
    const y = Math.round(baseY + arch);
    deck.push(vec(cx, y, cz));

    for (let w = -half; w <= half; w++) {
      const x = Math.round(cx + perpX * w);
      const z = Math.round(cz + perpZ * w);
      if (vol.plot(vec(x, y, z), deckSource)) placed++;
      // Clear headroom so a covered bridge does not bury its own walkway.
      for (let clear = 1; clear <= 2; clear++) {
        if (style !== "covered" && vol.get(x, y + clear, z) !== AIR) {
          if (vol.set(x, y + clear, z, AIR)) placed++;
        }
      }
      const onEdge = Math.abs(Math.abs(w) - half) < 0.5;
      if (onEdge && railing > 0) {
        for (let r = 1; r <= railing; r++) {
          if (vol.plot(vec(x, y + r, z), r === railing ? slabTop(palette.primary("TRIM"), false) : railSource)) {
            placed++;
          }
        }
      }
    }

    if (style === "covered" && i % 1 === 0) {
      // Posts and a roof plate every other column: a covered walkway, not a tunnel.
      if (i % 4 === 0) {
        for (const w of [-half, half]) {
          const x = Math.round(cx + perpX * w);
          const z = Math.round(cz + perpZ * w);
          for (let h = 1; h <= 3; h++) if (vol.plot(vec(x, y + h, z), supportSource)) placed++;
        }
      }
      for (let w = -half - 1; w <= half + 1; w++) {
        const x = Math.round(cx + perpX * w);
        const z = Math.round(cz + perpZ * w);
        if (vol.plot(vec(x, y + 4, z), palette.source("ROOF_PRIMARY", { scale: 3 }))) placed++;
      }
    }

    if (style === "suspension" && i % 6 === 0 && i > 0 && i < columns.length - 1) {
      // Hangers from the deck up to a cable line: cheap, and it reads unmistakably as a suspension
      // bridge from any distance.
      const cableY = Math.round(from.y + (to.y - from.y) * t + rise + 4);
      for (const w of [-half, half]) {
        const x = Math.round(cx + perpX * w);
        const z = Math.round(cz + perpZ * w);
        for (let hy = y + railing + 1; hy <= cableY; hy++) {
          if (vol.plot(vec(x, hy, z), palette.primary("SUPPORT"))) placed++;
        }
      }
    }

    if (supportSpacing > 0 && i % supportSpacing === 0) {
      placed += dropSupport(vol, vec(cx, y - 1, cz), supportSource, supportDepth);
    }
  });

  return { blocksPlaced: placed, deck, length: Math.round(span) };
}

/** Extend a pier downward until it hits something solid, or give up after `maxDepth`. */
function dropSupport(vol: Volume, top: Vec3, block: BlockSource, maxDepth: number): number {
  let placed = 0;
  for (let d = 0; d < maxDepth; d++) {
    const y = top.y - d;
    if (y < 0) break;
    if (vol.get(top.x, y, top.z) !== AIR) break;
    if (vol.plot(vec(top.x, y, top.z), block)) placed++;
  }
  return placed;
}

export interface PathOptions {
  /** Waypoints in order. The path follows the terrain surface between them. */
  readonly points: readonly Vec3[];
  readonly palette: Palette;
  readonly width?: number;
  /** Border material one block outside the path surface. Set false to skip. */
  readonly edging?: boolean;
  /** Randomise the width by up to this many blocks so the path does not read as a ruler line. */
  readonly wobble?: number;
  /** Sink the path one block into the terrain, which reads as worn rather than laid on top. */
  readonly inset?: boolean;
}

/**
 * Lay a path across terrain.
 *
 * Paths follow the existing surface height rather than a fixed Y, which is what keeps them looking
 * laid rather than floating. On a themed map the paths are load-bearing visually: they tell the
 * player where to walk and they break up an otherwise uniform grass plateau.
 */
export function buildPath(vol: Volume, opts: PathOptions): number {
  const { points, palette, width = 3 } = opts;
  if (points.length < 2) return 0;
  const surface = palette.source("PATH", { scale: 2.5 });
  const edge = palette.source("TRIM", { scale: 2 });
  let placed = 0;

  for (let seg = 0; seg < points.length - 1; seg++) {
    const a = points[seg]!;
    const b = points[seg + 1]!;
    const columns = plotLine2D(a.x, a.z, b.x, b.z);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const perpX = -dz / len;
    const perpZ = dx / len;

    columns.forEach(([cx, cz], i) => {
      const wobble = opts.wobble ? Math.round(Math.sin(i * 0.4 + seg) * opts.wobble) : 0;
      const halfWidth = (width + wobble - 1) / 2;
      for (let w = -halfWidth - (opts.edging === false ? 0 : 1); w <= halfWidth + (opts.edging === false ? 0 : 1); w++) {
        const x = Math.round(cx + perpX * w);
        const z = Math.round(cz + perpZ * w);
        const surfaceY = vol.topSolidY(x, z);
        if (surfaceY < 0) continue;
        const y = opts.inset ? surfaceY : surfaceY;
        const isEdge = Math.abs(w) > halfWidth;
        if (isEdge) {
          if (vol.plot(vec(x, y, z), edge)) placed++;
        } else {
          if (vol.plot(vec(x, y, z), surface)) placed++;
          // Clear anything standing on the path (vegetation grown before the path was laid).
          if (vol.get(x, y + 1, z) !== AIR && vol.set(x, y + 1, z, AIR)) placed++;
        }
      }
    });
  }
  return placed;
}

export interface StairwayOptions {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly palette: Palette;
  readonly width?: number;
  /** Insert a landing every this many steps. 0 for a continuous flight. */
  readonly landingEvery?: number;
}

/**
 * A stepped ramp between two heights.
 *
 * Used wherever a themed map needs to get a player from a lower island tier to a higher one without
 * a jump. The steps are full blocks rather than stairs so the walk is unambiguous — a stair block
 * a player can fail to mount is a gameplay bug on a competitive map.
 */
export function buildStairway(vol: Volume, opts: StairwayOptions): number {
  const { from, to, palette, width = 3 } = opts;
  const rise = to.y - from.y;
  const run = Math.max(1, Math.round(distanceXZ(from, to)));
  const surface = palette.source("PATH", { scale: 2 });
  const side = palette.source("TRIM");
  const columns = plotLine2D(from.x, from.z, to.x, to.z);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const perpX = -dz / len;
  const perpZ = dx / len;
  const half = (width - 1) / 2;
  const landingEvery = opts.landingEvery ?? 0;

  let placed = 0;
  columns.forEach(([cx, cz], i) => {
    const t = columns.length <= 1 ? 0 : i / (columns.length - 1);
    // Landings hold the height steady for a couple of columns, which reads as architecture.
    const eased = landingEvery > 0 ? quantizeWithLandings(t, run, landingEvery) : t;
    const y = from.y + Math.round(rise * eased);
    for (let w = -half - 1; w <= half + 1; w++) {
      const x = Math.round(cx + perpX * w);
      const z = Math.round(cz + perpZ * w);
      const isEdge = Math.abs(w) > half;
      if (vol.plot(vec(x, y, z), isEdge ? side : surface)) placed++;
      for (let clear = 1; clear <= 2; clear++) {
        if (vol.get(x, y + clear, z) !== AIR && vol.set(x, y + clear, z, AIR)) placed++;
      }
    }
  });
  return placed;
}

function quantizeWithLandings(t: number, run: number, landingEvery: number): number {
  const flights = Math.max(1, Math.round(run / landingEvery));
  const flight = Math.min(flights - 1, Math.floor(t * flights));
  const withinFlight = clamp01(t * flights - flight);
  // Ease within each flight so the last step of a flight and the landing share a height.
  return (flight + smoothstep(withinFlight)) / flights;
}

/** Resolve a block source at a point — re-exported so callers can compose sources conveniently. */
export { resolveSource };
