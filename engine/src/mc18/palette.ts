/**
 * Palettes: named material roles, weighted block mixes, and gradient ramps.
 *
 * Palette is the fastest thing to get wrong and the fastest to get right. Two builds with identical
 * geometry read as "professional" or "generated" almost entirely on block choice, which is why the
 * engine never hard-codes a block in a structure generator — a tower asks for `WALL_PRIMARY` and
 * the palette decides what that is for this style, this team colour, this map.
 *
 * Three ideas do most of the work:
 *
 *  - **Roles, not blocks.** A generator names the job (`TRIM`, `ROOF`, `TERRAIN_TOP`), so restyling
 *    a whole map is swapping one object.
 *  - **Weighted mixes.** A role holds several blocks with weights, sampled per cell from a
 *    positional hash. `cobblestone 4 : mossy 2 : stone_bricks 1` is what stops a wall reading flat,
 *    and hashing rather than drawing from a stream keeps it stable under re-renders and edits.
 *  - **Ramps.** An ordered list of blocks for gradients, which is the single most transferable thing
 *    extracted from a reference schematic: a style's material progression survives even when none
 *    of its shapes do.
 */

import { Noise } from "../core/noise.js";
import { type Prng, type Weighted } from "../core/prng.js";
import {
  AIR,
  type BlockSource,
  type PackedBlock,
  type Volume,
  type Mask,
} from "../core/volume.js";
import { type Region } from "../core/vec.js";
import { blockColor, blockName, materialKey } from "./blocks.js";
import { MaterialResolver, block as resolveBlock } from "./material.js";

/** The vocabulary a structure generator uses to ask for material. */
export type PaletteRole =
  | "WALL_PRIMARY"
  | "WALL_SECONDARY"
  | "ACCENT"
  | "TRIM"
  | "DETAIL"
  | "ROOF_PRIMARY"
  | "ROOF_SECONDARY"
  | "SUPPORT"
  | "FLOOR"
  | "PATH"
  | "TERRAIN_TOP"
  | "TERRAIN_MID"
  | "TERRAIN_BASE"
  | "TERRAIN_EDGE"
  | "GLASS"
  | "LIGHT"
  | "VEGETATION"
  | "DECOR";

export const PALETTE_ROLES: readonly PaletteRole[] = [
  "WALL_PRIMARY",
  "WALL_SECONDARY",
  "ACCENT",
  "TRIM",
  "DETAIL",
  "ROOF_PRIMARY",
  "ROOF_SECONDARY",
  "SUPPORT",
  "FLOOR",
  "PATH",
  "TERRAIN_TOP",
  "TERRAIN_MID",
  "TERRAIN_BASE",
  "TERRAIN_EDGE",
  "GLASS",
  "LIGHT",
  "VEGETATION",
  "DECOR",
];

export interface WeightedBlock extends Weighted {
  readonly block: PackedBlock;
  readonly weight: number;
}

/** A named ordered progression of blocks, used by gradients. */
export type Ramp = readonly PackedBlock[];

export interface PaletteData {
  readonly id: string;
  readonly roles: Partial<Record<PaletteRole, readonly WeightedBlock[]>>;
  readonly ramps?: Readonly<Record<string, Ramp>>;
  /** Blocks this palette must never emit, even if a generator asks for them by name. */
  readonly forbidden?: readonly PackedBlock[];
}

/** The JSON shape a style pack stores on disk — block *names*, resolved on load. */
export interface PaletteJson {
  readonly id: string;
  readonly roles: Partial<Record<PaletteRole, readonly (string | { block: string; weight: number })[]>>;
  readonly ramps?: Readonly<Record<string, readonly string[]>>;
  readonly forbidden?: readonly string[];
}

/** Fallback used when a role is missing, so a generator never has to null-check. */
const ROLE_FALLBACK: Readonly<Record<PaletteRole, PaletteRole | null>> = {
  WALL_PRIMARY: null,
  WALL_SECONDARY: "WALL_PRIMARY",
  ACCENT: "TRIM",
  TRIM: "WALL_SECONDARY",
  DETAIL: "TRIM",
  ROOF_PRIMARY: "WALL_PRIMARY",
  ROOF_SECONDARY: "ROOF_PRIMARY",
  SUPPORT: "WALL_SECONDARY",
  FLOOR: "WALL_SECONDARY",
  PATH: "FLOOR",
  TERRAIN_TOP: null,
  TERRAIN_MID: "TERRAIN_BASE",
  TERRAIN_BASE: "TERRAIN_TOP",
  TERRAIN_EDGE: "TERRAIN_BASE",
  GLASS: null,
  LIGHT: null,
  VEGETATION: "TERRAIN_TOP",
  DECOR: "ACCENT",
};

const LAST_RESORT: Readonly<Record<PaletteRole, string>> = {
  WALL_PRIMARY: "stone_bricks",
  WALL_SECONDARY: "cobblestone",
  ACCENT: "quartz_block",
  TRIM: "stone_slab",
  DETAIL: "stone_bricks",
  ROOF_PRIMARY: "oak_planks",
  ROOF_SECONDARY: "spruce_planks",
  SUPPORT: "oak_log",
  FLOOR: "oak_planks",
  PATH: "gravel",
  TERRAIN_TOP: "grass",
  TERRAIN_MID: "dirt",
  TERRAIN_BASE: "stone",
  TERRAIN_EDGE: "cobblestone",
  GLASS: "glass",
  LIGHT: "glowstone",
  VEGETATION: "tall_grass",
  DECOR: "red_flower",
};

export class Palette {
  readonly id: string;
  private readonly roles: Map<PaletteRole, readonly WeightedBlock[]>;
  private readonly ramps: Map<string, Ramp>;
  private readonly forbidden: Set<PackedBlock>;
  private readonly noise: Noise;

  constructor(data: PaletteData, seed: number | string = data.id) {
    this.id = data.id;
    this.roles = new Map(
      Object.entries(data.roles).filter(([, v]) => v && v.length > 0) as [
        PaletteRole,
        readonly WeightedBlock[],
      ][],
    );
    this.ramps = new Map(Object.entries(data.ramps ?? {}));
    this.forbidden = new Set((data.forbidden ?? []).map(materialKey));
    // Positional sampling uses a hash keyed on the palette, so two palettes never produce the same
    // speckle pattern in the same place.
    this.noise = new Noise(seed);
  }

  /** Load a palette from its JSON form, resolving names against 1.8. */
  static fromJson(json: PaletteJson, resolver = new MaterialResolver({ mode: "strict" })): Palette {
    const roles: Partial<Record<PaletteRole, WeightedBlock[]>> = {};
    for (const [role, entries] of Object.entries(json.roles)) {
      if (!entries) continue;
      roles[role as PaletteRole] = entries.map((e) =>
        typeof e === "string"
          ? { block: resolver.require(e), weight: 1 }
          : { block: resolver.require(e.block), weight: e.weight },
      );
    }
    const ramps: Record<string, Ramp> = {};
    for (const [name, blocks] of Object.entries(json.ramps ?? {})) {
      ramps[name] = blocks.map((b) => resolver.require(b));
    }
    return new Palette({
      id: json.id,
      roles,
      ramps,
      forbidden: (json.forbidden ?? []).map((b) => resolver.require(b)),
    });
  }

  toJson(): PaletteJson {
    const roles: Record<string, { block: string; weight: number }[]> = {};
    for (const [role, entries] of this.roles) {
      roles[role] = entries.map((e) => ({ block: blockName(e.block), weight: e.weight }));
    }
    const ramps: Record<string, string[]> = {};
    for (const [name, ramp] of this.ramps) ramps[name] = ramp.map(blockName);
    return {
      id: this.id,
      roles: roles as PaletteJson["roles"],
      ramps,
      forbidden: [...this.forbidden].map(blockName),
    };
  }

  has(role: PaletteRole): boolean {
    return this.roles.has(role);
  }

  /** Every block a role can produce, following the fallback chain. */
  entries(role: PaletteRole): readonly WeightedBlock[] {
    const seen = new Set<PaletteRole>();
    let current: PaletteRole | null = role;
    while (current && !seen.has(current)) {
      seen.add(current);
      const found = this.roles.get(current);
      if (found && found.length > 0) return found;
      current = ROLE_FALLBACK[current];
    }
    return [{ block: resolveBlock(LAST_RESORT[role]), weight: 1 }];
  }

  /** The single most-weighted block for a role — for places where variation would be noise. */
  primary(role: PaletteRole): PackedBlock {
    const entries = this.entries(role);
    let best = entries[0]!;
    for (const e of entries) if (e.weight > best.weight) best = e;
    return best.block;
  }

  /** Draw one block from a role's weighted mix. */
  pick(role: PaletteRole, prng: Prng): PackedBlock {
    return prng.weightedPick(this.entries(role)).block;
  }

  /**
   * A {@link BlockSource} that samples a role's mix per cell from a positional hash.
   *
   * Hash-based rather than stream-based on purpose: the same cell always gets the same block, so
   * re-running one pass, re-rendering, or regenerating a single structure does not reshuffle the
   * texture of everything around it.
   */
  source(role: PaletteRole, opts: { scale?: number } = {}): BlockSource {
    const entries = this.entries(role);
    if (entries.length === 1) return entries[0]!.block;
    let total = 0;
    for (const e of entries) total += Math.max(0, e.weight);
    const scale = opts.scale ?? 1;
    const noise = this.noise.fork(role);
    return (p) => {
      // A little spatial coherence (scale > 1) clumps the variants instead of speckling them, which
      // reads as weathering rather than TV static.
      const r =
        scale <= 1
          ? noise.white3(p.x, p.y, p.z)
          : (noise.fbm3(p.x / scale, p.y / scale, p.z / scale, { octaves: 2 }) + 1) / 2;
      let acc = r * total;
      for (const e of entries) {
        acc -= Math.max(0, e.weight);
        if (acc < 0) return e.block;
      }
      return entries[entries.length - 1]!.block;
    };
  }

  ramp(name: string): Ramp | undefined {
    return this.ramps.get(name);
  }

  rampNames(): string[] {
    return [...this.ramps.keys()];
  }

  isForbidden(block: PackedBlock): boolean {
    return this.forbidden.has(materialKey(block));
  }

  /** A copy with some roles overridden — the mechanism behind per-team recolouring. */
  withOverrides(id: string, overrides: Partial<Record<PaletteRole, readonly WeightedBlock[]>>): Palette {
    const roles: Partial<Record<PaletteRole, readonly WeightedBlock[]>> = {};
    for (const [role, entries] of this.roles) roles[role] = entries;
    for (const [role, entries] of Object.entries(overrides)) {
      if (entries && entries.length > 0) roles[role as PaletteRole] = entries;
    }
    const ramps: Record<string, Ramp> = {};
    for (const [name, ramp] of this.ramps) ramps[name] = ramp;
    return new Palette({ id, roles, ramps, forbidden: [...this.forbidden] });
  }
}

/**
 * Blend two palettes.
 *
 * `weightB` is how much of B's identity survives, in `[0, 1]`. Roles are merged by scaling each
 * side's weights, so at 0.3 a role keeps A's dominant material with B's showing through as
 * variation — which is exactly what "70% carousel architecture, 30% snoopy decoration" should mean.
 * Ramps are taken whole from whichever side is dominant, because interleaving two material
 * progressions produces a gradient that reads as a mistake.
 */
export function blendPalettes(
  a: Palette,
  b: Palette,
  weightB: number,
  id = `${a.id}+${b.id}`,
): Palette {
  const t = Math.min(1, Math.max(0, weightB));
  const roles: Partial<Record<PaletteRole, WeightedBlock[]>> = {};
  for (const role of PALETTE_ROLES) {
    const fromA = a.has(role) ? a.entries(role) : [];
    const fromB = b.has(role) ? b.entries(role) : [];
    if (fromA.length === 0 && fromB.length === 0) continue;
    const merged = new Map<PackedBlock, number>();
    const add = (entries: readonly WeightedBlock[], scale: number) => {
      let total = 0;
      for (const e of entries) total += Math.max(0, e.weight);
      if (total <= 0) return;
      for (const e of entries) {
        const normalized = (Math.max(0, e.weight) / total) * scale;
        merged.set(e.block, (merged.get(e.block) ?? 0) + normalized);
      }
    };
    add(fromA, 1 - t);
    add(fromB, t);
    const entries = [...merged.entries()]
      .filter(([, w]) => w > 0.001)
      .map(([block, weight]) => ({ block, weight: Math.round(weight * 1000) / 1000 }))
      .sort((x, y) => y.weight - x.weight);
    if (entries.length > 0) roles[role] = entries;
  }

  const dominant = t >= 0.5 ? b : a;
  const ramps: Record<string, Ramp> = {};
  for (const name of dominant.rampNames()) ramps[name] = dominant.ramp(name)!;
  return new Palette({ id, roles, ramps });
}

// -- Extraction ----------------------------------------------------------------------------------

export interface PaletteObservation {
  readonly block: PackedBlock;
  readonly name: string;
  readonly count: number;
  readonly share: number;
  /** Share of this block's cells that are on the visible surface. */
  readonly exposure: number;
  readonly color: number;
}

/**
 * Measure which blocks a volume actually uses, and how visible each one is.
 *
 * Raw counts are misleading — the stone filling an island's interior outnumbers everything on its
 * surface — so exposure is tracked separately. A style's identity lives in what you can *see*.
 */
export function observePalette(vol: Volume, r?: Region): PaletteObservation[] {
  const counts = new Map<PackedBlock, { total: number; exposed: number }>();
  let total = 0;
  for (const { pos, block } of vol.iterateSolid(r)) {
    const key = materialKey(block);
    const entry = counts.get(key) ?? { total: 0, exposed: 0 };
    entry.total++;
    total++;
    if (
      vol.get(pos.x + 1, pos.y, pos.z) === AIR ||
      vol.get(pos.x - 1, pos.y, pos.z) === AIR ||
      vol.get(pos.x, pos.y + 1, pos.z) === AIR ||
      vol.get(pos.x, pos.y - 1, pos.z) === AIR ||
      vol.get(pos.x, pos.y, pos.z + 1) === AIR ||
      vol.get(pos.x, pos.y, pos.z - 1) === AIR
    ) {
      entry.exposed++;
    }
    counts.set(key, entry);
  }
  const out: PaletteObservation[] = [];
  for (const [block, entry] of counts) {
    out.push({
      block,
      name: blockName(block),
      count: entry.total,
      share: total === 0 ? 0 : entry.total / total,
      exposure: entry.total === 0 ? 0 : entry.exposed / entry.total,
      color: blockColor(block),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Recolour a region by mapping each source material to a replacement. */
export function applyPaletteMapping(
  vol: Volume,
  mapping: ReadonlyMap<PackedBlock, BlockSource>,
  opts: { region?: Region; mask?: Mask } = {},
): number {
  const keyed = new Map<PackedBlock, BlockSource>();
  for (const [from, to] of mapping) keyed.set(materialKey(from), to);
  return vol.fill(
    opts.region ?? vol.bounds,
    (p, v) => {
      const current = v.getAt(p);
      const replacement = keyed.get(materialKey(current));
      return replacement === undefined
        ? current
        : typeof replacement === "number"
          ? replacement
          : replacement(p, v);
    },
    (p, current, v) => {
      if (current === AIR) return false;
      if (!keyed.has(materialKey(current))) return false;
      return opts.mask ? opts.mask(p, current, v) : true;
    },
  );
}
