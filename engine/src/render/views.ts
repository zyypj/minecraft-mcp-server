/**
 * The named preview shots.
 *
 * Five views, chosen because they answer the five questions a builder asks about a map:
 *
 *  - `perspective` — does the silhouette read? is there a focal point?
 *  - `front` / `side` — are the heights right? does anything float or sink?
 *  - `top` — is the layout symmetric? are the distances balanced?
 *  - `gameplay` — the top view annotated with spawns, generators and rush routes, which is the one
 *    that says whether the map is *competitive* rather than merely pretty.
 *
 * `gameplay` is the reason the overlay layer exists: for BedWars, a top-down plan with the
 * generator positions and rush distances drawn on it catches problems that no amount of staring at
 * a pretty render will.
 */

import { type Vec3 } from "../core/vec.js";
import { type Volume } from "../core/volume.js";
import {
  type LegendEntry,
  type MarkerShape,
  drawCaption,
  drawLegend,
  drawMarker,
  drawRoute,
} from "./overlay.js";
import { encodePng } from "./png.js";
import { type CameraSpec, type RenderOptions, renderVolume } from "./voxel-renderer.js";

export type ViewName = "perspective" | "front" | "side" | "top" | "gameplay";

export const ALL_VIEWS: readonly ViewName[] = ["perspective", "front", "side", "top", "gameplay"];

/** A marker in build space, projected into whichever view is being drawn. */
export interface WorldMarker {
  readonly pos: Vec3;
  readonly color: number;
  readonly label?: string;
  readonly shape?: MarkerShape;
  readonly radius?: number;
}

export interface WorldRoute {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly color: number;
  readonly label?: string;
  readonly dashed?: boolean;
}

export interface Annotation {
  readonly markers?: readonly WorldMarker[];
  readonly routes?: readonly WorldRoute[];
  readonly legend?: readonly LegendEntry[];
  readonly caption?: readonly string[];
}

const CAMERAS: Readonly<Record<ViewName, CameraSpec>> = {
  // Three-quarter view from the south-east, the angle a screenshot of a map is normally taken from.
  perspective: {
    azimuthDegrees: 135,
    elevationDegrees: 28,
    projection: "perspective",
    fovDegrees: 42,
    zoom: 1.05,
  },
  // Elevations use orthographic so heights can be compared by eye without perspective foreshortening.
  front: { azimuthDegrees: 180, elevationDegrees: 6, projection: "orthographic", zoom: 1.05 },
  side: { azimuthDegrees: 90, elevationDegrees: 6, projection: "orthographic", zoom: 1.05 },
  top: {
    azimuthDegrees: 0,
    elevationDegrees: 89.9,
    projection: "orthographic",
    zoom: 1.02,
    upAzimuthDegrees: 0,
  },
  gameplay: {
    azimuthDegrees: 0,
    elevationDegrees: 89.9,
    projection: "orthographic",
    zoom: 1.08,
    upAzimuthDegrees: 0,
  },
};

export interface RenderViewsOptions {
  readonly views?: readonly ViewName[];
  readonly width?: number;
  readonly height?: number;
  readonly supersample?: 1 | 2 | 3;
  /** Annotations applied to the `gameplay` view. */
  readonly annotation?: Annotation;
  /** Annotations applied to *every* view. Use sparingly; the plain views should stay clean. */
  readonly globalAnnotation?: Annotation;
  readonly background?: readonly [number, number];
}

export interface RenderedView {
  readonly name: ViewName;
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Render a set of views and return each as an encoded PNG. */
export function renderViews(vol: Volume, opts: RenderViewsOptions = {}): RenderedView[] {
  const views = opts.views ?? ALL_VIEWS;
  const out: RenderedView[] = [];

  for (const name of views) {
    // The top-down views want a squarer frame; the elevations want a wide one.
    const isPlan = name === "top" || name === "gameplay";
    const width = opts.width ?? (isPlan ? 960 : 1024);
    const height = opts.height ?? (isPlan ? 960 : 600);

    const renderOptions: RenderOptions = {
      width,
      height,
      camera: CAMERAS[name],
      supersample: opts.supersample ?? 2,
      background: opts.background,
      // A plan view lit from due north keeps north-facing walls dark, which reads as depth on a
      // layout that is otherwise all roofs.
      lightAzimuthDegrees: isPlan ? 315 : 135,
    };

    const result = renderVolume(vol, renderOptions);
    const fb = result.framebuffer;

    const annotations: Annotation[] = [];
    if (opts.globalAnnotation) annotations.push(opts.globalAnnotation);
    if (name === "gameplay" && opts.annotation) annotations.push(opts.annotation);

    for (const ann of annotations) {
      for (const route of ann.routes ?? []) {
        const a = result.project(route.from);
        const b = result.project(route.to);
        drawRoute(fb, {
          from: a,
          to: b,
          color: route.color,
          label: route.label,
          dashed: route.dashed,
          thickness: 3,
        });
      }
      for (const marker of ann.markers ?? []) {
        const p = result.project(marker.pos);
        drawMarker(fb, {
          x: p.x,
          y: p.y,
          color: marker.color,
          label: marker.label,
          shape: marker.shape,
          radius: marker.radius,
        });
      }
      if (ann.legend?.length) drawLegend(fb, ann.legend, { corner: "bottom-left", title: "Legend" });
      if (ann.caption?.length) drawCaption(fb, ann.caption);
    }

    out.push({
      name,
      png: encodePng(fb.color as unknown as Uint8Array, fb.width, fb.height),
      width: fb.width,
      height: fb.height,
    });
  }

  return out;
}

/** Render a single arbitrary camera — for detail shots the presets do not cover. */
export function renderCustomView(
  vol: Volume,
  camera: CameraSpec,
  opts: { width?: number; height?: number; supersample?: 1 | 2 | 3; annotation?: Annotation } = {},
): { png: Buffer; width: number; height: number } {
  const result = renderVolume(vol, {
    width: opts.width ?? 1024,
    height: opts.height ?? 640,
    camera,
    supersample: opts.supersample ?? 2,
  });
  const fb = result.framebuffer;
  if (opts.annotation) {
    for (const route of opts.annotation.routes ?? []) {
      drawRoute(fb, {
        from: result.project(route.from),
        to: result.project(route.to),
        color: route.color,
        label: route.label,
        dashed: route.dashed,
      });
    }
    for (const marker of opts.annotation.markers ?? []) {
      const p = result.project(marker.pos);
      drawMarker(fb, { ...marker, x: p.x, y: p.y });
    }
    if (opts.annotation.legend?.length) drawLegend(fb, opts.annotation.legend);
    if (opts.annotation.caption?.length) drawCaption(fb, opts.annotation.caption);
  }
  return {
    png: encodePng(fb.color as unknown as Uint8Array, fb.width, fb.height),
    width: fb.width,
    height: fb.height,
  };
}

/** Standard colours for BedWars annotations, so every map's gameplay view reads the same way. */
export const GAMEPLAY_COLORS = {
  spawn: 0xff4d4d,
  bed: 0xff8a3d,
  ironGenerator: 0xd8d8d8,
  goldGenerator: 0xf5c542,
  diamondGenerator: 0x4ddbe0,
  emeraldGenerator: 0x3fd67a,
  shop: 0xb07be0,
  upgrades: 0x7ba7e0,
  mid: 0xffffff,
  rushRoute: 0xff6b6b,
  resourceRoute: 0x6bc5ff,
} as const;
