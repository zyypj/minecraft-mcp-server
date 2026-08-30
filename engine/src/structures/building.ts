/**
 * Buildings and towers, assembled from named components.
 *
 * The component vocabulary is the point. A plan says "a small house, two floors, gable roof, facing
 * the middle" and the generator composes:
 *
 *     Foundation -> MainVolume -> FloorLines -> Openings -> Entrance -> Roof -> Decoration
 *
 * Each step is a rule, not a coordinate. That is what lets a style change the *look* of every
 * building on a map by swapping a palette and a couple of parameters, and what lets "redo only the
 * roofs of the team islands" be a real operation rather than a rebuild.
 *
 * Every rule here exists to break a flat plane: a plinth that steps out, corner posts that read as
 * structure, a band at each floor line, window reveals two blocks deep. A wall the sun hits evenly
 * reads as unfinished, and these are the cheapest ways to stop that happening.
 */

import { type Facing, type Region, type Vec3, facingVector, region, regionSize, vec } from "../core/vec.js";
import { type Prng } from "../core/prng.js";
import { AIR, type PackedBlock, type Volume, pack, blockId } from "../core/volume.js";
import { renderClass } from "../mc18/blocks.js";
import { type Palette } from "../mc18/palette.js";
import { buildBox, buildCylinder, buildPolygonPrism, regularPolygon } from "../geom/shapes.js";
import { type RoofResult, type RoofStyle, buildRoof, slabTop, stairsFacing, trimEaves } from "./roof.js";

/** The named parts of a structure, so a caller can regenerate one without touching the others. */
export type ComponentKind =
  | "foundation"
  | "main_volume"
  | "floor_lines"
  | "openings"
  | "entrance"
  | "roof"
  | "decoration"
  | "interior";

export interface ComponentReport {
  readonly kind: ComponentKind;
  readonly blocksPlaced: number;
  readonly bounds?: Region;
}

export interface BuildingOptions {
  /** Horizontal footprint. `min.y` is the ground level the building sits on. */
  readonly footprint: Region;
  readonly baseY: number;
  readonly palette: Palette;
  readonly prng: Prng;
  /** Number of storeys. */
  readonly floors?: number;
  /** Height of each storey, floor surface to ceiling. 4 is the readable default. */
  readonly floorHeight?: number;
  readonly roofStyle?: RoofStyle;
  readonly roofPitch?: number;
  readonly roofOverhang?: number;
  /** Which way the entrance faces. */
  readonly entranceFacing?: Facing;
  /** Wall thickness. 2 gives every opening a real reveal and a real shadow. */
  readonly wallThickness?: number;
  /** Add a foundation course one block proud of the walls. */
  readonly plinth?: boolean;
  /** Add vertical corner posts in the SUPPORT material. */
  readonly cornerPosts?: boolean;
  /** Add a horizontal trim band at each floor line. */
  readonly floorBands?: boolean;
  /** Spacing between window centres along a wall. 0 disables windows. */
  readonly windowSpacing?: number;
  readonly windowHeight?: number;
  /** Fill interiors with floors and a light source per storey. */
  readonly interior?: boolean;
}

export interface BuildingResult {
  readonly components: readonly ComponentReport[];
  readonly bounds: Region;
  readonly roof?: RoofResult;
  readonly ridgeY: number;
  readonly totalBlocks: number;
  readonly entrance?: { readonly facing: Facing; readonly position: Vec3 };
}

/** Compose a building from its components. */
export function buildBuilding(vol: Volume, opts: BuildingOptions): BuildingResult {
  const {
    footprint,
    baseY,
    palette,
    prng,
    floors = 1,
    floorHeight = 4,
    roofStyle = "gable",
    entranceFacing = "south",
    wallThickness = 1,
    plinth = true,
    cornerPosts = true,
    floorBands = true,
    windowSpacing = 3,
    windowHeight = 2,
    interior = true,
  } = opts;

  const components: ComponentReport[] = [];
  const wallTop = baseY + floors * floorHeight;
  const size = regionSize(footprint);

  const wall = palette.source("WALL_PRIMARY", { scale: 3.5 });
  const secondary = palette.source("WALL_SECONDARY", { scale: 3 });
  const trim = palette.primary("TRIM");
  const support = palette.primary("SUPPORT");
  const glass = palette.source("GLASS");

  // -- Foundation ------------------------------------------------------------------------------
  if (plinth) {
    const plinthRegion = region(
      vec(footprint.min.x - 1, baseY - 1, footprint.min.z - 1),
      vec(footprint.max.x + 1, baseY, footprint.max.z + 1),
    );
    const placed = vol.fill(plinthRegion, secondary);
    components.push({ kind: "foundation", blocksPlaced: placed, bounds: plinthRegion });
  }

  // -- Main volume -----------------------------------------------------------------------------
  const shell = region(vec(footprint.min.x, baseY, footprint.min.z), vec(footprint.max.x, wallTop, footprint.max.z));
  let mainBlocks = buildBox(vol, shell, {
    block: wall,
    hollow: true,
    thickness: Math.max(1, wallThickness),
  });
  // Clear the interior explicitly: a hollow box leaves whatever terrain was inside it.
  if (size.x > 2 * wallThickness + 1 && size.z > 2 * wallThickness + 1) {
    vol.fill(
      region(
        vec(footprint.min.x + wallThickness, baseY + 1, footprint.min.z + wallThickness),
        vec(footprint.max.x - wallThickness, wallTop - 1, footprint.max.z - wallThickness),
      ),
      AIR,
    );
  }
  components.push({ kind: "main_volume", blocksPlaced: mainBlocks, bounds: shell });

  // -- Corner posts and floor bands ------------------------------------------------------------
  let lineBlocks = 0;
  if (cornerPosts) {
    for (const x of [footprint.min.x, footprint.max.x]) {
      for (const z of [footprint.min.z, footprint.max.z]) {
        for (let y = baseY; y <= wallTop; y++) {
          if (vol.plot(vec(x, y, z), support)) lineBlocks++;
        }
      }
    }
  }
  if (floorBands) {
    const band = slabTop(trim, false);
    for (let floor = 1; floor <= floors; floor++) {
      const y = baseY + floor * floorHeight;
      if (y >= wallTop) continue;
      lineBlocks += ringAtHeight(vol, footprint, y, band);
    }
  }
  if (lineBlocks > 0) components.push({ kind: "floor_lines", blocksPlaced: lineBlocks });

  // -- Openings --------------------------------------------------------------------------------
  let openingBlocks = 0;
  if (windowSpacing > 0) {
    for (let floor = 0; floor < floors; floor++) {
      const sillY = baseY + floor * floorHeight + 1;
      openingBlocks += cutWindows(vol, {
        footprint,
        sillY,
        height: windowHeight,
        spacing: windowSpacing,
        glass,
        reveal: trim,
        wallThickness,
      });
    }
    components.push({ kind: "openings", blocksPlaced: openingBlocks });
  }

  // -- Entrance --------------------------------------------------------------------------------
  const entrance = cutEntrance(vol, {
    footprint,
    baseY,
    facing: entranceFacing,
    height: Math.min(3, floorHeight - 1),
    palette,
    wallThickness,
  });
  components.push({ kind: "entrance", blocksPlaced: entrance.blocksPlaced });

  // -- Interior --------------------------------------------------------------------------------
  if (interior && size.x > 2 && size.z > 2) {
    let interiorBlocks = 0;
    const floorSource = palette.source("FLOOR", { scale: 3 });
    for (let floor = 1; floor < floors; floor++) {
      const y = baseY + floor * floorHeight;
      interiorBlocks += vol.fill(
        region(
          vec(footprint.min.x + wallThickness, y, footprint.min.z + wallThickness),
          vec(footprint.max.x - wallThickness, y, footprint.max.z - wallThickness),
        ),
        floorSource,
      );
    }
    // One light per storey: enough to stop mob spawns without the lamp-spam that reads as lazy.
    const light = palette.primary("LIGHT");
    for (let floor = 0; floor < floors; floor++) {
      const y = baseY + floor * floorHeight + floorHeight - 1;
      const p = vec(
        Math.round((footprint.min.x + footprint.max.x) / 2),
        y,
        Math.round((footprint.min.z + footprint.max.z) / 2),
      );
      if (vol.getAt(p) === AIR && vol.plot(p, light)) interiorBlocks++;
    }
    components.push({ kind: "interior", blocksPlaced: interiorBlocks });
  }

  // -- Roof ------------------------------------------------------------------------------------
  const roof = buildRoof(vol, {
    footprint,
    baseY: wallTop,
    style: roofStyle,
    palette,
    overhang: opts.roofOverhang ?? 1,
    pitch: opts.roofPitch ?? 0.8,
    prng,
    solid: false,
  });
  components.push({ kind: "roof", blocksPlaced: roof.blocksPlaced });
  if ((opts.roofOverhang ?? 1) > 0) {
    trimEaves(
      vol,
      region(
        vec(footprint.min.x - (opts.roofOverhang ?? 1), 0, footprint.min.z - (opts.roofOverhang ?? 1)),
        vec(footprint.max.x + (opts.roofOverhang ?? 1), 0, footprint.max.z + (opts.roofOverhang ?? 1)),
      ),
      wallTop - 1,
      palette,
    );
  }

  const totalBlocks = components.reduce((sum, c) => sum + c.blocksPlaced, 0);
  return {
    components,
    bounds: region(
      vec(footprint.min.x - 1, baseY - 1, footprint.min.z - 1),
      vec(footprint.max.x + 1, roof.ridgeY, footprint.max.z + 1),
    ),
    roof,
    ridgeY: roof.ridgeY,
    totalBlocks,
    entrance: entrance.position ? { facing: entranceFacing, position: entrance.position } : undefined,
  };
}

/** Lay a one-block ring at a height — used for floor bands and cornices. */
function ringAtHeight(vol: Volume, footprint: Region, y: number, block: PackedBlock): number {
  let placed = 0;
  for (let x = footprint.min.x; x <= footprint.max.x; x++) {
    if (vol.plot(vec(x, y, footprint.min.z), block)) placed++;
    if (vol.plot(vec(x, y, footprint.max.z), block)) placed++;
  }
  for (let z = footprint.min.z + 1; z < footprint.max.z; z++) {
    if (vol.plot(vec(footprint.min.x, y, z), block)) placed++;
    if (vol.plot(vec(footprint.max.x, y, z), block)) placed++;
  }
  return placed;
}

interface WindowOptions {
  readonly footprint: Region;
  readonly sillY: number;
  readonly height: number;
  readonly spacing: number;
  readonly glass: PackedBlock | ((p: Vec3, v: Volume) => PackedBlock);
  readonly reveal: PackedBlock;
  readonly wallThickness: number;
}

/**
 * Cut a rhythm of windows into all four walls.
 *
 * Windows are inset one block from the outer face rather than flush, which is what gives a facade
 * its shadow. The rhythm is anchored on the wall centre so opposite walls line up — a window row
 * that drifts out of alignment is one of the loudest tells of generated architecture.
 */
function cutWindows(vol: Volume, opts: WindowOptions): number {
  const { footprint, sillY, height, spacing, glass, reveal } = opts;
  let placed = 0;
  const inset = Math.max(0, opts.wallThickness - 1);

  const cutOne = (x: number, z: number, normal: Vec3): void => {
    for (let dy = 0; dy < height; dy++) {
      const y = sillY + dy;
      // Recess the pane by `inset` along the wall normal so the opening has a visible reveal.
      const px = x - normal.x * inset;
      const pz = z - normal.z * inset;
      for (let d = 0; d <= inset; d++) {
        const cx = x - normal.x * d;
        const cz = z - normal.z * d;
        if (vol.set(cx, y, cz, AIR)) placed++;
      }
      if (vol.plot(vec(px, y, pz), glass)) placed++;
    }
    // A lintel above the opening turns a hole into a window.
    if (vol.plot(vec(x, sillY + height, z), reveal)) placed++;
  };

  const midX = (footprint.min.x + footprint.max.x) / 2;
  const midZ = (footprint.min.z + footprint.max.z) / 2;

  for (let x = footprint.min.x + 1; x < footprint.max.x; x++) {
    if (Math.round(Math.abs(x - midX)) % spacing !== 0) continue;
    cutOne(x, footprint.min.z, vec(0, 0, -1));
    cutOne(x, footprint.max.z, vec(0, 0, 1));
  }
  for (let z = footprint.min.z + 1; z < footprint.max.z; z++) {
    if (Math.round(Math.abs(z - midZ)) % spacing !== 0) continue;
    cutOne(footprint.min.x, z, vec(-1, 0, 0));
    cutOne(footprint.max.x, z, vec(1, 0, 0));
  }
  return placed;
}

interface EntranceOptions {
  readonly footprint: Region;
  readonly baseY: number;
  readonly facing: Facing;
  readonly height: number;
  readonly palette: Palette;
  readonly wallThickness: number;
}

/** Cut a doorway in the named wall, with a stair canopy over it. */
function cutEntrance(
  vol: Volume,
  opts: EntranceOptions,
): { blocksPlaced: number; position?: Vec3 } {
  const { footprint, baseY, facing, height, palette } = opts;
  const normal = facingVector(facing);
  const midX = Math.round((footprint.min.x + footprint.max.x) / 2);
  const midZ = Math.round((footprint.min.z + footprint.max.z) / 2);
  const onWall =
    facing === "north"
      ? vec(midX, baseY, footprint.min.z)
      : facing === "south"
        ? vec(midX, baseY, footprint.max.z)
        : facing === "west"
          ? vec(footprint.min.x, baseY, midZ)
          : vec(footprint.max.x, baseY, midZ);

  let placed = 0;
  const width = 1;
  const along = facing === "north" || facing === "south" ? vec(1, 0, 0) : vec(0, 0, 1);
  for (let w = -width; w <= width; w++) {
    for (let dy = 1; dy <= height; dy++) {
      for (let d = 0; d < Math.max(1, opts.wallThickness); d++) {
        const p = vec(
          onWall.x + along.x * w - normal.x * d,
          baseY + dy,
          onWall.z + along.z * w - normal.z * d,
        );
        if (vol.setAt(p, AIR)) placed++;
      }
    }
  }

  // A stair canopy above the door: two blocks of shadow, and the strongest single cue that this
  // face of the building is the front.
  const canopy = palette.primary("TRIM");
  for (let w = -width - 1; w <= width + 1; w++) {
    const p = vec(
      onWall.x + along.x * w + normal.x,
      baseY + height + 1,
      onWall.z + along.z * w + normal.z,
    );
    const oriented =
      renderClass(canopy) === "stairs" ? stairsFacing(canopy, facing, true) : slabTop(canopy, true);
    if (vol.plot(p, oriented)) placed++;
  }

  return {
    blocksPlaced: placed,
    position: vec(onWall.x + normal.x, baseY + 1, onWall.z + normal.z),
  };
}

// -- Towers --------------------------------------------------------------------------------------

export type TowerShape = "round" | "square" | "hexagon" | "octagon";

export interface TowerOptions {
  readonly base: Vec3;
  readonly radius: number;
  readonly height: number;
  readonly palette: Palette;
  readonly prng: Prng;
  readonly shape?: TowerShape;
  readonly hollow?: boolean;
  readonly wallThickness?: number;
  /** Height between banding courses. 0 disables. */
  readonly bandSpacing?: number;
  /** Add a crenellated parapet on top. */
  readonly battlements?: boolean;
  readonly roofStyle?: RoofStyle;
  /** Windows every this many blocks of height. 0 disables. */
  readonly windowSpacing?: number;
  /** Widen the base by this many blocks over the bottom few courses. */
  readonly batter?: number;
}

export interface TowerResult {
  readonly topY: number;
  readonly ridgeY: number;
  readonly blocksPlaced: number;
  readonly components: readonly ComponentReport[];
}

/**
 * A tower — the shape "make a circular tower of radius 12 and height 35" resolves to.
 *
 * The parameters that matter for it reading as built rather than extruded are the batter (a wider
 * base, which is how real masonry towers stand up), the banding courses, and the crown treatment.
 * A bare cylinder of one block is the canonical generated-looking structure.
 */
export function buildTower(vol: Volume, opts: TowerOptions): TowerResult {
  const {
    base,
    radius,
    height,
    palette,
    shape = "round",
    hollow = true,
    wallThickness = 2,
    bandSpacing = 6,
    battlements = false,
    windowSpacing = 0,
    batter = 1,
  } = opts;

  const wall = palette.source("WALL_PRIMARY", { scale: 4 });
  const accent = palette.source("ACCENT", { scale: 3 });
  const trim = palette.primary("TRIM");
  const components: ComponentReport[] = [];
  let placed = 0;

  const shell = (r: number, y: number, h: number, blockSource: typeof wall): number => {
    if (shape === "round") {
      return buildCylinder(vol, {
        base: vec(base.x, y, base.z),
        radius: r,
        height: h,
        block: blockSource,
        hollow,
        thickness: wallThickness,
      });
    }
    if (shape === "square") {
      return buildBox(
        vol,
        region(vec(base.x - r, y, base.z - r), vec(base.x + r, y + h - 1, base.z + r)),
        { block: blockSource, hollow, thickness: wallThickness },
      );
    }
    const sides = shape === "hexagon" ? 6 : 8;
    return buildPolygonPrism(vol, {
      points: regularPolygon({ x: base.x, z: base.z }, r + 0.5, sides, shape === "octagon" ? 22.5 : 0),
      baseY: y,
      height: h,
      block: blockSource,
      hollow,
      thickness: wallThickness,
    });
  };

  // Battered base: a couple of wider courses at the bottom.
  if (batter > 0) {
    for (let i = 0; i < batter + 1; i++) {
      placed += shell(radius + batter - i, base.y + i, 1, accent);
    }
  }
  placed += shell(radius, base.y + (batter > 0 ? batter + 1 : 0), height - (batter > 0 ? batter + 1 : 0), wall);
  components.push({ kind: "main_volume", blocksPlaced: placed });

  // Banding: a ring of trim every few courses, which gives the shaft a scale reference.
  let bandBlocks = 0;
  if (bandSpacing > 0) {
    for (let y = base.y + bandSpacing; y < base.y + height - 1; y += bandSpacing) {
      bandBlocks += shell(radius, y, 1, slabTop(trim, false) as unknown as typeof wall);
    }
    components.push({ kind: "floor_lines", blocksPlaced: bandBlocks });
    placed += bandBlocks;
  }

  // Windows: narrow vertical slots, aligned to the four cardinal faces.
  let windowBlocks = 0;
  if (windowSpacing > 0) {
    const glass = palette.source("GLASS");
    for (let y = base.y + windowSpacing; y < base.y + height - 2; y += windowSpacing) {
      for (const dir of [vec(1, 0, 0), vec(-1, 0, 0), vec(0, 0, 1), vec(0, 0, -1)]) {
        for (let dy = 0; dy < 2; dy++) {
          for (let d = 0; d < wallThickness; d++) {
            const p = vec(base.x + dir.x * (radius - d), y + dy, base.z + dir.z * (radius - d));
            if (vol.setAt(p, AIR)) windowBlocks++;
          }
          const pane = vec(base.x + dir.x * (radius - wallThickness + 1), y + dy, base.z + dir.z * (radius - wallThickness + 1));
          if (vol.plot(pane, glass)) windowBlocks++;
        }
      }
    }
    components.push({ kind: "openings", blocksPlaced: windowBlocks });
    placed += windowBlocks;
  }

  const topY = base.y + height - 1;
  let ridgeY = topY;

  if (battlements) {
    // Alternate merlons around the rim: the crown treatment that makes a tower read as a tower.
    let crownBlocks = 0;
    const rim = radius + 1;
    for (let angleStep = 0; angleStep < 360; angleStep += 12) {
      const rad = (angleStep * Math.PI) / 180;
      const x = Math.round(base.x + Math.cos(rad) * rim);
      const z = Math.round(base.z + Math.sin(rad) * rim);
      const merlon = Math.round(angleStep / 12) % 2 === 0;
      if (vol.plot(vec(x, topY + 1, z), accent)) crownBlocks++;
      if (merlon && vol.plot(vec(x, topY + 2, z), accent)) crownBlocks++;
    }
    components.push({ kind: "decoration", blocksPlaced: crownBlocks });
    placed += crownBlocks;
    ridgeY = topY + 2;
  }

  if (opts.roofStyle && opts.roofStyle !== "flat") {
    const roof = buildRoof(vol, {
      footprint: region(vec(base.x - radius, 0, base.z - radius), vec(base.x + radius, 0, base.z + radius)),
      baseY: topY + 1,
      style: opts.roofStyle,
      palette,
      overhang: 1,
      pitch: 1.1,
      prng: opts.prng,
    });
    components.push({ kind: "roof", blocksPlaced: roof.blocksPlaced });
    placed += roof.blocksPlaced;
    ridgeY = roof.ridgeY;
  }

  return { topY, ridgeY, blocksPlaced: placed, components };
}

// -- Freestanding walls --------------------------------------------------------------------------

export interface WallStructureOptions {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly height: number;
  readonly palette: Palette;
  readonly thickness?: number;
  /** Add alternating merlons along the top. */
  readonly battlements?: boolean;
  /** Place a thicker pier every this many blocks. 0 disables. */
  readonly buttressSpacing?: number;
  /** Cap the top with slabs. */
  readonly coping?: boolean;
}

/**
 * A freestanding wall with the details that stop it reading as a fill: a coping course, periodic
 * buttresses, and optional battlements.
 */
export function buildWallStructure(vol: Volume, opts: WallStructureOptions): number {
  const { from, to, height, palette } = opts;
  const thickness = Math.max(1, opts.thickness ?? 1);
  const wall = palette.source("WALL_PRIMARY", { scale: 3.5 });
  const accent = palette.primary("ACCENT");
  const trim = palette.primary("TRIM");

  let placed = 0;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if (steps === 0) return 0;
  const px = -dz / Math.hypot(dx, dz);
  const pz = dx / Math.hypot(dx, dz);
  const half = (thickness - 1) / 2;
  const buttressSpacing = opts.buttressSpacing ?? 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = from.x + dx * t;
    const cz = from.z + dz * t;
    const isButtress = buttressSpacing > 0 && i % buttressSpacing === 0;
    const localThickness = isButtress ? thickness + 1 : thickness;
    for (let w = 0; w < localThickness; w++) {
      const off = w - (localThickness - 1) / 2;
      const x = Math.round(cx + px * off);
      const z = Math.round(cz + pz * off);
      const localHeight = isButtress ? height + 1 : height;
      for (let y = 0; y < localHeight; y++) {
        if (vol.plot(vec(x, from.y + y, z), wall)) placed++;
      }
      if (opts.coping !== false) {
        if (vol.plot(vec(x, from.y + localHeight, z), slabTop(trim, false))) placed++;
      }
      if (opts.battlements && Math.abs(off) <= half && i % 2 === 0) {
        if (vol.plot(vec(x, from.y + localHeight + 1, z), accent)) placed++;
      }
    }
  }
  return placed;
}

/** Orient a stair block toward a facing without needing the roof module. Re-exported for callers. */
export { stairsFacing, slabTop };

/** Convert any block to its stair form if the palette provides one; otherwise return it unchanged. */
export function asStair(block: PackedBlock, towards: Facing, upsideDown = false): PackedBlock {
  return renderClass(block) === "stairs"
    ? pack(blockId(block), (towards === "east" ? 0 : towards === "west" ? 1 : towards === "south" ? 2 : 3) | (upsideDown ? 4 : 0))
    : block;
}
