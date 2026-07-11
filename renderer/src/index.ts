/**
 * @mcbuild/renderer — public contract (BUILD_ENGINE_PLAN.md §6).
 *
 * The renderer is the "Eyes" of the four-role architecture: it turns extracted region
 * data into multi-angle PNGs for the LLM vision critique loop, and NEVER touches the
 * world. `renderRegion` is the one entry point the MCP `photograph-region` tool calls.
 *
 * WHAT'S REAL HERE: pose selection, camera computation (delegated to the fully-real
 * src/camera.ts), non-air block counting, and sidecar construction/formatting. WHAT'S
 * STUBBED: the mesh build (src/mesher.ts) and the pixel capture (src/puppeteer-host.ts)
 * — `renderRegion` wires them correctly and will work end-to-end once those M4 stubs
 * are filled.
 */

import { boundsFor, BlockModelMesher } from "./mesher.js";
import { PuppeteerRenderHost } from "./puppeteer-host.js";
import { computeCamera } from "./camera.js";
import { posesFor } from "./poses.js";
import type {
  CaptureSpec,
  RegionData,
  RenderedView,
  Sidecar,
} from "./types.js";
import type { AssetBundle } from "./asset-extractor.js";
import type { Mesher } from "./mesher.js";
import type { RenderHost } from "./puppeteer-host.js";

export * from "./types.js";
export {
  computeCamera,
  cameraDirection,
  frameRegion,
  frameDistance,
  aabbCorners,
  DEFAULT_FOV_DEG,
  FRAME_MARGIN,
} from "./camera.js";
export { PRESET_POSES, REVIEW_PRESET, posesFor } from "./poses.js";

/** Default square output edge in pixels (§6.3). */
export const DEFAULT_SIZE = 768;

/** Air-family blocks the mesher skips and the block count ignores. */
const AIR_BLOCKS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

function normalizeBlockName(state: string): string {
  // Strip blockstate props ("[...]") and normalize namespace, e.g.
  // "oak_stairs[facing=north]" -> "minecraft:oak_stairs".
  const base = state.split("[", 1)[0]!.trim();
  return base.includes(":") ? base : `minecraft:${base}`;
}

/**
 * Count non-air blocks in a region. Real + cheap: walk the palette once to find which
 * palette ids are air, then tally the voxel array. Used for the sidecar's `blockCount`.
 */
export function countNonAirBlocks(data: RegionData): number {
  const airIds = new Set<number>();
  data.palette.forEach((state, id) => {
    if (AIR_BLOCKS.has(normalizeBlockName(state))) airIds.add(id);
  });
  let count = 0;
  for (let i = 0; i < data.voxels.length; i++) {
    if (!airIds.has(data.voxels[i]!)) count++;
  }
  return count;
}

/** Injectable collaborators (defaults are the production stubs). Eases testing. */
export interface RenderDeps {
  mesher?: Mesher;
  host?: RenderHost;
  /** Resolved assets for the pinned version (from asset-extractor.ts). Required at run. */
  assets?: AssetBundle;
}

/**
 * Render a region into the preset's set of views (§6.3/§6.4).
 *
 * Orchestration (real wiring; mesh + capture are M4 stubs):
 *   1. resolve the pose list for `spec.preset` (rejects unimplemented v2 presets).
 *   2. frame with the LOCAL mesh AABB (0,0,0)..(w,h,l) — the mesh lives at the local
 *      origin, so the camera targets that box (src/camera.ts is translation-safe).
 *   3. mesh the region once (mesher), load it into the host once.
 *   4. per pose: computeCamera -> host.capture -> assemble a RenderedView + sidecar.
 *
 * @returns one {@link RenderedView} per pose, each carrying base64 PNG + a sidecar.
 */
export async function renderRegion(
  data: RegionData,
  spec: CaptureSpec,
  deps: RenderDeps = {}
): Promise<RenderedView[]> {
  const poses = posesFor(spec.preset);
  if (poses.length === 0) {
    throw new Error(
      `Preset "${spec.preset}" is not implemented in v1 (only "review" ships; detail/interior/cutaway are v2 — §6.3).`
    );
  }
  const assets = deps.assets;
  if (!assets) {
    throw new Error(
      "renderRegion requires resolved assets (deps.assets from asset-extractor.ts) — extract them once per pinned version (§11 #2)."
    );
  }

  const size = spec.size ?? DEFAULT_SIZE;
  const blockCount = countNonAirBlocks(data);
  const bounds = boundsFor(data); // local AABB (0,0,0)..(w,h,l)

  const mesher = deps.mesher ?? new BlockModelMesher();
  const host = deps.host ?? new PuppeteerRenderHost();

  const scene = mesher.build(data, assets);

  await host.launch();
  try {
    await host.setScene(scene);

    const views: RenderedView[] = [];
    for (const pose of poses) {
      const camera = computeCamera(pose, bounds, { aspect: 1 });
      const pngBase64 = await host.capture(camera, size);
      const sidecar: Sidecar = {
        shotName: pose.name,
        cameraType: pose.type,
        azimuthDeg: pose.azimuthDeg,
        elevationDeg: pose.elevationDeg,
        regionDims: data.dims,
        blockCount,
      };
      views.push({ name: pose.name, pose, pngBase64, sidecar });
    }
    return views;
  } finally {
    await host.close();
  }
}

/**
 * Format a view's structured {@link Sidecar} into the per-image text caption (§6.4) —
 * shot name, azimuth/elevation, region dims, block count — for spatial grounding when
 * the PNGs are handed to the vision model. REAL: pure formatter.
 */
export function sidecarFor(view: RenderedView): string {
  const s = view.sidecar;
  const angle =
    s.cameraType === "orthographic"
      ? "orthographic, top-down (elevation 90°)"
      : `perspective, azimuth ${s.azimuthDeg}° / elevation ${s.elevationDeg}°`;
  const { w, h, l } = s.regionDims;
  return [
    `Shot: ${s.shotName}`,
    `View: ${angle}`,
    `Region: ${w}×${h}×${l} (W×H×L blocks)`,
    `Blocks placed: ${s.blockCount}`,
  ].join("\n");
}
