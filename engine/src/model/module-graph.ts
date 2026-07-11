/**
 * The module graph (§5.3) — the *semantic* build.
 *
 * Where {@link BuildModel} is the rasterized voxel buffer, the module graph is the parameterized,
 * abstract description of what the build *is*: volumes, shells, openings, roofs, rooms, and
 * signature features. It stays editable through the whole pipeline; materials are **abstract roles
 * until pass 7 (palette resolution)**, so one build reskins across biomes for free. Repeated
 * modules are references + transforms (instancing).
 *
 * A `Window` module is `{ style, w, h, sill_y }` and expands to blocks *only* at rasterization —
 * you restyle by swapping the expander, not by re-authoring geometry.
 *
 * This file is TYPES ONLY (the shapes the passes read/write). No runtime logic.
 */

import type { Vec3, Region, Dims, Facing } from "./build-model.js";
import type { RoofType, MaterialRoleName } from "../styles/style-pack.js";

// ────────────────────────────────────────────────────────────────────────────────────────────
// Pipeline inputs: Brief and BuildSite
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Footprint silhouette family, best→worst per §5.4.1 (`box` is the slop baseline). */
export type FootprintShape = "rect" | "L" | "T" | "cross" | "U" | "irregular" | "box";

/**
 * The `Brief` (pass 0 output, §5.2): the high-level, schema-constrained spec the LLM art director
 * authors. Deterministic defaults fill any gap the LLM leaves. The engine never invents *taste*
 * here — it only fills structural gaps.
 */
export interface Brief {
  /** e.g. "cottage", "manor", "temple", "guildhall". */
  buildingType: string;
  /** Style pack id (e.g. "tudor"). Must resolve against the style registry. */
  styleTag: string;
  /** Palette family hint; defaults to the style pack's palette when absent. */
  paletteFamily?: string;
  /** Optional narrative hook that flavors room program + props ("a retired sailor's cottage"). */
  story?: string;
  /** Desired rooms, e.g. ["foyer","kitchen","hall","bedroom"]. */
  roomProgram: string[];
  /** Target footprint shape + rough size in blocks. */
  footprint: { shape: FootprintShape; width: number; length: number };
  /** Storey count hint; clamped to the style pack's `storeys` range. */
  storeys?: number;
  /** Deterministic seed for this build. */
  seed: number;
}

/** Per-voxel membership predicate for non-rectangular selections (§7.1). */
export interface RegionMask {
  /** `true` if model-local `(x,y,z)` is a writable cell. Always-true for cuboid selections. */
  contains(x: number, y: number, z: number): boolean;
}

/** Sampled-once terrain description under a site (§7.2), so passes plan against slope cheaply. */
export interface TerrainProfile {
  baseY: number;
  /** Row-major surface height samples over the footprint (optional in v1). */
  heightmap?: number[];
  /** Dominant surface block ids observed under the footprint. */
  surfacePalette?: string[];
  /** Max height delta across the footprint, in blocks. */
  slope?: number;
  /** Whether water intersects the footprint. */
  water?: boolean;
}

/** Adjacency context around a site (roads, other builds, cliffs…). Kept open for v1. */
export interface Adjacency {
  roads?: Region[];
  neighbours?: Region[];
  notes?: string[];
}

/**
 * A named, reserved region — the persistent contract between "where" and "what" (§7.2), distinct
 * from the transient voxel buffer written into it. The anchor is the coordinate frame; the region
 * is the box. Rotating a build changes local→world mapping but not the box.
 */
export interface BuildSite {
  id: string;
  name: string;
  region: {
    type: "cuboid" | "poly" | "cylinder";
    min: Vec3;
    max: Vec3;
    mask?: RegionMask;
  };
  anchor: { origin: Vec3; baseY: number; facing: Facing };
  footprint: { width: number; length: number; height: number };
  terrain: TerrainProfile;
  context: { biome: string; adjacency: Adjacency; reserved: boolean };
  currentBuildVersion: number;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Material roles (abstract until pass 7)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The abstract material roles a {@link Volume} references (§5.3). These stay abstract until the
 * palette pass binds each to a concrete block from the active style's weighted palette (§5.6).
 */
export interface MaterialRoles {
  WALL_PRIMARY: MaterialBinding;
  TRIM: MaterialBinding;
  ROOF: MaterialBinding;
  ACCENT: MaterialBinding;
  GLASS: MaterialBinding;
}

/** Binding of an abstract role to a palette slot; `resolved` is filled by pass 7. */
export interface MaterialBinding {
  /** The style-palette slot this role samples from. */
  role: MaterialRoleName;
  /** Concrete block state string, present only after palette resolution. */
  resolved?: string;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Geometry modules
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A rigid-body transform for a volume: placement + size + right-angle rotation about y. */
export interface Transform {
  origin: Vec3;
  size: Dims;
  /** Rotation about the y-axis, degrees. Right-angle only (buffer rotation is a pure transform). */
  rotation: 0 | 90 | 180 | 270;
}

/** Structural role of a volume in the massing hierarchy (§5.4.1). */
export type VolumeRole = "main" | "wing" | "tower" | "porch" | "annex" | "storey";

/**
 * An abstract sub-volume of the build (§5.3). The split grammar (pass 2) produces a tree of these;
 * `main` dominates in both height and footprint, wings are subordinate.
 */
export interface Volume {
  id: string;
  role: VolumeRole;
  transform: Transform;
  materialRoles: MaterialRoles;
  children: Volume[];
  shell?: Shell;
  roof?: Roof;
  features: FeatureInstance[];
  rooms?: RoomGraph;
}

/** Load-bearing shell of a volume: walls, floors, and applied facade detailing. */
export interface Shell {
  wallSegments: WallSegment[];
  floorSlabs: FloorSlab[];
  facadeDetails: FacadeDetail[];
}

/** The oriented plane a wall segment lives on. */
export interface WallPlane {
  /** Outward normal (which facade this wall faces). */
  facing: Facing;
  /** Bottom / top y of the segment, model-local. */
  y0: number;
  y1: number;
  /** Start / end along the wall's in-plane axis (x for N/S walls, z for E/W walls). */
  a0: number;
  a1: number;
  /** The fixed coordinate on the plane's normal axis. */
  offset: number;
}

/** One bay-width run of wall (§5.3). One window per bay is the rhythm target (§5.4.2). */
export interface WallSegment {
  id: string;
  plane: WallPlane;
  bayIndex: number;
  reservedForOpening: boolean;
  opening?: Opening;
}

/** A door/window placed in a wall segment. Expands to blocks only at rasterization. */
export interface Opening {
  type: "door" | "window";
  size: { w: number; h: number };
  /** Sill height above the segment's floor line. */
  sillY?: number;
  /** Rasterization template id (leaded-diamond, plank-door…). */
  blockTemplate?: string;
  /** Reveal recess depth in blocks (§5.4.2 — the highest-value depth trick). */
  recessDepth?: number;
}

/** A horizontal floor plate at a storey line. */
export interface FloorSlab {
  storey: number;
  /** Model-local y of the floor surface. */
  y: number;
  bbox: Region;
}

/** An applied facade ornament (§5.4.2). */
export interface FacadeDetail {
  kind:
    | "quoin"
    | "trim"
    | "sill"
    | "lintel"
    | "pilaster"
    | "stringCourse"
    | "cornice"
    | "plinth";
  anchor: Vec3;
  /** Optional extent for runs (string courses, cornices). */
  extent?: Dims;
}

// ── Roof ──────────────────────────────────────────────────────────────────────────────────

/** The ridge line of a roof, with its cap state. */
export interface Ridge {
  start: Vec3;
  end: Vec3;
  capped: boolean;
}

/** A dormer breaking a roof face (§5.4.3 — one per face longer than ~8 blocks). */
export interface Dormer {
  kind: "gable" | "hip" | "shed" | "eyebrow";
  pos: Vec3;
  size: Dims;
}

/** The roof module (§5.3, §5.4.3). `kind` mirrors the style pack's `roof.type`. */
export interface Roof {
  kind: RoofType;
  /** Pitch ratio (rise/run); drives stair placement. See §5.5 transfer function. */
  pitch: number;
  /** Eave overhang in blocks (>= 1 for pitched styles; §5.4.3). */
  overhang: number;
  ridge: Ridge;
  dormers: Dormer[];
  /** Offset chimney breaking the ridge, if any. */
  chimney?: { pos: Vec3; height: number };
}

// ── Features ──────────────────────────────────────────────────────────────────────────────

/**
 * An instance of a signature feature applied to the build (§5.5). References a {@link Feature} by
 * id; carries the concrete params the style supplied. `detected` is filled post-render by the
 * feature's detector and drives the "3+ tells" gate.
 */
export interface FeatureInstance {
  featureId: string;
  params: Record<string, number | string | boolean>;
  /** Target volume this instance decorates. */
  targetVolumeId?: string;
  /** 0..1 detector confidence, filled during QA. */
  detected?: number;
}

// ── Rooms ─────────────────────────────────────────────────────────────────────────────────

/** Coarse function class of a room; drives ceiling height + furniture template (§5.4.5). */
export type RoomFunction =
  | "foyer"
  | "hall"
  | "kitchen"
  | "living"
  | "bedroom"
  | "study"
  | "storage"
  | "cellar"
  | "stairwell"
  | "corridor";

/** A named, labeled room (§5.3). */
export interface Room {
  id: string;
  label: string;
  function: RoomFunction;
  bbox: Region;
  /** Air blocks between floor surface and ceiling underside (§5.4.5): cozy=3, grand hall=6+. */
  ceilingHeight: number;
  /** Placed light-source positions (working + fixture). */
  lights: Vec3[];
  /** Door openings connecting this room. */
  doors: Opening[];
}

/** The room graph of a volume: rooms off a circulation spine, plus furniture instances (§5.3). */
export interface RoomGraph {
  rooms: Room[];
  furniture: Furniture[];
  /** The 2–3-wide circulation spine rooms hang off (§5.4.5 — never chain rooms like train cars). */
  spine?: Region[];
}

/** A placed furniture cluster piece (§5.4.5b catalog). */
export interface Furniture {
  id: string;
  /** Catalog piece id ("chair","sofa","dining-table","fireplace"…). */
  piece: string;
  anchor: Vec3;
  facing: Facing;
  footprint: { w: number; l: number };
  roomId?: string;
}

// ── Site + Build root ───────────────────────────────────────────────────────────────────────

/** A terrain edit produced by the grounding/landscaping pass (§5.4.6). */
export interface TerrainOp {
  kind: "terrace" | "retainingWall" | "skirt" | "plinth" | "clear" | "path" | "scatter";
  region: Region;
  params?: Record<string, number | string | boolean>;
}

/** The site facet of the module graph (§5.3) — distinct from the reserved {@link BuildSite}. */
export interface Site {
  /** Footprint polygon in model-local space. */
  footprintPoly: Vec3[];
  /** Foundation datum: min/median ground height under the footprint. */
  datumY: number;
  orientation: Facing;
  terrainOps: TerrainOp[];
}

/** Metadata carried at the root of the module graph (§5.3). */
export interface BuildMeta {
  seed: number;
  /** Active style pack id. */
  style: string;
  /** Optional reference to the resolved palette. */
  paletteRef?: string;
  brief: Brief;
  /** Final rubric total (0..100). The full vector lives on the pipeline state. */
  score?: number;
}

/** The root of the module graph (§5.3). */
export interface Build {
  meta: BuildMeta;
  site: Site;
  root: Volume;
}
