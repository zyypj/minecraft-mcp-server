/**
 * Screen-space overlays: markers, routes, labels and a legend.
 *
 * The gameplay view is the one that actually decides whether a BedWars map is competitive, and it
 * is unreadable without annotation — a top-down render alone cannot tell you which island is a
 * team base, where the diamond generators sit, or how far a rush is. So the renderer draws a second
 * layer on top of the voxels with that information baked in, and the numbers come from the same
 * analyzer that gates the build.
 *
 * The font is a hand-encoded 5x7 bitmap. It is not pretty, but it needs no asset file, renders
 * identically everywhere, and stays legible at the 2x scale the overlay uses.
 */

import { Framebuffer } from "./raster.js";

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

/** Each glyph is 7 rows of 5 bits, most significant bit leftmost. */
const FONT: Readonly<Record<string, readonly number[]>> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0x0e, 0, 0, 0],
  "+": [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  ":": [0, 0x04, 0, 0, 0, 0x04, 0],
  ".": [0, 0, 0, 0, 0, 0, 0x04],
  ",": [0, 0, 0, 0, 0, 0x04, 0x08],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "%": [0x11, 0x12, 0x04, 0x04, 0x08, 0x09, 0x11],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  ">": [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  "<": [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  "=": [0, 0, 0x1f, 0, 0x1f, 0, 0],
  "#": [0x0a, 0x1f, 0x0a, 0x0a, 0x0a, 0x1f, 0x0a],
};

export interface TextOptions {
  readonly color?: number;
  /** Integer pixel scale. 2 is the readable default at 1024px wide. */
  readonly scale?: number;
  /** Draw a 1px dark outline so labels stay readable over any background. */
  readonly outline?: boolean;
  readonly outlineColor?: number;
}

export function measureText(text: string, scale = 2): { width: number; height: number } {
  return {
    width: text.length * (GLYPH_WIDTH + 1) * scale,
    height: GLYPH_HEIGHT * scale,
  };
}

/** Draw a string. Unmapped characters render as a space rather than failing. */
export function drawText(
  fb: Framebuffer,
  text: string,
  x: number,
  y: number,
  opts: TextOptions = {},
): void {
  const scale = Math.max(1, Math.floor(opts.scale ?? 2));
  const color = opts.color ?? 0xffffff;
  const outlineColor = opts.outlineColor ?? 0x101418;
  const upper = text.toUpperCase();

  const paint = (col: number, dx: number, dy: number): void => {
    let cursor = x + dx;
    for (const ch of upper) {
      const glyph = FONT[ch] ?? FONT[" "]!;
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        const bits = glyph[row]!;
        for (let bit = 0; bit < GLYPH_WIDTH; bit++) {
          if ((bits & (1 << (GLYPH_WIDTH - 1 - bit))) === 0) continue;
          fb.fillRect(cursor + bit * scale, y + dy + row * scale, scale, scale, col);
        }
      }
      cursor += (GLYPH_WIDTH + 1) * scale;
    }
  };

  if (opts.outline ?? true) {
    for (const [dx, dy] of [
      [-scale, 0],
      [scale, 0],
      [0, -scale],
      [0, scale],
    ] as const) {
      paint(outlineColor, dx, dy);
    }
  }
  paint(color, 0, 0);
}

export type MarkerShape = "circle" | "diamond" | "square" | "cross" | "ring";

export interface Marker {
  /** Screen position, in final-image pixels. */
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly shape?: MarkerShape;
  readonly radius?: number;
  readonly label?: string;
}

export function drawMarker(fb: Framebuffer, m: Marker): void {
  const r = Math.max(2, Math.round(m.radius ?? 7));
  const shape = m.shape ?? "circle";
  const cx = Math.round(m.x);
  const cy = Math.round(m.y);
  const outline = 0x101418;

  const plot = (px: number, py: number, color: number): void => {
    if (px < 0 || py < 0 || px >= fb.width || py >= fb.height) return;
    fb.fillRect(px, py, 1, 1, color);
  };

  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      let inside: boolean;
      let onEdge: boolean;
      switch (shape) {
        case "circle": {
          const d = Math.hypot(dx, dy);
          inside = d <= r;
          onEdge = d > r && d <= r + 1.4;
          break;
        }
        case "ring": {
          const d = Math.hypot(dx, dy);
          inside = d <= r && d >= r - 2;
          onEdge = (d > r && d <= r + 1.4) || (d < r - 2 && d >= r - 3.4);
          break;
        }
        case "diamond": {
          const d = Math.abs(dx) + Math.abs(dy);
          inside = d <= r;
          onEdge = d > r && d <= r + 1.4;
          break;
        }
        case "square": {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          inside = d <= r;
          onEdge = d > r && d <= r + 1;
          break;
        }
        case "cross": {
          inside = (Math.abs(dx) <= 1 && Math.abs(dy) <= r) || (Math.abs(dy) <= 1 && Math.abs(dx) <= r);
          onEdge =
            !inside &&
            ((Math.abs(dx) <= 2 && Math.abs(dy) <= r + 1) ||
              (Math.abs(dy) <= 2 && Math.abs(dx) <= r + 1));
          break;
        }
      }
      if (inside) plot(cx + dx, cy + dy, m.color);
      else if (onEdge) plot(cx + dx, cy + dy, outline);
    }
  }

  if (m.label) {
    const size = measureText(m.label, 2);
    drawText(fb, m.label, cx - size.width / 2, cy + r + 4, { scale: 2 });
  }
}

export interface RouteLine {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly color: number;
  readonly label?: string;
  readonly dashed?: boolean;
  readonly thickness?: number;
}

export function drawRoute(fb: Framebuffer, route: RouteLine): void {
  const thickness = route.thickness ?? 2;
  if (route.dashed) {
    const dx = route.to.x - route.from.x;
    const dy = route.to.y - route.from.y;
    const len = Math.hypot(dx, dy);
    const segments = Math.max(1, Math.round(len / 12));
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = t0 + 0.55 / segments;
      fb.drawLine(
        route.from.x + dx * t0,
        route.from.y + dy * t0,
        route.from.x + dx * t1,
        route.from.y + dy * t1,
        route.color,
        thickness,
      );
    }
  } else {
    fb.drawLine(route.from.x, route.from.y, route.to.x, route.to.y, route.color, thickness);
  }

  if (route.label) {
    const mx = (route.from.x + route.to.x) / 2;
    const my = (route.from.y + route.to.y) / 2;
    const size = measureText(route.label, 2);
    fb.fillRect(mx - size.width / 2 - 4, my - size.height / 2 - 3, size.width + 8, size.height + 6, 0x101418, 0.7);
    drawText(fb, route.label, mx - size.width / 2, my - size.height / 2, { scale: 2, outline: false });
  }
}

export interface LegendEntry {
  readonly color: number;
  readonly label: string;
  readonly shape?: MarkerShape;
}

/** A boxed legend in a corner of the image. */
export function drawLegend(
  fb: Framebuffer,
  entries: readonly LegendEntry[],
  opts: { corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right"; title?: string } = {},
): void {
  if (entries.length === 0) return;
  const scale = 2;
  const rowHeight = GLYPH_HEIGHT * scale + 8;
  const widest = Math.max(
    ...entries.map((e) => measureText(e.label, scale).width),
    opts.title ? measureText(opts.title, scale).width : 0,
  );
  const boxWidth = widest + 46;
  const boxHeight = rowHeight * entries.length + (opts.title ? rowHeight : 0) + 12;
  const margin = 16;
  const corner = opts.corner ?? "top-left";
  const x =
    corner === "top-left" || corner === "bottom-left" ? margin : fb.width - boxWidth - margin;
  const y =
    corner === "top-left" || corner === "top-right" ? margin : fb.height - boxHeight - margin;

  fb.fillRect(x, y, boxWidth, boxHeight, 0x0d1117, 0.78);
  fb.fillRect(x, y, boxWidth, 2, 0x2a3341);
  fb.fillRect(x, y + boxHeight - 2, boxWidth, 2, 0x2a3341);
  fb.fillRect(x, y, 2, boxHeight, 0x2a3341);
  fb.fillRect(x + boxWidth - 2, y, 2, boxHeight, 0x2a3341);

  let cursorY = y + 8;
  if (opts.title) {
    drawText(fb, opts.title, x + 12, cursorY, { scale, outline: false, color: 0xdde3ea });
    cursorY += rowHeight;
  }
  for (const entry of entries) {
    drawMarker(fb, {
      x: x + 20,
      y: cursorY + (GLYPH_HEIGHT * scale) / 2,
      color: entry.color,
      shape: entry.shape ?? "circle",
      radius: 5,
    });
    drawText(fb, entry.label, x + 34, cursorY, { scale, outline: false, color: 0xdde3ea });
    cursorY += rowHeight;
  }
}

/** A caption bar along the top of the image, for the view name and key numbers. */
export function drawCaption(fb: Framebuffer, lines: readonly string[]): void {
  if (lines.length === 0) return;
  const scale = 2;
  const lineHeight = GLYPH_HEIGHT * scale + 6;
  const height = lineHeight * lines.length + 10;
  fb.fillRect(0, 0, fb.width, height, 0x0d1117, 0.72);
  lines.forEach((line, i) => {
    drawText(fb, line, 14, 8 + i * lineHeight, { scale, outline: false, color: 0xe6ecf3 });
  });
}
