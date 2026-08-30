/**
 * A small software rasterizer: 4x4 matrices, a depth buffer, and perspective-correct triangles.
 *
 * The preview exists so a map can be judged before it touches a server, which means it has to run
 * anywhere the engine runs, deterministically, without a GPU. A voxel scene is the easy case for
 * software rendering — flat-shaded axis-aligned quads, no textures, no lighting model beyond a
 * per-face constant and ambient occlusion — so a few hundred lines here replace a headless-browser
 * stack and its whole class of install failures.
 */

export type Mat4 = Float64Array;

export interface Vec3f {
  x: number;
  y: number;
  z: number;
}

export function mat4Identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Row-major multiply: `out = a * b`, applied to column vectors as `a * (b * v)`. */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k]! * b[k * 4 + c]!;
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

export interface Vec4f {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function projectVertex(m: Mat4, p: Vec3f): Vec4f {
  return {
    x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!,
    y: m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]!,
    z: m[8]! * p.x + m[9]! * p.y + m[10]! * p.z + m[11]!,
    w: m[12]! * p.x + m[13]! * p.y + m[14]! * p.z + m[15]!,
  };
}

function normalize(v: Vec3f): Vec3f {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3f, b: Vec3f): Vec3f {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3f, b: Vec3f): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Right-handed look-at view matrix; the camera looks down its own -Z. */
export function lookAt(eye: Vec3f, target: Vec3f, up: Vec3f): Mat4 {
  const f = normalize({ x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
  let s = cross(f, up);
  if (Math.hypot(s.x, s.y, s.z) < 1e-6) {
    // Looking straight up or down: any perpendicular will do, pick one deterministically.
    s = cross(f, { x: 0, y: 0, z: 1 });
  }
  s = normalize(s);
  const u = cross(s, f);
  const m = new Float64Array(16);
  m[0] = s.x;
  m[1] = s.y;
  m[2] = s.z;
  m[3] = -dot(s, eye);
  m[4] = u.x;
  m[5] = u.y;
  m[6] = u.z;
  m[7] = -dot(u, eye);
  m[8] = -f.x;
  m[9] = -f.y;
  m[10] = -f.z;
  m[11] = dot(f, eye);
  m[15] = 1;
  return m;
}

export function perspective(fovYDegrees: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(((fovYDegrees * Math.PI) / 180) / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = (2 * far * near) / (near - far);
  m[14] = -1;
  return m;
}

export function orthographic(
  halfWidth: number,
  halfHeight: number,
  near: number,
  far: number,
): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1 / halfWidth;
  m[5] = 1 / halfHeight;
  m[10] = -2 / (far - near);
  m[11] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

/** A projected vertex ready for rasterization. */
export interface ScreenVertex {
  /** Screen-space pixel coordinates. */
  readonly x: number;
  readonly y: number;
  /**
   * Normalized device depth in `[-1, 1]`, near plane at -1. Smaller is nearer.
   *
   * NDC depth rather than view-space distance, because it is the one value that is linear in
   * *screen* space for both projections. Using clip `w` here works for perspective and silently
   * breaks orthographic, where `w` is 1 for every fragment and the depth test degenerates into
   * "whichever triangle was drawn first wins".
   */
  readonly depth: number;
  /** Reciprocal clip `w`, for perspective-correct attribute interpolation. */
  readonly invW: number;
  /** Per-vertex brightness multiplier in `[0, 1]`, carrying ambient occlusion. */
  readonly shade: number;
}

export interface DrawOptions {
  /** `0xRRGGBB`. */
  readonly color: number;
  readonly alpha?: number;
  /** Set false for translucent geometry so it does not occlude what is behind it. */
  readonly depthWrite?: boolean;
}

export class Framebuffer {
  readonly width: number;
  readonly height: number;
  readonly color: Uint8ClampedArray;
  readonly depth: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.color = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height).fill(Infinity);
  }

  /** Fill with a vertical two-tone sky so the silhouette of a floating island reads clearly. */
  clearGradient(topColor: number, bottomColor: number): void {
    const tr = (topColor >> 16) & 0xff;
    const tg = (topColor >> 8) & 0xff;
    const tb = topColor & 0xff;
    const br = (bottomColor >> 16) & 0xff;
    const bg = (bottomColor >> 8) & 0xff;
    const bb = bottomColor & 0xff;
    for (let y = 0; y < this.height; y++) {
      const t = this.height === 1 ? 0 : y / (this.height - 1);
      const r = Math.round(tr + (br - tr) * t);
      const g = Math.round(tg + (bg - tg) * t);
      const b = Math.round(tb + (bb - tb) * t);
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4;
        this.color[i] = r;
        this.color[i + 1] = g;
        this.color[i + 2] = b;
        this.color[i + 3] = 255;
      }
    }
    this.depth.fill(Infinity);
  }

  blendPixel(x: number, y: number, r: number, g: number, b: number, alpha: number): void {
    const i = (y * this.width + x) * 4;
    if (alpha >= 1) {
      this.color[i] = r;
      this.color[i + 1] = g;
      this.color[i + 2] = b;
      this.color[i + 3] = 255;
      return;
    }
    const inv = 1 - alpha;
    this.color[i] = r * alpha + this.color[i]! * inv;
    this.color[i + 1] = g * alpha + this.color[i + 1]! * inv;
    this.color[i + 2] = b * alpha + this.color[i + 2]! * inv;
    this.color[i + 3] = 255;
  }

  /**
   * Rasterize one triangle with a depth test.
   *
   * Attributes are interpolated perspective-correctly (`attr/w` over the barycentric coordinates,
   * divided back by the interpolated `1/w`). For orthographic views `invW` is constant, so the
   * same code path degrades to plain affine interpolation for free.
   */
  drawTriangle(a: ScreenVertex, b: ScreenVertex, c: ScreenVertex, opts: DrawOptions): void {
    const alpha = opts.alpha ?? 1;
    if (alpha <= 0.004) return;
    const depthWrite = opts.depthWrite ?? true;
    const cr = (opts.color >> 16) & 0xff;
    const cg = (opts.color >> 8) & 0xff;
    const cb = opts.color & 0xff;

    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (minX > maxX || minY > maxY) return;

    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-9) return;
    const invArea = 1 / area;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let w0 = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) * invArea;
        let w1 = ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) * invArea;
        let w2 = ((a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)) * invArea;
        // The winding-independent test: all three edge functions share the area's sign.
        if (w0 < 0 || w1 < 0 || w2 < 0) {
          if (!(w0 <= 0 && w1 <= 0 && w2 <= 0)) continue;
          w0 = -w0;
          w1 = -w1;
          w2 = -w2;
        }
        // w1 belongs to vertex a, w2 to b, w0 to c (each edge function opposes its vertex).
        const la = w1;
        const lb = w2;
        const lc = w0;

        const invW = la * a.invW + lb * b.invW + lc * c.invW;
        if (invW <= 0) continue;
        // Depth interpolates affinely (NDC z is linear in screen space); attributes interpolate
        // perspective-correctly through 1/w.
        const depth = la * a.depth + lb * b.depth + lc * c.depth;
        const i = y * this.width + x;
        if (depth >= this.depth[i]!) continue;

        const shade = (la * a.shade * a.invW + lb * b.shade * b.invW + lc * c.shade * c.invW) / invW;
        this.blendPixel(x, y, cr * shade, cg * shade, cb * shade, alpha);
        if (depthWrite) this.depth[i] = depth;
      }
    }
  }

  /** Draw an axis-aligned filled rectangle in screen space, ignoring depth. Used by overlays. */
  fillRect(x0: number, y0: number, w: number, h: number, color: number, alpha = 1): void {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    const xs = Math.max(0, Math.floor(x0));
    const ys = Math.max(0, Math.floor(y0));
    const xe = Math.min(this.width - 1, Math.floor(x0 + w) - 1);
    const ye = Math.min(this.height - 1, Math.floor(y0 + h) - 1);
    for (let y = ys; y <= ye; y++) for (let x = xs; x <= xe; x++) this.blendPixel(x, y, r, g, b, alpha);
  }

  /** Bresenham line in screen space, ignoring depth. Used for rush-route overlays. */
  drawLine(x0: number, y0: number, x1: number, y1: number, color: number, thickness = 1): void {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx - dy;
    const half = Math.floor(thickness / 2);
    for (;;) {
      for (let oy = -half; oy <= half; oy++)
        for (let ox = -half; ox <= half; ox++) {
          const px = x + ox;
          const py = y + oy;
          if (px >= 0 && py >= 0 && px < this.width && py < this.height) {
            this.blendPixel(px, py, r, g, b, 1);
          }
        }
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}
