/**
 * Shared argument schemas and resolvers for the build tools.
 *
 * Two conventions matter here:
 *
 *  - **Positions are objects**, `{x, y, z}`, never three loose numbers. Loose numbers get
 *    transposed; an object does not.
 *  - **Materials are names or roles.** A tool takes either a concrete 1.8 block (`red_wool`,
 *    `stone:1`, `35:14`) or a palette role (`WALL_PRIMARY`, `TERRAIN_TOP`). Roles are the preferred
 *    form: they let a style change repaint a whole map without touching a single generator call.
 */

import { z } from "zod";

import {
  MaterialResolver,
  PALETTE_ROLES,
  type BlockSource,
  type PackedBlock,
  type Palette,
  type PaletteRole,
  type Region,
  type Vec3,
  region as makeRegion,
  vec,
} from "@mcbuild/engine";

export const vec3Schema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
  })
  .describe("A position in build space, where (0,0,0) is the minimum corner of the volume.");

export const regionSchema = z
  .object({ min: vec3Schema, max: vec3Schema })
  .describe("An inclusive axis-aligned box. Corners may be given in any order.");

export const materialSchema = z
  .string()
  .describe(
    "A 1.8 block name (`red_wool`, `stone:1`, `granite`, `35:14`) or a palette role " +
      `(${PALETTE_ROLES.join(", ")}). Roles are preferred: they follow the build's style.`,
  );

export const buildRefSchema = z
  .string()
  .optional()
  .describe("Build id. Defaults to the build most recently created or selected.");

export const facingSchema = z.enum(["north", "east", "south", "west"]);

export function toVec(input: unknown): Vec3 {
  const parsed = vec3Schema.parse(input);
  return vec(parsed.x, parsed.y, parsed.z);
}

export function toRegion(input: unknown): Region {
  const parsed = regionSchema.parse(input);
  return makeRegion(vec(parsed.min.x, parsed.min.y, parsed.min.z), vec(parsed.max.x, parsed.max.y, parsed.max.z));
}

const ROLE_SET = new Set<string>(PALETTE_ROLES);

/** True when a material string names a palette role rather than a concrete block. */
export function isRole(material: string): material is PaletteRole {
  return ROLE_SET.has(material.toUpperCase());
}

const resolver = new MaterialResolver({ mode: "strict" });

/**
 * Resolve a material to something a fill can consume.
 *
 * A role becomes a weighted, position-stable source (so a wall gets texture); a block name becomes
 * a constant. Post-1.8 names fail loudly with the nearest legal substitute named, rather than
 * silently becoming grey.
 */
export function resolveMaterial(material: string, palette: Palette): BlockSource {
  if (isRole(material)) return palette.source(material.toUpperCase() as PaletteRole, { scale: 3 });
  const result = resolver.resolve(material);
  if (!result.ok) {
    throw new Error(
      result.suggestion
        ? `${result.reason}. The closest 1.8 block is "${result.suggestion}" — use that, or a palette role.`
        : result.reason,
    );
  }
  return result.block;
}

/** Resolve to a single concrete block, for places where per-cell variation makes no sense. */
export function resolveBlockOnly(material: string, palette: Palette): PackedBlock {
  if (isRole(material)) return palette.primary(material.toUpperCase() as PaletteRole);
  const result = resolver.resolve(material);
  if (!result.ok) {
    throw new Error(
      result.suggestion ? `${result.reason}. Did you mean "${result.suggestion}"?` : result.reason,
    );
  }
  return result.block;
}

/** Resolve a list of materials into gradient stops spaced evenly across `[0, 1]`. */
export function resolveStops(
  materials: readonly string[],
  palette: Palette,
): { block: PackedBlock; at: number }[] {
  if (materials.length === 0) throw new Error("A gradient needs at least one material");
  if (materials.length === 1) return [{ block: resolveBlockOnly(materials[0]!, palette), at: 0 }];
  return materials.map((m, i) => ({
    block: resolveBlockOnly(m, palette),
    at: i / (materials.length - 1),
  }));
}

/** A short human-readable summary of what an operation changed. */
export function changeSummary(label: string, changed: number, buildId: string): string {
  return `${label}: ${changed.toLocaleString("en-US")} blocks changed in ${buildId}.`;
}
