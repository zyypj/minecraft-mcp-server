/**
 * Duels arenas.
 *
 * The same architecture as the BedWars generator at a much smaller scale, and worth having as its
 * own domain function for one reason: the constraints are completely different. A duels arena is
 * judged on whether the two spawns are mirror-equal, whether there is cover that favours one side,
 * and whether the kit can be played in the space — not on rush distances.
 *
 * The kit drives the geometry. A boxing arena wants a flat floor and walls; a bridge kit wants two
 * platforms and a void between them; a sumo kit wants a small platform with nothing to grab.
 */

import { type Vec3, region, vec } from "../core/vec.js";
import { Prng } from "../core/prng.js";
import { AIR, Volume } from "../core/volume.js";
import { type Palette } from "../mc18/palette.js";
import { buildCircle } from "../geom/shapes.js";
import { mirrorInPlace, measureMirrorSymmetry } from "../ops/symmetry.js";
import { type ArenaBoundary, type ArenaShape, buildArena } from "../structures/arena.js";
import { buildBuilding } from "../structures/building.js";
import { buildBridge } from "../structures/connections.js";
import { buildVoxelSculpture } from "../sculpture/voxel-sculpture.js";
import { getArchetype } from "../sculpture/archetypes.js";
import { BuildGraph } from "../history/graph.js";
import { type InspectionReport, inspectRegion } from "../validate/inspect.js";
import { defaultBedwarsPalette } from "./bedwars.js";

export type DuelsKit =
  | "classic"
  | "boxing"
  | "sumo"
  | "bridge"
  | "nodebuff"
  | "uhc"
  | "combo"
  | "parkour";

export interface DuelsArenaSpec {
  readonly kit?: DuelsKit;
  readonly theme?: string;
  readonly seed?: number;
  /** Radius of the playable floor. */
  readonly playableRadius?: number;
  readonly palette?: Palette;
  readonly shape?: ArenaShape;
  readonly boundary?: ArenaBoundary;
  /** Rows of raised seating around the arena. */
  readonly seatingRows?: number;
  /** Add a themed landmark behind each spawn. */
  readonly landmark?: string | "none";
  readonly wallHeight?: number;
}

export interface DuelsArenaResult {
  readonly volume: Volume;
  readonly graph: BuildGraph;
  readonly spawns: readonly Vec3[];
  readonly kit: DuelsKit;
  readonly playableRadius: number;
  readonly symmetry: number;
  readonly inspection: InspectionReport;
  readonly seed: number;
}

/** Per-kit geometry defaults, since the kit is what actually decides the shape. */
const KIT_DEFAULTS: Readonly<
  Record<DuelsKit, { radius: number; boundary: ArenaBoundary; wallHeight: number; shape: ArenaShape }>
> = {
  classic: { radius: 26, boundary: "wall", wallHeight: 5, shape: "circle" },
  boxing: { radius: 18, boundary: "wall", wallHeight: 4, shape: "square" },
  // No walls at all: falling off is the loss condition.
  sumo: { radius: 9, boundary: "open", wallHeight: 0, shape: "circle" },
  // Two platforms and a gap; the arena floor is only the spawn islands.
  bridge: { radius: 12, boundary: "open", wallHeight: 0, shape: "circle" },
  nodebuff: { radius: 22, boundary: "wall", wallHeight: 5, shape: "octagon" },
  uhc: { radius: 34, boundary: "wall", wallHeight: 6, shape: "circle" },
  combo: { radius: 20, boundary: "wall", wallHeight: 6, shape: "circle" },
  parkour: { radius: 30, boundary: "void", wallHeight: 0, shape: "square" },
};

/** Build a duels arena. */
export function buildDuelsArena(spec: DuelsArenaSpec = {}): DuelsArenaResult {
  const kit = spec.kit ?? "classic";
  const defaults = KIT_DEFAULTS[kit];
  const seed = spec.seed ?? 4242;
  const prng = new Prng(seed);
  const palette = spec.palette ?? defaultBedwarsPalette();
  const radius = Math.round(spec.playableRadius ?? defaults.radius);
  const seatingRows = spec.seatingRows ?? (kit === "sumo" || kit === "bridge" ? 0 : 1);

  const reach = radius + 10 + seatingRows * 3;
  const span = reach * 2 + 1;
  const floorY = 32;
  const vol = Volume.of(span, floorY + 48, span);
  const graph = new BuildGraph(vol, seed);
  const center = vec(Math.floor(span / 2), floorY, Math.floor(span / 2));

  let spawns: Vec3[] = [];

  graph.build({ kind: "duels_arena", label: kit, params: { ...spec, kit, seed }, seed }, () => {
    if (kit === "bridge") {
      // Two separated platforms rather than one floor: the kit *is* the gap.
      const gap = radius * 2 + 14;
      const platformRadius = Math.max(6, Math.round(radius * 0.7));
      const positions = [
        vec(center.x, floorY, center.z - Math.round(gap / 2)),
        vec(center.x, floorY, center.z + Math.round(gap / 2)),
      ];
      for (const [index, at] of positions.entries()) {
        graph.build({ kind: "platform", label: `side_${index}` }, () => {
          for (let d = 0; d < 4; d++) {
            buildCircle(vol, {
              center: vec(at.x, floorY - d, at.z),
              radius: platformRadius - d,
              block: d === 0 ? palette.source("FLOOR", { scale: 3 }) : palette.source("TERRAIN_BASE", { scale: 4 }),
            });
          }
          buildCircle(vol, {
            center: vec(at.x, floorY, at.z),
            radius: platformRadius,
            filled: false,
            block: palette.primary("ACCENT"),
          });
        });
        spawns.push(vec(at.x, floorY + 1, at.z));
      }
      graph.build({ kind: "bridge", label: "centre span" }, () =>
        buildBridge(vol, {
          from: vec(positions[0]!.x, floorY, positions[0]!.z + platformRadius),
          to: vec(positions[1]!.x, floorY, positions[1]!.z - platformRadius),
          palette,
          width: 3,
          style: "flat",
          railing: 0,
        }),
      );
    } else {
      const arena = graph.build({ kind: "arena", label: kit }, () =>
        buildArena(vol, {
          center,
          playableRadius: radius,
          palette,
          prng: prng.fork("arena"),
          shape: spec.shape ?? defaults.shape,
          boundary: spec.boundary ?? defaults.boundary,
          wallHeight: spec.wallHeight ?? defaults.wallHeight,
          seatingRows,
          spawns: 2,
          floorDepth: 3,
          pillars: kit === "nodebuff" || kit === "classic" ? 8 : 0,
        }),
      );
      spawns = [...arena.result.spawns];
    }

    // Landmarks sit behind each spawn, outside the playable radius, so they frame the fight
    // without giving either player cover.
    if (spec.landmark !== "none" && kit !== "sumo") {
      const archetype = spec.landmark ?? themeArchetype(spec.theme, prng);
      const height = Math.round(Math.max(10, radius * 0.8));
      for (const [index, spawn] of spawns.entries()) {
        const outward = vec(
          Math.sign(spawn.x - center.x) * (radius + 6),
          0,
          Math.sign(spawn.z - center.z) * (radius + 6),
        );
        graph.build({ kind: "landmark", label: `${archetype}_${index}` }, () =>
          buildVoxelSculpture(vol, {
            model: getArchetype(archetype),
            anchor: vec(center.x + outward.x, floorY + 1, center.z + outward.z),
            height,
            materials: {
              body: palette.source("WALL_PRIMARY", { scale: 4 }),
              belly: palette.source("WALL_SECONDARY", { scale: 4 }),
              detail: palette.source("DETAIL"),
              accent: palette.source("ACCENT", { scale: 3 }),
              eye: palette.primary("DETAIL"),
              limb: palette.source("SUPPORT", { scale: 3 }),
              highlight: palette.source("TRIM"),
            },
            detail: "medium",
            prng: prng.fork(`landmark-${index}`),
          }),
        );
      }
    }

    // A small shelter outside the ring gives the arena a sense of place without entering play.
    if (seatingRows > 0) {
      graph.build({ kind: "building", label: "pavilion" }, () =>
        buildBuilding(vol, {
          footprint: region(
            vec(center.x - 4, floorY, center.z - radius - 9),
            vec(center.x + 4, floorY, center.z - radius - 5),
          ),
          baseY: floorY + 1,
          palette,
          prng: prng.fork("pavilion"),
          floors: 1,
          floorHeight: 5,
          roofStyle: "gable",
          entranceFacing: "south",
          windowSpacing: 3,
          interior: false,
        }),
      );
    }
  });

  // Both spawns must see the same arena. Mirroring is enforced, not hoped for: build one half,
  // reflect it, and the symmetry check afterwards is then a real assertion rather than a wish.
  const mirrorAxis = Math.abs(spawns[0]!.z - spawns[1]!.z) > Math.abs(spawns[0]!.x - spawns[1]!.x) ? "z" : "x";
  graph.build({ kind: "symmetry", label: `mirror-${mirrorAxis}` }, () => {
    mirrorInPlace(vol, {
      axis: mirrorAxis,
      at: mirrorAxis === "x" ? center.x : center.z,
      source: "low",
    });
  });
  for (const spawn of spawns) {
    for (let dy = 0; dy < 3; dy++) vol.set(spawn.x, spawn.y + dy, spawn.z, AIR);
  }

  return {
    volume: vol,
    graph,
    spawns,
    kit,
    playableRadius: radius,
    symmetry: Math.round(measureMirrorSymmetry(vol, mirrorAxis) * 1000) / 1000,
    inspection: inspectRegion(vol, {
      expectSymmetry: mirrorAxis,
      symmetryThreshold: 0.9,
      floatingClusterMax: 16,
    }),
    seed,
  };
}

function themeArchetype(theme: string | undefined, prng: Prng): string {
  const t = (theme ?? "").toLowerCase();
  if (t.includes("japan") || t.includes("zen")) return "stylized_tree";
  if (t.includes("nature") || t.includes("forest")) return "stylized_tree";
  if (t.includes("candy") || t.includes("sweet")) return "mushroom";
  if (t.includes("space") || t.includes("orb")) return "orb";
  if (t.includes("statue") || t.includes("greek")) return "humanoid";
  return prng.fork("duels-archetype").pick(["stylized_tree", "orb", "humanoid", "star"]);
}
