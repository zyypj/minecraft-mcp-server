/**
 * A self-contained NBT reader/writer.
 *
 * The engine needs NBT for exactly one thing — the legacy MCEdit `.schematic` format that 1.8-era
 * WorldEdit reads and writes — and that format is small: big-endian, gzip-wrapped, a dozen tag
 * types. Implementing it here rather than pulling a dependency keeps the whole schematic path free
 * of native modules and version drift, and lets the writer guarantee byte-stable output, which is
 * what makes "the same seed produces the same file" checkable.
 *
 * Strings use Java's modified UTF-8. For the ASCII tag names and block ids a schematic actually
 * contains this is identical to standard UTF-8; the encoder handles the supplementary-plane and
 * embedded-NUL cases correctly anyway so a hand-edited file with unusual sign text round-trips.
 */

import { gunzipSync, gzipSync } from "node:zlib";

export type NbtType =
  | "end"
  | "byte"
  | "short"
  | "int"
  | "long"
  | "float"
  | "double"
  | "byteArray"
  | "string"
  | "list"
  | "compound"
  | "intArray"
  | "longArray";

const TYPE_BY_ID: readonly NbtType[] = [
  "end",
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "byteArray",
  "string",
  "list",
  "compound",
  "intArray",
  "longArray",
];

const ID_BY_TYPE: Readonly<Record<NbtType, number>> = Object.freeze(
  Object.fromEntries(TYPE_BY_ID.map((t, i) => [t, i])) as Record<NbtType, number>,
);

export type NbtCompoundValue = Record<string, NbtTag>;

export type NbtTag =
  | { readonly type: "byte"; readonly value: number }
  | { readonly type: "short"; readonly value: number }
  | { readonly type: "int"; readonly value: number }
  | { readonly type: "long"; readonly value: bigint }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "double"; readonly value: number }
  | { readonly type: "byteArray"; readonly value: Int8Array }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "list"; readonly elementType: NbtType; readonly value: readonly NbtTag[] }
  | { readonly type: "compound"; readonly value: NbtCompoundValue }
  | { readonly type: "intArray"; readonly value: Int32Array }
  | { readonly type: "longArray"; readonly value: BigInt64Array };

/** A whole NBT document: a single named root compound. */
export interface NbtDocument {
  readonly name: string;
  readonly root: NbtCompoundValue;
}

// -- Construction helpers ------------------------------------------------------------------------

export const nbt = {
  byte: (value: number): NbtTag => ({ type: "byte", value: value | 0 }),
  short: (value: number): NbtTag => ({ type: "short", value: value | 0 }),
  int: (value: number): NbtTag => ({ type: "int", value: value | 0 }),
  long: (value: bigint | number): NbtTag => ({ type: "long", value: BigInt(value) }),
  float: (value: number): NbtTag => ({ type: "float", value }),
  double: (value: number): NbtTag => ({ type: "double", value }),
  byteArray: (value: Int8Array | Uint8Array): NbtTag => ({
    type: "byteArray",
    value: value instanceof Int8Array ? value : new Int8Array(value.buffer.slice(0)),
  }),
  string: (value: string): NbtTag => ({ type: "string", value }),
  list: (elementType: NbtType, value: readonly NbtTag[]): NbtTag => ({
    type: "list",
    elementType,
    value,
  }),
  compound: (value: NbtCompoundValue): NbtTag => ({ type: "compound", value }),
  intArray: (value: Int32Array): NbtTag => ({ type: "intArray", value }),
  longArray: (value: BigInt64Array): NbtTag => ({ type: "longArray", value }),
} as const;

// -- Reading -------------------------------------------------------------------------------------

class NbtReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  private need(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new Error(
        `NBT truncated: needed ${bytes} bytes at offset ${this.offset}, buffer is ${this.buf.length}`,
      );
    }
  }

  readByte(): number {
    this.need(1);
    return this.buf.readInt8(this.offset++);
  }

  readUByte(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  readShort(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readUShort(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readLong(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  readFloat(): number {
    this.need(4);
    const v = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return v;
  }

  readDouble(): number {
    this.need(8);
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  readString(): string {
    const len = this.readUShort();
    this.need(len);
    const slice = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return decodeModifiedUtf8(slice);
  }

  readPayload(type: NbtType): NbtTag {
    switch (type) {
      case "byte":
        return { type, value: this.readByte() };
      case "short":
        return { type, value: this.readShort() };
      case "int":
        return { type, value: this.readInt() };
      case "long":
        return { type, value: this.readLong() };
      case "float":
        return { type, value: this.readFloat() };
      case "double":
        return { type, value: this.readDouble() };
      case "byteArray": {
        const len = this.readInt();
        if (len < 0) throw new Error(`NBT byte array has negative length ${len}`);
        this.need(len);
        // Copy: the decompressed buffer may be reused, and callers keep these arrays.
        const out = new Int8Array(len);
        for (let i = 0; i < len; i++) out[i] = this.buf.readInt8(this.offset + i);
        this.offset += len;
        return { type, value: out };
      }
      case "string":
        return { type, value: this.readString() };
      case "list": {
        const elementTypeId = this.readUByte();
        const elementType = TYPE_BY_ID[elementTypeId];
        if (!elementType) throw new Error(`NBT list has unknown element type ${elementTypeId}`);
        const len = this.readInt();
        const items: NbtTag[] = [];
        if (elementType !== "end") {
          for (let i = 0; i < len; i++) items.push(this.readPayload(elementType));
        }
        return { type, elementType, value: items };
      }
      case "compound": {
        const value: NbtCompoundValue = {};
        for (;;) {
          const tagId = this.readUByte();
          if (tagId === 0) break;
          const tagType = TYPE_BY_ID[tagId];
          if (!tagType) throw new Error(`NBT compound has unknown tag type ${tagId}`);
          const name = this.readString();
          value[name] = this.readPayload(tagType);
        }
        return { type, value };
      }
      case "intArray": {
        const len = this.readInt();
        this.need(len * 4);
        const out = new Int32Array(len);
        for (let i = 0; i < len; i++) out[i] = this.buf.readInt32BE(this.offset + i * 4);
        this.offset += len * 4;
        return { type, value: out };
      }
      case "longArray": {
        const len = this.readInt();
        this.need(len * 8);
        const out = new BigInt64Array(len);
        for (let i = 0; i < len; i++) out[i] = this.buf.readBigInt64BE(this.offset + i * 8);
        this.offset += len * 8;
        return { type, value: out };
      }
      case "end":
        throw new Error("NBT: cannot read an END payload");
    }
  }
}

/** True when the buffer starts with the gzip magic number. */
function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Parse an NBT document, transparently gunzipping a compressed one. */
export function parseNbt(data: Buffer | Uint8Array): NbtDocument {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (isGzip(buf)) buf = gunzipSync(buf);
  const reader = new NbtReader(buf);
  const rootTypeId = reader.readUByte();
  if (rootTypeId !== ID_BY_TYPE.compound) {
    throw new Error(`NBT root must be a compound, got tag type ${rootTypeId}`);
  }
  const name = reader.readString();
  const root = reader.readPayload("compound");
  if (root.type !== "compound") throw new Error("NBT root payload was not a compound");
  return { name, root: root.value };
}

// -- Writing -------------------------------------------------------------------------------------

class NbtWriter {
  private chunks: Buffer[] = [];
  private scratch = Buffer.alloc(8);

  private push(buf: Buffer): void {
    this.chunks.push(buf);
  }

  writeUByte(v: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    this.push(b);
  }

  writeByte(v: number): void {
    const b = Buffer.alloc(1);
    b.writeInt8(((v | 0) << 24) >> 24, 0);
    this.push(b);
  }

  writeShort(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(((v | 0) << 16) >> 16, 0);
    this.push(b);
  }

  writeUShort(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff, 0);
    this.push(b);
  }

  writeInt(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v | 0, 0);
    this.push(b);
  }

  writeLong(v: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(v, 0);
    this.push(b);
  }

  writeFloat(v: number): void {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v, 0);
    this.push(b);
  }

  writeDouble(v: number): void {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    this.push(b);
  }

  writeString(s: string): void {
    const encoded = encodeModifiedUtf8(s);
    if (encoded.length > 0xffff) throw new Error(`NBT string too long: ${encoded.length} bytes`);
    this.writeUShort(encoded.length);
    this.push(encoded);
  }

  writePayload(tag: NbtTag): void {
    switch (tag.type) {
      case "byte":
        return this.writeByte(tag.value);
      case "short":
        return this.writeShort(tag.value);
      case "int":
        return this.writeInt(tag.value);
      case "long":
        return this.writeLong(tag.value);
      case "float":
        return this.writeFloat(tag.value);
      case "double":
        return this.writeDouble(tag.value);
      case "byteArray": {
        this.writeInt(tag.value.length);
        this.push(Buffer.from(tag.value.buffer, tag.value.byteOffset, tag.value.byteLength));
        return;
      }
      case "string":
        return this.writeString(tag.value);
      case "list": {
        // An empty list still needs a declared element type; END is the conventional choice.
        const elementType = tag.value.length === 0 ? "end" : tag.elementType;
        this.writeUByte(ID_BY_TYPE[elementType]);
        this.writeInt(tag.value.length);
        for (const item of tag.value) {
          if (item.type !== elementType) {
            throw new Error(
              `NBT list declared element type "${elementType}" but contains a "${item.type}"`,
            );
          }
          this.writePayload(item);
        }
        return;
      }
      case "compound": {
        // Sorted keys: byte-stable output for identical logical content.
        for (const key of Object.keys(tag.value).sort()) {
          const child = tag.value[key]!;
          this.writeUByte(ID_BY_TYPE[child.type]);
          this.writeString(key);
          this.writePayload(child);
        }
        this.writeUByte(0);
        return;
      }
      case "intArray": {
        this.writeInt(tag.value.length);
        const b = Buffer.alloc(tag.value.length * 4);
        for (let i = 0; i < tag.value.length; i++) b.writeInt32BE(tag.value[i]!, i * 4);
        this.push(b);
        return;
      }
      case "longArray": {
        this.writeInt(tag.value.length);
        const b = Buffer.alloc(tag.value.length * 8);
        for (let i = 0; i < tag.value.length; i++) b.writeBigInt64BE(tag.value[i]!, i * 8);
        this.push(b);
        return;
      }
    }
    // `scratch` exists only to keep allocation strategy visible for future tuning.
    void this.scratch;
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Serialize an NBT document. Gzipped by default, which is what `.schematic` files are. */
export function writeNbt(doc: NbtDocument, opts: { compress?: boolean } = {}): Buffer {
  const { compress = true } = opts;
  const writer = new NbtWriter();
  writer.writeUByte(ID_BY_TYPE.compound);
  writer.writeString(doc.name);
  writer.writePayload({ type: "compound", value: doc.root });
  const raw = writer.finish();
  // Node writes a zero mtime in the gzip header, so identical content yields an identical file.
  return compress ? gzipSync(raw, { level: 9 }) : raw;
}

// -- Typed accessors -----------------------------------------------------------------------------

/**
 * Read a field of an expected type, throwing a message that names the field. Schematics in the
 * wild are inconsistent enough that "Height is a Short here and an Int there" is normal, so the
 * numeric accessor deliberately accepts any integral tag.
 */
export function getNumber(root: NbtCompoundValue, field: string): number {
  const tag = root[field];
  if (!tag) throw new Error(`NBT: missing field "${field}"`);
  switch (tag.type) {
    case "byte":
    case "short":
    case "int":
      return tag.value;
    case "long":
      return Number(tag.value);
    case "float":
    case "double":
      return tag.value;
    default:
      throw new Error(`NBT: field "${field}" is a ${tag.type}, expected a number`);
  }
}

export function getNumberOr(root: NbtCompoundValue, field: string, fallback: number): number {
  return root[field] === undefined ? fallback : getNumber(root, field);
}

export function getString(root: NbtCompoundValue, field: string): string | undefined {
  const tag = root[field];
  return tag?.type === "string" ? tag.value : undefined;
}

export function getByteArray(root: NbtCompoundValue, field: string): Int8Array {
  const tag = root[field];
  if (!tag) throw new Error(`NBT: missing field "${field}"`);
  if (tag.type !== "byteArray") {
    throw new Error(`NBT: field "${field}" is a ${tag.type}, expected a byte array`);
  }
  return tag.value;
}

export function getByteArrayOr(root: NbtCompoundValue, field: string): Int8Array | undefined {
  const tag = root[field];
  return tag?.type === "byteArray" ? tag.value : undefined;
}

export function getList(root: NbtCompoundValue, field: string): readonly NbtTag[] {
  const tag = root[field];
  if (!tag) return [];
  if (tag.type !== "list") throw new Error(`NBT: field "${field}" is a ${tag.type}, expected a list`);
  return tag.value;
}

export function getCompound(root: NbtCompoundValue, field: string): NbtCompoundValue | undefined {
  const tag = root[field];
  return tag?.type === "compound" ? tag.value : undefined;
}

// -- Modified UTF-8 ------------------------------------------------------------------------------

function encodeModifiedUtf8(str: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x0001 && c <= 0x007f) {
      bytes.push(c);
    } else if (c <= 0x07ff) {
      // Includes U+0000, which modified UTF-8 encodes as two bytes rather than a NUL.
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      // Surrogates are emitted individually (CESU-8), which is what modified UTF-8 requires.
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Buffer.from(bytes);
}

function decodeModifiedUtf8(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i < buf.length) {
    const b = buf[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (buf[i + 1]! & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((buf[i + 1]! & 0x3f) << 6) | (buf[i + 2]! & 0x3f),
      );
      i += 3;
    }
  }
  return out;
}
