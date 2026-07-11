/**
 * The voxel build model (§5.3).
 *
 * Two coupled structures make up a build: the **module graph** (see `module-graph.ts`) is the
 * semantic build — what things *are*, still editable — and the **voxel buffer** below is the
 * rasterized build — what blocks go where, validated before commit.
 *
 * The buffer is dense and palette-indexed and mirrors the Sponge `.schem` v3 layout so
 * serialization is near-free: `voxels` is indexed `x + z*w + y*w*l` (== `.schem` `Data` order,
 * §7.3). Parallel {@link MetaLayers} stamp provenance on every voxel so later passes and the
 * scorer can reason about *who wrote what* — this is the key idea of the whole engine.
 *
 * This file contains REAL implementations of voxel indexing, palette interning, tag interning,
 * and the atomic `set()`; it is not a stub.
 */

// ────────────────────────────────────────────────────────────────────────────────────────────
// Geometry primitives
//
// These mirror the coordinate shapes in `@mcbuild/protocol` (§3.3: integer `{x,y,z}`,
// `region = {min,max,world}`). They are declared locally so the engine is internally coherent
// and testable without Minecraft; the protocol package owns the wire contract.
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned bounding box in world (or model-local) space, `max` inclusive. */
export interface Region {
  min: Vec3;
  max: Vec3;
}

/** Cardinal facing of the build's primary facade / anchor frame. */
export type Facing = "north" | "east" | "south" | "west";

/** Build dimensions in blocks. `w`=x extent, `h`=y extent, `l`=z extent. */
export interface Dims {
  w: number;
  h: number;
  l: number;
}

/**
 * Block-entity NBT payload (chests, signs, banners, item frames, chiseled bookshelves…).
 * Kept structurally open here; serialization to/from `prismarine-nbt` happens at the `.schem`
 * boundary, not in the engine.
 */
export type NBT = Record<string, unknown>;

/** A non-block entity to spawn with the build (armor stands, item frames, paintings…). */
export interface EntitySpec {
  id: string;
  pos: Vec3;
  nbt?: NBT;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Provenance enums
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The semantic layer of a voxel, stored in `MetaLayers.layerTag` (a `Uint8Array`).
 * Exactly the §5.3 set: `foundation | wall | floor | roof | trim | glazing | decor`, plus `NONE`.
 */
export enum VoxelLayer {
  NONE = 0,
  FOUNDATION = 1,
  WALL = 2,
  FLOOR = 3,
  ROOF = 4,
  TRIM = 5,
  GLAZING = 6,
  DECOR = 7,
}

/** Bitflags packed into `MetaLayers.protect` (a `Uint8Array`). */
export enum ProtectFlag {
  NONE = 0,
  /** A pass may not overwrite this voxel (e.g. a hand-locked or human-approved cell). */
  LOCKED = 1 << 0,
  /** This voxel must stay empty — writing a non-air state here is refused. */
  VOID = 1 << 1,
}

/**
 * A pass ordinal (0–255): the position of a pass in the canonical pipeline order. Stored in
 * `MetaLayers.writtenBy` and used by the {@link PassDag} to invalidate transitive dependents on a
 * targeted re-run (§5.2). Kept as a plain number so the model does not depend on the pass list.
 */
export type PassId = number;

/** Sentinel ordinal meaning "no pass has written this voxel". */
export const NO_PASS: PassId = 0xff;

/** Options every `set()` carries so voxel + all meta layers update atomically. */
export interface SetOptions {
  /** Ordinal of the pass performing the write (drives `writtenBy` / DAG invalidation). */
  passId: PassId;
  /** Semantic component this cell belongs to, e.g. `"roof"`, `"wall-3"`. Interned to a Uint16 id. */
  moduleTag?: string;
  /** Room this cell belongs to, e.g. `"kitchen"`, `"exterior"`. Interned to a Uint16 id. */
  roomLabel?: string;
  /** Semantic layer tag for the cell. */
  layerTag?: VoxelLayer;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Meta layers
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Parallel provenance arrays, one entry per voxel, all indexed identically to `voxels`.
 * Every pass stamps provenance so downstream passes, validators, and refine ops can target cells
 * by *who wrote them* / *what they are* rather than by raw coordinate (§5.3).
 */
export interface MetaLayers {
  /** voxel → pass ordinal that wrote it. Drives DAG invalidation on targeted re-runs. */
  writtenBy: Uint8Array;
  /** voxel → interned module-tag id (0 = untagged). Resolve via `BuildModel.moduleTagName`. */
  moduleTag: Uint16Array;
  /** voxel → interned room-label id (0 = untagged). Resolve via `BuildModel.roomLabelName`. */
  roomLabel: Uint16Array;
  /** voxel → {@link VoxelLayer}. */
  layerTag: Uint8Array;
  /** voxel → {@link ProtectFlag} bitfield. */
  protect: Uint8Array;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// BuildModel
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Canonical air block id. Interned to palette index 0 so a zeroed `voxels` array is all-air. */
export const AIR = "minecraft:air";

export interface BuildModelInit {
  dims: Dims;
  origin: Vec3;
  facing: Facing;
}

/**
 * The dense, palette-indexed voxel build with parallel provenance meta layers.
 *
 * Layout mirrors `.schem` v3: `voxels[i]` holds a palette index; `palette[voxels[i]]` is the block
 * state string. `blockEntities` and `entities` carry NBT decoration. `meta` carries provenance.
 */
export class BuildModel {
  readonly dims: Dims;
  readonly origin: Vec3;
  facing: Facing;

  /** Palette index → block state string. `palette[0]` is always {@link AIR}. */
  readonly palette: string[];
  /** Block state string → palette index (inverse of `palette`). */
  readonly paletteIndex: Map<string, number>;

  /** Dense voxel buffer; `voxels[index(x,y,z)]` is a palette index. */
  readonly voxels: Uint16Array;

  /** voxel index → block-entity NBT (chests/signs/…); sparse. */
  readonly blockEntities: Map<number, NBT>;
  /** Entities to spawn with the build; ordered. */
  readonly entities: EntitySpec[];

  readonly meta: MetaLayers;

  /** Set when any voxel changes; cleared by the serializer/committer. */
  dirty: boolean;

  // Tag interning registries. Index 0 is the reserved "untagged" sentinel in both.
  private readonly moduleTags: string[];
  private readonly moduleTagIndex: Map<string, number>;
  private readonly roomLabels: string[];
  private readonly roomLabelIndex: Map<string, number>;

  constructor(init: BuildModelInit) {
    const { dims } = init;
    if (dims.w <= 0 || dims.h <= 0 || dims.l <= 0) {
      throw new Error(`BuildModel: dims must be positive, got ${dims.w}x${dims.h}x${dims.l}`);
    }
    const volume = dims.w * dims.h * dims.l;
    if (!Number.isSafeInteger(volume)) {
      throw new Error(`BuildModel: volume ${volume} exceeds safe integer range`);
    }

    this.dims = { ...dims };
    this.origin = { ...init.origin };
    this.facing = init.facing;

    this.palette = [AIR];
    this.paletteIndex = new Map([[AIR, 0]]);

    this.voxels = new Uint16Array(volume); // 0 == AIR everywhere

    this.blockEntities = new Map();
    this.entities = [];

    this.meta = {
      writtenBy: new Uint8Array(volume).fill(NO_PASS),
      moduleTag: new Uint16Array(volume),
      roomLabel: new Uint16Array(volume),
      layerTag: new Uint8Array(volume), // 0 == VoxelLayer.NONE
      protect: new Uint8Array(volume), // 0 == ProtectFlag.NONE
    };

    this.dirty = false;

    this.moduleTags = [""];
    this.moduleTagIndex = new Map([["", 0]]);
    this.roomLabels = [""];
    this.roomLabelIndex = new Map([["", 0]]);
  }

  // ── Indexing (real) ─────────────────────────────────────────────────────────────────────

  /** Flatten `(x,y,z)` → buffer index. Layout: `x + z*w + y*w*l` (matches `.schem` Data order). */
  index(x: number, y: number, z: number): number {
    return x + z * this.dims.w + y * this.dims.w * this.dims.l;
  }

  /** Inverse of {@link index}: buffer index → `(x,y,z)`. */
  coords(index: number): Vec3 {
    const wl = this.dims.w * this.dims.l;
    const y = Math.floor(index / wl);
    const rem = index - y * wl;
    const z = Math.floor(rem / this.dims.w);
    const x = rem - z * this.dims.w;
    return { x, y, z };
  }

  /** True if `(x,y,z)` is inside the model's dimensions. */
  inBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < this.dims.w &&
      y < this.dims.h &&
      z < this.dims.l
    );
  }

  /** Total number of voxels (== `voxels.length`). */
  get volume(): number {
    return this.voxels.length;
  }

  // ── Palette interning (real) ────────────────────────────────────────────────────────────

  /** Intern a block state string, returning its palette index (assigning a new one if needed). */
  internBlock(state: string): number {
    const existing = this.paletteIndex.get(state);
    if (existing !== undefined) return existing;
    const idx = this.palette.length;
    if (idx > 0xffff) {
      throw new Error(`BuildModel: palette overflow (> 65536 distinct block states)`);
    }
    this.palette.push(state);
    this.paletteIndex.set(state, idx);
    return idx;
  }

  /** Block state string at `(x,y,z)`. Out-of-bounds reads return {@link AIR}. */
  blockAt(x: number, y: number, z: number): string {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.palette[this.voxels[this.index(x, y, z)] as number] as string;
  }

  // ── Tag interning (real) ────────────────────────────────────────────────────────────────

  private internModuleTag(tag: string): number {
    const existing = this.moduleTagIndex.get(tag);
    if (existing !== undefined) return existing;
    const idx = this.moduleTags.length;
    this.moduleTags.push(tag);
    this.moduleTagIndex.set(tag, idx);
    return idx;
  }

  private internRoomLabel(label: string): number {
    const existing = this.roomLabelIndex.get(label);
    if (existing !== undefined) return existing;
    const idx = this.roomLabels.length;
    this.roomLabels.push(label);
    this.roomLabelIndex.set(label, idx);
    return idx;
  }

  /** Resolve an interned module-tag id back to its string (or `""` for untagged). */
  moduleTagName(id: number): string {
    return this.moduleTags[id] ?? "";
  }

  /** Resolve an interned room-label id back to its string (or `""` for untagged). */
  roomLabelName(id: number): string {
    return this.roomLabels[id] ?? "";
  }

  // ── Atomic write (real) ─────────────────────────────────────────────────────────────────

  /**
   * Write a block state at `(x,y,z)` and stamp all meta layers atomically (§5.3).
   *
   * Respects `protect`:
   * - `LOCKED` cells are never overwritten.
   * - `VOID` cells refuse any non-air write.
   *
   * @returns `true` if the write happened, `false` if it was refused by a protect flag or was
   *          out of bounds. (All-or-nothing: no meta layer is touched on a refused write.)
   */
  set(x: number, y: number, z: number, state: string, opts: SetOptions): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);

    const protect = this.meta.protect[i] as number;
    if (protect & ProtectFlag.LOCKED) return false;
    const isAir = state === AIR;
    if (protect & ProtectFlag.VOID && !isAir) return false;

    this.voxels[i] = this.internBlock(state);
    this.meta.writtenBy[i] = opts.passId & 0xff;
    if (opts.moduleTag !== undefined) {
      this.meta.moduleTag[i] = this.internModuleTag(opts.moduleTag);
    }
    if (opts.roomLabel !== undefined) {
      this.meta.roomLabel[i] = this.internRoomLabel(opts.roomLabel);
    }
    if (opts.layerTag !== undefined) {
      this.meta.layerTag[i] = opts.layerTag;
    }
    // A cell set to air drops any block-entity NBT it carried.
    if (isAir) this.blockEntities.delete(i);

    this.dirty = true;
    return true;
  }

  /**
   * Reset a cell to air and wipe its provenance (used by DAG invalidation on a targeted re-run,
   * §5.2). Respects `LOCKED` (a locked cell is left untouched). Returns whether it was cleared.
   */
  clear(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    if ((this.meta.protect[i] as number) & ProtectFlag.LOCKED) return false;
    this.voxels[i] = 0; // AIR
    this.meta.writtenBy[i] = NO_PASS;
    this.meta.moduleTag[i] = 0;
    this.meta.roomLabel[i] = 0;
    this.meta.layerTag[i] = VoxelLayer.NONE;
    this.blockEntities.delete(i);
    this.dirty = true;
    return true;
  }

  /** Attach block-entity NBT to a cell (chest contents, sign text…). No-op if out of bounds. */
  setBlockEntity(x: number, y: number, z: number, nbt: NBT): void {
    if (!this.inBounds(x, y, z)) return;
    this.blockEntities.set(this.index(x, y, z), nbt);
  }

  /** Set / clear protect flags on a cell (OR-in the given flags). */
  protectCell(x: number, y: number, z: number, flags: ProtectFlag): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.index(x, y, z);
    this.meta.protect[i] = (this.meta.protect[i] as number) | flags;
  }

  // ── Iteration helpers ───────────────────────────────────────────────────────────────────

  /**
   * Visit every cell whose `(x,y,z)` lies within `region` (clamped to bounds). Used by targeted
   * re-runs and validators that operate on a sub-box.
   */
  forEachInRegion(region: Region, cb: (x: number, y: number, z: number, i: number) => void): void {
    const x0 = Math.max(0, region.min.x);
    const y0 = Math.max(0, region.min.y);
    const z0 = Math.max(0, region.min.z);
    const x1 = Math.min(this.dims.w - 1, region.max.x);
    const y1 = Math.min(this.dims.h - 1, region.max.y);
    const z1 = Math.min(this.dims.l - 1, region.max.z);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          cb(x, y, z, this.index(x, y, z));
        }
      }
    }
  }
}
