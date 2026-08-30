/**
 * Seeded pseudo-random number generator.
 *
 * The engine is *mostly deterministic*: given `(seed, plan, site)` it must reproduce the exact
 * build, so a map can be regenerated from its manifest and a flaw can be traced to the rule that
 * produced it. All controlled randomness — dimension jitter, weighted palette sampling, decoration
 * scatter, procedural variation between the four diamond islands — flows through one instance of
 * this PRNG with bounded ranges. **Randomness adds texture, never structure.**
 *
 * Implementation: `mulberry32`, a small, fast, well-distributed 32-bit generator. It is not
 * cryptographically secure (it must never be used for security) — it is chosen for being tiny,
 * portable, and byte-stable across platforms, which is exactly what the determinism contract needs.
 */

/** Something pickable with a relative weight. */
export interface Weighted {
  readonly weight: number;
}

/** Hash an arbitrary string into a 32-bit unsigned seed (xmur3). Lets callers seed from labels. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * A deterministic, resettable, sub-streamable PRNG.
 *
 * Sub-streams (`fork`) let each pass draw from an independent, reproducible stream keyed by a
 * label, so adding randomness in one pass never shifts the numbers another pass sees. That is what
 * makes "regenerate only the team islands' roofs" leave the rest of the map byte-identical.
 */
export class Prng {
  private state: number;
  /** The seed this generator was constructed with — recorded for provenance and reset(). */
  readonly seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
    this.state = this.seed;
  }

  /** Restore the generator to its initial seed state. */
  reset(): void {
    this.state = this.seed;
  }

  /**
   * Derive an independent child PRNG from a label. Deterministic: the same parent seed + label
   * always yields the same child stream, regardless of how many numbers the parent has drawn.
   */
  fork(label: string): Prng {
    return new Prng((this.seed ^ hashSeed(label)) >>> 0);
  }

  /** Next raw uint32 (mulberry32 core). */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  floatRange(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in the inclusive range [min, max]. */
  intRange(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean {
    return this.float() < clamp01(p);
  }

  /** Uniformly pick one element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Prng.pick: empty array");
    return items[this.intRange(0, items.length - 1)] as T;
  }

  /**
   * Weighted pick. The primary texture-variation primitive: sampling
   * `cobblestone : mossy_cobblestone : stone_bricks` at weights `4:2:1` is what breaks a flat
   * single-block wall into something that reads as built rather than filled.
   */
  weightedPick<T extends Weighted>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Prng.weightedPick: empty list");
    let total = 0;
    for (const b of items) total += Math.max(0, b.weight);
    if (total <= 0) throw new Error("Prng.weightedPick: total weight must be > 0");
    let r = this.float() * total;
    for (const b of items) {
      r -= Math.max(0, b.weight);
      if (r < 0) return b;
    }
    return items[items.length - 1] as T;
  }

  /** In-place deterministic Fisher-Yates shuffle. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.intRange(0, i);
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  }

  /**
   * Symmetric jitter around a base value: `base + U(-amount, +amount)` rounded to an integer.
   * Bounded dimension jitter — variation, not chaos.
   */
  jitterInt(base: number, amount: number): number {
    return Math.round(base + this.floatRange(-amount, amount));
  }

  /** Standard normal via Box-Muller. Useful for natural-looking scatter falloff. */
  gaussian(mean = 0, stdDev = 1): number {
    const u = 1 - this.float();
    const v = this.float();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Clamp a number to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Clamp a number to an arbitrary range. */
export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep on [0,1] — the standard easing for terrain and gradient falloff. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}
