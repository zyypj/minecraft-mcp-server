/**
 * Capture presets — the named camera poses for each preset (BUILD_ENGINE_PLAN.md §6.3).
 *
 * A "pose" is a direction to look FROM (azimuth + elevation) plus a projection type.
 * The concrete camera (position / lookAt / frustum) is derived per-region by
 * src/camera.ts::computeCamera, which frames the region's bounding box.
 */

import type { Preset, ShotPose } from "./types.js";

/**
 * The `review` preset — the v1 default, 5 shots (§6.3 table). Four perspective
 * orbit corners at elevation 35° + one orthographic top-down.
 *
 * Azimuth is a compass bearing CLOCKWISE from North (0°=N, 90°=E, 180°=S, 270°=W),
 * so the corner names line up: NE=45°, SE=135°, SW=225°, NW=315°
 * (see the coordinate convention doc in src/camera.ts).
 */
export const REVIEW_PRESET: ShotPose[] = [
  { name: "orbit_NE", type: "perspective", azimuthDeg: 45, elevationDeg: 35 },
  { name: "orbit_SE", type: "perspective", azimuthDeg: 135, elevationDeg: 35 },
  { name: "orbit_SW", type: "perspective", azimuthDeg: 225, elevationDeg: 35 },
  { name: "orbit_NW", type: "perspective", azimuthDeg: 315, elevationDeg: 35 },
  // Straight down. Azimuth is irrelevant at elevation 90° (see computeUp), fixed to 0.
  { name: "top_ortho", type: "orthographic", azimuthDeg: 0, elevationDeg: 90 },
];

/**
 * Preset -> ordered pose list. Only `review` is populated in v1.
 *
 * `detail` / `interior` / `cutaway` are v2 (§6.3 "v2 add-ons"): `detail` auto-aims at
 * the highest block-entropy cluster, `interior` puts the camera inside the box with
 * roof-culling, `cutaway` slices a cross-section. They need scene analysis the mesher
 * doesn't do yet, so their pose lists are intentionally empty and the orchestrator
 * rejects them (src/index.ts).
 */
export const PRESET_POSES: Record<Preset, ShotPose[]> = {
  review: REVIEW_PRESET,
  detail: [], // v2 — auto-aimed close-ups (needs block-entropy analysis)
  interior: [], // v2 — inside-the-box, roof-culled (§6.3: "harder than any exterior orbit")
  cutaway: [], // v2 — cross-section slice
};

/** Convenience: the pose list for a preset (empty for unimplemented presets). */
export function posesFor(preset: Preset): ShotPose[] {
  return PRESET_POSES[preset];
}
