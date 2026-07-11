# @mcbuild/renderer — the Camera / "Eyes" service

> Turns extracted region data (`.schem` / compact JSON from the plugin) into
> multi-angle PNGs for the LLM vision-critique loop. This package is the **Eyes** of
> the four-role architecture (see `BUILD_ENGINE_PLAN.md` §1.3, §6). It **never touches
> the world** — it only photographs data the plugin extracted.
>
> **Skeleton status:** the **camera framing math (`src/camera.ts`) is real and tested**.
> The mesher, asset extraction, `.schem` loading, and the Puppeteer host are **documented
> stubs** (`throw new Error("TODO M4…")`) — their interfaces and the load-bearing
> decisions are pinned down; the heavy bodies land in M4 (§9).

## Why the renderer exists at all: the plugin can't render (§6.1)

A Paper/Spigot **server** JVM cannot produce images. It holds only block-state data —
**no GPU, no OpenGL, and critically no client render assets** (block models, textures,
and blockstate mappings all live in the *client* jar). "The plugin takes a photo" is
therefore impossible. The plugin's job is strictly **data extraction** (`captureRegion`
-> `.schem` or compact JSON); **all rendering happens Node-side, here.** The MCP server
relays the resulting PNGs to Claude as base64 — the plugin never serves images it
didn't render.

## The renderer stack (hardened against the native-GL risk — §6.2, §11 #3)

The one genuine feasibility risk is an **offscreen WebGL context in Node**
(`headless-gl`/`gl`/`node-canvas-webgl`) — a notoriously fragile native module, worst
of all on Windows. So the primary path **avoids native GL entirely**:

| Path | Runtime | Role | Why |
|---|---|---|---|
| **Puppeteer + headless Chromium (SwiftShader)** | Node / Chromium | **PRIMARY** | three.js runs inside headless Chrome, which supplies WebGL through **SwiftShader** (Chromium's *software* rasterizer). **No native GL build; Windows-native out of the box** (§11 #3). A bit slower than a GPU, but portable and deterministic. |
| `headless-gl` | Node + native GL | **optional speed path** | Behind the *same* scene/camera contract, for when a fast native GL context is available (Linux CI / container). Purely an optimization — **never the only path**. |
| **Chunky** | **JVM** | **independent fallback + beauty pass** | A *different runtime* with *no Node-GL dependency*, so it fails independently of the whole Chromium/GL stack (§6.5). Also the final-presentation photoreal renderer (GI/AO/soft shadows), minutes per render, never in the tight loop. |

The two fallbacks (Puppeteer/SwiftShader on Node/Chromium, Chunky on the JVM) **share
nothing**, so they don't fail together — unlike the earlier "prismarine primary +
deepslate fallback", which both depended on the same native GL module.

**Real block models are mandatory.** The mesher draws real MC block models/blockstates
so stairs, slabs, fences, walls, panes, trapdoors, and logs-with-axis look native
(§6.2). A cube raycaster would make the LLM critique **rendering artifacts as build
flaws** — the exact failure mode the whole feedback loop must avoid (§12).

## Assets come from the pinned version's client `.jar` (§11 #2)

The project pins to the **latest** stable MC 1.21.x patch that Paper + FAWE ship for.
The npm asset packages (`minecraft-assets`) **lag** that patch by weeks. So:

- **Authoritative source:** extract block models / blockstates / textures directly from
  the **pinned version's client `.jar`** at build time (a zip under
  `assets/minecraft/{models,blockstates,textures}`). See `src/asset-extractor.ts`.
- `minecraft-data` supplies block-state **semantics**.
- The nearest published **`minecraft-assets`** version is a **rendering-only fallback**
  — block models change rarely within a major version, so it's usually visually correct
  even for a brand-new patch.

The extracted texture atlas' average per-tile color also bootstraps the engine's
per-block attribute DB (temperature/saturation, §5.6) — the renderer is the natural
owner of that color data.

## Deterministic lighting + the byte-stable contract (§6.3)

The MVP uses **flat, fixed, deterministic lighting** — a single "sun" at a fixed
45°/60° vector, full-bright floor, **no day-night cycle, no shadows**. Consistency
matters more than realism: the LLM must attribute a change between two renders to an
**edit**, not to lighting drift. (Photoreal GI is the Chunky beauty pass only.)

**Determinism contract:** identical `(region, preset, version)` ⇒ **byte-stable PNGs**,
so before/after diffs are meaningful. SwiftShader is deterministic across machines (no
driver variance) — the reason this path, not a real GPU, drives the diff loop. The host
fixes the viewport/DPR/color-profile, renders one frame, and normalizes the PNG bytes
(strip timestamp/text chunks, fixed compression) — see `src/puppeteer-host.ts`.

Output is **768×768 per shot** (matches vision-model tiling, keeps base64 small);
detail shots use 1024².

## Camera capture spec (§6.3)

Frame to the region bounding box:

```
center = (min + max) / 2
radius = 0.5 * ||max - min||
dist   = radius / sin(fov/2) * 1.15      # box fills ~80% of frame
```

**`review` preset (default, 5 shots):**

| Shot | Type | Azimuth | Elevation |
|---|---|---|---|
| orbit_NE | perspective | 45° | 35° |
| orbit_SE | perspective | 135° | 35° |
| orbit_SW | perspective | 225° | 35° |
| orbit_NW | perspective | 315° | 35° |
| top_ortho | **orthographic** | — | 90° |

FOV ~35° (mild). `detail` / `interior` / `cutaway` are **v2** and intentionally
unimplemented (`src/poses.ts`).

### Coordinate convention (Minecraft, right-handed, Y-up)

```
+X = East    -X = West
+Y = Up      -Y = Down
+Z = South   -Z = North
```

**Azimuth is a compass bearing, clockwise from North through East** (0°=N, 90°=E,
180°=S, 270°=W), so the horizontal direction is `(sin θ, 0, -cos θ)` and the corner
names line up exactly: `orbit_NE`'s eye sits at **+X/-Z** (East+North) and looks back at
the build. **Elevation** is the angle above horizontal (90° = straight down). At 90° the
world-up is degenerate, so the top-down shot's up-vector falls back to **North** — North
points to the top of the frame (map convention). Full derivation in `src/camera.ts`.

## Public contract

```ts
// The one entry point the MCP `photograph-region` tool calls (§4, §6.4):
renderRegion(data: RegionData, spec: CaptureSpec, deps?: RenderDeps): Promise<RenderedView[]>

// Per-image text caption for spatial grounding (shot, angle, dims, block count) (§6.4):
sidecarFor(view: RenderedView): string
```

Each `RenderedView` carries a base64 PNG + a structured `Sidecar`; the MCP result is N
`image/png` blocks (one per pose) each captioned by `sidecarFor`.

## Package layout

```
src/
├─ types.ts           RegionData (.schem/engine buffer layout) · CaptureSpec · ShotPose
│                     · CameraConfig · RenderedView · Sidecar · voxelIndex()      [REAL types]
├─ camera.ts          framing math: center/radius/dist, azimuth→eye, ortho frustum [REAL, tested]
├─ poses.ts           the `review` preset (§6.3 table) + preset→poses map          [REAL]
├─ schem-loader.ts    Sponge .schem v3 / JSON → RegionData (prismarine-nbt)         [STUB]
├─ asset-extractor.ts client-.jar model/blockstate/texture extraction + fallback   [STUB]
├─ mesher.ts          RegionData + models → serializable three.js scene            [STUB + boundsFor REAL]
├─ puppeteer-host.ts  headless Chromium + SwiftShader flags + determinism          [STUB + flag set REAL]
└─ index.ts           renderRegion() orchestrator + sidecarFor()                   [orchestration REAL, capture STUB]
test/
└─ camera.test.ts     azimuth convention · top_ortho straight-down · orbit quadrants
```

## What's real vs stubbed

- **Real:** all types/contracts; the entire camera math (`camera.ts`); the `review`
  poses; block counting + sidecars; `renderRegion`'s pose/camera/host wiring;
  `PuppeteerRenderHost.swiftShaderArgs()`; `mesher.boundsFor`.
- **Stubbed (M4 — bodies throw `TODO M4…`):** `.schem`/JSON parsing, `.jar` asset
  extraction + atlas packing, voxel→instanced-mesh expansion, and the actual
  Puppeteer/three.js screenshot. Each stub documents its real contract inline.

Nothing here has been built/type-checked in this environment (no Node toolchain
available); correctness of the stubs' surfaces is by inspection, the camera math by the
`test/camera.test.ts` assertions once a toolchain runs them.
