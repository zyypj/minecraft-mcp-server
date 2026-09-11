/**
 * Deterministic gradient noise.
 *
 * Organic terrain is the difference between an island that reads as a floating disc of grass and
 * one that reads as a piece of land. Every irregular edge, overhang, thickness variation and
 * decoration scatter in the engine is driven from here.
 *
 * This is a seeded 2D/3D simplex-style gradient noise (the classic Perlin/simplex construction,
 * hash-based rather than table-permuted so it needs no setup and seeds cheaply). Output is
 * approximately in `[-1, 1]`. Two runs with the same seed produce identical fields on any platform:
 * the hash is pure integer arithmetic with `Math.imul`, no floating-point accumulation.
 */

import { hashSeed, lerp } from "./prng.js";

/** Integer hash of three coordinates plus a seed, returned as a uint32. */
function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h = (h << 11) | (h >>> 21);
  h = Math.imul(h ^ (z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The 12 classic Perlin gradient directions, indexed by the low bits of a hash. */
const GRAD3: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
];

/** Quintic fade, the improved-Perlin interpolant (C2 continuous, no second-derivative creases). */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface FbmOptions {
  /** Number of noise layers summed. More octaves = more fine detail, linearly more cost. */
  readonly octaves?: number;
  /** Frequency multiplier between octaves. 2 is the standard "one more level of detail". */
  readonly lacunarity?: number;
  /** Amplitude multiplier between octaves. Below 0.5 gives smooth terrain, above gives rough. */
  readonly persistence?: number;
  /** Base frequency: roughly `1 / feature size in blocks`. */
  readonly frequency?: number;
}

export class Noise {
  private readonly seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  }

  /** Derive an independent noise field from a label — same contract as `Prng.fork`. */
  fork(label: string): Noise {
    return new Noise((this.seed ^ hashSeed(label)) >>> 0);
  }

  private gradDot(ix: number, iy: number, iz: number, dx: number, dy: number, dz: number): number {
    const g = GRAD3[hash3(this.seed, ix, iy, iz) % 12]!;
    return g[0] * dx + g[1] * dy + g[2] * dz;
  }

  /** 3D gradient noise in roughly `[-1, 1]`. */
  noise3(x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);

    const n000 = this.gradDot(ix, iy, iz, fx, fy, fz);
    const n100 = this.gradDot(ix + 1, iy, iz, fx - 1, fy, fz);
    const n010 = this.gradDot(ix, iy + 1, iz, fx, fy - 1, fz);
    const n110 = this.gradDot(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
    const n001 = this.gradDot(ix, iy, iz + 1, fx, fy, fz - 1);
    const n101 = this.gradDot(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
    const n011 = this.gradDot(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
    const n111 = this.gradDot(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);

    const x00 = lerp(n000, n100, u);
    const x10 = lerp(n010, n110, u);
    const x01 = lerp(n001, n101, u);
    const x11 = lerp(n011, n111, u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }

  /** 2D gradient noise — `noise3` on the `y = 0` plane. */
  noise2(x: number, z: number): number {
    return this.noise3(x, 0, z);
  }

  /** Fractal Brownian motion: summed octaves, normalized back into roughly `[-1, 1]`. */
  fbm2(x: number, z: number, opts: FbmOptions = {}): number {
    const { octaves = 4, lacunarity = 2, persistence = 0.5, frequency = 1 } = opts;
    let sum = 0;
    let amp = 1;
    let freq = frequency;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, i * 37.19, z * freq);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return norm === 0 ? 0 : sum / norm;
  }

  fbm3(x: number, y: number, z: number, opts: FbmOptions = {}): number {
    const { octaves = 4, lacunarity = 2, persistence = 0.5, frequency = 1 } = opts;
    let sum = 0;
    let amp = 1;
    let freq = frequency;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq + i * 11.3, y * freq, z * freq - i * 7.7);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return norm === 0 ? 0 : sum / norm;
  }

  /**
   * Ridged multifractal: `1 - |noise|`, squared. Produces sharp crests and smooth valleys, which
   * is what makes island undersides look like eroded rock rather than a blurred blob.
   */
  ridged2(x: number, z: number, opts: FbmOptions = {}): number {
    const { octaves = 4, lacunarity = 2, persistence = 0.5, frequency = 1 } = opts;
    let sum = 0;
    let amp = 1;
    let freq = frequency;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise3(x * freq, i * 23.7, z * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return norm === 0 ? 0 : sum / norm;
  }

  /**
   * Domain-warped 2D fbm. Offsetting the sample point by another noise field turns the
   * characteristic "cloud" look into curling, geological shapes — the cheapest single trick for
   * making a generated island edge stop looking generated.
   */
  warped2(x: number, z: number, strength: number, opts: FbmOptions = {}): number {
    const wx = this.fbm2(x + 41.7, z - 13.2, opts) * strength;
    const wz = this.fbm2(x - 27.1, z + 63.9, opts) * strength;
    return this.fbm2(x + wx, z + wz, opts);
  }

  /** Deterministic scalar in `[0, 1)` for a cell — for scatter decisions, not smooth fields. */
  white3(x: number, y: number, z: number): number {
    return hash3(this.seed, x, y, z) / 4294967296;
  }
}
