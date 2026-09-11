/**
 * Arenas — a bounded fighting space with a floor, a boundary and somewhere to stand.
 *
 * The gameplay requirements are narrow and specific, which makes this one of the easier things to
 * generate well: a flat playable floor of a known radius, a boundary a player cannot leave by
 * accident, spawn positions that are symmetric and equidistant, and no cover that favours one side.
 * Everything else is decoration on top of that skeleton.
 */

import { type Region, type Vec3, region, vec } from "../core/vec.js";
import { type Prng } from "../core/prng.js";
import { AIR, type Volume } from "../core/volume.js";
import { type Palette } from "../mc18/palette.js";
import {
  buildBox,
  buildCircle,
  buildCylinder,
  buildPolygonPrism,
  regularPolygon,
} from "../geom/shapes.js";
import { slabTop } from "./roof.js";

export type ArenaShape = "circle" | "square" | "hexagon" | "octagon";
export type ArenaBoundary = "wall" | "fence" | "void" | "glass" | "open";

export interface ArenaOptions {
  /** Centre of the arena, at floor level. */
  readonly center: Vec3;
  /** Radius of the *playable* floor. Everything else is built outside it. */
  readonly playableRadius: number;
  readonly palette: Palette;
  readonly prng: Prng;
  readonly shape?: ArenaShape;
  readonly boundary?: ArenaBoundary;
  readonly wallHeight?: number;
  /** Rings of raised seating outside the boundary. 0 for a bare arena. */
  readonly seatingRows?: number;
  /** Thickness of the floor slab. */
  readonly floorDepth?: number;
  /** Number of evenly spaced spawn positions to compute. */
  readonly spawns?: number;
  /** Roof the arena over at this height above the floor. 0 leaves it open to the sky. */
  readonly roofHeight?: number;
  /** Corner towers or pillars around the boundary. */
  readonly pillars?: number;
}

export interface ArenaResult {
  readonly blocksPlaced: number;
  /** Evenly spaced spawn positions on the floor, facing the centre. */
  readonly spawns: readonly Vec3[];
  readonly floorY: number;
  /** The box a validator should treat as the playable area. */
  readonly playableArea: Region;
  readonly bounds: Region;
}

/** Build an arena. */
export function buildArena(vol: Volume, opts: ArenaOptions): ArenaResult {
  const {
    center,
    playableRadius: r,
    palette,
    shape = "circle",
    boundary = "wall",
    wallHeight = 4,
    seatingRows = 0,
    floorDepth = 3,
    spawns = 2,
    roofHeight = 0,
    pillars = 0,
  } = opts;

  const floor = palette.source("FLOOR", { scale: 3.5 });
  const wall = palette.source("WALL_PRIMARY", { scale: 3 });
  const accent = palette.source("ACCENT", { scale: 2 });
  const trim = palette.primary("TRIM");
  let placed = 0;

  // -- Floor -------------------------------------------------------------------------------------
  const layers = Math.max(1, Math.floor(floorDepth));
  for (let d = 0; d < layers; d++) {
    const y = center.y - d;
    const source = d === 0 ? floor : palette.source("TERRAIN_BASE", { scale: 4 });
    placed += fillShape(vol, shape, center.x, y, center.z, r, source);
  }

  // A contrasting ring one block in from the edge: reads as a boundary line and gives the floor
  // a centre, which a flat disc badly needs.
  if (shape === "circle") {
    placed += buildCircle(vol, {
      center: vec(center.x, center.y, center.z),
      radius: r - 1,
      filled: false,
      thickness: 1,
      block: accent,
    });
    placed += buildCircle(vol, {
      center: vec(center.x, center.y, center.z),
      radius: Math.max(1, Math.round(r * 0.25)),
      filled: false,
      thickness: 1,
      block: accent,
    });
  }

  // -- Boundary ----------------------------------------------------------------------------------
  if (boundary !== "open" && boundary !== "void") {
    const material =
      boundary === "glass"
        ? palette.source("GLASS")
        : boundary === "fence"
          ? palette.primary("DETAIL")
          : wall;
    const height = boundary === "fence" ? Math.max(1, Math.min(2, wallHeight)) : wallHeight;
    for (let h = 0; h < height; h++) {
      placed += ringShape(vol, shape, center.x, center.y + 1 + h, center.z, r + 1, material);
    }
    // Cap the wall so it does not end in a raw edge.
    placed += ringShape(vol, shape, center.x, center.y + 1 + height, center.z, r + 1, slabTop(trim, false));
  }

  if (boundary === "void") {
    // Carve a moat one block outside the floor: falling off is the boundary.
    for (let d = 0; d < layers + 4; d++) {
      ringShape(vol, shape, center.x, center.y - d, center.z, r + 1, AIR, true);
    }
  }

  // -- Seating -----------------------------------------------------------------------------------
  for (let row = 0; row < seatingRows; row++) {
    const radius = r + 3 + row * 2;
    const y = center.y + 2 + row * 2;
    placed += ringShape(vol, shape, center.x, y, center.z, radius, palette.source("WALL_SECONDARY", { scale: 3 }));
    placed += ringShape(vol, shape, center.x, y, center.z, radius + 1, palette.source("WALL_SECONDARY", { scale: 3 }));
    placed += ringShape(vol, shape, center.x, y + 1, center.z, radius + 1, slabTop(trim, false));
  }

  // -- Pillars -----------------------------------------------------------------------------------
  if (pillars > 0) {
    const pillarHeight = roofHeight > 0 ? roofHeight : wallHeight + 4;
    for (let i = 0; i < pillars; i++) {
      const angle = (i / pillars) * Math.PI * 2;
      const px = Math.round(center.x + Math.cos(angle) * (r + 2));
      const pz = Math.round(center.z + Math.sin(angle) * (r + 2));
      placed += buildCylinder(vol, {
        base: vec(px, center.y + 1, pz),
        radius: 1,
        height: pillarHeight,
        block: palette.source("SUPPORT", { scale: 2 }),
      });
    }
  }

  // -- Roof --------------------------------------------------------------------------------------
  if (roofHeight > 0) {
    placed += fillShape(
      vol,
      shape,
      center.x,
      center.y + roofHeight,
      center.z,
      r + 2,
      palette.source("ROOF_PRIMARY", { scale: 3 }),
    );
  }

  // -- Spawns ------------------------------------------------------------------------------------
  const spawnPositions: Vec3[] = [];
  const spawnRadius = Math.max(1, r - 3);
  for (let i = 0; i < spawns; i++) {
    const angle = (i / spawns) * Math.PI * 2;
    spawnPositions.push(
      vec(
        Math.round(center.x + Math.sin(angle) * spawnRadius),
        center.y + 1,
        Math.round(center.z - Math.cos(angle) * spawnRadius),
      ),
    );
  }
  // Clear the spawn columns so decoration cannot bury a player.
  for (const spawn of spawnPositions) {
    for (let h = 0; h < 3; h++) vol.set(spawn.x, spawn.y + h, spawn.z, AIR);
  }

  const reach = r + 4 + seatingRows * 2;
  return {
    blocksPlaced: placed,
    spawns: spawnPositions,
    floorY: center.y,
    playableArea: region(
      vec(center.x - r, center.y, center.z - r),
      vec(center.x + r, center.y + Math.max(wallHeight, 8), center.z + r),
    ),
    bounds: region(
      vec(center.x - reach, center.y - floorDepth, center.z - reach),
      vec(center.x + reach, center.y + Math.max(roofHeight, wallHeight) + 2, center.z + reach),
    ),
  };
}

function fillShape(
  vol: Volume,
  shape: ArenaShape,
  cx: number,
  y: number,
  cz: number,
  r: number,
  block: Parameters<Volume["fill"]>[1],
): number {
  if (shape === "circle") {
    return buildCircle(vol, { center: vec(cx, y, cz), radius: r, block, filled: true });
  }
  if (shape === "square") {
    return buildBox(vol, region(vec(cx - r, y, cz - r), vec(cx + r, y, cz + r)), { block });
  }
  const sides = shape === "hexagon" ? 6 : 8;
  return buildPolygonPrism(vol, {
    points: regularPolygon({ x: cx, z: cz }, r + 0.5, sides, shape === "octagon" ? 22.5 : 0),
    baseY: y,
    height: 1,
    block,
  });
}

function ringShape(
  vol: Volume,
  shape: ArenaShape,
  cx: number,
  y: number,
  cz: number,
  r: number,
  block: Parameters<Volume["fill"]>[1],
  force = false,
): number {
  if (shape === "circle") {
    return buildCircle(vol, { center: vec(cx, y, cz), radius: r, block, filled: false, thickness: 1 });
  }
  if (shape === "square") {
    return buildBox(vol, region(vec(cx - r, y, cz - r), vec(cx + r, y, cz + r)), {
      block,
      hollow: true,
      thickness: 1,
    });
  }
  const sides = shape === "hexagon" ? 6 : 8;
  const count = buildPolygonPrism(vol, {
    points: regularPolygon({ x: cx, z: cz }, r + 0.5, sides, shape === "octagon" ? 22.5 : 0),
    baseY: y,
    height: 1,
    block,
    hollow: true,
    thickness: 1,
  });
  void force;
  return count;
}
