/**
 * The voxel renderer — the engine's eyes.
 *
 * A generated map is only useful if it can be judged before it reaches a server, and judging a
 * BedWars map means seeing four things: the silhouette from outside, the layout from directly
 * above, the relative heights from the side, and where the gameplay points sit. This renderer
 * produces exactly those.
 *
 * ## How it draws
 *
 * Every non-air cell becomes a box whose size comes from its render class (a slab is half height, a
 * carpet is a sixteenth, a flower is a thin cross-section). Faces of full cubes that touch another
 * full cube are culled. Each remaining face is projected and rasterized with a per-face brightness
 * and per-corner ambient occlusion, which is what gives a flat-coloured voxel scene readable form.
 *
 * Translucent blocks (glass, water, ice, leaves) draw in a second pass, sorted back to front and
 * not writing depth, so a glass dome does not erase the build behind it.
 */

import { type Vec3, vec } from "../core/vec.js";
import { AIR, type PackedBlock, type Volume } from "../core/volume.js";
import { blockAlpha, blockColor, renderClass } from "../mc18/blocks.js";
import {
  Framebuffer,
  type Mat4,
  type ScreenVertex,
  lookAt,
  mat4Multiply,
  orthographic,
  perspective,
  projectVertex,
} from "./raster.js";

/** Camera placement, expressed the way a person describes a viewpoint. */
export interface CameraSpec {
  /** Compass direction the camera looks *from*, in degrees clockwise from north. */
  readonly azimuthDegrees: number;
  /** Angle above the horizon, in degrees. 90 looks straight down. */
  readonly elevationDegrees: number;
  readonly projection: "perspective" | "orthographic";
  /** Vertical field of view for perspective shots. */
  readonly fovDegrees?: number;
  /** Multiplier on the auto-computed framing distance. Above 1 pulls back. */
  readonly zoom?: number;
  /** Roll the camera so a top-down shot has a chosen compass direction up. */
  readonly upAzimuthDegrees?: number;
}

export interface RenderOptions {
  readonly width?: number;
  readonly height?: number;
  readonly camera: CameraSpec;
  /** Sky gradient, top and bottom, as `0xRRGGBB`. */
  readonly background?: readonly [number, number];
  /** Supersampling factor. 2 renders at double resolution and downsamples — worth it for previews. */
  readonly supersample?: 1 | 2 | 3;
  /** Direction the key light comes from, as a compass bearing. Shifts which faces read brightest. */
  readonly lightAzimuthDegrees?: number;
  /** Skip cells below this Y. Useful for cutaways. */
  readonly minY?: number;
  readonly maxY?: number;
}

export interface RenderResult {
  readonly framebuffer: Framebuffer;
  /** Combined view-projection, so overlays can place markers at world positions. */
  readonly viewProjection: Mat4;
  readonly width: number;
  readonly height: number;
  /** Project a build-space position to pixel coordinates in the final (downsampled) image. */
  project(p: Vec3): { x: number; y: number; depth: number; visible: boolean };
}

/** Face brightness. The sun is high and to one side; the ground bounce keeps undersides readable. */
const FACE_LIGHT: Readonly<Record<Face, number>> = {
  top: 1.0,
  bottom: 0.45,
  north: 0.72,
  south: 0.86,
  east: 0.66,
  west: 0.78,
};

type Face = "top" | "bottom" | "north" | "south" | "east" | "west";

const FACE_NORMALS: Readonly<Record<Face, Vec3>> = {
  top: vec(0, 1, 0),
  bottom: vec(0, -1, 0),
  north: vec(0, 0, -1),
  south: vec(0, 0, 1),
  east: vec(1, 0, 0),
  west: vec(-1, 0, 0),
};

/** Corner offsets of each face, counter-clockwise seen from outside, in unit-cube space. */
const FACE_CORNERS: Readonly<Record<Face, readonly [number, number, number][]>> = {
  top: [
    [0, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
  ],
  bottom: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
  north: [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
  ],
  south: [
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  east: [
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
    [1, 0, 1],
  ],
  west: [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
  ],
};

/** The box a block occupies inside its cell, as `[min, max]` in `[0,1]` units. */
function boxForBlock(block: PackedBlock): { min: Vec3; max: Vec3; fullCube: boolean } | null {
  const cls = renderClass(block);
  switch (cls) {
    case "air":
      return null;
    case "cube":
    case "stairs":
      // Stairs draw as a full cube: at preview scale the step is a pixel, and the silhouette of the
      // massing is what the viewer is judging.
      return { min: vec(0, 0, 0), max: vec(1, 1, 1), fullCube: true };
    case "translucent":
    case "liquid":
      return { min: vec(0, 0, 0), max: vec(1, 1, 1), fullCube: false };
    case "slab":
      // Data bit 3 selects a top slab.
      return (block & 0x8) !== 0
        ? { min: vec(0, 0.5, 0), max: vec(1, 1, 1), fullCube: false }
        : { min: vec(0, 0, 0), max: vec(1, 0.5, 1), fullCube: false };
    case "carpet":
      return { min: vec(0, 0, 0), max: vec(1, 0.0625, 1), fullCube: false };
    case "pane":
      return { min: vec(0.4375, 0, 0), max: vec(0.5625, 1, 1), fullCube: false };
    case "fence":
      return { min: vec(0.375, 0, 0.375), max: vec(0.625, 1, 0.625), fullCube: false };
    case "wall":
      return { min: vec(0.25, 0, 0.25), max: vec(0.75, 1, 0.75), fullCube: false };
    case "cross":
      return { min: vec(0.2, 0, 0.2), max: vec(0.8, 0.8, 0.8), fullCube: false };
    case "thin":
      return { min: vec(0.4, 0, 0.4), max: vec(0.6, 0.6, 0.6), fullCube: false };
    case "other":
      return { min: vec(0.06, 0, 0.06), max: vec(0.94, 0.94, 0.94), fullCube: false };
  }
}

/** Blocks that hide the faces behind them. */
function occludes(block: PackedBlock): boolean {
  if (block === AIR) return false;
  const cls = renderClass(block);
  return cls === "cube" || cls === "stairs";
}

interface QuadJob {
  readonly face: Face;
  readonly cell: Vec3;
  readonly box: { min: Vec3; max: Vec3 };
  readonly color: number;
  readonly alpha: number;
  /** Per-corner ambient occlusion factors, matching FACE_CORNERS order. */
  readonly ao: readonly [number, number, number, number];
  /** View depth of the face centre, used to sort the translucent pass. */
  depth: number;
}

/**
 * Standard voxel ambient occlusion: a corner darkens with the number of the three cells touching it
 * that are solid, with the classic "both sides solid" case treated as fully occluded.
 */
function cornerAo(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0.55;
  const n = (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0);
  return [1, 0.85, 0.72, 0.62][n]!;
}

/** Tangent basis for a face: the two in-plane axes, used to look up AO neighbours. */
const FACE_TANGENTS: Readonly<Record<Face, readonly [Vec3, Vec3]>> = {
  top: [vec(1, 0, 0), vec(0, 0, 1)],
  bottom: [vec(1, 0, 0), vec(0, 0, 1)],
  north: [vec(1, 0, 0), vec(0, 1, 0)],
  south: [vec(1, 0, 0), vec(0, 1, 0)],
  east: [vec(0, 0, 1), vec(0, 1, 0)],
  west: [vec(0, 0, 1), vec(0, 1, 0)],
};

function computeAo(vol: Volume, cell: Vec3, face: Face): [number, number, number, number] {
  const n = FACE_NORMALS[face];
  const [tu, tv] = FACE_TANGENTS[face];
  const solidAt = (du: number, dv: number): boolean =>
    occludes(
      vol.get(
        cell.x + n.x + tu.x * du + tv.x * dv,
        cell.y + n.y + tu.y * du + tv.y * dv,
        cell.z + n.z + tu.z * du + tv.z * dv,
      ),
    );
  // Corner order must match FACE_CORNERS; each corner sits at a (u, v) sign pair.
  const corners = FACE_CORNERS[face];
  const out: number[] = [];
  for (const c of corners) {
    // Map the unit-cube corner back to (u, v) signs in the face's tangent basis.
    const local = vec(c[0] - 0.5, c[1] - 0.5, c[2] - 0.5);
    const u = Math.sign(local.x * tu.x + local.y * tu.y + local.z * tu.z);
    const v = Math.sign(local.x * tv.x + local.y * tv.y + local.z * tv.z);
    out.push(cornerAo(solidAt(u, 0), solidAt(0, v), solidAt(u, v)));
  }
  return out as unknown as [number, number, number, number];
}

/** Compute a camera position that frames the whole volume. */
function frameCamera(
  vol: Volume,
  cam: CameraSpec,
  aspect: number,
): { eye: Vec3; target: Vec3; up: Vec3; projection: Mat4; near: number; far: number } {
  const bounds = vol.occupiedBounds() ?? vol.bounds;
  const target = vec(
    (bounds.min.x + bounds.max.x) / 2 + 0.5,
    (bounds.min.y + bounds.max.y) / 2 + 0.5,
    (bounds.min.z + bounds.max.z) / 2 + 0.5,
  );
  const extent = Math.max(
    bounds.max.x - bounds.min.x + 1,
    bounds.max.y - bounds.min.y + 1,
    bounds.max.z - bounds.min.z + 1,
  );
  const radius = (Math.hypot(
    bounds.max.x - bounds.min.x + 1,
    bounds.max.y - bounds.min.y + 1,
    bounds.max.z - bounds.min.z + 1,
  ) / 2) || 1;

  const az = (cam.azimuthDegrees * Math.PI) / 180;
  const el = (Math.min(89.9, Math.max(-89.9, cam.elevationDegrees)) * Math.PI) / 180;
  const zoom = cam.zoom ?? 1;
  const fov = cam.fovDegrees ?? 45;

  // Distance that fits a sphere of `radius` in the narrower of the two view angles.
  const vFov = (fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * zoom;

  const dir = vec(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const eye = vec(
    target.x + dir.x * distance,
    target.y + dir.y * distance,
    target.z + dir.z * distance,
  );

  // A top-down shot needs an explicit up vector; anything else uses world up.
  let up = vec(0, 1, 0);
  if (Math.abs(cam.elevationDegrees) > 85 || cam.upAzimuthDegrees !== undefined) {
    const upAz = ((cam.upAzimuthDegrees ?? cam.azimuthDegrees) * Math.PI) / 180;
    up = vec(Math.sin(upAz), 0, -Math.cos(upAz));
  }

  const near = Math.max(0.1, distance - radius * 2);
  const far = distance + radius * 3;
  const projection =
    cam.projection === "orthographic"
      ? // Orthographic framing is set directly by the half-extents; `zoom` above 1 pulls back the
        // same way it does for perspective, so the two projections respond identically to it.
        orthographic(radius * zoom * aspect, radius * zoom, 0.1, far + extent)
      : perspective(fov, aspect, near, far);

  return { eye, target, up, projection, near, far };
}

export function renderVolume(vol: Volume, opts: RenderOptions): RenderResult {
  const ss = opts.supersample ?? 2;
  const outWidth = opts.width ?? 1024;
  const outHeight = opts.height ?? 640;
  const width = outWidth * ss;
  const height = outHeight * ss;
  const aspect = width / height;

  const { eye, target, up, projection } = frameCamera(vol, opts.camera, aspect);
  const view = lookAt(eye, target, up);
  const viewProjection = mat4Multiply(projection, view);

  const fb = new Framebuffer(width, height);
  const [skyTop, skyBottom] = opts.background ?? [0xa8c8e8, 0xdcebf6];
  fb.clearGradient(skyTop, skyBottom);

  // A light direction shifts which vertical faces read as lit, which is what stops a symmetric
  // build from looking like a flat plan.
  const lightAz = ((opts.lightAzimuthDegrees ?? 135) * Math.PI) / 180;
  const lightBias: Record<Face, number> = {
    top: 1,
    bottom: 1,
    north: 1 + 0.14 * -Math.cos(lightAz),
    south: 1 + 0.14 * Math.cos(lightAz),
    east: 1 + 0.14 * Math.sin(lightAz),
    west: 1 + 0.14 * -Math.sin(lightAz),
  };

  const minY = Math.max(0, opts.minY ?? 0);
  const maxY = Math.min(vol.height - 1, opts.maxY ?? vol.height - 1);

  const opaque: QuadJob[] = [];
  const translucent: QuadJob[] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let z = 0; z < vol.length; z++) {
      for (let x = 0; x < vol.width; x++) {
        const block = vol.cells[vol.index(x, y, z)]!;
        if (block === AIR) continue;
        const box = boxForBlock(block);
        if (!box) continue;
        const cell = vec(x, y, z);
        const color = blockColor(block);
        const alpha = blockAlpha(block);
        const target = alpha >= 0.999 ? opaque : translucent;
        for (const face of Object.keys(FACE_NORMALS) as Face[]) {
          const n = FACE_NORMALS[face];
          const neighbour = vol.get(x + n.x, y + n.y, z + n.z);
          if (box.fullCube && occludes(neighbour)) continue;
          // A translucent block against the same block hides the internal face (glass panes in a
          // wall should not show a grid of seams).
          if (!box.fullCube && alpha < 1 && neighbour === block) continue;
          if (face === "bottom" && y === minY && minY > 0) continue;
          target.push({
            face,
            cell,
            box,
            color,
            alpha,
            ao: box.fullCube ? computeAo(vol, cell, face) : [1, 1, 1, 1],
            depth: 0,
          });
        }
      }
    }
  }

  const project = (p: { x: number; y: number; z: number }): ScreenVertex | null => {
    const clip = projectVertex(viewProjection, p);
    if (clip.w <= 1e-6) return null;
    const invW = 1 / clip.w;
    return {
      x: (clip.x * invW * 0.5 + 0.5) * width,
      y: (1 - (clip.y * invW * 0.5 + 0.5)) * height,
      depth: clip.z * invW,
      invW,
      shade: 1,
    };
  };

  const drawQuad = (job: QuadJob, depthWrite: boolean): void => {
    const corners = FACE_CORNERS[job.face];
    const verts: (ScreenVertex | null)[] = corners.map((c, i) => {
      const p = {
        x: job.cell.x + job.box.min.x + c[0] * (job.box.max.x - job.box.min.x),
        y: job.cell.y + job.box.min.y + c[1] * (job.box.max.y - job.box.min.y),
        z: job.cell.z + job.box.min.z + c[2] * (job.box.max.z - job.box.min.z),
      };
      const v = project(p);
      if (!v) return null;
      return { ...v, shade: FACE_LIGHT[job.face] * lightBias[job.face] * job.ao[i]! };
    });
    if (verts.some((v) => v === null)) return;
    const [a, b, c, d] = verts as ScreenVertex[];
    const draw = { color: job.color, alpha: job.alpha, depthWrite };
    fb.drawTriangle(a!, b!, c!, draw);
    fb.drawTriangle(a!, c!, d!, draw);
  };

  for (const job of opaque) drawQuad(job, true);

  if (translucent.length > 0) {
    for (const job of translucent) {
      const cx = job.cell.x + 0.5;
      const cy = job.cell.y + 0.5;
      const cz = job.cell.z + 0.5;
      job.depth = Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z);
    }
    translucent.sort((p, q) => q.depth - p.depth);
    for (const job of translucent) drawQuad(job, false);
  }

  const final = ss === 1 ? fb : downsample(fb, ss);

  return {
    framebuffer: final,
    viewProjection,
    width: outWidth,
    height: outHeight,
    project(p: Vec3) {
      const clip = projectVertex(viewProjection, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
      if (clip.w <= 1e-6) return { x: 0, y: 0, depth: Infinity, visible: false };
      const invW = 1 / clip.w;
      const x = (clip.x * invW * 0.5 + 0.5) * outWidth;
      const y = (1 - (clip.y * invW * 0.5 + 0.5)) * outHeight;
      return {
        x,
        y,
        depth: clip.w,
        visible: x >= 0 && y >= 0 && x < outWidth && y < outHeight,
      };
    },
  };
}

/** Box-filter downsample. With `supersample: 2` this is the whole anti-aliasing story. */
function downsample(src: Framebuffer, factor: number): Framebuffer {
  const width = Math.floor(src.width / factor);
  const height = Math.floor(src.height / factor);
  const out = new Framebuffer(width, height);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * src.width + (x * factor + sx)) * 4;
          r += src.color[i]!;
          g += src.color[i + 1]!;
          b += src.color[i + 2]!;
        }
      }
      const o = (y * width + x) * 4;
      out.color[o] = r / area;
      out.color[o + 1] = g / area;
      out.color[o + 2] = b / area;
      out.color[o + 3] = 255;
    }
  }
  return out;
}
