/**
 * Legacy `.schematic` (MCEdit) read/write, plus best-effort ingestion of Sponge `.schem`.
 *
 * **The output format is always MCEdit legacy**, because that is what 1.8-era WorldEdit
 * (`//schem load`) reads, and shipping a map to a 1.8 server is the whole point. MCEdit stores a
 * flat `Blocks` byte array of numeric ids and a parallel `Data` nibble array — exactly the packed
 * cell layout {@link Volume} already uses, so export is a split, not a conversion.
 *
 * Input is more forgiving. Reference maps arrive from wherever the builder got them, so the reader
 * also accepts Sponge `.schem` v2/v3 and maps its modern block names back onto 1.8 through the
 * {@link MaterialResolver} in substitute mode, reporting what it had to approximate.
 */

import { Volume, blockData, blockId, pack } from "../core/volume.js";
import { type Vec3, vec } from "../core/vec.js";
import { MaterialResolver } from "../mc18/material.js";
import {
  type NbtCompoundValue,
  type NbtTag,
  getByteArray,
  getByteArrayOr,
  getCompound,
  getList,
  getNumber,
  getNumberOr,
  getString,
  nbt,
  parseNbt,
  writeNbt,
} from "./nbt.js";

/** A block entity (chest, sign, spawner) with its position inside the schematic. */
export interface SchematicBlockEntity {
  readonly pos: Vec3;
  /** The raw NBT compound, preserved verbatim so nothing is lost on round-trip. */
  readonly nbt: NbtCompoundValue;
}

export interface SchematicReadResult {
  readonly volume: Volume;
  readonly blockEntities: readonly SchematicBlockEntity[];
  readonly entities: readonly NbtCompoundValue[];
  /** WorldEdit paste offset (`WEOffset*`), relative to the schematic's own origin. */
  readonly offset: Vec3;
  readonly sourceFormat: "mcedit" | "sponge2" | "sponge3";
  /** Post-1.8 blocks that had to be approximated when reading a Sponge file. */
  readonly substitutions: readonly { from: string; to: string; count: number }[];
}

export interface SchematicWriteOptions {
  /** WorldEdit paste offset written as `WEOffsetX/Y/Z`. Defaults to `(0,0,0)`. */
  readonly offset?: Vec3;
  readonly blockEntities?: readonly SchematicBlockEntity[];
  readonly entities?: readonly NbtCompoundValue[];
  /** Extra metadata written alongside the standard tags. Ignored by WorldEdit, read by us. */
  readonly metadata?: NbtCompoundValue;
  /** Set false to emit uncompressed NBT (useful in tests). Real `.schematic` files are gzipped. */
  readonly compress?: boolean;
}

const MAX_SCHEMATIC_AXIS = 4096;

/** Parse any supported schematic buffer into a {@link Volume}. */
export function readSchematic(data: Buffer | Uint8Array): SchematicReadResult {
  const doc = parseNbt(data);
  let root = doc.root;

  // Sponge v3 nests everything under a "Schematic" compound.
  const nested = getCompound(root, "Schematic");
  if (nested && nested["Version"]) root = nested;

  const version = root["Version"] ? getNumber(root, "Version") : null;
  if (version === 2) return readSponge(root, "sponge2");
  if (version === 3) return readSponge(root, "sponge3");
  if (root["Blocks"] && root["Data"]) return readMcEdit(root);
  if (root["BlockData"] && root["Palette"]) return readSponge(root, version === 3 ? "sponge3" : "sponge2");

  throw new Error(
    "Unrecognised schematic: expected MCEdit (Blocks/Data) or Sponge (Palette/BlockData) tags",
  );
}

function readDimensions(root: NbtCompoundValue): { w: number; h: number; l: number } {
  const w = getNumber(root, "Width");
  const h = getNumber(root, "Height");
  const l = getNumber(root, "Length");
  for (const [axis, n] of [
    ["Width", w],
    ["Height", h],
    ["Length", l],
  ] as const) {
    if (!Number.isInteger(n) || n <= 0 || n > MAX_SCHEMATIC_AXIS) {
      throw new Error(`Schematic ${axis} of ${n} is out of range (1-${MAX_SCHEMATIC_AXIS})`);
    }
  }
  return { w, h, l };
}

function readMcEdit(root: NbtCompoundValue): SchematicReadResult {
  const { w, h, l } = readDimensions(root);
  const blocks = getByteArray(root, "Blocks");
  const data = getByteArray(root, "Data");
  const add = getByteArrayOr(root, "AddBlocks") ?? getByteArrayOr(root, "Add");
  const expected = w * h * l;
  if (blocks.length !== expected) {
    throw new Error(`Schematic Blocks array is ${blocks.length}, expected ${expected} (${w}x${h}x${l})`);
  }
  if (data.length !== expected) {
    throw new Error(`Schematic Data array is ${data.length}, expected ${expected}`);
  }

  const volume = Volume.of(w, h, l);
  for (let i = 0; i < expected; i++) {
    let id = blocks[i]! & 0xff;
    if (add) {
      // Nibble-packed high bits, WorldEdit's convention: even index -> low nibble.
      const byte = add[i >> 1] ?? 0;
      const high = (i & 1) === 0 ? byte & 0x0f : (byte & 0xf0) >> 4;
      id |= high << 8;
    }
    volume.cells[i] = pack(id, data[i]! & 0x0f);
  }

  return {
    volume,
    blockEntities: readTileEntities(getList(root, "TileEntities")),
    entities: getList(root, "Entities")
      .filter((t): t is Extract<NbtTag, { type: "compound" }> => t.type === "compound")
      .map((t) => t.value),
    offset: vec(
      getNumberOr(root, "WEOffsetX", 0),
      getNumberOr(root, "WEOffsetY", 0),
      getNumberOr(root, "WEOffsetZ", 0),
    ),
    sourceFormat: "mcedit",
    substitutions: [],
  };
}

function readTileEntities(list: readonly NbtTag[]): SchematicBlockEntity[] {
  const out: SchematicBlockEntity[] = [];
  for (const tag of list) {
    if (tag.type !== "compound") continue;
    const c = tag.value;
    // MCEdit uses x/y/z ints; Sponge uses a Pos int array. Accept either.
    const posTag = c["Pos"];
    if (posTag?.type === "intArray" && posTag.value.length >= 3) {
      out.push({ pos: vec(posTag.value[0]!, posTag.value[1]!, posTag.value[2]!), nbt: c });
      continue;
    }
    if (c["x"] && c["y"] && c["z"]) {
      out.push({ pos: vec(getNumber(c, "x"), getNumber(c, "y"), getNumber(c, "z")), nbt: c });
    }
  }
  return out;
}

function readSponge(root: NbtCompoundValue, format: "sponge2" | "sponge3"): SchematicReadResult {
  const { w, h, l } = readDimensions(root);
  const blocksContainer = format === "sponge3" ? (getCompound(root, "Blocks") ?? root) : root;
  const paletteTag =
    getCompound(blocksContainer, "Palette") ?? getCompound(root, "Palette") ?? undefined;
  if (!paletteTag) throw new Error("Sponge schematic is missing its Palette");
  const blockData =
    getByteArrayOr(blocksContainer, "Data") ?? getByteArrayOr(root, "BlockData");
  if (!blockData) throw new Error("Sponge schematic is missing its BlockData");

  const resolver = new MaterialResolver({ mode: "substitute" });
  const failed = new Map<string, number>();

  // Palette maps a modern block-state string to the index used in BlockData.
  const indexToBlock: number[] = [];
  for (const [stateString, tag] of Object.entries(paletteTag)) {
    if (tag.type !== "int" && tag.type !== "short" && tag.type !== "byte") continue;
    const index = tag.value;
    // `minecraft:oak_stairs[facing=north,half=bottom]` -> `oak_stairs`. Properties are dropped:
    // 1.8 encodes orientation in the data nibble and there is no general mapping back.
    const base = stateString.replace(/\[.*$/, "");
    const resolved = resolver.resolve(base);
    if (resolved.ok) {
      indexToBlock[index] = resolved.block;
    } else {
      indexToBlock[index] = 0;
      failed.set(base, (failed.get(base) ?? 0) + 1);
    }
  }

  const volume = Volume.of(w, h, l);
  let cursor = 0;
  for (let i = 0; i < w * h * l; i++) {
    // Varint-encoded palette index, little-endian 7-bit groups.
    let value = 0;
    let shift = 0;
    for (;;) {
      if (cursor >= blockData.length) {
        throw new Error(`Sponge BlockData ended early at cell ${i} of ${w * h * l}`);
      }
      const byte = blockData[cursor++]! & 0xff;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("Sponge BlockData contains a malformed varint");
    }
    volume.cells[i] = indexToBlock[value] ?? 0;
  }

  const offsetTag = root["Offset"];
  const offset =
    offsetTag?.type === "intArray" && offsetTag.value.length >= 3
      ? vec(offsetTag.value[0]!, offsetTag.value[1]!, offsetTag.value[2]!)
      : vec(0, 0, 0);

  const substitutions = [
    ...resolver.substitutions(),
    ...[...failed.entries()].map(([from, count]) => ({ from, to: "air", count })),
  ];

  return {
    volume,
    blockEntities: readTileEntities(
      getList(blocksContainer, "BlockEntities").length
        ? getList(blocksContainer, "BlockEntities")
        : getList(root, "BlockEntities"),
    ),
    entities: [],
    offset,
    sourceFormat: format,
    substitutions,
  };
}

/**
 * Serialize a volume as a 1.8-compatible MCEdit `.schematic`.
 *
 * `AddBlocks` is only emitted when some block id exceeds 255. Vanilla 1.8 never needs it, so a map
 * generated by this engine produces a file byte-identical to what 1.8 WorldEdit would have saved.
 */
export function writeSchematic(volume: Volume, opts: SchematicWriteOptions = {}): Buffer {
  const { width: w, height: h, length: l } = volume;
  const total = w * h * l;
  if (w > MAX_SCHEMATIC_AXIS || h > MAX_SCHEMATIC_AXIS || l > MAX_SCHEMATIC_AXIS) {
    throw new RangeError(`Schematic dimensions ${w}x${h}x${l} exceed ${MAX_SCHEMATIC_AXIS} per axis`);
  }

  const blocks = new Int8Array(total);
  const data = new Int8Array(total);
  let addNibbles: Int8Array | null = null;

  for (let i = 0; i < total; i++) {
    const cell = volume.cells[i]!;
    const id = blockId(cell);
    // Int8Array stores the low byte; values >127 wrap to negative, which is exactly what the
    // format expects (Java `byte`), and the reader masks with 0xff on the way back in.
    blocks[i] = (id & 0xff) << 24 >> 24;
    data[i] = blockData(cell);
    if (id > 0xff) {
      addNibbles ??= new Int8Array(Math.ceil(total / 2));
      const high = (id >> 8) & 0x0f;
      const byteIndex = i >> 1;
      const current = addNibbles[byteIndex]! & 0xff;
      const merged = (i & 1) === 0 ? (current & 0xf0) | high : (current & 0x0f) | (high << 4);
      addNibbles[byteIndex] = (merged << 24) >> 24;
    }
  }

  const offset = opts.offset ?? vec(0, 0, 0);
  const root: NbtCompoundValue = {
    Width: nbt.short(w),
    Height: nbt.short(h),
    Length: nbt.short(l),
    Materials: nbt.string("Alpha"),
    Blocks: nbt.byteArray(blocks),
    Data: nbt.byteArray(data),
    Entities: nbt.list(
      "compound",
      (opts.entities ?? []).map((e) => nbt.compound(e)),
    ),
    TileEntities: nbt.list(
      "compound",
      (opts.blockEntities ?? []).map((be) => nbt.compound(be.nbt)),
    ),
    WEOffsetX: nbt.int(offset.x),
    WEOffsetY: nbt.int(offset.y),
    WEOffsetZ: nbt.int(offset.z),
    WEOriginX: nbt.int(0),
    WEOriginY: nbt.int(0),
    WEOriginZ: nbt.int(0),
  };
  if (addNibbles) root["AddBlocks"] = nbt.byteArray(addNibbles);
  if (opts.metadata) root["Metadata"] = nbt.compound(opts.metadata);

  return writeNbt({ name: "Schematic", root }, { compress: opts.compress ?? true });
}

/**
 * Build the `TileEntities` position fields MCEdit expects. Block entities carried in from a Sponge
 * file use `Pos`, which 1.8 WorldEdit does not understand.
 */
export function normalizeBlockEntity(be: SchematicBlockEntity): SchematicBlockEntity {
  const copy: NbtCompoundValue = { ...be.nbt };
  delete copy["Pos"];
  copy["x"] = nbt.int(be.pos.x);
  copy["y"] = nbt.int(be.pos.y);
  copy["z"] = nbt.int(be.pos.z);
  const id = getString(copy, "Id");
  if (id && !copy["id"]) copy["id"] = nbt.string(id);
  return { pos: be.pos, nbt: copy };
}
