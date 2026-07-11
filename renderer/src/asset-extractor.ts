/**
 * Client-jar asset extraction (BUILD_ENGINE_PLAN.md §6.2, §11 #2) — INTERFACE + STUB.
 *
 * WHY THIS EXISTS: the project pins to the LATEST stable MC 1.21.x patch that Paper +
 * FAWE ship for (§11 #2). The npm asset packages (`minecraft-assets`) LAG that patch
 * by weeks. So the authoritative source of block models / blockstates / textures is
 * the pinned version's CLIENT `.jar` itself, extracted at build time. `minecraft-data`
 * supplies block-state SEMANTICS; the nearest published `minecraft-assets` is a
 * RENDERING-ONLY FALLBACK (block models change rarely within a major version, so the
 * fallback is usually visually correct even for a brand-new patch).
 *
 * These assets are what let the mesher draw real stairs/slabs/fences/logs-with-axis
 * (§6.2). Getting those right is the whole point — a cube raycaster would make the LLM
 * critique rendering artifacts as build flaws (§12).
 *
 * REAL IMPLEMENTATION NOTES:
 *  - A client `.jar` is a zip. The assets live under `assets/minecraft/`:
 *      models/block/*.json      (element boxes, faces, uv, `parent` chain, `textures`)
 *      models/item/*.json        (mostly irrelevant to block meshing)
 *      blockstates/*.json        (variant/multipart -> model + x/y/z rotation + uvlock)
 *      textures/block/*.png      (16×16 tiles; some animated as vertical strips + .mcmeta)
 *  - Resolve the `parent` chain (block/block -> block/cube -> …) and merge `textures`
 *    top-down so `#all`/`#side`/`#top` refs bottom out at real texture paths.
 *  - Build a texture ATLAS (pack tiles into one image) and a UV table; the in-page
 *    three.js harness samples that atlas. The atlas' average per-tile color also
 *    bootstraps the engine's block-attribute temperature/saturation DB (§5.6) — the
 *    renderer is the natural owner of that color data.
 *  - Cache the extracted+resolved bundle on disk keyed by version so extraction runs
 *    once per pinned patch, not per render.
 */

/** Fully-resolved model for one block state, ready for the mesher (elements + UVs). */
export interface ResolvedBlockModel {
  /** The blockstate string this resolves, e.g. "minecraft:oak_stairs[facing=east,...]". */
  state: string;
  /** Cuboid elements with per-face texture + uv, after parent-chain + rotation resolve. */
  elements: unknown[];
  /** Whether the model is a full opaque cube (lets the mesher cull hidden faces fast). */
  fullCube: boolean;
}

/** A packed texture atlas + the UV lookup the in-page harness needs. */
export interface TextureAtlas {
  /** PNG bytes of the packed atlas. */
  png: Uint8Array;
  /** texture path -> [u0, v0, u1, v1] in atlas UV space. */
  uv: Map<string, [number, number, number, number]>;
  /** Average linear RGB per texture path (bootstraps the §5.6 attribute DB). */
  averageColor: Map<string, [number, number, number]>;
}

/** The complete asset bundle for one pinned MC version. */
export interface AssetBundle {
  version: string;
  atlas: TextureAtlas;
  /** Resolve a blockstate string to its meshable model (blockstate variant selection). */
  resolve(state: string): ResolvedBlockModel | undefined;
}

export interface AssetSource {
  /** Extract + resolve assets for a pinned version from a client `.jar`. */
  fromClientJar(jarPath: string, version: string): Promise<AssetBundle>;
  /** Fallback: load the nearest published `minecraft-assets` bundle (rendering-only). */
  fromMinecraftAssets(version: string): Promise<AssetBundle>;
}

/**
 * Default asset source.
 *
 * STUB: bodies throw. The `.jar` layout + parent/atlas resolution above is the real
 * contract; the zip walk, model resolver, and atlas packer are deferred (M4, §9).
 */
export class ClientJarAssetSource implements AssetSource {
  fromClientJar(_jarPath: string, _version: string): Promise<AssetBundle> {
    throw new Error(
      "TODO M4: unzip client .jar, resolve model parent chains + blockstates, pack a texture atlas (see asset-extractor.ts notes)."
    );
  }

  fromMinecraftAssets(_version: string): Promise<AssetBundle> {
    throw new Error(
      "TODO M4: load nearest `minecraft-assets` version as the rendering-only fallback (§11 #2)."
    );
  }
}
