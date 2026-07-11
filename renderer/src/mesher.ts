/**
 * Voxel-to-mesh conversion (BUILD_ENGINE_PLAN.md §6.2) — INTERFACE + STUB.
 *
 * The mesher turns {@link RegionData} + resolved block models (from
 * asset-extractor.ts) into a three.js scene description. THIS FIDELITY IS
 * LOAD-BEARING (§6.2, §12): the whole reason for a real-model renderer instead of a
 * cube raycaster is that stairs, slabs, fences, walls, panes, trapdoors, and
 * logs-with-axis are exactly what make a build read as "native Minecraft". If the
 * mesher drew everything as full cubes, the LLM critic would flag rendering artifacts
 * as build flaws and the feedback loop would chase ghosts.
 *
 * ARCHITECTURE (why the output is a serializable DESCRIPTION, not a live THREE.Scene):
 *  The actual three.js scene is built INSIDE the headless-Chromium page (§6.2,
 *  src/puppeteer-host.ts). A live `THREE.Scene` object cannot cross the Node↔page
 *  boundary. So the mesher emits a JSON-serializable {@link MeshedScene} — instanced
 *  geometry keyed by (model, rotation) + an atlas reference — which `page.evaluate`
 *  reconstructs into real THREE geometry. This keeps the heavy per-block work in Node
 *  and the GL work in the page.
 *
 * REAL IMPLEMENTATION NOTES:
 *  - Iterate voxels via {@link voxelIndex}; skip air palette entries.
 *  - For each non-air cell, resolve its blockstate -> ResolvedBlockModel, apply the
 *    blockstate rotation, and emit one instance (position = local x/y/z). Batch
 *    instances by model so the page can use THREE.InstancedMesh (millions of blocks).
 *  - Cull faces against opaque neighbors (`fullCube`) to cut geometry ~6×.
 *  - Biome-tint grass/foliage/water via RegionData.biomes.
 *  - Fixed deterministic lighting (§6.3): a single directional "sun" at a fixed
 *    45°/60° vector, full-bright ambient, NO shadows / NO day-night in the MVP — the
 *    scene must be byte-stable so before/after diffs are meaningful. Emit the light
 *    rig here as part of the scene so the harness stays dumb.
 *  - NBT decoration (item-frame art, paintings, banners, sign text, chiseled-bookshelf
 *    fill) is STUBBED as neutral placeholders and EXCLUDED from vision scoring in v1
 *    (§5.4.5 caveat, §11). Geometry still records "an item-frame exists"; the picture
 *    on it is not drawn.
 */

import type { AssetBundle } from "./asset-extractor.js";
import type { RegionData, Vec3 } from "./types.js";

/** One placed block instance in local mesh space (§6.2 instancing). */
export interface BlockInstance {
  /** Index into MeshedScene.models. */
  model: number;
  /** Local position (block coords). */
  pos: Vec3;
  /** Blockstate-derived rotation in degrees about Y (and rarely X), for instancing. */
  rotY: number;
  rotX: number;
}

/** A fixed deterministic light (§6.3). */
export interface LightRig {
  /** Direction the sun points FROM (normalized). Fixed 45°/60° — never day-night. */
  sunDir: Vec3;
  /** Ambient term so shadowed faces stay readable (full-bright floor, no shadows). */
  ambient: number;
}

/**
 * A JSON-serializable scene description handed to the in-page three.js harness.
 * (Deliberately NOT a live THREE.Scene — see the architecture note above.)
 */
export interface MeshedScene {
  /** Distinct resolved models referenced by instances (dedup for InstancedMesh). */
  models: unknown[];
  /** Every non-air block as an instance. */
  instances: BlockInstance[];
  /** Local-frame AABB of the mesh: min is (0,0,0), max is (w,h,l). Used for framing. */
  bounds: { min: Vec3; max: Vec3 };
  light: LightRig;
  /** Reference to the texture atlas the harness binds. */
  atlasPng: Uint8Array;
}

/** Meshes region data into a serializable scene for the render harness. */
export interface Mesher {
  build(data: RegionData, assets: AssetBundle): MeshedScene;
}

/**
 * Default mesher.
 *
 * STUB: `build` throws. The instancing / face-culling / light-rig contract above is
 * real; the per-block model expansion is deferred (M4, §9). Note `boundsFor` below is
 * implemented — it is the (real) local AABB the camera frames.
 */
export class BlockModelMesher implements Mesher {
  build(_data: RegionData, _assets: AssetBundle): MeshedScene {
    throw new Error(
      "TODO M4: expand voxels into instanced block-model geometry (see mesher.ts notes: fidelity is load-bearing)."
    );
  }
}

/**
 * The local-frame AABB the camera should frame: (0,0,0)..(w,h,l). Real + trivial —
 * the mesh is always built at the local origin, so this is what computeCamera receives
 * (see src/index.ts). Kept here so the framing frame-of-reference lives with the mesh.
 */
export function boundsFor(data: RegionData): { min: Vec3; max: Vec3 } {
  return {
    min: { x: 0, y: 0, z: 0 },
    max: { x: data.dims.w, y: data.dims.h, z: data.dims.l },
  };
}
