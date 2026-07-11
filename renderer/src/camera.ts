/**
 * Camera framing math (BUILD_ENGINE_PLAN.md §6.3).
 *
 * This is the one part of the renderer implemented fully and correctly — it is easy
 * to get right, load-bearing for the determinism contract, and unit-testable without
 * any GPU/asset dependency (test/camera.test.ts). Everything else in the package is a
 * documented stub.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  COORDINATE CONVENTION (Minecraft, right-handed, Y-up)
 * ─────────────────────────────────────────────────────────────────────────────
 *   +X = East      -X = West
 *   +Y = Up        -Y = Down
 *   +Z = South     -Z = North
 *
 *   Azimuth θ is a COMPASS BEARING measured clockwise from North, through East:
 *       θ=0°   -> North (0, 0, -1)
 *       θ=90°  -> East  (1, 0,  0)
 *       θ=180° -> South (0, 0,  1)
 *       θ=270° -> West  (-1,0,  0)
 *   So the horizontal unit direction is (sin θ, 0, -cos θ).
 *
 *   Elevation φ is the angle above the horizontal plane (φ=90° looks straight down).
 *
 *   The camera SITS in the (azimuth, elevation) direction from the region center and
 *   looks back at it. Hence the review-preset corner names line up with azimuth:
 *       orbit_NE (45°)  -> eye at +X/-Z (East+North)
 *       orbit_SE (135°) -> eye at +X/+Z (East+South)
 *       orbit_SW (225°) -> eye at -X/+Z (West+South)
 *       orbit_NW (315°) -> eye at -X/-Z (West+North)
 *
 *  FRAMING (§6.3):
 *       center = (min + max) / 2
 *       radius = 0.5 * ||max - min||           (bounding-sphere radius)
 *       dist   = radius / sin(fov/2) * 1.15     (box fills ~80% of frame)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { CameraConfig, Region, ShotPose, Vec3 } from "./types.js";

/** Default (mild) vertical field of view for perspective shots, degrees (§6.3). */
export const DEFAULT_FOV_DEG = 35;

/** Frame margin so the box fills ~80% of the frame (the 1.15 in the dist formula). */
export const FRAME_MARGIN = 1.15;

/** Below this |dot(forward, worldUp)| the view is treated as vertical (degenerate up). */
const VERTICAL_EPS = 1e-6;

// ── minimal vec3 helpers (exported for tests) ────────────────────────────────

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < VERTICAL_EPS) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / len);
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Fallback up for straight-down/up views: North, so North points to the frame top. */
const NORTH: Vec3 = { x: 0, y: 0, z: -1 };

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

// ── framing primitives ───────────────────────────────────────────────────────

/**
 * Bounding-sphere framing of a region: its center and radius (§6.3).
 * The radius is clamped to a small floor so a degenerate (single-block / min==max)
 * region still yields a finite camera distance instead of dividing by zero.
 */
export function frameRegion(region: Region): { center: Vec3; radius: number } {
  const center = scale(add(region.min, region.max), 0.5);
  const radius = Math.max(0.5 * length(sub(region.max, region.min)), 0.5);
  return { center, radius };
}

/**
 * Unit direction FROM the region center TO the camera, for a (azimuth, elevation)
 * pose. See the coordinate convention above.
 *
 *   dir = ( cosφ·sinθ,  sinφ,  -cosφ·cosθ )
 */
export function cameraDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = deg2rad(azimuthDeg);
  const el = deg2rad(elevationDeg);
  const cosEl = Math.cos(el);
  return {
    x: cosEl * Math.sin(az),
    y: Math.sin(el),
    z: -cosEl * Math.cos(az),
  };
}

/**
 * Distance from the region center at which a perspective camera with the given
 * vertical FOV frames the bounding sphere with the standard margin (§6.3).
 */
export function frameDistance(radius: number, fovDeg: number): number {
  const halfFov = deg2rad(fovDeg) / 2;
  return (radius / Math.sin(halfFov)) * FRAME_MARGIN;
}

/**
 * Pick a reference up-vector and orthonormalize the camera basis.
 * For near-vertical views (|forward·worldUp| ≈ 1) worldUp is degenerate, so we fall
 * back to North. Returns { right, up } with `up` being the true (orthonormal) up.
 */
function computeBasis(forward: Vec3): { right: Vec3; up: Vec3 } {
  const refUp = Math.abs(dot(forward, WORLD_UP)) > 1 - VERTICAL_EPS ? NORTH : WORLD_UP;
  const right = normalize(cross(forward, refUp));
  const up = normalize(cross(right, forward));
  return { right, up };
}

// ── the public entry point ───────────────────────────────────────────────────

export interface ComputeCameraOptions {
  /** Viewport aspect ratio (width / height). Default 1 (square 768×768, §6.3). */
  aspect?: number;
  /** Vertical FOV for perspective shots. Default {@link DEFAULT_FOV_DEG}. */
  fovDeg?: number;
}

/**
 * Turn a pose + region AABB into a three.js-compatible {@link CameraConfig}.
 *
 * Both projection types position the eye along the pose direction at `frameDistance`
 * from the center and look back at the center. Perspective shots carry fov/aspect;
 * orthographic shots carry a frustum sized to the box's projected extent (rotation-
 * aware: it projects the 8 AABB corners onto the camera's right/up axes), fit to the
 * viewport aspect so nothing is distorted or clipped.
 *
 * NOTE on the frame used: the renderer meshes region data in a LOCAL frame
 * (0,0,0)..(w,h,l). Callers that mesh locally should pass a local AABB
 * `{min:{0,0,0}, max:{w,h,l}}`; the returned position/target are then in that same
 * local frame. Passing a world AABB works identically (framing is translation-safe).
 */
export function computeCamera(
  pose: ShotPose,
  region: Region,
  options: ComputeCameraOptions = {}
): CameraConfig {
  const aspect = options.aspect ?? 1;
  const fovDeg = options.fovDeg ?? DEFAULT_FOV_DEG;

  const { center, radius } = frameRegion(region);
  const dist = frameDistance(radius, fovDeg);

  const dir = cameraDirection(pose.azimuthDeg, pose.elevationDeg);
  const position = add(center, scale(dir, dist));
  // forward = from eye toward target; since dir is unit, this is exactly -dir.
  const forward = normalize(sub(center, position));
  const { right, up } = computeBasis(forward);

  // Near/far bracket the bounding sphere along the view axis, with a small margin.
  const near = Math.max(0.1, dist - radius - 1);
  const far = dist + radius + 1;

  if (pose.type === "perspective") {
    return {
      type: "perspective",
      position,
      target: center,
      up,
      near,
      far,
      fovDeg,
      aspect,
    };
  }

  // Orthographic: size the frustum to the projected extent of the AABB corners.
  const corners = aabbCorners(region);
  let halfW = 0;
  let halfH = 0;
  for (const c of corners) {
    const rel = sub(c, center);
    halfW = Math.max(halfW, Math.abs(dot(rel, right)));
    halfH = Math.max(halfH, Math.abs(dot(rel, up)));
  }
  // Fit to aspect: choose a half-height that contains both extents, then apply margin.
  const halfHeight = Math.max(halfH, halfW / aspect) * FRAME_MARGIN;
  const halfWidth = halfHeight * aspect;

  return {
    type: "orthographic",
    position,
    target: center,
    up,
    near,
    far,
    aspect,
    ortho: {
      left: -halfWidth,
      right: halfWidth,
      top: halfHeight,
      bottom: -halfHeight,
    },
  };
}

/** The 8 corners of a region's AABB. */
export function aabbCorners(region: Region): Vec3[] {
  const { min, max } = region;
  return [
    { x: min.x, y: min.y, z: min.z },
    { x: max.x, y: min.y, z: min.z },
    { x: min.x, y: max.y, z: min.z },
    { x: max.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z },
    { x: max.x, y: min.y, z: max.z },
    { x: min.x, y: max.y, z: max.z },
    { x: max.x, y: max.y, z: max.z },
  ];
}
