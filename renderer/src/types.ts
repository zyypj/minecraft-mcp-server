/**
 * @mcbuild/renderer — shared types.
 *
 * These are the renderer's public data contracts. The heavy internals (mesher,
 * asset extraction, Puppeteer host) are stubs; the camera math (src/camera.ts) is
 * real. See BUILD_ENGINE_PLAN.md §6 for the full design.
 *
 * NOTE ON @mcbuild/protocol: Vec3 and the region AABB are conceptually owned by the
 * shared protocol package (§8). It doesn't exist yet, so they are defined locally.
 * When protocol lands, re-export these from it instead of redefining — the shapes
 * are intentionally identical (integer {x,y,z}; region = {min,max,world?}).
 */

/** Integer (or world-unit) 3D vector. Minecraft convention: +X=East, +Y=Up, +Z=South. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * An axis-aligned bounding box in world coordinates, plus optional source world.
 * `min` is the corner with the smallest x/y/z; `max` the largest. Matches the
 * protocol's `region = {min, max, world}` shape (§3.3).
 */
export interface Region {
  min: Vec3;
  max: Vec3;
  world?: string;
}

/** Cardinal facing, Minecraft convention. */
export type Facing = "north" | "east" | "south" | "west";

/** Capture presets. Only `review` is implemented in v1 (§6.3); the rest are v2. */
export type Preset = "review" | "detail" | "interior" | "cutaway";

/**
 * A single camera shot definition (a named pose on the orbit).
 *
 * `azimuthDeg` is a compass bearing measured CLOCKWISE from North (0°=N, 90°=E,
 * 180°=S, 270°=W) — see the coordinate convention in src/camera.ts.
 * `elevationDeg` is the angle above the horizontal plane (90°=straight down).
 */
export interface ShotPose {
  name: string;
  type: "perspective" | "orthographic";
  azimuthDeg: number;
  elevationDeg: number;
}

/**
 * A three.js-compatible camera configuration produced by src/camera.ts.
 *
 * `position`/`target`/`up` map directly onto `camera.position.set(...)` +
 * `camera.lookAt(target)` + `camera.up.copy(up)`. For a PerspectiveCamera use
 * `fovDeg`/`aspect`; for an OrthographicCamera use the `ortho` frustum. Both carry
 * `near`/`far`. This object is JSON-serializable so it can be handed straight into
 * the in-page three.js harness via `page.evaluate` (src/puppeteer-host.ts).
 */
export interface CameraConfig {
  type: "perspective" | "orthographic";
  /** Eye position in the same (local mesh) frame the scene is built in. */
  position: Vec3;
  /** Look-at point (the region center). */
  target: Vec3;
  /** Up vector (already orthonormalized against the view direction). */
  up: Vec3;
  near: number;
  far: number;
  /** Perspective only: vertical field of view in degrees. */
  fovDeg?: number;
  /** Viewport aspect ratio (width / height). 1 for the square 768×768 default. */
  aspect?: number;
  /** Orthographic only: symmetric-ish frustum in world units. */
  ortho?: { left: number; right: number; top: number; bottom: number };
}

/**
 * Tile-entity NBT for a block (chest contents, sign text, banner patterns, …).
 * `prismarine-nbt` produces a richly-typed tag tree; we keep it loose here so the
 * renderer doesn't hard-depend on that lib's type surface. Per §5.4.5 / §11, NBT
 * decoration is stubbed as neutral placeholders in the mesher and excluded from
 * vision scoring in v1.
 */
export type BlockEntityNBT = Record<string, unknown>;

/**
 * Region data extracted by the plugin's `captureRegion` (§3.3, §6.2). This is the
 * renderer's input. The layout mirrors the Sponge `.schem` v3 `Blocks` compound and
 * the engine's `BuildModel.voxels` buffer 1:1 (§5.3, §7.3), so loading is near-zero
 * cost: a palette + a dense palette-indexed array.
 *
 * VOXEL INDEXING (load-bearing — must match .schem Data order and the engine buffer):
 *
 *     index = x + z * w + y * (w * l)
 *
 * where w=dims.w (X extent), l=dims.l (Z extent), h=dims.h (Y extent). Use
 * {@link voxelIndex}. Coordinates are LOCAL to the region: (0,0,0)..(w-1,h-1,l-1).
 */
export interface RegionData {
  /** Local extents: w=X, h=Y, l=Z. */
  dims: { w: number; h: number; l: number };
  /** World coordinate of the local (0,0,0) corner (== region.min). */
  origin: Vec3;
  /**
   * Palette: index -> block state string, e.g.
   * "minecraft:oak_stairs[facing=north,half=bottom,shape=straight]".
   * Air ("minecraft:air", "minecraft:cave_air", "minecraft:void_air") is a normal
   * palette entry (usually index 0) that the mesher skips.
   */
  palette: string[];
  /** Palette index per cell; length === w*h*l; indexed by {@link voxelIndex}. */
  voxels: Uint16Array;
  /** Optional tile-entity NBT keyed by voxel index (§5.4.5 caveat: placeholders in v1). */
  blockEntities?: Map<number, BlockEntityNBT>;
  /** Optional biome ids (for tinting grass/foliage/water). Layout is renderer-defined. */
  biomes?: Uint16Array;
  /** MC DataVersion from the .schem, for cross-version asset resolution (§11 #2). */
  dataVersion?: number;
}

/** Compute the flat voxel index for local coords, matching the .schem Data order. */
export function voxelIndex(
  x: number,
  y: number,
  z: number,
  dims: { w: number; h: number; l: number }
): number {
  return x + z * dims.w + y * (dims.w * dims.l);
}

/**
 * What to capture. `region` is the world-space AABB provenance of `data`; `preset`
 * selects the pose set (§6.3); `size` is the square edge length in pixels
 * (default 768 — matches vision-model tiling and keeps base64 small).
 */
export interface CaptureSpec {
  region: Region;
  preset: Preset;
  /** Square output edge in pixels. Default 768 (§6.3). Detail shots use 1024. */
  size?: number;
}

/**
 * The per-image text sidecar payload (§6.4). Emitted alongside each PNG so the
 * vision model has spatial grounding (which angle it is looking from, how big the
 * region is, how much was built). {@link RenderedView.sidecar} carries the
 * structured form; `sidecarFor(view)` in src/index.ts formats it to text.
 */
export interface Sidecar {
  shotName: string;
  cameraType: "perspective" | "orthographic";
  azimuthDeg: number;
  elevationDeg: number;
  regionDims: { w: number; h: number; l: number };
  /** Non-air block count in the region (context for the critic). */
  blockCount: number;
}

/** One rendered view: the PNG plus everything the caller needs to caption it. */
export interface RenderedView {
  name: string;
  pose: ShotPose;
  /** Base64-encoded PNG bytes (no data: URI prefix) — ready for an MCP image block. */
  pngBase64: string;
  sidecar: Sidecar;
}
