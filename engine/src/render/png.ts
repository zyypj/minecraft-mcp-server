/**
 * A minimal PNG encoder.
 *
 * The renderer's only output is an 8-bit RGBA image, which PNG stores as raw scanlines with a
 * filter byte, deflated. Node ships deflate, so the whole encoder is a CRC table and three chunks.
 * Writing it here rather than depending on `sharp` keeps the preview path free of native modules —
 * the thing most likely to break a Windows install of this project.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode RGBA pixel data as a PNG.
 *
 * `pixels` is `width * height * 4` bytes in row-major order. Scanlines use filter type 1 (Sub)
 * when it shrinks the row and 0 otherwise — a cheap heuristic that meaningfully compresses the
 * large flat colour regions a voxel render produces.
 */
export function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `encodePng: expected ${width * height * 4} bytes for ${width}x${height}, got ${pixels.length}`,
    );
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const sub = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    // Sub filter: each byte minus the byte 4 positions earlier in the same row.
    let subSum = 0;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? pixels[rowStart + i - 4]! : 0;
      const v = (pixels[rowStart + i]! - left) & 0xff;
      sub[i] = v;
      subSum += v < 128 ? v : 256 - v;
    }
    let noneSum = 0;
    for (let i = 0; i < stride; i++) {
      const v = pixels[rowStart + i]!;
      noneSum += v < 128 ? v : 256 - v;
    }
    const out = y * (stride + 1);
    if (subSum < noneSum) {
      raw[out] = 1;
      sub.copy(raw, out + 1);
    } else {
      raw[out] = 0;
      Buffer.from(pixels.buffer, pixels.byteOffset + rowStart, stride).copy(raw, out + 1);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
