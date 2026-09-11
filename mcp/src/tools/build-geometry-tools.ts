/**
 * Geometry tools — the vocabulary that replaces thousands of block placements.
 *
 * Every tool here is a *whole shape or whole region* operation. That is the point of the engine:
 * an agent should be deciding "a circular tower of radius 12 and height 35", not enumerating the
 * thirty thousand cells that make one. `set_block` exists, and its description says plainly that it
 * is for final adjustments only.
 */

import { z } from "zod";

import {
  buildArch,
  buildBox,
  buildCircle,
  buildCone,
  buildCylinder,
  buildGradient,
  buildHelix,
  buildLine,
  buildPolygonPrism,
  buildPyramid,
  buildSphere,
  buildTorus,
  buildWall,
  copyRegion,
  distributeRadially,
  hollowOut,
  mirrorInPlace,
  outlineRegion,
  pasteClipboard,
  radialSymmetry,
  regionWalls,
  replaceBlocks,
  scatter,
  smoothRegion,
  transformRegionInPlace,
  Prng,
  blockName,
  type OrientTransform,
} from "@mcbuild/engine";

import { type BuildToolRegistry, json, text } from "../build/registry.js";
import { type BuildWorkspace } from "../build/session.js";
import {
  buildRefSchema,
  changeSummary,
  materialSchema,
  regionSchema,
  resolveBlockOnly,
  resolveMaterial,
  resolveStops,
  toRegion,
  toVec,
  vec3Schema,
} from "../build/args.js";

export function registerBuildGeometryTools(registry: BuildToolRegistry, workspace: BuildWorkspace): void {
  const run = (
    args: Record<string, unknown>,
    label: string,
    fn: (session: ReturnType<BuildWorkspace["require"]>) => number,
  ): string => {
    const session = workspace.require(args["build"] as string | undefined);
    const changed = session.history.run(label, () => fn(session));
    return changeSummary(label, changed, session.id);
  };

  // -- Primitives ----------------------------------------------------------------------------------

  registry.register(
    "build_box",
    "Fill or shell a rectangular box. Use `hollow` with a `thickness` for walls, floors and ceilings in one call.",
    {
      build: buildRefSchema,
      region: regionSchema,
      material: materialSchema,
      hollow: z.boolean().optional().describe("Draw only a shell of `thickness` blocks."),
      thickness: z.number().int().min(1).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "build_box", (s) =>
          buildBox(s.volume, toRegion(args["region"]), {
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
            thickness: args["thickness"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_circle",
    "A flat disc or ring on the XZ plane. Radius follows the WorldEdit convention: radius 3 spans 7 blocks.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      radius: z.number().min(0).max(512),
      material: materialSchema,
      filled: z.boolean().optional().describe("Default true. False draws only the ring."),
      thickness: z.number().int().min(1).max(16).optional().describe("Ring thickness when not filled."),
    },
    (args) =>
      text(
        run(args, "build_circle", (s) =>
          buildCircle(s.volume, {
            center: toVec(args["center"]),
            radius: args["radius"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            filled: (args["filled"] as boolean | undefined) ?? true,
            thickness: args["thickness"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_sphere",
    "A solid or hollow sphere or ellipsoid. Give `radius` for a sphere, or `radii` for independent axes.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      radius: z.number().min(0).max(256).optional(),
      radii: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      material: materialSchema,
      hollow: z.boolean().optional(),
      thickness: z.number().int().min(1).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "build_sphere", (s) =>
          buildSphere(s.volume, {
            center: toVec(args["center"]),
            radius: (args["radii"] as { x: number; y: number; z: number } | undefined) ?? (args["radius"] as number),
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
            thickness: args["thickness"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_cylinder",
    "A vertical cylinder. `hollow` with `thickness` gives a tube; `capped` closes the ends.",
    {
      build: buildRefSchema,
      base: vec3Schema.describe("Centre of the bottom layer."),
      radius: z.number().min(0).max(512),
      height: z.number().int().min(1).max(256),
      material: materialSchema,
      hollow: z.boolean().optional(),
      thickness: z.number().int().min(1).max(16).optional(),
      capped: z.boolean().optional(),
    },
    (args) =>
      text(
        run(args, "build_cylinder", (s) =>
          buildCylinder(s.volume, {
            base: toVec(args["base"]),
            radius: args["radius"] as number,
            height: args["height"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
            thickness: args["thickness"] as number | undefined,
            capped: args["capped"] as boolean | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_cone",
    "A cone or frustum. `topRadius` above 0 truncates it; `curve` bends the taper into a spire or a bell.",
    {
      build: buildRefSchema,
      base: vec3Schema,
      baseRadius: z.number().min(0).max(256),
      topRadius: z.number().min(0).max(256).optional(),
      height: z.number().int().min(1).max(256),
      material: materialSchema,
      hollow: z.boolean().optional(),
      curve: z.enum(["linear", "concave", "convex"]).optional(),
    },
    (args) =>
      text(
        run(args, "build_cone", (s) =>
          buildCone(s.volume, {
            base: toVec(args["base"]),
            baseRadius: args["baseRadius"] as number,
            topRadius: args["topRadius"] as number | undefined,
            height: args["height"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
            curve: args["curve"] as "linear" | "concave" | "convex" | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_pyramid",
    "A square pyramid. `size` is the half-width of the base, so size 5 gives an 11x11 footprint.",
    {
      build: buildRefSchema,
      base: vec3Schema,
      size: z.number().int().min(1).max(128),
      height: z.number().int().min(1).max(256).optional(),
      material: materialSchema,
      hollow: z.boolean().optional(),
    },
    (args) =>
      text(
        run(args, "build_pyramid", (s) =>
          buildPyramid(s.volume, {
            base: toVec(args["base"]),
            size: args["size"] as number,
            height: args["height"] as number | undefined,
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_torus",
    "A ring. `majorRadius` is centre-to-tube, `minorRadius` is the tube itself. Axis `y` lies flat.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      majorRadius: z.number().min(1).max(256),
      minorRadius: z.number().min(1).max(64),
      material: materialSchema,
      axis: z.enum(["x", "y", "z"]).optional(),
    },
    (args) =>
      text(
        run(args, "build_torus", (s) =>
          buildTorus(s.volume, {
            center: toVec(args["center"]),
            majorRadius: args["majorRadius"] as number,
            minorRadius: args["minorRadius"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            axis: args["axis"] as "x" | "y" | "z" | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_line",
    "A straight line between two points, optionally swept with a brush of `radius`.",
    {
      build: buildRefSchema,
      from: vec3Schema,
      to: vec3Schema,
      material: materialSchema,
      radius: z.number().min(0).max(32).optional(),
    },
    (args) =>
      text(
        run(args, "build_line", (s) =>
          buildLine(s.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            block: resolveMaterial(args["material"] as string, s.palette),
            radius: args["radius"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_wall",
    "A vertical wall between two horizontal points: `height` tall and `width` thick.",
    {
      build: buildRefSchema,
      from: vec3Schema.describe("One end, at the base of the wall."),
      to: vec3Schema,
      height: z.number().int().min(1).max(256),
      material: materialSchema,
      width: z.number().int().min(1).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "build_wall", (s) =>
          buildWall(s.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            height: args["height"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            width: args["width"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_arch",
    "An arch spanning two points. Profiles: round (classical), pointed (gothic), catenary (a hanging curve, also correct for a suspension span), segmental (shallow).",
    {
      build: buildRefSchema,
      from: vec3Schema.describe("One springing point; must share Y with `to`."),
      to: vec3Schema,
      rise: z.number().int().min(1).max(128).describe("Peak height above the springing line."),
      material: materialSchema,
      profile: z.enum(["round", "pointed", "catenary", "segmental"]).optional(),
      depth: z.number().int().min(1).max(16).optional().describe("Depth along the arch's own axis."),
      band: z.number().int().min(1).max(16).optional().describe("Radial thickness of the band."),
    },
    (args) =>
      text(
        run(args, "build_arch", (s) =>
          buildArch(s.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            rise: args["rise"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            profile: args["profile"] as "round" | "pointed" | "catenary" | "segmental" | undefined,
            depth: args["depth"] as number | undefined,
            band: args["band"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_helix",
    "A spiral ribbon around a vertical axis — spiral stairs, ramps, banding around a tower.",
    {
      build: buildRefSchema,
      center: vec3Schema.describe("Centre of the bottom of the spiral."),
      radius: z.number().min(1).max(128),
      height: z.number().int().min(1).max(256),
      turns: z.number().min(-16).max(16).describe("Full turns over the height. Negative reverses the handedness."),
      material: materialSchema,
      width: z.number().int().min(1).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "build_helix", (s) =>
          buildHelix(s.volume, {
            center: toVec(args["center"]),
            radius: args["radius"] as number,
            height: args["height"] as number,
            turns: args["turns"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            width: args["width"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_polygon",
    "Extrude a 2D polygon vertically. The general fallback for a footprint the other shapes cannot express.",
    {
      build: buildRefSchema,
      points: z.array(z.object({ x: z.number(), z: z.number() })).min(3).max(64),
      baseY: z.number().int(),
      height: z.number().int().min(1).max(256),
      material: materialSchema,
      hollow: z.boolean().optional(),
      thickness: z.number().int().min(1).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "build_polygon", (s) =>
          buildPolygonPrism(s.volume, {
            points: args["points"] as { x: number; z: number }[],
            baseY: args["baseY"] as number,
            height: args["height"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            hollow: args["hollow"] as boolean | undefined,
            thickness: args["thickness"] as number | undefined,
          }),
        ),
      ),
  );

  // -- Region operations ----------------------------------------------------------------------------

  registry.register(
    "build_gradient",
    "Paint a gradient across a region. Two or more materials are spaced evenly and dithered into each other, which is what makes a large surface read as deliberate rather than as one flat fill.",
    {
      build: buildRefSchema,
      region: regionSchema.optional().describe("Defaults to the whole build."),
      materials: z.array(materialSchema).min(1).max(12).describe("Ordered from the start of the gradient to its end."),
      axis: z.enum(["x", "y", "z", "radial", "spherical"]).optional().describe("Default y."),
      center: vec3Schema.optional().describe("Centre for radial and spherical gradients."),
      dither: z.enum(["none", "ordered", "noise"]).optional().describe("`ordered` reads as hand-placed; `noise` reads as weathering."),
      blend: z.number().min(0).max(1).optional().describe("Width of the blended band. Below 1 keeps distinct zones."),
      only: materialSchema.optional().describe("Only recolour cells that currently hold this material."),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const changed = session.history.run("build_gradient", () =>
        buildGradient(session.volume, {
          region: args["region"] ? toRegion(args["region"]) : undefined,
          stops: resolveStops(args["materials"] as string[], session.palette),
          axis: args["axis"] as "x" | "y" | "z" | "radial" | "spherical" | undefined,
          center: args["center"] ? toVec(args["center"]) : undefined,
          dither: args["dither"] as "none" | "ordered" | "noise" | undefined,
          blend: args["blend"] as number | undefined,
          only: args["only"] ? resolveBlockOnly(args["only"] as string, session.palette) : undefined,
        }),
      );
      return text(changeSummary("build_gradient", changed, session.id));
    },
  );

  registry.register(
    "replace_region",
    "Replace one material with another across a region. Matching ignores orientation bits, so every rotation of a stair is replaced, not just the ones facing one way.",
    {
      build: buildRefSchema,
      region: regionSchema.optional(),
      from: materialSchema,
      to: materialSchema,
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const changed = session.history.run("replace_region", () =>
        replaceBlocks(session.volume, {
          region: args["region"] ? toRegion(args["region"]) : undefined,
          from: resolveBlockOnly(args["from"] as string, session.palette),
          to: resolveMaterial(args["to"] as string, session.palette),
        }),
      );
      return text(changeSummary("replace_region", changed, session.id));
    },
  );

  registry.register(
    "hollow_region",
    "Clear every solid cell that is fully enclosed by other solids, leaving a shell of `thickness`.",
    {
      build: buildRefSchema,
      region: regionSchema.optional(),
      thickness: z.number().int().min(1).max(8).optional(),
    },
    (args) =>
      text(
        run(args, "hollow_region", (s) =>
          hollowOut(s.volume, args["region"] ? toRegion(args["region"]) : undefined, args["thickness"] as number | undefined),
        ),
      ),
  );

  registry.register(
    "outline_region",
    "Draw only the six faces of a region (`outline`) or its four vertical faces (`walls`).",
    {
      build: buildRefSchema,
      region: regionSchema,
      material: materialSchema,
      mode: z.enum(["outline", "walls"]).optional(),
    },
    (args) =>
      text(
        run(args, "outline_region", (s) => {
          const r = toRegion(args["region"]);
          const material = resolveMaterial(args["material"] as string, s.palette);
          return (args["mode"] ?? "outline") === "walls"
            ? regionWalls(s.volume, r, material)
            : outlineRegion(s.volume, r, material);
        }),
      ),
  );

  registry.register(
    "smooth_region",
    "Majority-filter smoothing over the solid/air field. Rounds voxel stepping on terrain and sculpture without averaging materials into mush.",
    {
      build: buildRefSchema,
      region: regionSchema.optional(),
      iterations: z.number().int().min(1).max(8).optional(),
      threshold: z.number().min(0.3).max(0.7).optional().describe("Above 0.5 erodes more than it fills."),
    },
    (args) =>
      text(
        run(args, "smooth_region", (s) =>
          smoothRegion(s.volume, {
            region: args["region"] ? toRegion(args["region"]) : undefined,
            iterations: args["iterations"] as number | undefined,
            threshold: args["threshold"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "scatter_decoration",
    "Scatter decoration across a region. Density around 0.06-0.12 reads as planted; much more reads as noise. `spacing` stops it clumping.",
    {
      build: buildRefSchema,
      region: regionSchema.optional(),
      material: materialSchema,
      density: z.number().min(0).max(1),
      spacing: z.number().int().min(0).max(16).optional(),
      seed: z.number().int().optional(),
    },
    (args) =>
      text(
        run(args, "scatter_decoration", (s) =>
          scatter(s.volume, {
            region: args["region"] ? toRegion(args["region"]) : undefined,
            density: args["density"] as number,
            block: resolveMaterial(args["material"] as string, s.palette),
            prng: new Prng((args["seed"] as number | undefined) ?? s.seed),
            spacing: args["spacing"] as number | undefined,
          }),
        ),
      ),
  );

  // -- Copy, paste, transform -----------------------------------------------------------------------

  registry.register(
    "copy_region",
    "Copy a region into the build's clipboard, ready for `paste_region` or `distribute_radially`.",
    { build: buildRefSchema, region: regionSchema, anchor: vec3Schema.optional() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const r = toRegion(args["region"]);
      session.clipboard = copyRegion(session.volume, r, args["anchor"] ? toVec(args["anchor"]) : undefined);
      const size = session.clipboard.volume.size;
      return text(
        `Copied ${size.x}x${size.y}x${size.z} (${session.clipboard.volume.countNonAir().toLocaleString("en-US")} blocks) into ${session.id}'s clipboard.`,
      );
    },
  );

  registry.register(
    "paste_region",
    "Paste the clipboard. Rotation reorients block data too, so stairs and doors stay correct.",
    {
      build: buildRefSchema,
      at: vec3Schema,
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
      mirrorX: z.boolean().optional(),
      mirrorZ: z.boolean().optional(),
      ignoreAir: z.boolean().optional().describe("Default true: air in the clipboard leaves the target untouched."),
      byAnchor: z.boolean().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      if (!session.clipboard) throw new Error("Nothing has been copied yet. Call `copy_region` first.");
      const transform: OrientTransform = {
        rotation: ((args["rotation"] as number | undefined) ?? 0) as 0 | 90 | 180 | 270,
        mirrorX: args["mirrorX"] as boolean | undefined,
        mirrorZ: args["mirrorZ"] as boolean | undefined,
      };
      const changed = session.history.run("paste_region", () =>
        pasteClipboard(session.volume, session.clipboard!, toVec(args["at"]), {
          transform,
          ignoreAir: (args["ignoreAir"] as boolean | undefined) ?? true,
          byAnchor: args["byAnchor"] as boolean | undefined,
        }),
      );
      return text(changeSummary("paste_region", changed, session.id));
    },
  );

  registry.register(
    "rotate_structure",
    "Rotate a region in place, clockwise about +Y. A quarter turn needs a square footprint; otherwise copy and paste the rotated clipboard instead.",
    {
      build: buildRefSchema,
      region: regionSchema,
      degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
    },
    (args) =>
      text(
        run(args, "rotate_structure", (s) =>
          transformRegionInPlace(s.volume, toRegion(args["region"]), {
            rotation: args["degrees"] as 90 | 180 | 270,
          }),
        ),
      ),
  );

  registry.register(
    "mirror_structure",
    "Mirror a region in place across an axis, transforming block data with it.",
    { build: buildRefSchema, region: regionSchema, axis: z.enum(["x", "z"]) },
    (args) =>
      text(
        run(args, "mirror_structure", (s) =>
          transformRegionInPlace(s.volume, toRegion(args["region"]), {
            rotation: 0,
            mirrorX: args["axis"] === "x",
            mirrorZ: args["axis"] === "z",
          }),
        ),
      ),
  );

  registry.register(
    "mirror_half",
    "Mirror one half of the build onto the other. The direct way to make a map symmetric: build the west half, then reflect it east.",
    {
      build: buildRefSchema,
      axis: z.enum(["x", "z"]),
      at: z.number().int().describe("Coordinate of the mirror plane."),
      source: z.enum(["low", "high"]).optional().describe("Which side is the original. Default low."),
    },
    (args) =>
      text(
        run(args, "mirror_half", (s) =>
          mirrorInPlace(s.volume, {
            axis: args["axis"] as "x" | "z",
            at: args["at"] as number,
            source: args["source"] as "low" | "high" | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "distribute_radially",
    "Paste the clipboard `count` times around a circle. Positions are exact; block orientation snaps to the nearest quarter turn, because 1.8 cannot express a 45-degree stair. This is how one team island becomes eight.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      count: z.number().int().min(2).max(32),
      radius: z.number().min(1).max(2048),
      startAngle: z.number().min(-360).max(360).optional().describe("Degrees clockwise from north."),
      rotationMode: z.enum(["quantized", "none"]).optional(),
      variation: z.number().min(0).max(1).optional().describe("Per-instance rim jitter, so copies read as siblings rather than clones."),
      seed: z.number().int().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      if (!session.clipboard) throw new Error("Nothing has been copied yet. Call `copy_region` first.");
      const variation = (args["variation"] as number | undefined) ?? 0;
      const prng = new Prng((args["seed"] as number | undefined) ?? session.seed);
      let instances: ReturnType<typeof distributeRadially> = [];
      session.history.run("distribute_radially", () => {
        instances = distributeRadially(session.volume, session.clipboard!, {
          center: toVec(args["center"]),
          count: args["count"] as number,
          radius: args["radius"] as number,
          startAngleDegrees: args["startAngle"] as number | undefined,
          rotationMode: (args["rotationMode"] as "quantized" | "none" | undefined) ?? "quantized",
          prng,
          vary:
            variation > 0
              ? (volume, _instance, instancePrng) => {
                  // Trim rim cells only: the outline changes, the interior does not.
                  for (const { pos } of [...volume.iterateSolid()]) {
                    let open = 0;
                    if (volume.get(pos.x + 1, pos.y, pos.z) === 0) open++;
                    if (volume.get(pos.x - 1, pos.y, pos.z) === 0) open++;
                    if (volume.get(pos.x, pos.y, pos.z + 1) === 0) open++;
                    if (volume.get(pos.x, pos.y, pos.z - 1) === 0) open++;
                    if (open >= 2 && instancePrng.chance(variation * 0.3)) volume.setAt(pos, 0);
                  }
                }
              : undefined,
        });
        return 0;
      });
      return json({
        build: session.id,
        instances: instances.map((i) => ({
          index: i.index,
          position: i.position,
          angleDegrees: Math.round(i.angleDegrees * 10) / 10,
          rotation: i.rotation,
        })),
      });
    },
  );

  registry.register(
    "radial_symmetry",
    "Replicate one angular sector of the build around a centre. Build the first sector however you like, then fan it out.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      count: z.number().int().min(2).max(32),
      startAngle: z.number().min(-360).max(360).optional(),
    },
    (args) =>
      text(
        run(args, "radial_symmetry", (s) =>
          radialSymmetry(s.volume, {
            center: toVec(args["center"]),
            count: args["count"] as number,
            startAngleDegrees: args["startAngle"] as number | undefined,
          }),
        ),
      ),
  );

  // -- Single cells ---------------------------------------------------------------------------------

  registry.register(
    "set_block",
    "Set one block. FOR FINAL ADJUSTMENTS ONLY — a detail a shape operation cannot express. Never build a structure out of these calls; find the geometric, structural or region-level operation instead.",
    { build: buildRefSchema, position: vec3Schema, material: materialSchema },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const changed = session.history.run("set_block", () =>
        session.volume.plot(toVec(args["position"]), resolveMaterial(args["material"] as string, session.palette))
          ? 1
          : 0,
      );
      return text(changeSummary("set_block", changed, session.id));
    },
  );

  registry.register(
    "fill_region",
    "Fill a region with one material. The blunt instrument: prefer a shape or a gradient when one fits.",
    { build: buildRefSchema, region: regionSchema, material: materialSchema },
    (args) =>
      text(
        run(args, "fill_region", (s) =>
          s.volume.fill(toRegion(args["region"]), resolveMaterial(args["material"] as string, s.palette)),
        ),
      ),
  );

  registry.register(
    "clear_region",
    "Set a region to air.",
    { build: buildRefSchema, region: regionSchema },
    (args) =>
      text(run(args, "clear_region", (s) => s.volume.fill(toRegion(args["region"]), 0))),
  );

  registry.register(
    "get_block",
    "Read the block at a position, and a small summary of the column it sits in.",
    { build: buildRefSchema, position: vec3Schema },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const p = toVec(args["position"]);
      return json({
        build: session.id,
        position: p,
        block: blockName(session.volume.getAt(p)),
        surfaceY: session.volume.topSolidY(p.x, p.z),
        bottomY: session.volume.bottomSolidY(p.x, p.z),
      });
    },
  );
}
