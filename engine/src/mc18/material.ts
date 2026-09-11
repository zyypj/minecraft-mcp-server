/**
 * The Material Compatibility Layer.
 *
 * An LLM writing a build plan will reach for `white_concrete`, `deepslate_tiles` or
 * `waxed_copper_block` without noticing they postdate 1.8 by half a decade. If those silently
 * became "some grey block", every map would drift away from the target version in ways nobody sees
 * until it fails to load on the server.
 *
 * So the resolver has exactly two modes and no third:
 *
 *  - **strict** (the default for anything that reaches the world): a block that did not exist in
 *    1.8 is an error, with the nearest legal substitute named in the message so the caller can fix
 *    the plan deliberately.
 *  - **substitute**: the same lookup, but a known post-1.8 block is silently mapped to its closest
 *    1.8 equivalent and reported in `warnings`. Used when ingesting third-party schematics, where
 *    rejecting the whole file over one block helps nobody.
 *
 * Accepted syntax: `stone`, `stone:1`, `granite`, `35:14`, `wool:14`, `red_wool`,
 * `minecraft:red_wool`. Case and namespace are ignored.
 */

import { type PackedBlock, blockData, blockId, pack } from "../core/volume.js";
import { BLOCKS_BY_ID, BLOCKS_BY_NAME, MAX_LEGACY_ID, blockName } from "./blocks.js";

export type ResolveMode = "strict" | "substitute";

export interface ResolveOk {
  readonly ok: true;
  readonly block: PackedBlock;
  /** Set when `substitute` mode replaced a post-1.8 block. */
  readonly substitutedFrom?: string;
}

export interface ResolveError {
  readonly ok: false;
  readonly input: string;
  readonly reason: string;
  /** The 1.8 block the caller most likely wanted, when we can guess. */
  readonly suggestion?: string;
}

export type ResolveResult = ResolveOk | ResolveError;

/**
 * Post-1.8 blocks a modern builder reaches for, mapped to their nearest 1.8 equivalent.
 *
 * The mapping is deliberately conservative: it matches *hue and role*, not exact shade. Concrete
 * becomes wool because wool is the flat saturated block 1.8 had; terracotta variants collapse onto
 * stained clay, which is literally the same block under its old name.
 */
const MODERN_SUBSTITUTES: Readonly<Record<string, string>> = {
  // Concrete / concrete powder -> wool (the 1.8 flat-colour block).
  white_concrete: "white_wool",
  orange_concrete: "orange_wool",
  magenta_concrete: "magenta_wool",
  light_blue_concrete: "light_blue_wool",
  yellow_concrete: "yellow_wool",
  lime_concrete: "lime_wool",
  pink_concrete: "pink_wool",
  gray_concrete: "gray_wool",
  light_gray_concrete: "silver_wool",
  cyan_concrete: "cyan_wool",
  purple_concrete: "purple_wool",
  blue_concrete: "blue_wool",
  brown_concrete: "brown_wool",
  green_concrete: "green_wool",
  red_concrete: "red_wool",
  black_concrete: "black_wool",

  // Terracotta is stained clay renamed.
  terracotta: "hardened_clay",
  white_terracotta: "white_stained_clay",
  orange_terracotta: "orange_stained_clay",
  magenta_terracotta: "magenta_stained_clay",
  light_blue_terracotta: "light_blue_stained_clay",
  yellow_terracotta: "yellow_stained_clay",
  lime_terracotta: "lime_stained_clay",
  pink_terracotta: "pink_stained_clay",
  gray_terracotta: "gray_stained_clay",
  light_gray_terracotta: "silver_stained_clay",
  cyan_terracotta: "cyan_stained_clay",
  purple_terracotta: "purple_stained_clay",
  blue_terracotta: "blue_stained_clay",
  brown_terracotta: "brown_stained_clay",
  green_terracotta: "green_stained_clay",
  red_terracotta: "red_stained_clay",
  black_terracotta: "black_stained_clay",

  // Stone family added after 1.8.
  smooth_stone: "stone",
  deepslate: "stone",
  cobbled_deepslate: "cobblestone",
  polished_deepslate: "stone",
  deepslate_bricks: "stone_bricks",
  deepslate_tiles: "stone_bricks",
  tuff: "andesite",
  calcite: "diorite",
  dripstone_block: "stone",
  blackstone: "obsidian",
  polished_blackstone: "obsidian",
  polished_blackstone_bricks: "obsidian",
  basalt: "stone",
  smooth_basalt: "stone",
  mud_bricks: "brick_block",
  packed_mud: "hardened_clay",
  mud: "dirt",
  rooted_dirt: "dirt",

  // Woods added after 1.8.
  crimson_planks: "dark_oak_planks",
  warped_planks: "spruce_planks",
  mangrove_planks: "dark_oak_planks",
  cherry_planks: "birch_planks",
  bamboo_planks: "birch_planks",

  // Copper and friends.
  copper_block: "orange_stained_clay",
  exposed_copper: "orange_stained_clay",
  weathered_copper: "cyan_stained_clay",
  oxidized_copper: "cyan_stained_clay",
  cut_copper: "orange_stained_clay",
  waxed_copper_block: "orange_stained_clay",

  // Misc.
  amethyst_block: "purple_stained_clay",
  honeycomb_block: "yellow_stained_clay",
  bone_block: "quartz_block",
  purpur_block: "purple_stained_clay",
  end_stone_bricks: "end_stone",
  smooth_quartz: "quartz_block",
  quartz_bricks: "quartz_block",
  glowing_obsidian: "obsidian",
  shroomlight: "glowstone",
  sculk: "black_wool",
  moss_block: "green_wool",
  azalea_leaves: "oak_leaves",
  grass_block: "grass",
  dirt_path: "grass",
  granite_stairs: "stone_stairs",
  cobblestone_stairs: "stone_stairs",
  stone_bricks_stairs: "stone_brick_stairs",
  light_gray_wool: "silver_wool",
  light_gray_carpet: "silver_carpet",
  light_gray_stained_glass: "silver_stained_glass",
  light_gray_stained_glass_pane: "silver_stained_glass_pane",
  light_gray_concrete_powder: "silver_wool",
  oak_log: "oak_log",
  oak_wood: "oak_log",
  oak_fence: "fence",
  oak_door: "wooden_door",
  oak_slab: "oak_slab",
  oak_trapdoor: "trapdoor",
  short_grass: "tall_grass",
};

/** Normalize `Minecraft:Red_Wool` / ` red wool ` to `red_wool`. */
function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/[\s-]+/g, "_");
}

/** Split a trailing `:data` suffix, but only when it is a bare number. */
function splitData(name: string): { base: string; data: number | null } {
  const m = /^(.*?):(\d{1,2})$/.exec(name);
  if (!m) return { base: name, data: null };
  const data = Number(m[2]);
  if (data < 0 || data > 15) return { base: name, data: null };
  return { base: m[1]!, data };
}

export interface ResolverOptions {
  readonly mode?: ResolveMode;
}

/**
 * Resolves block names to packed 1.8 `(id, data)` pairs, and accumulates substitution warnings so
 * a caller can report "this schematic used 3 post-1.8 blocks" once rather than per cell.
 */
export class MaterialResolver {
  private readonly mode: ResolveMode;
  private readonly warnings = new Map<string, { to: string; count: number }>();
  private readonly cache = new Map<string, ResolveResult>();

  constructor(opts: ResolverOptions = {}) {
    this.mode = opts.mode ?? "strict";
  }

  /** Every distinct substitution made so far, with how often each fired. */
  substitutions(): { from: string; to: string; count: number }[] {
    return [...this.warnings.entries()].map(([from, v]) => ({ from, to: v.to, count: v.count }));
  }

  resetWarnings(): void {
    this.warnings.clear();
  }

  resolve(input: string): ResolveResult {
    const cached = this.cache.get(input);
    if (cached) {
      if (cached.ok && cached.substitutedFrom) this.noteSubstitution(cached);
      return cached;
    }
    const result = this.resolveUncached(input);
    this.cache.set(input, result);
    if (result.ok && result.substitutedFrom) this.noteSubstitution(result);
    return result;
  }

  /** Resolve or throw. For call sites where a bad material is a programming error. */
  require(input: string): PackedBlock {
    const r = this.resolve(input);
    if (!r.ok) {
      throw new Error(
        r.suggestion
          ? `${r.reason} (input: "${r.input}"; did you mean "${r.suggestion}"?)`
          : `${r.reason} (input: "${r.input}")`,
      );
    }
    return r.block;
  }

  private noteSubstitution(r: ResolveOk): void {
    const from = r.substitutedFrom!;
    const existing = this.warnings.get(from);
    if (existing) existing.count++;
    else this.warnings.set(from, { to: blockName(r.block), count: 1 });
  }

  private resolveUncached(input: string): ResolveResult {
    const name = normalize(input);
    if (name === "") return { ok: false, input, reason: "empty block name" };

    // `35:14` and bare `35`.
    const numeric = /^(\d{1,4})(?::(\d{1,2}))?$/.exec(name);
    if (numeric) {
      const id = Number(numeric[1]);
      const data = numeric[2] === undefined ? 0 : Number(numeric[2]);
      if (!BLOCKS_BY_ID.has(id)) {
        return {
          ok: false,
          input,
          reason: `block id ${id} does not exist in Minecraft 1.8 (valid ids are 0-${MAX_LEGACY_ID})`,
        };
      }
      if (data > 15) return { ok: false, input, reason: `data value ${data} exceeds the 4-bit range` };
      return { ok: true, block: pack(id, data) };
    }

    // `name:data` and plain names, including every variant name (`granite`, `red_wool`).
    const { base, data } = splitData(name);
    const direct = BLOCKS_BY_NAME.get(data === null ? name : base);
    if (direct !== undefined) {
      return { ok: true, block: data === null ? direct : pack(blockId(direct), data) };
    }

    // Known post-1.8 block: substitute or reject with the substitute as the suggestion.
    const lookupKey = data === null ? name : base;
    const substitute = MODERN_SUBSTITUTES[lookupKey];
    if (substitute) {
      const target = BLOCKS_BY_NAME.get(substitute);
      if (target !== undefined) {
        if (this.mode === "substitute") {
          return { ok: true, block: target, substitutedFrom: lookupKey };
        }
        return {
          ok: false,
          input,
          reason: `"${lookupKey}" does not exist in Minecraft 1.8`,
          suggestion: substitute,
        };
      }
    }

    return {
      ok: false,
      input,
      reason: `unknown block "${lookupKey}"`,
      suggestion: nearestName(lookupKey),
    };
  }
}

/** Cheap edit-distance suggestion so a typo produces a useful error instead of a dead end. */
function nearestName(name: string): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of BLOCKS_BY_NAME.keys()) {
    const d = editDistance(name, candidate, bestScore);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  // Beyond a third of the name being wrong it is a different block, not a typo.
  return bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string, cutoff: number): number {
  if (Math.abs(a.length - b.length) > cutoff) return Infinity;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > cutoff) return Infinity;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** A shared strict resolver, for call sites that do not need their own warning bucket. */
export const strictResolver = new MaterialResolver({ mode: "strict" });

/** Resolve a name to a packed block or throw. Shorthand over {@link strictResolver}. */
export function block(name: string): PackedBlock {
  return strictResolver.require(name);
}

/** Round-trip helper: packed block back to its canonical 1.8 name plus data. */
export function describeBlock(b: PackedBlock): { id: number; data: number; name: string } {
  return { id: blockId(b), data: blockData(b), name: blockName(b) };
}
