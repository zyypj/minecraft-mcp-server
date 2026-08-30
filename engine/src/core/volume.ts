/**
 * The voxel buffer every part of the engine reads and writes.
 *
 * ## Packed blocks
 *
 * Minecraft 1.8 addresses a block as `(id, data)` where `id` is 12-bit (0-4095, the legacy
 * `Blocks` byte plus the `AddBlocks` nibble) and `data` is 4-bit (0-15). We store the pair packed
 * into one 16-bit cell as `(id << 4) | data`, which fits a `Uint16Array` exactly. One array instead
 * of two means a cell is a plain number: comparisons, histograms, `Map` keys and hashing are all
 * cheap, and there is no way for the two halves to drift apart.
 *
 * ## Layout
 *
 * `index = (y * length + z) * width + x` — byte-for-byte the MCEdit `.schematic` layout, so export
 * is a split of one array rather than a transpose.
 */

import { type Region, type Vec3, contains, region, regionFromSize, vec, ZERO } from "./vec.js";

/** A block packed as `(id << 4) | data`. `0` is air. */
export type PackedBlock = number;

export const AIR: PackedBlock = 0;

export const pack = (id: number, data = 0): PackedBlock => ((id & 0xfff) << 4) | (data & 0xf);
export const blockId = (b: PackedBlock): number => (b >> 4) & 0xfff;
export const blockData = (b: PackedBlock): number => b & 0xf;
export const isAir = (b: PackedBlock): boolean => b === AIR;

/**
 * A source of blocks for a fill. Either a constant, or a function of position — which is how
 * gradients, noise-driven material mixes and weighted palettes all plug into the same fill call.
 */
export type BlockSource = PackedBlock | ((p: Vec3, vol: Volume) => PackedBlock);

/** Restricts where an operation may write. `undefined` means "anywhere". */
export type Mask = (p: Vec3, current: PackedBlock, vol: Volume) => boolean;

export const resolveSource = (src: BlockSource, p: Vec3, vol: Volume): PackedBlock =>
  typeof src === "number" ? src : src(p, vol);

/** One overwritten cell, kept so an edit can be inverted exactly. */
export interface CellChange {
  readonly index: number;
  readonly before: PackedBlock;
}

/**
 * Records the previous value of every cell an operation overwrote, so the operation can be undone
 * without snapshotting the whole volume. The first write to a given cell wins: re-writing a cell
 * inside the same journal must not clobber the original "before" value.
 */
export class ChangeJournal {
  private readonly seen = new Set<number>();
  private readonly changes: CellChange[] = [];

  record(index: number, before: PackedBlock): void {
    if (this.seen.has(index)) return;
    this.seen.add(index);
    this.changes.push({ index, before });
  }

  get size(): number {
    return this.changes.length;
  }

  entries(): readonly CellChange[] {
    return this.changes;
  }
}

export interface VolumeInit {
  readonly size: Vec3;
  /** Where this volume's `(0,0,0)` sits in world space. Used only at paste/export time. */
  readonly origin?: Vec3;
}

export class Volume {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly origin: Vec3;
  readonly cells: Uint16Array;

  /**
   * Active recorders, outermost first. Managed by `withJournal`.
   *
   * A stack rather than a single slot because the build graph nests: a map records the whole
   * generation, a team island records its own subtree, and a roof records just itself, all at once.
   * Each journal keeps its own "first write wins" set, so every level's inverse patch is correct
   * for its own scope.
   */
  private journals: ChangeJournal[] = [];

  constructor(init: VolumeInit) {
    const { size } = init;
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
      throw new RangeError(
        `Volume size must be positive on every axis, got ${size.x}x${size.y}x${size.z}`,
      );
    }
    // 1.8 worlds are 256 tall; a schematic wider than a few thousand blocks is a mistake, not a map.
    const total = size.x * size.y * size.z;
    if (total > 200_000_000) {
      throw new RangeError(`Volume of ${total} cells is too large (limit 200M)`);
    }
    this.width = size.x;
    this.height = size.y;
    this.length = size.z;
    this.origin = init.origin ?? ZERO;
    this.cells = new Uint16Array(total);
  }

  static of(width: number, height: number, length: number, origin?: Vec3): Volume {
    return new Volume({ size: vec(width, height, length), origin });
  }

  get size(): Vec3 {
    return vec(this.width, this.height, this.length);
  }

  /** The full extent of this volume in local coordinates. */
  get bounds(): Region {
    return regionFromSize(ZERO, this.size);
  }

  get cellCount(): number {
    return this.cells.length;
  }

  index(x: number, y: number, z: number): number {
    return (y * this.length + z) * this.width + x;
  }

  /** Inverse of {@link index} — used by the undo journal, which stores flat indices. */
  positionOf(index: number): Vec3 {
    const x = index % this.width;
    const rest = (index - x) / this.width;
    const z = rest % this.length;
    const y = (rest - z) / this.length;
    return vec(x, y, z);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.height && z < this.length;
  }

  containsPoint(p: Vec3): boolean {
    return this.inBounds(p.x, p.y, p.z);
  }

  /** Out-of-bounds reads return {@link AIR}, so neighbourhood scans need no edge special-casing. */
  get(x: number, y: number, z: number): PackedBlock {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.cells[this.index(x, y, z)]!;
  }

  getAt(p: Vec3): PackedBlock {
    return this.get(p.x, p.y, p.z);
  }

  /** Out-of-bounds writes are dropped. Returns whether the cell actually changed. */
  set(x: number, y: number, z: number, block: PackedBlock): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    const before = this.cells[i]!;
    if (before === block) return false;
    for (let j = 0; j < this.journals.length; j++) this.journals[j]!.record(i, before);
    this.cells[i] = block;
    return true;
  }

  setAt(p: Vec3, block: PackedBlock): boolean {
    return this.set(p.x, p.y, p.z, block);
  }

  // -- Journaling ------------------------------------------------------------------------------

  /**
   * Run `fn` with every overwrite recorded, and return the journal.
   *
   * Nesting is supported and expected: an inner scope's journal undoes only its own writes, while
   * every enclosing journal still sees them.
   */
  withJournal<T>(fn: () => T): { result: T; journal: ChangeJournal } {
    const journal = new ChangeJournal();
    this.journals.push(journal);
    try {
      return { result: fn(), journal };
    } finally {
      const index = this.journals.lastIndexOf(journal);
      if (index >= 0) this.journals.splice(index, 1);
    }
  }

  /** True while at least one journal is recording. */
  get isRecording(): boolean {
    return this.journals.length > 0;
  }

  /**
   * Restore every cell a journal recorded, returning a journal that redoes the change.
   *
   * Reverting writes directly rather than through `set`, so an undo is not itself recorded by an
   * enclosing journal — history is managed by the caller, not accumulated by accident.
   */
  revert(journal: ChangeJournal): ChangeJournal {
    const inverse = new ChangeJournal();
    for (const { index, before } of journal.entries()) {
      inverse.record(index, this.cells[index]!);
      this.cells[index] = before;
    }
    return inverse;
  }

  // -- Bulk operations -------------------------------------------------------------------------

  /** Fill a region, clipped to bounds. Returns the number of cells changed. */
  fill(r: Region, src: BlockSource, mask?: Mask): number {
    const box = clipToVolume(r, this);
    if (!box) return 0;
    let changed = 0;
    const constant = typeof src === "number" ? src : null;
    for (let y = box.min.y; y <= box.max.y; y++) {
      for (let z = box.min.z; z <= box.max.z; z++) {
        for (let x = box.min.x; x <= box.max.x; x++) {
          const p = vec(x, y, z);
          if (mask && !mask(p, this.get(x, y, z), this)) continue;
          const block = constant ?? (src as (q: Vec3, v: Volume) => PackedBlock)(p, this);
          if (this.set(x, y, z, block)) changed++;
        }
      }
    }
    return changed;
  }

  /** Write a single point through the same mask/source machinery as {@link fill}. */
  plot(p: Vec3, src: BlockSource, mask?: Mask): boolean {
    if (!this.containsPoint(p)) return false;
    if (mask && !mask(p, this.getAt(p), this)) return false;
    return this.setAt(p, resolveSource(src, p, this));
  }

  clear(r?: Region): number {
    return this.fill(r ?? this.bounds, AIR);
  }

  clone(): Volume {
    const copy = new Volume({ size: this.size, origin: this.origin });
    copy.cells.set(this.cells);
    return copy;
  }

  /** Extract a sub-region as a new volume. The result's origin is the sub-region's min corner. */
  crop(r: Region): Volume {
    const clipped = clipToVolume(r, this);
    if (!clipped) throw new RangeError("crop region does not overlap the volume");
    const w = clipped.max.x - clipped.min.x + 1;
    const h = clipped.max.y - clipped.min.y + 1;
    const l = clipped.max.z - clipped.min.z + 1;
    const out = Volume.of(w, h, l, clipped.min);
    for (let y = 0; y < h; y++)
      for (let z = 0; z < l; z++)
        for (let x = 0; x < w; x++)
          out.cells[out.index(x, y, z)] = this.get(
            clipped.min.x + x,
            clipped.min.y + y,
            clipped.min.z + z,
          );
    return out;
  }

  /** Stamp another volume into this one at `at`. `ignoreAir` is the WorldEdit `-a` paste flag. */
  blit(other: Volume, at: Vec3, opts: { ignoreAir?: boolean; mask?: Mask } = {}): number {
    const { ignoreAir = false, mask } = opts;
    let changed = 0;
    for (let y = 0; y < other.height; y++) {
      for (let z = 0; z < other.length; z++) {
        for (let x = 0; x < other.width; x++) {
          const block = other.cells[other.index(x, y, z)]!;
          if (ignoreAir && block === AIR) continue;
          const tx = at.x + x;
          const ty = at.y + y;
          const tz = at.z + z;
          if (!this.inBounds(tx, ty, tz)) continue;
          const p = vec(tx, ty, tz);
          if (mask && !mask(p, this.get(tx, ty, tz), this)) continue;
          if (this.set(tx, ty, tz, block)) changed++;
        }
      }
    }
    return changed;
  }

  // -- Queries ---------------------------------------------------------------------------------

  countNonAir(r?: Region): number {
    if (!r) {
      let n = 0;
      for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== AIR) n++;
      return n;
    }
    let n = 0;
    for (const p of this.iterate(r)) if (this.getAt(p) !== AIR) n++;
    return n;
  }

  /** Counts of every distinct packed block present, air excluded unless `includeAir`. */
  histogram(r?: Region, includeAir = false): Map<PackedBlock, number> {
    const out = new Map<PackedBlock, number>();
    const bump = (b: PackedBlock) => {
      if (!includeAir && b === AIR) return;
      out.set(b, (out.get(b) ?? 0) + 1);
    };
    if (!r) for (let i = 0; i < this.cells.length; i++) bump(this.cells[i]!);
    else for (const p of this.iterate(r)) bump(this.getAt(p));
    return out;
  }

  /** The tightest region containing every non-air cell, or `null` for an empty volume. */
  occupiedBounds(): Region | null {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let y = 0; y < this.height; y++)
      for (let z = 0; z < this.length; z++)
        for (let x = 0; x < this.width; x++)
          if (this.cells[this.index(x, y, z)] !== AIR) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
    if (minX === Infinity) return null;
    return region(vec(minX, minY, minZ), vec(maxX, maxY, maxZ));
  }

  /** Highest non-air Y at a column, or `-1` if the column is empty. */
  topSolidY(x: number, z: number): number {
    for (let y = this.height - 1; y >= 0; y--) if (this.get(x, y, z) !== AIR) return y;
    return -1;
  }

  /** Lowest non-air Y at a column, or `-1` if the column is empty. */
  bottomSolidY(x: number, z: number): number {
    for (let y = 0; y < this.height; y++) if (this.get(x, y, z) !== AIR) return y;
    return -1;
  }

  /** A `width x length` grid of {@link topSolidY}. The basis for terrain and silhouette analysis. */
  heightmap(): Int32Array {
    const out = new Int32Array(this.width * this.length);
    for (let z = 0; z < this.length; z++)
      for (let x = 0; x < this.width; x++) out[z * this.width + x] = this.topSolidY(x, z);
    return out;
  }

  *iterate(r?: Region): Generator<Vec3> {
    const box = r ? clipToVolume(r, this) : this.bounds;
    if (!box) return;
    for (let y = box.min.y; y <= box.max.y; y++)
      for (let z = box.min.z; z <= box.max.z; z++)
        for (let x = box.min.x; x <= box.max.x; x++) yield vec(x, y, z);
  }

  /** Iterate only non-air cells. Avoids allocating a `Vec3` for empty space in large volumes. */
  *iterateSolid(r?: Region): Generator<{ pos: Vec3; block: PackedBlock }> {
    for (const p of this.iterate(r)) {
      const block = this.getAt(p);
      if (block !== AIR) yield { pos: p, block };
    }
  }
}

/** Clamp a (possibly fractional, possibly out-of-range) region to integer cells inside `vol`. */
export function clipToVolume(r: Region, vol: Volume): Region | null {
  const min = vec(
    Math.max(0, Math.ceil(r.min.x)),
    Math.max(0, Math.ceil(r.min.y)),
    Math.max(0, Math.ceil(r.min.z)),
  );
  const max = vec(
    Math.min(vol.width - 1, Math.floor(r.max.x)),
    Math.min(vol.height - 1, Math.floor(r.max.y)),
    Math.min(vol.length - 1, Math.floor(r.max.z)),
  );
  if (min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

/** Convenience mask builder so callers do not have to import `contains` separately. */
export const insideRegion =
  (r: Region): Mask =>
  (p) =>
    contains(r, p);
