/**
 * `@mcbuild/engine` — a deterministic build engine for Minecraft 1.8.
 *
 * The engine exists to move the level of abstraction. Instead of an agent emitting thousands of
 * `place_block` calls, it declares intent — *a circular tower of radius 12 and height 35*, *an
 * eight-team BedWars map in the carousel style with a 34-block rush* — and the engine owns the
 * geometry, the materials, the validation and the preview.
 *
 * ```
 * intent -> plan -> geometry ops -> voxel volume -> validation -> preview + .schematic
 * ```
 *
 * Nothing here talks to a server. A build is a `Volume` in memory until something exports it, which
 * is what makes "look at it before it goes live" the default rather than an extra step.
 *
 * Zero runtime dependencies: the NBT codec, the PNG encoder, the noise and the renderer are all
 * in-tree, so the whole pipeline runs anywhere Node runs.
 */

// -- Core -----------------------------------------------------------------------------------------
export * from "./core/vec.js";
export * from "./core/volume.js";
export * from "./core/prng.js";
export * from "./core/noise.js";

// -- Minecraft 1.8 ---------------------------------------------------------------------------------
export * from "./mc18/blocks.js";
export * from "./mc18/material.js";
export * from "./mc18/rotation.js";
export * from "./mc18/palette.js";

// -- Schematic I/O ---------------------------------------------------------------------------------
export * from "./schematic/nbt.js";
export * from "./schematic/schematic.js";

// -- Geometry and operations -----------------------------------------------------------------------
export * from "./geom/shapes.js";
export * from "./ops/transform.js";
export * from "./ops/edit.js";
export * from "./ops/symmetry.js";

// -- Terrain, structures, sculpture ----------------------------------------------------------------
export * from "./terrain/island.js";
export * from "./structures/roof.js";
export * from "./structures/building.js";
export * from "./structures/connections.js";
export * from "./structures/arena.js";
export * from "./sculpture/voxel-sculpture.js";
export * from "./sculpture/archetypes.js";

// -- Style knowledge base --------------------------------------------------------------------------
export * from "./style/profile.js";
export * from "./style/analyze.js";
export * from "./style/components.js";
export * from "./style/library.js";
export * from "./style/blend.js";

// -- History and structure graph -------------------------------------------------------------------
export * from "./history/graph.js";
export * from "./history/history.js";

// -- Validation ------------------------------------------------------------------------------------
export * from "./validate/constraints.js";
export * from "./validate/inspect.js";
export * from "./validate/gameplay.js";

// -- Rendering ---------------------------------------------------------------------------------------
export * from "./render/png.js";
export * from "./render/raster.js";
export * from "./render/voxel-renderer.js";
export * from "./render/overlay.js";
export * from "./render/views.js";

// -- Domain generators -------------------------------------------------------------------------------
export * from "./domain/bedwars.js";
export * from "./domain/duels.js";

// -- Project output ----------------------------------------------------------------------------------
export * from "./project/output.js";
