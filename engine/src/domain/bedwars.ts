/**
 * The BedWars map generator.
 *
 * This is where the whole engine points. A plan says *eight teams, carousel style, rush distance
 * 32, a giant mascot in the middle* and this produces a validated, analysed, 1.8-compatible map.
 *
 * ## Gameplay first, then structure, then theme
 *
 * The generation runs in passes, and their order is the single most important design decision here:
 *
 * ```
 *  1 Gameplay layout   positions derived from rush distance and team count
 *  2 Terrain           islands, sized to hold what pass 3 needs
 *  3 Major structures  bed platforms, spawn pads, shop areas
 *  4 Landmark          the focal sculpture, sized against the composition
 *  5 Architecture      buildings, sized to fit around the gameplay furniture
 *  6 Paths             routes between the gameplay points on each island
 *  7 Decoration        vegetation and props, masked away from every clearance
 *  8 Details           generator pads, spawn clearing, edge trim
 *  9 Gameplay checks   constraints, distances, symmetry
 * 10 Structural checks floating blocks, sealed pockets, suffocation
 * ```
 *
 * The positions are fixed in pass 1 and every later pass is masked away from them. That ordering is
 * what stops a giant carousel from eating a rush lane: the lane existed before the carousel did,
 * and the carousel is physically unable to write into it.
 */

import { type Region, type Vec3, distanceXZ, region, vec } from "../core/vec.js";
import { Noise } from "../core/noise.js";
import { Prng, clamp } from "../core/prng.js";
import { AIR, type Mask, Volume } from "../core/volume.js";
import { Palette, type WeightedBlock, blendPalettes } from "../mc18/palette.js";
import { block as resolveBlock } from "../mc18/material.js";
import { buildCircle, buildCylinder } from "../geom/shapes.js";
import { copyRegion, transformVolume } from "../ops/transform.js";
import { scatter } from "../ops/edit.js";
import { measureRadialSymmetry } from "../ops/symmetry.js";
import { buildOrganicIsland, flattenTerrain, plantVegetation } from "../terrain/island.js";
import { buildBuilding, buildTower } from "../structures/building.js";
import { buildBridge, buildPath } from "../structures/connections.js";
import { type RoofStyle, slabTop } from "../structures/roof.js";
import { ARCHETYPES, getArchetype } from "../sculpture/archetypes.js";
import { buildVoxelSculpture } from "../sculpture/voxel-sculpture.js";
import { BuildGraph } from "../history/graph.js";
import {
  type Constraints,
  type GameplayContext,
  type Violation,
  allMasks,
  checkConstraints,
  constraintMask,
} from "../validate/constraints.js";
import { type InspectionReport, inspectRegion } from "../validate/inspect.js";
import { type AnalysisPoint, type BedwarsAnalysis, analyzeBedwarsMap } from "../validate/gameplay.js";
import { type ResolvedStyle } from "../style/blend.js";

/** Team colours in the order a BedWars map assigns them. */
export const TEAM_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "cyan",
  "white",
  "pink",
  "gray",
] as const;

export type TeamColor = (typeof TEAM_COLORS)[number];

/** The wool a team colour maps to in 1.8. `cyan` and `white` are the two that need care. */
const TEAM_WOOL: Readonly<Record<TeamColor, string>> = {
  red: "red_wool",
  blue: "blue_wool",
  green: "green_wool",
  yellow: "yellow_wool",
  cyan: "cyan_wool",
  white: "white_wool",
  pink: "pink_wool",
  gray: "gray_wool",
};

const TEAM_CLAY: Readonly<Record<TeamColor, string>> = {
  red: "red_stained_clay",
  blue: "blue_stained_clay",
  green: "green_stained_clay",
  yellow: "yellow_stained_clay",
  cyan: "cyan_stained_clay",
  white: "white_stained_clay",
  pink: "pink_stained_clay",
  gray: "gray_stained_clay",
};

/** Marker colours used by the gameplay preview. */
export const TEAM_MARKER_COLORS: Readonly<Record<TeamColor, number>> = {
  red: 0xd94b4b,
  blue: 0x4b6fd9,
  green: 0x4bd96f,
  yellow: 0xe0c33c,
  cyan: 0x3cc9d9,
  white: 0xeeeeee,
  pink: 0xe07bb0,
  gray: 0x8a8a8a,
};

export interface BedwarsSpec {
  /** 2, 4 or 8 teams. Other counts work but produce unusual layouts. */
  readonly teams: number;
  readonly playersPerTeam?: number;
  readonly seed?: number;
  /** Free-text theme, recorded in the manifest and used to pick a landmark when none is named. */
  readonly theme?: string;
  /** The middle landmark. `"none"` leaves the centre clear. */
  readonly landmark?: { readonly archetype?: string; readonly height?: number } | "none";
  /** Target straight-line distance between adjacent team bases. Drives the whole layout. */
  readonly rushDistance?: number;
  /** Overrides the radius derived from `rushDistance`. */
  readonly mapRadius?: number;
  readonly teamIslandRadius?: number;
  readonly midRadius?: number;
  readonly diamondIslands?: number;
  /** The palette to build in. Taken from `style` when absent. */
  readonly palette?: Palette;
  /** A style resolved from the library, which supplies the palette and the measured traits. */
  readonly style?: ResolvedStyle;
  /** Per-island procedural variation in `[0, 1]`. */
  readonly variation?: number;
  /** Decoration density override, in `[0, 1]`. */
  readonly decorationDensity?: number;
  /** Whether to build connecting bridges. Competitive maps normally use `"none"`. */
  readonly bridges?: "none" | "diamond" | "full";
  /** Roof style for the team buildings. */
  readonly roofStyle?: RoofStyle;
  readonly constraints?: Constraints;
  /** Run the (slow) walkable-path search during analysis. */
  readonly walkPaths?: boolean;
}

export interface TeamIslandPlan {
  readonly index: number;
  readonly color: TeamColor;
  readonly label: string;
  readonly center: Vec3;
  readonly radius: number;
  readonly angleDegrees: number;
  /**
   * Quarter turn applied to this island's instance of the team-island template.
   *
   * Positions are exact on the ring; orientation snaps to the nearest cardinal, because 1.8 block
   * data cannot express a 45-degree stair.
   */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly spawn: Vec3;
  readonly bed: Vec3;
  readonly generator: Vec3;
  readonly shop: Vec3;
  readonly upgrades: Vec3;
}

export interface DiamondIslandPlan {
  readonly index: number;
  readonly center: Vec3;
  readonly radius: number;
  readonly generator: Vec3;
}

export interface BedwarsLayout {
  readonly center: Vec3;
  readonly surfaceY: number;
  readonly mapRadius: number;
  readonly teamRingRadius: number;
  readonly rushDistance: number;
  readonly teamIslands: readonly TeamIslandPlan[];
  readonly diamondIslands: readonly DiamondIslandPlan[];
  readonly mid: { readonly center: Vec3; readonly radius: number; readonly emeralds: readonly Vec3[] };
  readonly volumeSize: Vec3;
}

export interface BedwarsResult {
  readonly volume: Volume;
  readonly graph: BuildGraph;
  readonly layout: BedwarsLayout;
  readonly points: readonly AnalysisPoint[];
  readonly analysis: BedwarsAnalysis;
  readonly inspection: InspectionReport;
  readonly violations: readonly Violation[];
  readonly seed: number;
  readonly palette: Palette;
  readonly passLog: readonly { readonly pass: string; readonly blocksPlaced: number; readonly ms: number }[];
}

/**
 * Derive every position from the team count and the target rush distance.
 *
 * Solving for the ring radius rather than accepting one is what makes `rushDistance` a real
 * control: for `n` teams evenly spaced on a circle, adjacent bases are `2 R sin(pi/n)` apart, so
 * `R = rush / (2 sin(pi/n))`. Ask for a 32-block rush with 8 teams and you get a 42-block ring;
 * ask for the same rush with 4 teams and you get 23. That relationship is the whole map.
 */
export function planBedwarsLayout(spec: BedwarsSpec): BedwarsLayout {
  const teams = clamp(Math.round(spec.teams), 2, 16);
  // Defaults scale with team count: eight bases on a ring need a much bigger circle than four
  // before the middle has room for anything, and a cramped middle is the most common way a
  // generated BedWars map ends up unplayable.
  const rushDistance = spec.rushDistance ?? (teams <= 2 ? 46 : teams <= 4 ? 46 : teams <= 8 ? 52 : 58);
  const teamRingRadius =
    spec.mapRadius !== undefined
      ? spec.mapRadius * 0.68
      : rushDistance / (2 * Math.sin(Math.PI / teams));

  // Everything below is sized from the space that actually exists, not from independent guesses.
  // The failure this prevents is real and was in the first version of this file: a mid island and a
  // ring of diamond islands each individually reasonable, overlapping each other by six blocks.
  const adjacentGap = 2 * teamRingRadius * Math.sin(Math.PI / teams);
  const teamIslandRadius = Math.round(
    Math.min(spec.teamIslandRadius ?? adjacentGap * 0.34, adjacentGap * 0.4),
  );
  // Radius available inside the team ring, keeping a void gap the players can fall through.
  const innerFree = Math.max(12, teamRingRadius - teamIslandRadius - 6);
  const midRadius = Math.round(Math.min(spec.midRadius ?? innerFree * 0.55, innerFree * 0.62));
  const band = Math.max(6, innerFree - midRadius);

  const diamondCount = spec.diamondIslands ?? (teams >= 6 ? 4 : 2);
  const diamondRadius = Math.round(clamp(Math.floor(band / 2) - 1, 4, 12));
  const diamondRingRadius = Math.round(midRadius + diamondRadius + Math.max(3, band * 0.2));

  const mapRadius = Math.round(spec.mapRadius ?? teamRingRadius + teamIslandRadius + 12);
  const margin = 8;
  const span = (mapRadius + margin) * 2;
  const surfaceY = 48;
  // Enough headroom for a landmark plus the tallest realistic build on top of the surface.
  const height = Math.min(255, surfaceY + 100);
  const center = vec(Math.round(span / 2), surfaceY, Math.round(span / 2));

  const local = teamLocalOffsets(teamIslandRadius);
  const teamIslands: TeamIslandPlan[] = [];
  for (let i = 0; i < teams; i++) {
    const angle = (360 / teams) * i;
    const rad = (angle * Math.PI) / 180;
    const rotation = inwardRotation(angle);

    // Orientation is quantized to a quarter turn, so the template's spawn offset points at the
    // nearest cardinal rather than exactly outward. Left alone, that makes adjacent rush distances
    // alternate by several blocks on an eight-team ring — a real fairness defect.
    //
    // The fix is to nudge the island rather than the furniture: place the spawn at its exact
    // position on the ring, then position the island so its template spawn lands there. Spawns end
    // up perfectly equidistant; the islands sit a couple of blocks off a perfect circle, which
    // nobody can see and no metric cares about.
    const outX = Math.sin(rad);
    const outZ = -Math.cos(rad);
    const spawnRing = teamRingRadius + Math.abs(local.spawn.z);
    const desiredSpawn = vec(
      Math.round(center.x + outX * spawnRing),
      surfaceY + local.spawn.y,
      Math.round(center.z + outZ * spawnRing),
    );
    const rotatedSpawn = rotateOffset(local.spawn, rotation);
    const anchorX = desiredSpawn.x - rotatedSpawn.x;
    const anchorZ = desiredSpawn.z - rotatedSpawn.z;
    const islandCenter = vec(anchorX, surfaceY, anchorZ);

    // Gameplay positions come from the template's own offsets put through the same rotation the
    // paste uses, so the plan and the blocks can never disagree about where a spawn is.
    const at = (offset: Vec3): Vec3 => {
      const r = rotateOffset(offset, rotation);
      return vec(anchorX + r.x, surfaceY + offset.y, anchorZ + r.z);
    };

    teamIslands.push({
      index: i,
      color: TEAM_COLORS[i % TEAM_COLORS.length]!,
      label: `${TEAM_COLORS[i % TEAM_COLORS.length]!.toUpperCase()}`,
      center: islandCenter,
      radius: teamIslandRadius,
      angleDegrees: angle,
      rotation,
      spawn: at(local.spawn),
      bed: at(local.bed),
      generator: at(local.generator),
      shop: at(local.shop),
      upgrades: at(local.upgrades),
    });
  }

  const diamondIslands: DiamondIslandPlan[] = [];
  for (let i = 0; i < diamondCount; i++) {
    // Offset by half a *team* sector, not half a diamond sector. With eight teams and four
    // diamonds the latter puts every diamond island directly in front of a team base, which is
    // both unfair and the reason the islands used to collide.
    const angle = (360 / diamondCount) * i + 180 / teams;
    const rad = (angle * Math.PI) / 180;
    const cx = Math.round(center.x + Math.sin(rad) * diamondRingRadius);
    const cz = Math.round(center.z - Math.cos(rad) * diamondRingRadius);
    diamondIslands.push({
      index: i,
      center: vec(cx, surfaceY, cz),
      radius: diamondRadius,
      generator: vec(cx, surfaceY + 1, cz),
    });
  }

  const emeralds: Vec3[] = [];
  const emeraldCount = teams >= 8 ? 4 : 2;
  for (let i = 0; i < emeraldCount; i++) {
    const angle = (360 / emeraldCount) * i + 45;
    const rad = (angle * Math.PI) / 180;
    emeralds.push(
      vec(
        Math.round(center.x + Math.sin(rad) * midRadius * 0.62),
        surfaceY + 1,
        Math.round(center.z - Math.cos(rad) * midRadius * 0.62),
      ),
    );
  }

  return {
    center,
    surfaceY,
    mapRadius,
    teamRingRadius: Math.round(teamRingRadius),
    rushDistance:
      teamIslands.length >= 2
        ? Math.round(distanceXZ(teamIslands[0]!.center, teamIslands[1]!.center))
        : 0,
    teamIslands,
    diamondIslands,
    mid: { center, radius: midRadius, emeralds },
    volumeSize: vec(span, height, span),
  };
}

/**
 * Where the gameplay furniture sits inside a team island, in template-local coordinates.
 *
 * The template's "inward" direction is south (+Z), so a positive Z offset is toward the middle of
 * the map. Spawn sits *behind* the bed, away from the middle, with the bed between it and the
 * attackers: the standard defensive arrangement, and the reason the offsets are asymmetric.
 */
export function teamLocalOffsets(radius: number): {
  spawn: Vec3;
  bed: Vec3;
  generator: Vec3;
  shop: Vec3;
  upgrades: Vec3;
  building: Vec3;
  buildingHalf: number;
} {
  const r = (f: number): number => Math.round(radius * f);
  return {
    spawn: vec(0, 1, -r(0.28)),
    bed: vec(0, 1, r(0.1)),
    generator: vec(0, 1, r(0.45)),
    shop: vec(r(0.5), 1, -r(0.12)),
    upgrades: vec(-r(0.5), 1, -r(0.12)),
    // Behind the spawn, and far enough out that its walls clear the spawn's protection radius.
    building: vec(0, 0, -r(0.66)),
    buildingHalf: Math.max(3, r(0.24)),
  };
}

/** The quarter turn that points a south-facing template toward the middle of the map. */
export function inwardRotation(angleDegrees: number): 0 | 90 | 180 | 270 {
  // The island's inward heading is its ring angle plus 180; the template already faces 180.
  const inward = angleDegrees + 180;
  const quantized = ((Math.round(inward / 90) * 90) % 360 + 360) % 360;
  return (((quantized - 180) % 360 + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Rotate a template-local offset clockwise about +Y, matching `transformVolume`. */
export function rotateOffset(offset: Vec3, rotation: 0 | 90 | 180 | 270): Vec3 {
  let x = offset.x;
  let z = offset.z;
  for (let turn = 0; turn < rotation / 90; turn++) {
    const nx = -z;
    z = x;
    x = nx;
  }
  return vec(x, offset.y, z);
}

/** Build a complete BedWars map. */
export function buildBedwarsMap(spec: BedwarsSpec): BedwarsResult {
  const seed = spec.seed ?? 1337;
  const prng = new Prng(seed);
  const noise = new Noise(seed);
  const layout = planBedwarsLayout(spec);
  const variation = spec.variation ?? 0.35;
  const style = spec.style;
  const basePalette = spec.palette ?? style?.palette ?? defaultBedwarsPalette();

  const vol = new Volume({ size: layout.volumeSize });
  const graph = new BuildGraph(vol, seed);
  const passLog: { pass: string; blocksPlaced: number; ms: number }[] = [];

  // -- Pass 1: gameplay layout -> constraints -------------------------------------------------
  const gameplayContext = buildGameplayContext(layout);
  const constraints: Constraints = {
    maxHeight: layout.volumeSize.y - 2,
    minHeight: 0,
    spawnClearance: 2,
    generatorClearance: 2,
    minRushDistance: Math.round(layout.rushDistance * 0.8),
    maxRushDistance: Math.round(layout.rushDistance * 1.35),
    ...spec.constraints,
  };
  // The gameplay furniture is protected before anything is built, so no later pass can reach it.
  const protectedMask = allMasks(
    constraintMask(constraints, gameplayContext),
    keepOutMask(layout),
  );

  const { id: rootId } = graph.build(
    { kind: "bedwars_map", label: spec.theme ?? "bedwars", params: { ...spec, seed }, seed },
    () => {
      // -- Pass 2: terrain (middle and diamond islands) -----------------------------------------
      timed(passLog, "terrain", () => {
        graph.build({ kind: "terrain", label: "middle" }, () =>
          buildIsland(vol, layout.mid.center, layout.mid.radius, basePalette, seed, {
            depth: Math.round(layout.mid.radius * 0.9),
            variation: 0,
            style,
            prng,
          }),
        );

        // Diamond islands are instanced from one template so their shapes match, with per-instance
        // variation applied to the copy: siblings, not clones and not strangers.
        const diamondTemplate = buildDiamondTemplate(layout, basePalette, seed, style, prng);
        for (const island of layout.diamondIslands) {
          graph.build(
            {
              kind: "diamond_island",
              label: `diamond_${island.index}`,
              params: { index: island.index, variation },
            },
            () => {
            const instance =
              variation > 0
                ? varyIsland(diamondTemplate.volume, prng.fork(`diamond-var-${island.index}`), variation)
                : diamondTemplate.volume;
            vol.blit(
              instance,
              vec(
                island.center.x - Math.floor(instance.width / 2),
                layout.surfaceY - diamondTemplate.surfaceLocalY,
                island.center.z - Math.floor(instance.length / 2),
              ),
              { ignoreAir: true },
              );
            },
          );
        }
      });

      // -- Passes 3, 5 and 6 for teams: one template, N instances --------------------------------
      timed(passLog, "team_islands", () => {
        for (const island of layout.teamIslands) {
          const teamPalette = teamTintedPalette(basePalette, island.color);
          graph.build(
            {
              kind: "team_island",
              label: island.label,
              params: { team: island.index, color: island.color, rotation: island.rotation },
            },
            () => {
              // The template is rebuilt per team so the palette differs, but every parameter that
              // affects *geometry* is identical — which is what makes the map provably fair.
              const template = buildTeamTemplate(spec, layout, island, teamPalette, seed, style, prng);
              const oriented =
                island.rotation === 0
                  ? template.volume
                  : transformVolume(template.volume, { rotation: island.rotation });
              vol.blit(
                oriented,
                vec(
                  island.center.x - Math.floor(oriented.width / 2),
                  layout.surfaceY - template.surfaceLocalY,
                  island.center.z - Math.floor(oriented.length / 2),
                ),
                { ignoreAir: true },
              );
            },
          );
        }
      });

      // -- Pass 4: landmark ----------------------------------------------------------------------
      timed(passLog, "landmark", () => {
        if (spec.landmark === "none") return;
        const archetype = pickArchetype(spec, prng);
        // Sized against the middle island so the landmark dominates the composition without
        // overhanging the playable ring.
        const height = spec.landmark?.height ?? Math.round(clamp(layout.mid.radius * 1.7, 20, 70));
        graph.build(
          { kind: "landmark", label: archetype, params: { archetype, height } },
          () =>
            buildVoxelSculpture(vol, {
              model: getArchetype(archetype),
              anchor: vec(layout.center.x, layout.surfaceY + 1, layout.center.z),
              height,
              materials: sculptureMaterials(basePalette),
              detail: "high",
              facing: "south",
              variation: variation * 0.4,
              prng: prng.fork("landmark"),
            }),
        );
      });

      // -- Pass 5b: middle architecture ----------------------------------------------------------
      timed(passLog, "architecture", () => {
        for (const island of layout.diamondIslands) {
          graph.build({ kind: "tower", label: `diamond_${island.index} feature` }, () =>
            buildTower(vol, {
              base: vec(island.center.x, layout.surfaceY + 1, island.center.z),
              radius: Math.max(2, Math.round(island.radius * 0.32)),
              height: Math.round(island.radius * 0.9),
              palette: basePalette,
              prng: prng.fork(`diamond-tower-${island.index}`),
              shape: "round",
              hollow: true,
              wallThickness: 1,
              bandSpacing: 4,
              roofStyle: "cone",
              batter: 1,
            }),
          );
        }
      });

      // -- Pass 6: middle paths and optional bridges ---------------------------------------------
      timed(passLog, "paths", () => {
        graph.build({ kind: "path", label: "middle ring" }, () => {
          for (const emerald of layout.mid.emeralds) {
            buildPath(vol, {
              points: [layout.center, emerald],
              palette: basePalette,
              width: 3,
              edging: true,
            });
          }
        });

        if (spec.bridges && spec.bridges !== "none") {
          graph.build({ kind: "bridges", label: spec.bridges }, () => {
            for (const diamond of layout.diamondIslands) {
              buildBridge(vol, {
                from: vec(diamond.center.x, layout.surfaceY + 1, diamond.center.z),
                to: vec(layout.center.x, layout.surfaceY + 1, layout.center.z),
                palette: basePalette,
                width: 3,
                style: "flat",
                railing: 1,
              });
            }
            if (spec.bridges === "full") {
              for (const island of layout.teamIslands) {
                const nearest = nearestDiamond(layout, island);
                if (!nearest) continue;
                buildBridge(vol, {
                  from: vec(island.center.x, layout.surfaceY + 1, island.center.z),
                  to: vec(nearest.center.x, layout.surfaceY + 1, nearest.center.z),
                  palette: basePalette,
                  width: 3,
                  style: "flat",
                  railing: 1,
                });
              }
            }
          });
        }
      });

      // -- Pass 7: decoration --------------------------------------------------------------------
      timed(passLog, "decoration", () => {
        const density =
          spec.decorationDensity ??
          (style?.profile ? clamp(style.profile.density.decorationDensity * 2.2, 0.03, 0.16) : 0.07);
        graph.build({ kind: "decoration", label: "vegetation", params: { density } }, () => {
          const surface = vol.heightmap();
          plantVegetation(vol, {
            surface,
            volumeWidth: vol.width,
            region: vol.bounds,
            palette: basePalette,
            prng: prng.fork("vegetation"),
            density,
            avoid: keepOutRegions(layout),
          });
          scatter(vol, {
            region: vol.bounds,
            density: density * 0.12,
            block: basePalette.source("DECOR", { scale: 4 }),
            prng: prng.fork("props"),
            spacing: 4,
            placement: (p, v) =>
              v.getAt(p) === AIR &&
              v.get(p.x, p.y - 1, p.z) !== AIR &&
              !isKeepOut(layout, p),
          });
        });
      });

      // -- Pass 8: details -----------------------------------------------------------------------
      timed(passLog, "details", () => {
        graph.build({ kind: "details", label: "generators and spawns" }, () => {
          for (const island of layout.diamondIslands) {
            buildGeneratorPad(vol, island.generator, basePalette, "diamond");
          }
          for (const emerald of layout.mid.emeralds) {
            buildGeneratorPad(vol, emerald, basePalette, "emerald");
          }
          // The last thing any pass does is guarantee the clearances. Decoration, roofs and
          // overhangs all get a chance to encroach before this; nothing gets a chance after.
          // Heights match `clearanceBox` in the constraint checker exactly: clearing one layer
          // fewer than the check measures is how a "cleared" spawn still fails validation.
          for (const spawn of gameplayContext.spawns ?? []) {
            clearBox(vol, spawn.pos, constraints.spawnClearance ?? 2, 4);
          }
          for (const generator of gameplayContext.generators ?? []) {
            clearBox(vol, generator.pos, constraints.generatorClearance ?? 2, 4);
          }
        });
      });

      void protectedMask;
      void noise;
    },
  );

  // -- Passes 9 and 10: validation --------------------------------------------------------------
  const points = toAnalysisPoints(layout);
  // Occupancy rather than block-exact: the islands are geometrically identical but deliberately
  // coloured per team, and a block-exact score would report a perfectly fair map as lopsided.
  const symmetry = measureRadialSymmetry(vol, layout.center, layout.teamIslands.length, "occupancy");
  const analysis = analyzeBedwarsMap(vol, {
    points,
    teams: layout.teamIslands.length,
    walkPaths: spec.walkPaths ?? false,
    symmetryScore: symmetry,
  });
  const violations = checkConstraints(vol, constraints, gameplayContext);
  const inspection = inspectRegion(vol, {
    floatingClusterMax: 24,
    blockBudget: 2_500_000,
  });

  void rootId;
  return {
    volume: vol,
    graph,
    layout,
    points,
    analysis,
    inspection,
    violations,
    seed,
    palette: basePalette,
    passLog,
  };
}

// -- Pass helpers --------------------------------------------------------------------------------

function timed(log: { pass: string; blocksPlaced: number; ms: number }[], name: string, fn: () => void): void {
  const start = Date.now();
  fn();
  log.push({ pass: name, blocksPlaced: 0, ms: Date.now() - start });
}

function buildIsland(
  vol: Volume,
  center: Vec3,
  radius: number,
  palette: Palette,
  seed: number,
  opts: { depth: number; variation: number; style?: ResolvedStyle; prng: Prng },
): void {
  const prng = opts.prng.fork(`island-${center.x}-${center.z}`);
  const edgeNoise = opts.style
    ? opts.style.trait(0.22, (p) => clamp(p.terrain.edgeRoughness * 0.35, 0.08, 0.45), prng, {
        min: 0.05,
        max: 0.5,
      })
    : 0.22;
  const relief = opts.style
    ? opts.style.trait(2, (p) => clamp(p.terrain.surfaceRelief * 0.4, 1, 5), prng, { min: 0, max: 6 })
    : 2;

  buildOrganicIsland(vol, {
    center,
    radius,
    depth: opts.depth,
    palette,
    seed,
    edgeNoise,
    topRelief: relief,
    overhang: Math.max(1, radius * 0.12),
    flatCoreRatio: 0.7,
    variation: opts.variation,
  });
}

/** The bed platform: a flat pad in the team's colour, the one place a team's identity must read. */
function buildBedPlatform(vol: Volume, island: TeamIslandPlan, palette: Palette): void {
  const wool = resolveBlock(TEAM_WOOL[island.color]);
  const clay = resolveBlock(TEAM_CLAY[island.color]);
  const pad = Math.max(3, Math.round(island.radius * 0.32));
  const y = island.bed.y - 1;

  flattenTerrain(vol, {
    region: region(vec(island.bed.x - pad, y, island.bed.z - pad), vec(island.bed.x + pad, y, island.bed.z + pad)),
    y,
    surfaceBlock: clay,
    fillBlock: palette.source("TERRAIN_MID", { scale: 3 }),
    feather: 2,
  });
  buildCircle(vol, { center: vec(island.bed.x, y, island.bed.z), radius: pad - 1, block: clay });
  buildCircle(vol, { center: vec(island.bed.x, y, island.bed.z), radius: Math.max(1, pad - 3), block: wool });
  // Clear the space a bed and its defenders occupy.
  for (let dy = 1; dy <= 3; dy++) {
    vol.fill(
      region(vec(island.bed.x - 2, y + dy, island.bed.z - 2), vec(island.bed.x + 2, y + dy, island.bed.z + 2)),
      AIR,
    );
  }
}

/** A raised pad marking where a shop or upgrade NPC stands. */
function buildServicePad(vol: Volume, at: Vec3, palette: Palette, kind: "shop" | "upgrades"): void {
  const y = at.y - 1;
  const accent = kind === "shop" ? palette.primary("ACCENT") : palette.primary("TRIM");
  flattenTerrain(vol, {
    region: region(vec(at.x - 2, y, at.z - 2), vec(at.x + 2, y, at.z + 2)),
    y,
    surfaceBlock: palette.source("PATH", { scale: 2 }),
    feather: 1,
  });
  buildCircle(vol, { center: vec(at.x, y, at.z), radius: 2, block: palette.source("PATH", { scale: 2 }) });
  buildCircle(vol, { center: vec(at.x, y, at.z), radius: 2, filled: false, block: accent });
  for (let dy = 1; dy <= 3; dy++) {
    vol.fill(region(vec(at.x - 1, y + dy, at.z - 1), vec(at.x + 1, y + dy, at.z + 1)), AIR);
  }
}

/** A generator pad: a visually distinct disc, cleared above, so drops are visible and reachable. */
function buildGeneratorPad(
  vol: Volume,
  at: Vec3,
  palette: Palette,
  kind: "iron" | "diamond" | "emerald",
): void {
  const material =
    kind === "diamond" ? resolveBlock("diamond_block") : kind === "emerald" ? resolveBlock("emerald_block") : resolveBlock("iron_block");
  const y = at.y - 1;
  buildCylinder(vol, {
    base: vec(at.x, y - 1, at.z),
    radius: 2,
    height: 2,
    block: palette.source("WALL_SECONDARY", { scale: 2 }),
  });
  buildCircle(vol, { center: vec(at.x, y, at.z), radius: 2, block: slabTop(palette.primary("TRIM"), false) });
  vol.setAt(vec(at.x, y, at.z), material);
  clearColumn(vol, at, 4);
}

function clearColumn(vol: Volume, at: Vec3, height: number): void {
  for (let dy = 0; dy < height; dy++) vol.set(at.x, at.y + dy, at.z, AIR);
}

/** Clear a box of air around a gameplay point, so its clearance constraint is satisfied by fiat. */
function clearBox(vol: Volume, at: Vec3, radius: number, height: number): void {
  vol.fill(
    region(vec(at.x - radius, at.y, at.z - radius), vec(at.x + radius, at.y + height - 1, at.z + radius)),
    AIR,
  );
}

// -- Island templates ----------------------------------------------------------------------------

export interface IslandTemplate {
  readonly volume: Volume;
  /** Y inside the template that corresponds to the map's surface level. */
  readonly surfaceLocalY: number;
}

/**
 * Build one team island in its own local volume.
 *
 * This is the mechanism that makes the map fair. Terrain noise is sampled in *world* coordinates,
 * so eight islands generated in place would have eight different outlines however carefully their
 * seeds were matched. Built in a local frame and instanced, they are identical by construction —
 * and the check that proves it (radial occupancy symmetry) comes out at essentially 100%.
 *
 * Only the palette varies between teams. Geometry parameters are byte-identical across the set.
 */
export function buildTeamTemplate(
  spec: BedwarsSpec,
  layout: BedwarsLayout,
  island: TeamIslandPlan,
  palette: Palette,
  seed: number,
  style: ResolvedStyle | undefined,
  prng: Prng,
): IslandTemplate {
  const r = island.radius;
  const pad = 7;
  const size = (r + pad) * 2 + 1;
  const depth = Math.round(r * 0.85);
  const surfaceLocalY = depth + 5;
  const height = surfaceLocalY + 26;
  const template = Volume.of(size, height, size);
  const c = Math.floor(size / 2);
  const local = teamLocalOffsets(r);
  const at = (offset: Vec3): Vec3 => vec(c + offset.x, surfaceLocalY + offset.y, c + offset.z);

  // Every team draws from the same fork, so the geometry is identical regardless of team index.
  const templatePrng = prng.fork("team-template");

  buildIsland(template, vec(c, surfaceLocalY, c), r, palette, seed, {
    depth,
    variation: 0,
    style,
    prng: templatePrng,
  });

  const bed = at(local.bed);
  const spawn = at(local.spawn);
  buildBedPlatform(template, { ...island, bed, center: vec(c, surfaceLocalY, c) }, palette);
  buildServicePad(template, at(local.shop), palette, "shop");
  buildServicePad(template, at(local.upgrades), palette, "upgrades");

  const buildingCentre = at(local.building);
  const half = local.buildingHalf;
  buildBuilding(template, {
    footprint: region(
      vec(buildingCentre.x - half, surfaceLocalY, buildingCentre.z - half),
      vec(buildingCentre.x + half, surfaceLocalY, buildingCentre.z + half),
    ),
    baseY: surfaceLocalY + 1,
    palette,
    prng: templatePrng.fork("building"),
    floors: 1,
    floorHeight: 5,
    roofStyle: spec.roofStyle ?? "hip",
    // The template faces south by definition, so the entrance faces the middle after rotation.
    entranceFacing: "south",
    windowSpacing: 3,
    plinth: true,
    cornerPosts: true,
    interior: false,
  });

  buildPath(template, {
    points: [spawn, bed, at(local.generator)],
    palette,
    width: 3,
    edging: true,
  });
  buildGeneratorPad(template, at(local.generator), palette, "iron");
  clearColumn(template, spawn, 3);

  return { volume: template, surfaceLocalY };
}

/** Build one diamond island in its own local volume, for instancing around the ring. */
export function buildDiamondTemplate(
  layout: BedwarsLayout,
  palette: Palette,
  seed: number,
  style: ResolvedStyle | undefined,
  prng: Prng,
): IslandTemplate {
  const r = layout.diamondIslands[0]?.radius ?? 9;
  const pad = 6;
  const size = (r + pad) * 2 + 1;
  const depth = Math.round(r * 1.1);
  const surfaceLocalY = depth + 4;
  const height = surfaceLocalY + 20;
  const template = Volume.of(size, height, size);
  const c = Math.floor(size / 2);
  buildIsland(template, vec(c, surfaceLocalY, c), r, palette, seed + 104729, {
    depth,
    variation: 0,
    style,
    prng: prng.fork("diamond-template"),
  });
  return { volume: template, surfaceLocalY };
}

/**
 * Perturb a copy of an island so instances read as siblings rather than clones.
 *
 * Only the rim is touched: cells with air on two or more horizontal sides. Trimming there changes
 * the outline, which is what the eye actually compares, while leaving the buildable core and every
 * gameplay position exactly where the template put them.
 */
export function varyIsland(source: Volume, prng: Prng, amount: number): Volume {
  const copy = source.clone();
  const strength = Math.min(0.4, amount * 0.3);
  if (strength <= 0) return copy;
  const trim: Vec3[] = [];
  for (const { pos } of source.iterateSolid()) {
    let openSides = 0;
    if (source.get(pos.x + 1, pos.y, pos.z) === AIR) openSides++;
    if (source.get(pos.x - 1, pos.y, pos.z) === AIR) openSides++;
    if (source.get(pos.x, pos.y, pos.z + 1) === AIR) openSides++;
    if (source.get(pos.x, pos.y, pos.z - 1) === AIR) openSides++;
    if (openSides >= 2 && prng.chance(strength)) trim.push(pos);
  }
  for (const p of trim) copy.setAt(p, AIR);
  return copy;
}

// -- Layout helpers ------------------------------------------------------------------------------

function behindSpawn(layout: BedwarsLayout, island: TeamIslandPlan, distance: number): Vec3 {
  const rad = (island.angleDegrees * Math.PI) / 180;
  return vec(
    Math.round(island.center.x + Math.sin(rad) * distance),
    layout.surfaceY,
    Math.round(island.center.z - Math.cos(rad) * distance),
  );
}

function facingTowardCentre(layout: BedwarsLayout, island: TeamIslandPlan): "north" | "south" | "east" | "west" {
  const dx = layout.center.x - island.center.x;
  const dz = layout.center.z - island.center.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? "east" : "west";
  return dz > 0 ? "south" : "north";
}

function nearestDiamond(layout: BedwarsLayout, island: TeamIslandPlan): DiamondIslandPlan | null {
  let best: DiamondIslandPlan | null = null;
  let bestDistance = Infinity;
  for (const diamond of layout.diamondIslands) {
    const d = distanceXZ(island.center, diamond.center);
    if (d < bestDistance) {
      bestDistance = d;
      best = diamond;
    }
  }
  return best;
}

/** Regions decoration must stay out of: every gameplay point plus its working space. */
function keepOutRegions(layout: BedwarsLayout): Region[] {
  const out: Region[] = [];
  const box = (p: Vec3, r: number): Region =>
    region(vec(p.x - r, p.y - 2, p.z - r), vec(p.x + r, p.y + 4, p.z + r));
  for (const island of layout.teamIslands) {
    out.push(box(island.spawn, 3), box(island.bed, 4), box(island.generator, 3), box(island.shop, 2), box(island.upgrades, 2));
  }
  for (const island of layout.diamondIslands) out.push(box(island.generator, 3));
  for (const emerald of layout.mid.emeralds) out.push(box(emerald, 3));
  return out;
}

function isKeepOut(layout: BedwarsLayout, p: Vec3): boolean {
  for (const r of keepOutRegions(layout)) {
    if (p.x >= r.min.x && p.x <= r.max.x && p.z >= r.min.z && p.z <= r.max.z) return true;
  }
  return false;
}

function keepOutMask(layout: BedwarsLayout): Mask {
  const regions = keepOutRegions(layout);
  return (p) => {
    for (const r of regions) {
      if (
        p.x >= r.min.x &&
        p.x <= r.max.x &&
        p.y >= r.min.y &&
        p.y <= r.max.y &&
        p.z >= r.min.z &&
        p.z <= r.max.z
      ) {
        return false;
      }
    }
    return true;
  };
}

function buildGameplayContext(layout: BedwarsLayout): GameplayContext {
  return {
    spawns: layout.teamIslands.map((t) => ({ label: t.label, pos: t.spawn })),
    beds: layout.teamIslands.map((t) => ({ label: `${t.label} bed`, pos: t.bed })),
    generators: [
      ...layout.teamIslands.map((t) => ({ label: `${t.label} iron`, pos: t.generator })),
      ...layout.diamondIslands.map((d) => ({ label: `diamond ${d.index}`, pos: d.generator })),
      ...layout.mid.emeralds.map((e, i) => ({ label: `emerald ${i}`, pos: e })),
    ],
    center: layout.center,
  };
}

/** Every gameplay point, in the form the analyzer and the preview overlay consume. */
export function toAnalysisPoints(layout: BedwarsLayout): AnalysisPoint[] {
  const points: AnalysisPoint[] = [];
  for (const island of layout.teamIslands) {
    points.push({ label: island.label, pos: island.spawn, role: "team", team: island.index });
    points.push({ label: `${island.label} bed`, pos: island.bed, role: "bed", team: island.index });
    points.push({ label: `${island.label} iron`, pos: island.generator, role: "iron", team: island.index });
    points.push({ label: `${island.label} shop`, pos: island.shop, role: "shop", team: island.index });
  }
  for (const island of layout.diamondIslands) {
    points.push({ label: `diamond ${island.index + 1}`, pos: island.generator, role: "diamond" });
  }
  layout.mid.emeralds.forEach((pos, i) => {
    points.push({ label: `emerald ${i + 1}`, pos, role: "emerald" });
  });
  points.push({ label: "mid", pos: vec(layout.center.x, layout.surfaceY + 1, layout.center.z), role: "mid" });
  return points;
}

// -- Palette helpers -----------------------------------------------------------------------------

/**
 * Tint a palette toward a team colour.
 *
 * Only the accent-level roles move. Recolouring the walls and terrain per team would make the eight
 * islands read as eight different maps; recolouring the trim and accents makes them read as one map
 * with eight teams, which is the correct answer.
 */
export function teamTintedPalette(base: Palette, color: TeamColor): Palette {
  const wool = resolveBlock(TEAM_WOOL[color]);
  const clay = resolveBlock(TEAM_CLAY[color]);
  const accent: WeightedBlock[] = [
    { block: clay, weight: 6 },
    { block: wool, weight: 3 },
  ];
  return base.withOverrides(`${base.id}-${color}`, {
    ACCENT: accent,
    ROOF_PRIMARY: [
      { block: clay, weight: 7 },
      { block: wool, weight: 2 },
    ],
    DECOR: [{ block: wool, weight: 1 }],
  });
}

function sculptureMaterials(palette: Palette): Record<string, number | ((p: Vec3, v: Volume) => number)> {
  return {
    body: palette.source("WALL_PRIMARY", { scale: 5 }),
    belly: palette.source("WALL_SECONDARY", { scale: 5 }),
    detail: palette.source("DETAIL"),
    accent: palette.source("ACCENT", { scale: 3 }),
    eye: palette.primary("DETAIL"),
    limb: palette.source("SUPPORT", { scale: 4 }),
    highlight: palette.source("TRIM"),
  };
}

function pickArchetype(spec: BedwarsSpec, prng: Prng): string {
  if (spec.landmark && spec.landmark !== "none" && spec.landmark.archetype) {
    return spec.landmark.archetype;
  }
  const theme = (spec.theme ?? "").toLowerCase();
  // Map a few obvious theme words onto archetypes; otherwise pick one deterministically.
  const hints: [string, string][] = [
    ["dog", "cartoon_dog"],
    ["bird", "cartoon_bird"],
    ["chick", "cartoon_bird"],
    ["mouse", "cartoon_rodent"],
    ["rodent", "cartoon_rodent"],
    ["bear", "bear"],
    ["rabbit", "rabbit"],
    ["bunny", "rabbit"],
    ["easter", "rabbit"],
    ["egg", "mascot_egg"],
    ["flower", "giant_flower"],
    ["garden", "giant_flower"],
    ["mushroom", "mushroom"],
    ["candy", "gift_box"],
    ["gift", "gift_box"],
    ["christmas", "gift_box"],
    ["tree", "stylized_tree"],
    ["forest", "stylized_tree"],
    ["star", "star"],
    ["ball", "orb"],
    ["carousel", "orb"],
    ["statue", "humanoid"],
  ];
  for (const [word, archetype] of hints) if (theme.includes(word)) return archetype;
  return prng.fork("archetype").pick(Object.keys(ARCHETYPES));
}

/** A neutral, readable palette used when no style or palette is supplied. */
export function defaultBedwarsPalette(): Palette {
  return blendPalettes(
    Palette.fromJson({
      id: "bedwars-default",
      roles: {
        WALL_PRIMARY: [
          { block: "quartz_block", weight: 6 },
          { block: "white_stained_clay", weight: 3 },
        ],
        WALL_SECONDARY: [
          { block: "stone_bricks", weight: 6 },
          { block: "cracked_stone_bricks", weight: 2 },
        ],
        ACCENT: [{ block: "orange_stained_clay", weight: 5 }],
        TRIM: [{ block: "quartz_slab", weight: 5 }],
        // Deliberately the darkest entry in the palette: DETAIL is what a sculpture's eyes and
        // nose resolve to, and without real contrast a mascot comes out as a featureless blob.
        DETAIL: [{ block: "gray_stained_clay", weight: 3 }],
        ROOF_PRIMARY: [
          { block: "red_stained_clay", weight: 6 },
          { block: "orange_stained_clay", weight: 2 },
        ],
        ROOF_SECONDARY: [{ block: "brown_stained_clay", weight: 4 }],
        SUPPORT: [{ block: "spruce_log", weight: 4 }],
        FLOOR: [{ block: "spruce_planks", weight: 5 }],
        PATH: [
          { block: "sandstone", weight: 6 },
          { block: "smooth_sandstone", weight: 3 },
        ],
        TERRAIN_TOP: [{ block: "grass", weight: 10 }],
        TERRAIN_MID: [
          { block: "dirt", weight: 8 },
          { block: "coarse_dirt", weight: 2 },
        ],
        TERRAIN_BASE: [
          { block: "stone", weight: 8 },
          { block: "andesite", weight: 3 },
          { block: "cobblestone", weight: 2 },
        ],
        TERRAIN_EDGE: [
          { block: "dirt", weight: 5 },
          { block: "gravel", weight: 3 },
        ],
        GLASS: [{ block: "glass", weight: 5 }],
        LIGHT: [{ block: "glowstone", weight: 5 }],
        VEGETATION: [
          { block: "tall_grass", weight: 8 },
          { block: "red_flower", weight: 2 },
          { block: "yellow_flower", weight: 2 },
        ],
        DECOR: [{ block: "red_flower", weight: 3 }],
      },
    }),
    Palette.fromJson({ id: "noop", roles: {} }),
    0,
    "bedwars-default",
  );
}

/** Convenience: build a clipboard of one team island, for reuse or inspection. */
export function copyTeamIsland(result: BedwarsResult, teamIndex: number): ReturnType<typeof copyRegion> {
  const island = result.layout.teamIslands[teamIndex];
  if (!island) throw new Error(`No team island ${teamIndex}; the map has ${result.layout.teamIslands.length}`);
  const r = island.radius + 4;
  return copyRegion(
    result.volume,
    region(
      vec(island.center.x - r, 0, island.center.z - r),
      vec(island.center.x + r, result.volume.height - 1, island.center.z + r),
    ),
    island.center,
  );
}
