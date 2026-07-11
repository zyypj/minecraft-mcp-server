/**
 * Headless-Chromium render host (BUILD_ENGINE_PLAN.md §6.2, §11 #3) — STUB.
 *
 * This is the PRIMARY renderer path and the reason the whole stack is Windows-native
 * with no native GL build (§11 #3): three.js runs INSIDE headless Chromium, which
 * supplies WebGL through SwiftShader (Chromium's software rasterizer). That avoids the
 * fragile `headless-gl` native module entirely. `headless-gl` stays an OPTIONAL speed
 * path behind this same contract; Chunky (JVM) is the independent fallback (§6.2/§6.5).
 *
 * ── LAUNCH FLAGS (the load-bearing part) ─────────────────────────────────────
 * Chromium normally refuses WebGL when headless / GPU-less. These flags force the
 * SwiftShader software GL path so `canvas.getContext('webgl2')` succeeds off-GPU:
 *
 *   --headless=new                       modern headless (real GL stack, unlike legacy)
 *   --use-gl=angle                       route GL through ANGLE...
 *   --use-angle=swiftshader              ...backed by SwiftShader (software) — the key pair
 *   --enable-unsafe-swiftshader          allow SwiftShader in newer Chromium builds
 *   --disable-gpu                        no hardware GPU (we want the software path)
 *   --in-process-gpu                     avoids a flaky GPU-process handshake in headless
 *   --no-sandbox                         needed in many CI/container/Windows-service envs
 *   --hide-scrollbars --force-color-profile=srgb   pixel stability (see determinism)
 *
 * (Older recipes used `--use-gl=swiftshader` directly; the ANGLE+SwiftShader pair is
 *  the current reliable combo. Spike the exact set before M4 commits — §12.)
 *
 * ── DETERMINISM (§6.3 contract: identical (region, preset, version) => byte-stable PNG)
 *  - Fixed viewport + deviceScaleFactor=1 (no DPR scaling).
 *  - Force sRGB color profile; disable animations/day-night; fixed light rig (mesher).
 *  - `preserveDrawingBuffer:true`, render one frame, read it back synchronously —
 *    never screenshot mid-frame.
 *  - Prefer `gl.readPixels` -> encode PNG deterministically (or Puppeteer
 *    `page.screenshot({type:'png'})`), then run the bytes through `sharp` to strip the
 *    PNG tEXt/tIME chunks and re-encode at a fixed compression level, so two runs are
 *    byte-identical. SwiftShader is deterministic across machines (no driver variance),
 *    which is the reason this path — not a real GPU — is chosen for the diff loop.
 *
 * ── DATA FLOW ────────────────────────────────────────────────────────────────
 *  1. launch() once; reuse the browser across a build's shots (cheap orbit re-aim).
 *  2. loadHarness(): open an about:blank page, inject bundled three.js + the harness
 *     script (an offscreen <canvas> renderer with a `renderView(scene, camera)` fn).
 *  3. setScene(scene): pass the serializable MeshedScene into the page via
 *     `page.evaluate`; the harness reconstructs InstancedMeshes + the light rig once.
 *  4. capture(camera, size): set the page camera from the CameraConfig (position /
 *     lookAt / up / fov|ortho-frustum / near / far), size the canvas to size×size,
 *     render one frame, screenshot, normalize, return base64.
 */

import type { CameraConfig } from "./types.js";
import type { MeshedScene } from "./mesher.js";

/** How the host was configured (which GL backend, headful debug, etc.). */
export interface RenderHostOptions {
  /** "swiftshader" (default, portable) | "gl" (optional headless-gl speed path). */
  backend?: "swiftshader" | "gl";
  /** Extra Chromium args appended to the SwiftShader flag set. */
  extraArgs?: string[];
  /** Run headful for debugging (never in prod — breaks determinism). */
  headful?: boolean;
}

/**
 * A render host: owns a browser + the three.js harness page, renders one scene from
 * many cameras. Implementations must satisfy the determinism contract above.
 */
export interface RenderHost {
  /** Launch the browser with the SwiftShader flag set + open the harness page. */
  launch(): Promise<void>;
  /** Load a meshed scene into the page once; subsequent captures just re-aim. */
  setScene(scene: MeshedScene): Promise<void>;
  /** Render one shot; returns base64 PNG (no data: prefix). `size` is the square edge. */
  capture(camera: CameraConfig, size: number): Promise<string>;
  /** Tear down the browser. */
  close(): Promise<void>;
}

/**
 * Puppeteer + headless-Chromium + SwiftShader host — the primary path (§6.2).
 *
 * STUB: all bodies throw. The launch flags, determinism approach, and data flow above
 * are the real contract; the Puppeteer wiring + in-page three.js harness are deferred
 * (M4, §9). Spike the full flag chain before M4 per §12's high-severity render risk.
 */
export class PuppeteerRenderHost implements RenderHost {
  constructor(private readonly options: RenderHostOptions = {}) {}

  /** The SwiftShader flag set documented above (exposed for the M4 spike + tests). */
  static swiftShaderArgs(extra: string[] = []): string[] {
    return [
      "--headless=new",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-gpu",
      "--in-process-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      ...extra,
    ];
  }

  launch(): Promise<void> {
    throw new Error(
      "TODO M4: puppeteer.launch with PuppeteerRenderHost.swiftShaderArgs() and open the three.js harness page (see puppeteer-host.ts)."
    );
  }

  setScene(_scene: MeshedScene): Promise<void> {
    throw new Error("TODO M4: inject MeshedScene into the page harness via page.evaluate.");
  }

  capture(_camera: CameraConfig, _size: number): Promise<string> {
    throw new Error(
      "TODO M4: set the page camera from CameraConfig, render one deterministic frame, screenshot -> normalize (sharp) -> base64."
    );
  }

  close(): Promise<void> {
    throw new Error("TODO M4: close the browser.");
  }
}
