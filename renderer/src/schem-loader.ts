/**
 * Region-data loading (BUILD_ENGINE_PLAN.md §6.2, §7.3) — INTERFACE + STUB.
 *
 * The plugin's `captureRegion` emits either a Sponge `.schem` (v3) blob or a compact
 * JSON form. Both deserialize into the SAME {@link RegionData} because the `.schem`
 * `Blocks` compound (Palette map + varint `Data` array, indexed x + z*W + y*W*L) maps
 * 1:1 onto our voxel buffer (§7.3). Loading is therefore near-zero cost.
 *
 * REAL IMPLEMENTATION NOTES (for whoever fills these in):
 *  - Use `prismarine-nbt` (`parse(buffer)`) to read the gzipped NBT. Sponge v3 nests
 *    everything under a `Schematic` root: `Width`/`Height`/`Length` (shorts),
 *    `Offset` (int[3]), `DataVersion` (int), and a `Blocks` compound holding
 *    `Palette` (compound: blockstate-string -> int id), `Data` (varint-packed byte
 *    array of palette ids in x + z*W + y*W*L order), and optional
 *    `BlockEntities` (list of compounds with `Pos`, `Id`, and NBT).
 *  - Sponge v2 puts `Palette`/`BlockData`/`Offset` at the root and lacks the `Blocks`
 *    wrapper; support it behind a version check (root has `Version:2`).
 *  - Decode the varint `Data`/`BlockData` stream into a `Uint16Array` of the same
 *    length as W*H*L (palette ids rarely exceed 16 bits for a single build region).
 *  - Convert `Palette` (string->id) into our `palette: string[]` (id->string) by
 *    inverting the map, preserving ids so `voxels` indices stay valid.
 *  - Map `BlockEntities[].Pos` (relative x/y/z) through {@link voxelIndex} to build
 *    the `blockEntities` map; keep the raw NBT compound as the value.
 *  - `origin` = `Offset` (or the region.min the plugin recorded).
 */

import type { RegionData } from "./types.js";

/** Loads region data extracted by the plugin. */
export interface SchemLoader {
  /** Parse a Sponge `.schem` (v3, with a v2 fallback) NBT blob. */
  loadSchem(buffer: Uint8Array): Promise<RegionData>;
  /** Parse the compact JSON form used for tight iterate loops (§6.2). */
  loadJson(json: unknown): RegionData;
}

/**
 * Default loader.
 *
 * STUB: bodies throw. The interface and the field mapping above are the real contract;
 * the NBT/varint decoding is deferred (M4, §9). See prismarine-nbt for `parse`.
 */
export class PrismarineSchemLoader implements SchemLoader {
  loadSchem(_buffer: Uint8Array): Promise<RegionData> {
    throw new Error(
      "TODO M4: parse Sponge .schem via prismarine-nbt into RegionData (see schem-loader.ts field map)."
    );
  }

  loadJson(_json: unknown): RegionData {
    throw new Error(
      "TODO M4: validate + map compact capture JSON into RegionData (palette + Uint16Array voxels)."
    );
  }
}
