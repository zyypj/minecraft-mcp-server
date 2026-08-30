/**
 * Structure and domain tools.
 *
 * The level above geometry: terrain, buildings, roofs, bridges, arenas, sculptures, and the two
 * domain generators. A plan that reaches for these is describing *architecture* — "an organic
 * island of radius 28 with overhangs", "a two-storey base with a hip roof facing the middle" — and
 * the engine turns that into geometry, materials and validation.
 */

import { z } from "zod";

import {
  ARCHETYPE_IDS,
  Prng,
  buildArena,
  buildBedwarsMap,
  buildBridge,
  buildBuilding,
  buildDuelsArena,
  buildOrganicIsland,
  buildPath,
  buildRoof,
  buildStairway,
  buildTower,
  buildDiamondTemplate,
  buildTeamTemplate,
  buildVoxelSculpture,
  buildWallStructure,
  carveFromSilhouettes,
  flattenTerrain,
  getArchetype,
  plantVegetation,
  silhouetteFromAscii,
  resolveStyle,
  teamTintedPalette,
  transformVolume,
  varyIsland,
  vec,
  type BedwarsSpec,
  type ResolvedStyle,
} from "@mcbuild/engine";

import { type BuildToolRegistry, json, lines, text } from "../build/registry.js";
import { BuildSession, type BuildWorkspace } from "../build/session.js";
import {
  buildRefSchema,
  changeSummary,
  facingSchema,
  materialSchema,
  regionSchema,
  resolveMaterial,
  toRegion,
  toVec,
  vec3Schema,
} from "../build/args.js";

const roofStyleSchema = z.enum([
  "gable",
  "hip",
  "pyramid",
  "cone",
  "dome",
  "flat",
  "tent",
  "pagoda",
  "barrel",
]);

/**
 * How a structure of each kind is rebuilt from its recorded parameters.
 *
 * This table is what makes `regenerate_structure` possible. Every structure tool records the exact
 * arguments it was called with on its graph node, so regenerating is re-dispatching those arguments
 * (with any overrides merged in) through the same builder. Kinds absent from the table were not
 * produced by a single parameterized call — a whole BedWars map, for instance — and are reported as
 * such rather than silently doing nothing.
 */
type Rebuilder = (session: BuildSession, params: Record<string, unknown>) => number;

const REBUILDERS: Readonly<Record<string, Rebuilder>> = {
  terrain: (session, params) =>
    buildOrganicIsland(session.volume, {
      center: toVec(params["center"]),
      radius: params["radius"] as number,
      depth: (params["depth"] as number | undefined) ?? Math.round((params["radius"] as number) * 0.8),
      palette: session.palette,
      seed: (params["seed"] as number | undefined) ?? session.seed,
      edgeNoise: params["edgeNoise"] as number | undefined,
      overhang: params["overhang"] as number | undefined,
      topRelief: params["topRelief"] as number | undefined,
      flatCoreRatio: params["flatCoreRatio"] as number | undefined,
      stretchX: params["stretchX"] as number | undefined,
      stretchZ: params["stretchZ"] as number | undefined,
      variation: params["variation"] as number | undefined,
    }).blocksPlaced,

  tower: (session, params) =>
    buildTower(session.volume, {
      base: toVec(params["base"]),
      radius: params["radius"] as number,
      height: params["height"] as number,
      palette: session.palette,
      prng: new Prng(session.seed),
      shape: params["shape"] as never,
      hollow: params["hollow"] as boolean | undefined,
      wallThickness: params["wallThickness"] as number | undefined,
      bandSpacing: params["bandSpacing"] as number | undefined,
      windowSpacing: params["windowSpacing"] as number | undefined,
      battlements: params["battlements"] as boolean | undefined,
      batter: params["batter"] as number | undefined,
      roofStyle: params["roofStyle"] as never,
    }).blocksPlaced,

  building: (session, params) =>
    buildBuilding(session.volume, {
      footprint: toRegion(params["footprint"]),
      baseY: params["baseY"] as number,
      palette: session.palette,
      prng: new Prng(session.seed),
      floors: params["floors"] as number | undefined,
      floorHeight: params["floorHeight"] as number | undefined,
      roofStyle: params["roofStyle"] as never,
      roofPitch: params["roofPitch"] as number | undefined,
      roofOverhang: params["roofOverhang"] as number | undefined,
      entranceFacing: params["entranceFacing"] as never,
      wallThickness: params["wallThickness"] as number | undefined,
      windowSpacing: params["windowSpacing"] as number | undefined,
      interior: params["interior"] as boolean | undefined,
    }).totalBlocks,

  roof: (session, params) =>
    buildRoof(session.volume, {
      footprint: toRegion(params["footprint"]),
      baseY: params["baseY"] as number,
      style: params["style"] as never,
      palette: session.palette,
      overhang: params["overhang"] as number | undefined,
      pitch: params["pitch"] as number | undefined,
      tiers: params["tiers"] as number | undefined,
      solid: params["solid"] as boolean | undefined,
      prng: new Prng(session.seed),
    }).blocksPlaced,

  arena: (session, params) =>
    buildArena(session.volume, {
      center: toVec(params["center"]),
      playableRadius: params["playableRadius"] as number,
      palette: session.palette,
      prng: new Prng(session.seed),
      shape: params["shape"] as never,
      boundary: params["boundary"] as never,
      wallHeight: params["wallHeight"] as number | undefined,
      seatingRows: params["seatingRows"] as number | undefined,
      spawns: params["spawns"] as number | undefined,
      roofHeight: params["roofHeight"] as number | undefined,
      pillars: params["pillars"] as number | undefined,
    }).blocksPlaced,

  bridge: (session, params) =>
    buildBridge(session.volume, {
      from: toVec(params["from"]),
      to: toVec(params["to"]),
      palette: session.palette,
      width: params["width"] as number | undefined,
      style: params["style"] as never,
      railing: params["railing"] as number | undefined,
      rise: params["rise"] as number | undefined,
      supportSpacing: params["supportSpacing"] as number | undefined,
    }).blocksPlaced,

  landmark: (session, params) => {
    if (params["front"]) {
      return carveFromSilhouettes(session.volume, {
        front: silhouetteFromAscii(params["front"] as string[]),
        side: params["side"] ? silhouetteFromAscii(params["side"] as string[]) : undefined,
        top: params["top"] ? silhouetteFromAscii(params["top"] as string[]) : undefined,
        anchor: toVec(params["anchor"]),
        height: params["height"] as number,
        depth: params["depth"] as number | undefined,
        block: resolveMaterial((params["material"] as string) ?? "WALL_PRIMARY", session.palette),
        facing: params["facing"] as never,
        smooth: params["smooth"] as number | undefined,
      }).blocksPlaced;
    }
    const overrides = (params["materials"] as Record<string, string> | undefined) ?? {};
    const materials: Record<string, ReturnType<typeof resolveMaterial>> = {
      body: session.palette.source("WALL_PRIMARY", { scale: 5 }),
      belly: session.palette.source("WALL_SECONDARY", { scale: 5 }),
      detail: session.palette.source("DETAIL"),
      accent: session.palette.source("ACCENT", { scale: 3 }),
      eye: session.palette.primary("DETAIL"),
      limb: session.palette.source("SUPPORT", { scale: 4 }),
      highlight: session.palette.source("TRIM"),
    };
    for (const [key, value] of Object.entries(overrides)) {
      materials[key] = resolveMaterial(value, session.palette);
    }
    return buildVoxelSculpture(session.volume, {
      model: getArchetype(params["archetype"] as string),
      anchor: toVec(params["anchor"]),
      height: params["height"] as number,
      materials,
      facing: params["facing"] as never,
      detail: params["detail"] as never,
      smooth: params["smooth"] as number | undefined,
      variation: params["variation"] as number | undefined,
      prng: new Prng(session.seed),
    }).blocksPlaced;
  },

  build_path: (session, params) =>
    buildPath(session.volume, {
      points: (params["points"] as unknown[]).map(toVec),
      palette: session.palette,
      width: params["width"] as number | undefined,
      edging: params["edging"] as boolean | undefined,
      wobble: params["wobble"] as number | undefined,
    }),

  build_freestanding_wall: (session, params) =>
    buildWallStructure(session.volume, {
      from: toVec(params["from"]),
      to: toVec(params["to"]),
      height: params["height"] as number,
      palette: session.palette,
      thickness: params["thickness"] as number | undefined,
      battlements: params["battlements"] as boolean | undefined,
      buttressSpacing: params["buttressSpacing"] as number | undefined,
    }),

  build_stairway: (session, params) =>
    buildStairway(session.volume, {
      from: toVec(params["from"]),
      to: toVec(params["to"]),
      palette: session.palette,
      width: params["width"] as number | undefined,
      landingEvery: params["landingEvery"] as number | undefined,
    }),

  /**
   * A team island: rebuilt from the same template the generator used.
   *
   * This is the case the whole graph exists for. "Redo only the roofs of the team islands" means
   * calling this with `{ roofStyle: "dome" }` on each `team_island` node: the template is rebuilt
   * with the overridden spec, re-instanced at the same exact position and rotation, and nothing
   * else in the map moves by a block.
   */
  team_island: (session, params) => {
    const layout = session.layout;
    if (!layout) {
      throw new Error("This build has no BedWars layout, so its team islands cannot be rebuilt.");
    }
    const index = params["team"] as number;
    const island = layout.teamIslands[index];
    if (!island) throw new Error(`No team island ${index}; the map has ${layout.teamIslands.length}.`);

    // Node parameters override the map's original spec, which is how a single knob (a roof style, a
    // decoration density) can be changed without re-specifying the map.
    const spec = { ...(session.spec as BedwarsSpec), ...params } as BedwarsSpec;
    const teamPalette = teamTintedPalette(session.palette, island.color);
    const template = buildTeamTemplate(
      spec,
      layout,
      island,
      teamPalette,
      session.seed,
      undefined,
      new Prng(session.seed),
    );
    const oriented =
      island.rotation === 0
        ? template.volume
        : transformVolume(template.volume, { rotation: island.rotation });
    return session.volume.blit(
      oriented,
      vec(
        island.center.x - Math.floor(oriented.width / 2),
        layout.surfaceY - template.surfaceLocalY,
        island.center.z - Math.floor(oriented.length / 2),
      ),
      { ignoreAir: true },
    );
  },

  diamond_island: (session, params) => {
    const layout = session.layout;
    if (!layout) {
      throw new Error("This build has no BedWars layout, so its diamond islands cannot be rebuilt.");
    }
    const match = /diamond_(\d+)/.exec(String(params["label"] ?? ""));
    const index = match ? Number(match[1]) : (params["index"] as number | undefined) ?? 0;
    const island = layout.diamondIslands[index];
    if (!island) throw new Error(`No diamond island ${index}.`);

    const prng = new Prng(session.seed);
    const template = buildDiamondTemplate(layout, session.palette, session.seed, undefined, prng);
    const variation = (params["variation"] as number | undefined) ?? 0;
    const instance =
      variation > 0 ? varyIsland(template.volume, prng.fork(`diamond-var-${index}`), variation) : template.volume;
    return session.volume.blit(
      instance,
      vec(
        island.center.x - Math.floor(instance.width / 2),
        layout.surfaceY - template.surfaceLocalY,
        island.center.z - Math.floor(instance.length / 2),
      ),
      { ignoreAir: true },
    );
  },

  flatten_terrain: (session, params) =>
    flattenTerrain(session.volume, {
      region: toRegion(params["region"]),
      y: params["y"] as number,
      surfaceBlock: resolveMaterial(params["material"] as string, session.palette),
      feather: params["feather"] as number | undefined,
    }),
};

export function registerBuildStructureTools(registry: BuildToolRegistry, workspace: BuildWorkspace): void {
  const run = (
    args: Record<string, unknown>,
    label: string,
    fn: (session: BuildSession) => number,
  ): string => {
    const session = workspace.require(args["build"] as string | undefined);
    // The arguments are recorded on the node so `regenerate_structure` can replay them.
    const changed = session.history.run(label, () =>
      session.graph.build({ kind: label, params: args }, () => fn(session)).result,
    );
    return changeSummary(label, changed, session.id);
  };

  // -- Terrain -------------------------------------------------------------------------------------

  registry.register(
    "build_island",
    "An organic floating island: irregular outline, tapered underside, overhangs, and a flat buildable core. This is the terrain primitive for a floating-island map — a plain disc reads as programmer art no matter what is built on it.",
    {
      build: buildRefSchema,
      center: vec3Schema.describe("Centre of the island, at the height of its top surface."),
      radius: z.number().min(3).max(512),
      depth: z.number().min(1).max(200).optional().describe("Thickness below the surface at the centre."),
      edgeNoise: z.number().min(0).max(1).optional().describe("Outline irregularity. 0 is a circle; 0.25 is the sweet spot."),
      overhang: z.number().min(0).max(20).optional(),
      topRelief: z.number().min(0).max(12).optional().describe("Vertical relief on the surface. Keep small so it stays buildable."),
      flatCoreRatio: z.number().min(0.2).max(1).optional(),
      stretchX: z.number().min(0.2).max(4).optional().describe("Above 1 makes the island oval."),
      stretchZ: z.number().min(0.2).max(4).optional(),
      variation: z.number().min(0).max(1).optional(),
      seed: z.number().int().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let datumY = 0;
      const changed = session.history.run("build_island", () => {
        const { result } = session.graph.build({ kind: "terrain", label: "island", params: args }, () =>
          buildOrganicIsland(session.volume, {
            center: toVec(args["center"]),
            radius: args["radius"] as number,
            depth: (args["depth"] as number | undefined) ?? Math.round((args["radius"] as number) * 0.8),
            palette: session.palette,
            seed: (args["seed"] as number | undefined) ?? session.seed,
            edgeNoise: args["edgeNoise"] as number | undefined,
            overhang: args["overhang"] as number | undefined,
            topRelief: args["topRelief"] as number | undefined,
            flatCoreRatio: args["flatCoreRatio"] as number | undefined,
            stretchX: args["stretchX"] as number | undefined,
            stretchZ: args["stretchZ"] as number | undefined,
            variation: args["variation"] as number | undefined,
          }),
        );
        datumY = result.datumY;
        return result.blocksPlaced;
      });
      return text(
        `${changeSummary("build_island", changed, session.id)} Buildable surface is at Y=${datumY}.`,
      );
    },
  );

  registry.register(
    "flatten_terrain",
    "Level a patch of terrain to a fixed height, feathered into the surrounding surface. Use before placing anything that needs level ground.",
    {
      build: buildRefSchema,
      region: regionSchema,
      y: z.number().int(),
      material: materialSchema,
      feather: z.number().int().min(0).max(16).optional(),
    },
    (args) =>
      text(
        run(args, "flatten_terrain", (s) =>
          flattenTerrain(s.volume, {
            region: toRegion(args["region"]),
            y: args["y"] as number,
            surfaceBlock: resolveMaterial(args["material"] as string, s.palette),
            feather: args["feather"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "plant_vegetation",
    "Scatter vegetation over the current surface, skipping the regions you name. Density 0.06-0.12 reads as planted.",
    {
      build: buildRefSchema,
      region: regionSchema.optional(),
      density: z.number().min(0).max(1).optional(),
      avoid: z.array(regionSchema).optional().describe("Gameplay areas that must stay clear."),
      seed: z.number().int().optional(),
    },
    (args) =>
      text(
        run(args, "plant_vegetation", (s) =>
          plantVegetation(s.volume, {
            surface: s.volume.heightmap(),
            volumeWidth: s.volume.width,
            region: args["region"] ? toRegion(args["region"]) : s.volume.bounds,
            palette: s.palette,
            prng: new Prng((args["seed"] as number | undefined) ?? s.seed),
            density: (args["density"] as number | undefined) ?? 0.08,
            avoid: (args["avoid"] as unknown[] | undefined)?.map(toRegion),
          }),
        ),
      ),
  );

  // -- Architecture --------------------------------------------------------------------------------

  registry.register(
    "build_tower",
    "A tower, composed rather than extruded: a battered base, banding courses, optional windows, battlements and a roof. A bare cylinder is the canonical generated-looking structure; these parameters are what stop it being one.",
    {
      build: buildRefSchema,
      base: vec3Schema,
      radius: z.number().min(1).max(128),
      height: z.number().int().min(2).max(255),
      shape: z.enum(["round", "square", "hexagon", "octagon"]).optional(),
      hollow: z.boolean().optional(),
      wallThickness: z.number().int().min(1).max(8).optional(),
      bandSpacing: z.number().int().min(0).max(32).optional().describe("Courses between trim bands. 0 disables."),
      windowSpacing: z.number().int().min(0).max(32).optional(),
      battlements: z.boolean().optional(),
      batter: z.number().int().min(0).max(6).optional().describe("How many blocks wider the base is."),
      roofStyle: roofStyleSchema.optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let ridgeY = 0;
      const changed = session.history.run("build_tower", () => {
        const { result } = session.graph.build({ kind: "tower", params: args }, () =>
          buildTower(session.volume, {
            base: toVec(args["base"]),
            radius: args["radius"] as number,
            height: args["height"] as number,
            palette: session.palette,
            prng: new Prng(session.seed),
            shape: args["shape"] as "round" | "square" | "hexagon" | "octagon" | undefined,
            hollow: args["hollow"] as boolean | undefined,
            wallThickness: args["wallThickness"] as number | undefined,
            bandSpacing: args["bandSpacing"] as number | undefined,
            windowSpacing: args["windowSpacing"] as number | undefined,
            battlements: args["battlements"] as boolean | undefined,
            batter: args["batter"] as number | undefined,
            roofStyle: args["roofStyle"] as never,
          }),
        );
        ridgeY = result.ridgeY;
        return result.blocksPlaced;
      });
      return text(`${changeSummary("build_tower", changed, session.id)} Top of the roof is at Y=${ridgeY}.`);
    },
  );

  registry.register(
    "build_building",
    "A building assembled from named components: foundation, main volume, floor bands, windows, entrance, roof and interior. Every default exists to break a flat plane — a plinth that steps out, corner posts, two-block window reveals.",
    {
      build: buildRefSchema,
      footprint: regionSchema.describe("Horizontal footprint; Y is ignored, use `baseY`."),
      baseY: z.number().int(),
      floors: z.number().int().min(1).max(8).optional(),
      floorHeight: z.number().int().min(3).max(12).optional(),
      roofStyle: roofStyleSchema.optional(),
      roofPitch: z.number().min(0.2).max(2).optional(),
      roofOverhang: z.number().int().min(0).max(4).optional(),
      entranceFacing: facingSchema.optional(),
      wallThickness: z.number().int().min(1).max(4).optional(),
      windowSpacing: z.number().int().min(0).max(12).optional().describe("0 disables windows."),
      interior: z.boolean().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let ridgeY = 0;
      let components: string[] = [];
      const changed = session.history.run("build_building", () => {
        const { result } = session.graph.build({ kind: "building", params: args }, () =>
          buildBuilding(session.volume, {
            footprint: toRegion(args["footprint"]),
            baseY: args["baseY"] as number,
            palette: session.palette,
            prng: new Prng(session.seed),
            floors: args["floors"] as number | undefined,
            floorHeight: args["floorHeight"] as number | undefined,
            roofStyle: args["roofStyle"] as never,
            roofPitch: args["roofPitch"] as number | undefined,
            roofOverhang: args["roofOverhang"] as number | undefined,
            entranceFacing: args["entranceFacing"] as never,
            wallThickness: args["wallThickness"] as number | undefined,
            windowSpacing: args["windowSpacing"] as number | undefined,
            interior: args["interior"] as boolean | undefined,
          }),
        );
        ridgeY = result.ridgeY;
        components = result.components.map((c) => `${c.kind}:${c.blocksPlaced}`);
        return result.totalBlocks;
      });
      return lines([
        changeSummary("build_building", changed, session.id),
        `Ridge at Y=${ridgeY}. Components: ${components.join(", ")}.`,
      ]);
    },
  );

  registry.register(
    "build_roof",
    "A roof over a footprint. Nine styles, from gable and hip through cone and dome to the stacked tiers of a fairground pagoda. An eave overhang of 1-2 is what casts the shadow line that reads as built.",
    {
      build: buildRefSchema,
      footprint: regionSchema,
      baseY: z.number().int().describe("Y of the wall top the roof sits on."),
      style: roofStyleSchema,
      overhang: z.number().int().min(0).max(6).optional(),
      pitch: z.number().min(0.2).max(3).optional(),
      tiers: z.number().int().min(2).max(6).optional().describe("For tent and pagoda."),
      solid: z.boolean().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let ridgeY = 0;
      const changed = session.history.run("build_roof", () => {
        const { result } = session.graph.build({ kind: "roof", params: args }, () =>
          buildRoof(session.volume, {
            footprint: toRegion(args["footprint"]),
            baseY: args["baseY"] as number,
            style: args["style"] as never,
            palette: session.palette,
            overhang: args["overhang"] as number | undefined,
            pitch: args["pitch"] as number | undefined,
            tiers: args["tiers"] as number | undefined,
            solid: args["solid"] as boolean | undefined,
            prng: new Prng(session.seed),
          }),
        );
        ridgeY = result.ridgeY;
        return result.blocksPlaced;
      });
      return text(`${changeSummary("build_roof", changed, session.id)} Ridge at Y=${ridgeY}.`);
    },
  );

  registry.register(
    "build_freestanding_wall",
    "A freestanding wall with a coping course, periodic buttresses and optional battlements.",
    {
      build: buildRefSchema,
      from: vec3Schema,
      to: vec3Schema,
      height: z.number().int().min(1).max(128),
      thickness: z.number().int().min(1).max(8).optional(),
      battlements: z.boolean().optional(),
      buttressSpacing: z.number().int().min(0).max(32).optional(),
    },
    (args) =>
      text(
        run(args, "build_freestanding_wall", (s) =>
          buildWallStructure(s.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            height: args["height"] as number,
            palette: s.palette,
            thickness: args["thickness"] as number | undefined,
            battlements: args["battlements"] as boolean | undefined,
            buttressSpacing: args["buttressSpacing"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_arena",
    "A bounded fighting space: flat floor, boundary, evenly spaced spawns, optional seating and roof. Returns the spawn positions it computed.",
    {
      build: buildRefSchema,
      center: vec3Schema,
      playableRadius: z.number().min(4).max(256),
      shape: z.enum(["circle", "square", "hexagon", "octagon"]).optional(),
      boundary: z.enum(["wall", "fence", "void", "glass", "open"]).optional(),
      wallHeight: z.number().int().min(0).max(32).optional(),
      seatingRows: z.number().int().min(0).max(8).optional(),
      spawns: z.number().int().min(2).max(16).optional(),
      roofHeight: z.number().int().min(0).max(64).optional(),
      pillars: z.number().int().min(0).max(32).optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let spawns: readonly { x: number; y: number; z: number }[] = [];
      const changed = session.history.run("build_arena", () => {
        const { result } = session.graph.build({ kind: "arena", params: args }, () =>
          buildArena(session.volume, {
            center: toVec(args["center"]),
            playableRadius: args["playableRadius"] as number,
            palette: session.palette,
            prng: new Prng(session.seed),
            shape: args["shape"] as never,
            boundary: args["boundary"] as never,
            wallHeight: args["wallHeight"] as number | undefined,
            seatingRows: args["seatingRows"] as number | undefined,
            spawns: args["spawns"] as number | undefined,
            roofHeight: args["roofHeight"] as number | undefined,
            pillars: args["pillars"] as number | undefined,
          }),
        );
        spawns = result.spawns;
        return result.blocksPlaced;
      });
      return json({ message: changeSummary("build_arena", changed, session.id), spawns });
    },
  );

  // -- Connections ---------------------------------------------------------------------------------

  registry.register(
    "build_bridge",
    "A bridge between two points. On a competitive map this is a rush route first and scenery second, so width, railing height and supports are the parameters that matter.",
    {
      build: buildRefSchema,
      from: vec3Schema,
      to: vec3Schema,
      width: z.number().int().min(1).max(16).optional(),
      style: z.enum(["flat", "arched", "suspension", "covered"]).optional(),
      railing: z.number().int().min(0).max(4).optional().describe("0 leaves the deck open, so players can be knocked off."),
      rise: z.number().int().min(0).max(64).optional(),
      supportSpacing: z.number().int().min(0).max(64).optional().describe("Drop a pier every N blocks. 0 disables."),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      let length = 0;
      const changed = session.history.run("build_bridge", () => {
        const { result } = session.graph.build({ kind: "bridge", params: args }, () =>
          buildBridge(session.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            palette: session.palette,
            width: args["width"] as number | undefined,
            style: args["style"] as never,
            railing: args["railing"] as number | undefined,
            rise: args["rise"] as number | undefined,
            supportSpacing: args["supportSpacing"] as number | undefined,
          }),
        );
        length = result.length;
        return result.blocksPlaced;
      });
      return text(`${changeSummary("build_bridge", changed, session.id)} Span is ${length} blocks.`);
    },
  );

  registry.register(
    "build_path",
    "Lay a path across terrain, following the existing surface height rather than a fixed Y.",
    {
      build: buildRefSchema,
      points: z.array(vec3Schema).min(2).max(64),
      width: z.number().int().min(1).max(16).optional(),
      edging: z.boolean().optional(),
      wobble: z.number().int().min(0).max(4).optional().describe("Width jitter, so the path is not a ruler line."),
    },
    (args) =>
      text(
        run(args, "build_path", (s) =>
          buildPath(s.volume, {
            points: (args["points"] as unknown[]).map(toVec),
            palette: s.palette,
            width: args["width"] as number | undefined,
            edging: args["edging"] as boolean | undefined,
            wobble: args["wobble"] as number | undefined,
          }),
        ),
      ),
  );

  registry.register(
    "build_stairway",
    "A stepped ramp between two heights, with optional landings. Full blocks rather than stair blocks, because a step a player can fail to mount is a gameplay bug.",
    {
      build: buildRefSchema,
      from: vec3Schema,
      to: vec3Schema,
      width: z.number().int().min(1).max(12).optional(),
      landingEvery: z.number().int().min(0).max(32).optional(),
    },
    (args) =>
      text(
        run(args, "build_stairway", (s) =>
          buildStairway(s.volume, {
            from: toVec(args["from"]),
            to: toVec(args["to"]),
            palette: s.palette,
            width: args["width"] as number | undefined,
            landingEvery: args["landingEvery"] as number | undefined,
          }),
        ),
      ),
  );

  // -- Sculpture -----------------------------------------------------------------------------------

  registry.register(
    "list_sculpture_archetypes",
    "List the built-in sculpture archetypes. These are generic forms (a cartoon dog, a chick, a flower, an orb), not likenesses — for a specific character, trace it with `build_sculpture_from_silhouette` or extract it from a reference schematic.",
    {},
    () =>
      lines([
        `Archetypes: ${ARCHETYPE_IDS.join(", ")}`,
        "",
        "Material keys each archetype uses: body, belly, detail, accent, eye, limb, highlight.",
        "They default to the build's palette roles, so a sculpture picks up the map's style automatically.",
      ]),
  );

  registry.register(
    "build_voxel_sculpture",
    "Build a landmark sculpture from a parametric archetype. Sized by `height`; the model's proportions follow. This is what gives a themed map its identity — geometry primitives stacked together give you a snowman.",
    {
      build: buildRefSchema,
      archetype: z.string().describe(`One of: ${ARCHETYPE_IDS.join(", ")}`),
      anchor: vec3Schema.describe("Bottom centre of the sculpture."),
      height: z.number().int().min(4).max(200),
      facing: facingSchema.optional(),
      detail: z.enum(["low", "medium", "high"]).optional(),
      smooth: z.number().int().min(0).max(3).optional(),
      variation: z.number().min(0).max(1).optional(),
      materials: z
        .record(z.string())
        .optional()
        .describe("Override material keys with block names or palette roles, e.g. {\"body\":\"white_wool\"}."),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const overrides = (args["materials"] as Record<string, string> | undefined) ?? {};
      const materials: Record<string, ReturnType<typeof resolveMaterial>> = {
        body: session.palette.source("WALL_PRIMARY", { scale: 5 }),
        belly: session.palette.source("WALL_SECONDARY", { scale: 5 }),
        detail: session.palette.source("DETAIL"),
        accent: session.palette.source("ACCENT", { scale: 3 }),
        eye: session.palette.primary("DETAIL"),
        limb: session.palette.source("SUPPORT", { scale: 4 }),
        highlight: session.palette.source("TRIM"),
      };
      for (const [key, value] of Object.entries(overrides)) {
        materials[key] = resolveMaterial(value, session.palette);
      }

      let parts: Record<string, number> = {};
      const changed = session.history.run("build_voxel_sculpture", () => {
        const { result } = session.graph.build(
          { kind: "landmark", label: args["archetype"] as string, params: args },
          () =>
            buildVoxelSculpture(session.volume, {
              model: getArchetype(args["archetype"] as string),
              anchor: toVec(args["anchor"]),
              height: args["height"] as number,
              materials,
              facing: args["facing"] as never,
              detail: args["detail"] as never,
              smooth: args["smooth"] as number | undefined,
              variation: args["variation"] as number | undefined,
              prng: new Prng(session.seed),
            }),
        );
        parts = { ...result.partCounts };
        return result.blocksPlaced;
      });
      return lines([
        changeSummary("build_voxel_sculpture", changed, session.id),
        `Parts placed: ${Object.entries(parts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      ]);
    },
  );

  registry.register(
    "build_sculpture_from_silhouette",
    "Carve a sculpture as the intersection of orthographic silhouettes, given as ASCII art (`#` is solid, `.` or space is empty; the first row is the top). This is the path for an exact shape — trace a reference into a front and a side view and the engine produces the volume.",
    {
      build: buildRefSchema,
      anchor: vec3Schema,
      height: z.number().int().min(4).max(200),
      material: materialSchema,
      front: z.array(z.string()).min(2).describe("X/Y outline, viewed from the south."),
      side: z.array(z.string()).optional().describe("Z/Y outline. Without it the shape is a straight extrusion."),
      top: z.array(z.string()).optional().describe("X/Z outline, viewed from above."),
      depth: z.number().int().min(1).max(200).optional(),
      facing: facingSchema.optional(),
      smooth: z.number().int().min(0).max(3).optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const changed = session.history.run("build_sculpture_from_silhouette", () => {
        const { result } = session.graph.build({ kind: "landmark", label: "silhouette", params: args }, () =>
          carveFromSilhouettes(session.volume, {
            front: silhouetteFromAscii(args["front"] as string[]),
            side: args["side"] ? silhouetteFromAscii(args["side"] as string[]) : undefined,
            top: args["top"] ? silhouetteFromAscii(args["top"] as string[]) : undefined,
            anchor: toVec(args["anchor"]),
            height: args["height"] as number,
            depth: args["depth"] as number | undefined,
            block: resolveMaterial(args["material"] as string, session.palette),
            facing: args["facing"] as never,
            smooth: args["smooth"] as number | undefined,
          }),
        );
        return result.blocksPlaced;
      });
      return text(changeSummary("build_sculpture_from_silhouette", changed, session.id));
    },
  );

  // -- Domain generators ----------------------------------------------------------------------------

  registry.register(
    "build_bedwars_map",
    "Generate a complete BedWars map. Gameplay layout is fixed first and every later pass is masked away from it, so decoration can never eat a rush lane. Team islands are instanced from one template, which makes the map fair by construction. Creates a new build and returns its id, layout and analysis.",
    {
      name: z.string().optional(),
      teams: z.number().int().min(2).max(16),
      playersPerTeam: z.number().int().min(1).max(8).optional(),
      seed: z.number().int().optional().describe("The same seed and spec always rebuild the same map."),
      theme: z.string().optional().describe("Free text. Picks a landmark archetype when none is named."),
      rushDistance: z.number().int().min(16).max(200).optional().describe("Straight-line distance between adjacent bases. Drives the whole layout."),
      mapRadius: z.number().int().min(30).max(500).optional(),
      teamIslandRadius: z.number().int().min(6).max(60).optional(),
      midRadius: z.number().int().min(6).max(120).optional(),
      diamondIslands: z.number().int().min(0).max(8).optional(),
      landmarkArchetype: z.string().optional().describe(`One of: ${ARCHETYPE_IDS.join(", ")}, or "none".`),
      landmarkHeight: z.number().int().min(5).max(120).optional(),
      style: z.string().optional().describe("Style id from the library, used for palette and measured traits."),
      styleFidelity: z.number().min(0).max(1).optional(),
      styleOriginality: z.number().min(0).max(1).optional(),
      variation: z.number().min(0).max(1).optional(),
      decorationDensity: z.number().min(0).max(1).optional(),
      bridges: z.enum(["none", "diamond", "full"]).optional(),
      roofStyle: roofStyleSchema.optional(),
      walkPaths: z.boolean().optional().describe("Run the slower walkable-path search during analysis."),
    },
    (args) => {
      const styleId = args["style"] as string | undefined;
      const style = styleId
        ? resolveStyleFromLibrary(workspace, styleId, args["styleFidelity"] as number | undefined, args["styleOriginality"] as number | undefined)
        : undefined;

      const landmark =
        args["landmarkArchetype"] === "none"
          ? ("none" as const)
          : args["landmarkArchetype"] || args["landmarkHeight"]
            ? {
                archetype: args["landmarkArchetype"] as string | undefined,
                height: args["landmarkHeight"] as number | undefined,
              }
            : undefined;

      const spec = {
        teams: args["teams"] as number,
        playersPerTeam: args["playersPerTeam"] as number | undefined,
        seed: args["seed"] as number | undefined,
        theme: args["theme"] as string | undefined,
        rushDistance: args["rushDistance"] as number | undefined,
        mapRadius: args["mapRadius"] as number | undefined,
        teamIslandRadius: args["teamIslandRadius"] as number | undefined,
        midRadius: args["midRadius"] as number | undefined,
        diamondIslands: args["diamondIslands"] as number | undefined,
        landmark,
        style,
        variation: args["variation"] as number | undefined,
        decorationDensity: args["decorationDensity"] as number | undefined,
        bridges: args["bridges"] as never,
        roofStyle: args["roofStyle"] as never,
        walkPaths: args["walkPaths"] as boolean | undefined,
      };

      const result = buildBedwarsMap(spec);
      const session = new BuildSession({
        name: (args["name"] as string | undefined) ?? `bedwars_${result.layout.teamIslands.length}team_${result.seed}`,
        width: result.volume.width,
        height: result.volume.height,
        length: result.volume.length,
        seed: result.seed,
        palette: result.palette,
        volume: result.volume,
        graph: result.graph,
      });
      session.layout = result.layout;
      session.points = [...result.points];
      session.theme = args["theme"] as string | undefined;
      session.styleId = styleId;
      session.spec = { ...spec, style: styleId };
      workspace.add(session);

      const errors = result.violations.filter((v) => v.severity === "error");
      return json({
        build: session.id,
        name: session.name,
        seed: result.seed,
        dimensions: result.volume.size,
        blocks: result.volume.countNonAir(),
        layout: {
          center: result.layout.center,
          surfaceY: result.layout.surfaceY,
          teamRingRadius: result.layout.teamRingRadius,
          rushDistance: result.layout.rushDistance,
          teams: result.layout.teamIslands.map((t) => ({
            label: t.label,
            color: t.color,
            center: t.center,
            spawn: t.spawn,
            bed: t.bed,
            generator: t.generator,
          })),
          diamondIslands: result.layout.diamondIslands.map((d) => ({ center: d.center, generator: d.generator })),
          mid: result.layout.mid,
        },
        analysis: {
          rushDistance: result.analysis.rushDistance,
          baseToDiamond: result.analysis.baseToDiamond,
          diamondToMid: result.analysis.diamondToMid,
          symmetry: result.analysis.symmetry,
          voidExposure: result.analysis.voidExposure,
          heightAdvantage: result.analysis.heightAdvantage,
          warnings: result.analysis.warnings,
        },
        issues: result.inspection.issues.map((i) => `${i.severity}: ${i.kind} (${i.count})`),
        constraintErrors: errors.map((e) => e.message),
        passTimings: result.passLog,
        next: "Call `preview_build` to look at it, then `save_build` to write the schematic and previews to disk.",
      });
    },
  );

  registry.register(
    "build_duels_arena",
    "Generate a duels arena. The kit drives the geometry — boxing wants a walled floor, sumo a small platform with no walls, bridge two platforms and a gap. Mirror symmetry is enforced, not hoped for.",
    {
      name: z.string().optional(),
      kit: z.enum(["classic", "boxing", "sumo", "bridge", "nodebuff", "uhc", "combo", "parkour"]).optional(),
      theme: z.string().optional(),
      seed: z.number().int().optional(),
      playableRadius: z.number().int().min(5).max(120).optional(),
      shape: z.enum(["circle", "square", "hexagon", "octagon"]).optional(),
      boundary: z.enum(["wall", "fence", "void", "glass", "open"]).optional(),
      seatingRows: z.number().int().min(0).max(6).optional(),
      landmark: z.string().optional().describe(`Archetype id, or "none".`),
      style: z.string().optional(),
    },
    (args) => {
      const styleId = args["style"] as string | undefined;
      const palette = styleId ? workspace.library.loadPalette(styleId) : undefined;
      const result = buildDuelsArena({
        kit: args["kit"] as never,
        theme: args["theme"] as string | undefined,
        seed: args["seed"] as number | undefined,
        playableRadius: args["playableRadius"] as number | undefined,
        shape: args["shape"] as never,
        boundary: args["boundary"] as never,
        seatingRows: args["seatingRows"] as number | undefined,
        landmark: args["landmark"] as never,
        palette,
      });

      const session = new BuildSession({
        name: (args["name"] as string | undefined) ?? `duels_${result.kit}_${result.seed}`,
        width: result.volume.width,
        height: result.volume.height,
        length: result.volume.length,
        seed: result.seed,
        palette: palette,
        volume: result.volume,
        graph: result.graph,
      });
      session.theme = args["theme"] as string | undefined;
      session.styleId = styleId;
      session.spec = args;
      workspace.add(session);

      return json({
        build: session.id,
        name: session.name,
        kit: result.kit,
        seed: result.seed,
        dimensions: result.volume.size,
        blocks: result.volume.countNonAir(),
        spawns: result.spawns,
        symmetry: result.symmetry,
        issues: result.inspection.issues.map((i) => `${i.severity}: ${i.kind} (${i.count})`),
      });
    },
  );

  registry.register(
    "regenerate_structure",
    "Rebuild one structure in place, under the same id, optionally changing its parameters. Everything else in the build is left byte-identical. This is how 'make that roof a dome instead' works without regenerating the map.",
    {
      build: buildRefSchema,
      structure: z.string().describe("A permanent id from `list_structures`."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Parameters to change. Merged over the ones the structure was originally built with."),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const id = args["structure"] as string;
      const node = session.graph.get(id);
      const rebuild = REBUILDERS[node.kind];
      if (!rebuild) {
        throw new Error(
          `Structures of kind "${node.kind}" cannot be regenerated on their own — they were not produced by a single parameterized call. ` +
            `Regeneratable kinds: ${Object.keys(REBUILDERS).join(", ")}. ` +
            "For a whole generated map, call the domain generator again with a changed spec.",
        );
      }

      const before = node.blocksPlaced;
      const placed = session.history.run(`regenerate ${id}`, () =>
        session.graph.regenerate(
          id,
          (current) => rebuild(session, current.params),
          args["params"] as Record<string, unknown> | undefined,
        ),
      );
      return lines([
        `Regenerated ${id} (${node.kind}${node.label ? ` "${node.label}"` : ""}).`,
        `${before.toLocaleString("en-US")} blocks reverted, ${placed.toLocaleString("en-US")} placed.`,
        ...(args["params"] ? [`Changed: ${Object.keys(args["params"] as object).join(", ")}.`] : []),
      ]);
    },
  );

}

/** Resolve a style id into the engine's `ResolvedStyle`, or fail with the list of known ids. */
function resolveStyleFromLibrary(
  workspace: BuildWorkspace,
  id: string,
  fidelity: number | undefined,
  originality: number | undefined,
): ResolvedStyle {
  const profile = workspace.library.load(id);
  return resolveStyle([{ profile, weight: 1 }], { fidelity, originality }, workspace.library.loadPalette(id));
}
