/**
 * Camera math tests (BUILD_ENGINE_PLAN.md §6.3).
 *
 * The camera math is the one fully-real piece of the renderer, so it is the one piece
 * with tests. These assert the coordinate convention (azimuth = compass bearing
 * clockwise from North) and the two edge behaviors called out in the task: `top_ortho`
 * looks straight down, and `orbit_NE` sits at +X/-Z (East+North) above the build.
 *
 * A couple of assertions are intentionally coarse (this is a stub suite); golden-image
 * pixel tests come with the M4 render implementation (§9, §10 "golden-image").
 */

import test from "ava";
import {
  cameraDirection,
  computeCamera,
  frameRegion,
  sub,
  normalize,
} from "../src/camera.js";
import type { Vec3 } from "../src/types.js";
import { REVIEW_PRESET } from "../src/poses.js";

const REGION = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 8, z: 6 } };
const CENTER: Vec3 = { x: 5, y: 4, z: 3 };
const EPS = 1e-6;

function poseNamed(name: string) {
  const p = REVIEW_PRESET.find((s) => s.name === name);
  if (!p) throw new Error(`no pose ${name}`);
  return p;
}

test("cameraDirection: azimuth is a compass bearing clockwise from North", (t) => {
  // N = -Z, E = +X, S = +Z, W = -X.
  const n = cameraDirection(0, 0);
  t.true(Math.abs(n.x) < EPS && Math.abs(n.y) < EPS && Math.abs(n.z + 1) < EPS, "0° -> North (0,0,-1)");

  const e = cameraDirection(90, 0);
  t.true(Math.abs(e.x - 1) < EPS && Math.abs(e.y) < EPS && Math.abs(e.z) < EPS, "90° -> East (1,0,0)");

  const s = cameraDirection(180, 0);
  t.true(Math.abs(s.z - 1) < EPS, "180° -> South (+Z)");

  const w = cameraDirection(270, 0);
  t.true(Math.abs(w.x + 1) < EPS, "270° -> West (-X)");
});

test("frameRegion: center is the midpoint, radius half the diagonal", (t) => {
  const { center, radius } = frameRegion(REGION);
  t.deepEqual(center, CENTER);
  t.is(radius, 0.5 * Math.hypot(10, 8, 6));
});

test("frameRegion: degenerate region gets a nonzero radius (no div-by-zero)", (t) => {
  const { radius } = frameRegion({ min: { x: 3, y: 3, z: 3 }, max: { x: 3, y: 3, z: 3 } });
  t.true(radius > 0);
});

test("top_ortho looks straight down", (t) => {
  const cam = computeCamera(poseNamed("top_ortho"), REGION);

  t.is(cam.type, "orthographic");
  t.truthy(cam.ortho, "orthographic frustum is set");

  // Eye sits directly above the center.
  t.true(cam.position.y > cam.target.y, "eye above target");
  t.true(Math.abs(cam.position.x - CENTER.x) < EPS, "eye over center in X");
  t.true(Math.abs(cam.position.z - CENTER.z) < EPS, "eye over center in Z");

  // Forward points straight down.
  const forward = normalize(sub(cam.target, cam.position));
  t.true(Math.abs(forward.y + 1) < EPS, "forward is -Y");

  // Up is horizontal (North), since world-up is degenerate looking straight down.
  t.true(Math.abs(cam.up.y) < EPS, "up is horizontal");
  t.true(Math.abs(cam.up.z + 1) < EPS, "up points North (0,0,-1) -> North at frame top");
});

test("orbit_NE sits at +X / -Z (East+North) and above the build", (t) => {
  const cam = computeCamera(poseNamed("orbit_NE"), REGION);

  t.is(cam.type, "perspective");
  t.true(cam.position.x > CENTER.x, "east of center (+X)");
  t.true(cam.position.z < CENTER.z, "north of center (-Z)");
  t.true(cam.position.y > CENTER.y, "above center (+Y)");
  t.true(cam.up.y > 0, "up has a positive world-up component for an orbit shot");
  t.is(cam.fovDeg, 35);
});

test("the four orbit corners map to the right quadrants", (t) => {
  const quadrant = (name: string) => {
    const cam = computeCamera(poseNamed(name), REGION);
    return {
      east: cam.position.x > CENTER.x,
      south: cam.position.z > CENTER.z,
    };
  };
  t.deepEqual(quadrant("orbit_NE"), { east: true, south: false });
  t.deepEqual(quadrant("orbit_SE"), { east: true, south: true });
  t.deepEqual(quadrant("orbit_SW"), { east: false, south: true });
  t.deepEqual(quadrant("orbit_NW"), { east: false, south: false });
});

test("orthographic frustum encloses the region footprint", (t) => {
  const cam = computeCamera(poseNamed("top_ortho"), REGION);
  const o = cam.ortho!;
  // Looking down: right axis = East (X, half-extent 5), up axis = North (Z, half-extent 3).
  // Frustum is fit to a square (aspect 1) with the 1.15 margin, so it must cover both.
  t.true(o.right >= 5, "covers X half-extent");
  t.true(o.top >= 3, "covers Z half-extent");
  t.true(o.right === -o.left && o.top === -o.bottom, "symmetric frustum");
  t.true(cam.far > cam.near && cam.near > 0, "sane near/far");
});
