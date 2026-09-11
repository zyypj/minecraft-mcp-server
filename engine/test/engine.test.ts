import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";

import { region, vec } from "../src/core/vec.js";
import { AIR, Volume, pack } from "../src/core/volume.js";
import { Prng } from "../src/core/prng.js";
import { blockName } from "../src/mc18/blocks.js";
import { block } from "../src/mc18/material.js";
import { Palette, blendPalettes, observePalette } from "../src/mc18/palette.js";
import { transformBlock } from "../src/mc18/rotation.js";
import { buildCircle, buildCylinder, buildSphere } from "../src/geom/shapes.js";
import { buildGradient, replaceBlocks } from "../src/ops/edit.js";
import {
  copyRegion,
  mirrorVolume,
  pasteClipboard,
  rotateVolume,
  transformRegionInPlace,
} from "../src/ops/transform.js";
import { distributeRadially, measureRadialSymmetry } from "../src/ops/symmetry.js";
import { readSchematic, writeSchematic } from "../src/schematic/schematic.js";
import { buildVoxelSculpture } from "../src/sculpture/voxel-sculpture.js";
import { getArchetype } from "../src/sculpture/archetypes.js";
import { BuildGraph } from "../src/history/graph.js";
import { History } from "../src/history/history.js";
import { analyzeStyle } from "../src/style/analyze.js";
import { blendStyleProfiles } from "../src/style/blend.js";
import { StyleLibrary } from "../src/style/library.js";
import { checkConstraints } from "../src/validate/constraints.js";
import { inspectRegion } from "../src/validate/inspect.js";
import { estimateBridge, findWalkPath } from "../src/validate/gameplay.js";
import { buildBedwarsMap, planBedwarsLayout } from "../src/domain/bedwars.js";
import { buildDuelsArena } from "../src/domain/duels.js";
import { writeBuildOutput } from "../src/project/output.js";
import { renderViews } from "../src/render/views.js";
import { renderVolume } from "../src/render/voxel-renderer.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "mcbuild-test-"));

// -- Geometry --------------------------------------------------------------------------------------

test("a radius-3 circle spans 7 blocks, matching WorldEdit's convention", (t) => {
  const vol = Volume.of(11, 1, 11);
  buildCircle(vol, { center: vec(5, 0, 5), radius: 3, block: block("stone") });
  const bounds = vol.occupiedBounds()!;
  t.is(bounds.max.x - bounds.min.x + 1, 7);
  t.is(bounds.max.z - bounds.min.z + 1, 7);
});

test("a hollow sphere is a shell, not an eroded solid", (t) => {
  const vol = Volume.of(21, 21, 21);
  buildSphere(vol, { center: vec(10, 10, 10), radius: 8, block: block("stone"), hollow: true });
  t.is(vol.get(10, 10, 10), AIR, "the centre is empty");
  t.not(vol.get(10, 18, 10), AIR, "the pole is solid");
  t.not(vol.get(18, 10, 10), AIR, "the equator is solid");
});

test("a hollow cylinder has an open interior at every height", (t) => {
  const vol = Volume.of(21, 12, 21);
  buildCylinder(vol, {
    base: vec(10, 0, 10),
    radius: 7,
    height: 12,
    block: block("stone"),
    hollow: true,
    thickness: 2,
  });
  for (let y = 0; y < 12; y++) t.is(vol.get(10, y, 10), AIR, `y=${y} interior`);
  t.not(vol.get(17, 5, 10), AIR);
});

// -- Transforms ------------------------------------------------------------------------------------

test("rotating a volume four times returns it to the original", (t) => {
  const vol = Volume.of(7, 3, 5);
  const prng = new Prng(1);
  for (let i = 0; i < 40; i++) {
    vol.set(prng.intRange(0, 6), prng.intRange(0, 2), prng.intRange(0, 4), block("oak_stairs"));
  }
  let rotated = vol;
  for (let i = 0; i < 4; i++) rotated = rotateVolume(rotated, 90);
  t.deepEqual([...rotated.cells], [...vol.cells]);
});

test("rotation reorients stair block data", (t) => {
  // A stair facing east, rotated 90 degrees clockwise, must face south.
  const east = block("oak_stairs");
  t.is(east & 0xf, 0, "east is data 0");
  const south = transformBlock(east, { rotation: 90 });
  t.is(south & 0xf, 2, "south is data 2");
  const west = transformBlock(south, { rotation: 90 });
  t.is(west & 0xf, 1);
});

test("mirroring swaps east-facing and west-facing stairs", (t) => {
  const vol = Volume.of(3, 1, 1);
  vol.set(0, 0, 0, block("oak_stairs")); // east
  const mirrored = mirrorVolume(vol, "x");
  t.is(mirrored.get(2, 0, 0) & 0xf, 1, "mirrored to west");
});

test("copy and paste round-trips a region", (t) => {
  const vol = Volume.of(20, 6, 20);
  buildSphere(vol, { center: vec(5, 3, 5), radius: 3, block: block("red_wool") });
  const clip = copyRegion(vol, region(vec(0, 0, 0), vec(10, 5, 10)));
  pasteClipboard(vol, clip, vec(10, 0, 10));
  t.is(blockName(vol.get(15, 3, 15)), "red_wool");
});

test("rotating a non-square region in place is refused with an explanation", (t) => {
  const vol = Volume.of(20, 4, 20);
  const err = t.throws(() => {
    transformRegionInPlace(vol, region(vec(0, 0, 0), vec(9, 3, 4)), { rotation: 90 });
  });
  t.regex(String(err?.message), /square/);
});

// -- Symmetry and instancing -------------------------------------------------------------------------

test("radial distribution produces the requested instances at the requested angles", (t) => {
  const vol = Volume.of(81, 8, 81);
  const stamp = Volume.of(5, 4, 5);
  stamp.fill(stamp.bounds, block("stone"));
  const instances = distributeRadially(
    vol,
    { volume: stamp, anchor: vec(2, 0, 2) },
    { center: vec(40, 0, 40), count: 8, radius: 30, prng: new Prng(1) },
  );
  t.is(instances.length, 8);
  t.is(instances[0]!.angleDegrees, 0);
  t.is(instances[2]!.angleDegrees, 90);
  // The first instance sits due north of the centre.
  t.true(instances[0]!.position.z < 40);
  t.is(instances[0]!.position.x, 40);
  // Eight non-overlapping stamps of 5x4x5 means every instance actually landed.
  t.is(vol.countNonAir(), 8 * 5 * 4 * 5);
  t.true(measureRadialSymmetry(vol, vec(40, 0, 40), 8, "occupancy") > 0.55);
});

// -- Palette ---------------------------------------------------------------------------------------

test("a palette role falls back rather than throwing when unset", (t) => {
  const palette = Palette.fromJson({
    id: "sparse",
    roles: { WALL_PRIMARY: [{ block: "stone_bricks", weight: 1 }] },
  });
  t.is(blockName(palette.primary("WALL_PRIMARY")), "stone_bricks");
  t.is(blockName(palette.primary("WALL_SECONDARY")), "stone_bricks", "falls back to primary");
  t.truthy(palette.primary("TERRAIN_TOP"), "unrelated roles still resolve");
});

test("a weighted palette source is stable per position", (t) => {
  const palette = Palette.fromJson({
    id: "mixed",
    roles: {
      WALL_PRIMARY: [
        { block: "cobblestone", weight: 4 },
        { block: "mossy_cobblestone", weight: 2 },
        { block: "stone_bricks", weight: 1 },
      ],
    },
  });
  const source = palette.source("WALL_PRIMARY");
  const vol = Volume.of(4, 4, 4);
  const first = typeof source === "number" ? source : source(vec(1, 2, 3), vol);
  const second = typeof source === "number" ? source : source(vec(1, 2, 3), vol);
  t.is(first, second, "the same cell always gets the same block");
});

test("blending palettes keeps both sides in proportion", (t) => {
  const a = Palette.fromJson({ id: "a", roles: { WALL_PRIMARY: [{ block: "quartz_block", weight: 1 }] } });
  const b = Palette.fromJson({ id: "b", roles: { WALL_PRIMARY: [{ block: "red_wool", weight: 1 }] } });
  const blended = blendPalettes(a, b, 0.3);
  const entries = blended.entries("WALL_PRIMARY");
  t.is(entries.length, 2);
  const quartz = entries.find((e) => blockName(e.block) === "quartz_block")!;
  const red = entries.find((e) => blockName(e.block) === "red_wool")!;
  t.true(quartz.weight > red.weight, "the 70% side dominates");
});

// -- Gradients -------------------------------------------------------------------------------------

test("a gradient reaches both endpoint materials", (t) => {
  const vol = Volume.of(8, 32, 8);
  vol.fill(vol.bounds, block("stone"));
  buildGradient(vol, {
    stops: [
      { block: block("stone_bricks"), at: 0 },
      { block: block("cobblestone"), at: 1 },
    ],
    axis: "y",
    dither: "ordered",
  });
  const names = new Set([...vol.histogram().keys()].map(blockName));
  t.true(names.has("stone_bricks"));
  t.true(names.has("cobblestone"));
  t.is(blockName(vol.get(4, 0, 4)), "stone_bricks", "the bottom is the first stop");
  t.is(blockName(vol.get(4, 31, 4)), "cobblestone", "the top is the last stop");
});

test("replace matches a material regardless of orientation bits", (t) => {
  const vol = Volume.of(4, 1, 1);
  vol.set(0, 0, 0, block("oak_stairs"));
  vol.set(1, 0, 0, transformBlock(block("oak_stairs"), { rotation: 90 }));
  vol.set(2, 0, 0, transformBlock(block("oak_stairs"), { rotation: 180 }));
  const changed = replaceBlocks(vol, { from: block("oak_stairs"), to: block("stone") });
  t.is(changed, 3, "all three orientations were replaced");
});

// -- History and the structure graph ------------------------------------------------------------------

test("the build graph records nested structures and can delete a subtree", (t) => {
  const vol = Volume.of(20, 20, 20);
  const graph = new BuildGraph(vol, 7);
  let roofId = "";
  const { id: mapId } = graph.build({ kind: "map" }, () => {
    vol.fill(region(vec(0, 0, 0), vec(19, 0, 19)), block("grass"));
    graph.build({ kind: "building" }, () => {
      vol.fill(region(vec(5, 1, 5), vec(9, 4, 9)), block("stone"));
      roofId = graph.build({ kind: "roof" }, () => {
        vol.fill(region(vec(5, 5, 5), vec(9, 5, 9)), block("red_wool"));
      }).id;
    });
  });

  t.is(graph.ofKind("roof").length, 1);
  t.is(graph.subtree(mapId).length, 3, "map -> building -> roof");
  t.not(vol.get(7, 5, 7), AIR);
  graph.delete(roofId);
  t.is(vol.get(7, 5, 7), AIR, "deleting the roof reverted only the roof");
  t.not(vol.get(7, 2, 7), AIR, "the building below is untouched");
  t.not(vol.get(0, 0, 0), AIR, "the terrain is untouched");
  t.is(graph.subtree(mapId).length, 2, "the deleted node is detached from the tree");
  t.true(graph.has(roofId), "but its id still resolves, so errors stay useful");
});

test("regenerating a structure replaces it in place under the same id", (t) => {
  const vol = Volume.of(12, 12, 12);
  const graph = new BuildGraph(vol, 11);
  const { id } = graph.build({ kind: "roof", params: { style: "gable" } }, () => {
    vol.fill(region(vec(0, 5, 0), vec(11, 5, 11)), block("red_wool"));
  });
  graph.regenerate(
    id,
    () => {
      vol.fill(region(vec(0, 5, 0), vec(11, 5, 11)), block("blue_wool"));
    },
    { style: "hip" },
  );
  t.is(blockName(vol.get(5, 5, 5)), "blue_wool");
  t.is(graph.get(id).params["style"], "hip");
});

test("undo, redo and checkpoints restore exact state", (t) => {
  const vol = Volume.of(8, 8, 8);
  const history = new History(vol);
  history.run("floor", () => vol.fill(region(vec(0, 0, 0), vec(7, 0, 7)), block("stone")));
  history.createCheckpoint("after_floor");
  history.run("pillar", () => vol.fill(region(vec(4, 1, 4), vec(4, 7, 4)), block("quartz_block")));

  t.not(vol.get(4, 5, 4), AIR);
  history.undo();
  t.is(vol.get(4, 5, 4), AIR, "undo removed the pillar");
  history.redo();
  t.not(vol.get(4, 5, 4), AIR, "redo put it back");

  const diff = history.compareCheckpoints("after_floor");
  t.is(diff.added, 7, "the pillar added seven cells since the checkpoint");
  history.restoreCheckpoint("after_floor");
  t.is(vol.get(4, 5, 4), AIR, "restoring the checkpoint removed it again");
});

// -- Sculpture ---------------------------------------------------------------------------------------

test("a sculpture builds at the requested height with its features present", (t) => {
  const vol = Volume.of(60, 60, 60);
  const result = buildVoxelSculpture(vol, {
    model: getArchetype("cartoon_dog"),
    anchor: vec(30, 1, 30),
    height: 40,
    materials: {
      body: block("white_wool"),
      belly: block("silver_wool"),
      detail: block("black_wool"),
      accent: block("red_wool"),
      eye: block("black_wool"),
      limb: block("white_wool"),
      highlight: block("silver_wool"),
    },
  });
  t.is(result.size.y, 40, "height is exact");
  t.true(result.blocksPlaced > 2000);
  t.true((result.partCounts["head"] ?? 0) > 0, "the head landed");
  t.true((result.partCounts["ear"] ?? 0) > 0, "the ears landed");
  t.true((result.partCounts["collar"] ?? 0) > 0, "the collar landed");
});

// -- Style knowledge base ------------------------------------------------------------------------------

test("style analysis measures a synthetic reference correctly", (t) => {
  const vol = Volume.of(60, 30, 60);
  // Four identical towers in a ring around a taller centre: radial, with a clear landmark.
  buildCylinder(vol, { base: vec(30, 0, 30), radius: 6, height: 24, block: block("quartz_block") });
  for (const [dx, dz] of [
    [18, 0],
    [-18, 0],
    [0, 18],
    [0, -18],
  ] as const) {
    buildCylinder(vol, {
      base: vec(30 + dx, 0, 30 + dz),
      radius: 4,
      height: 8,
      block: block("red_stained_clay"),
    });
  }

  const profile = analyzeStyle(vol, { id: "synthetic" });
  t.is(profile.minecraftVersion, "1.8.9");
  t.true(profile.observations.length >= 2);
  t.true(profile.symmetry.radial["4"]! > 0.85, "four-fold symmetry is detected");
  t.true(profile.composition.focalRatio > 1.5, "the centre reads as a landmark");
  t.true(profile.summary.length > 0);
});

test("the style library ingests a schematic and reloads its palette", (t) => {
  const dir = scratch();
  const vol = Volume.of(40, 20, 40);
  buildCylinder(vol, { base: vec(20, 0, 20), radius: 12, height: 4, block: block("grass") });
  buildCylinder(vol, { base: vec(20, 4, 20), radius: 6, height: 12, block: block("pink_wool") });

  const schematicPath = join(dir, "reference.schematic");
  writeFileSync(schematicPath, writeSchematic(vol));

  const library = new StyleLibrary(join(dir, "styles"));
  const result = library.ingestFile(schematicPath, { styleId: "candy", name: "Candy" });

  t.is(result.profile.id, "candy");
  t.deepEqual(library.list(), ["candy"]);
  t.true(existsSync(join(dir, "styles", "candy", "profile.json")));
  t.true(existsSync(join(dir, "styles", "candy", "palette.json")));

  const palette = library.loadPalette("candy");
  t.truthy(palette.primary("WALL_PRIMARY"));
  t.true(result.components.length >= 1, "at least one component was extracted");
});

test("blending style profiles interpolates numbers and keeps the dominant layout", (t) => {
  const makeProfile = (id: string, roughness: number, layout: "radial" | "linear") => {
    const vol = Volume.of(20, 10, 20);
    vol.fill(region(vec(0, 0, 0), vec(19, 2, 19)), block("stone"));
    const base = analyzeStyle(vol, { id });
    return {
      ...base,
      terrain: { ...base.terrain, edgeRoughness: roughness },
      composition: { ...base.composition, layout },
    };
  };
  const blended = blendStyleProfiles(
    [
      { profile: makeProfile("a", 0.2, "radial"), weight: 0.7 },
      { profile: makeProfile("b", 1.0, "linear"), weight: 0.3 },
    ],
    "mix",
  );
  t.is(blended.composition.layout, "radial", "the heavier style decides the layout");
  t.true(blended.terrain.edgeRoughness > 0.35 && blended.terrain.edgeRoughness < 0.5);
});

// -- Validation ----------------------------------------------------------------------------------------

test("inspection finds a floating block and a sealed pocket", (t) => {
  const vol = Volume.of(20, 20, 20);
  vol.fill(region(vec(2, 2, 2), vec(8, 8, 8)), block("stone"));
  vol.fill(region(vec(4, 4, 4), vec(6, 6, 6)), AIR); // sealed interior
  vol.set(15, 15, 15, block("stone")); // floating debris

  const report = inspectRegion(vol);
  const kinds = report.issues.map((i) => i.kind);
  t.true(kinds.includes("isolated_block"));
  t.true(kinds.includes("sealed_pocket"));
  t.is(report.stats.components, 2);
});

test("constraints reject a build that breaks its height limit", (t) => {
  const vol = Volume.of(10, 40, 10);
  vol.fill(region(vec(0, 0, 0), vec(9, 35, 9)), block("stone"));
  const violations = checkConstraints(vol, { maxHeight: 20 });
  t.is(violations.length, 1);
  t.is(violations[0]!.rule, "maxHeight");
  t.is(violations[0]!.severity, "error");
});

test("bridge estimation prefers diagonal placement over straight", (t) => {
  const estimate = estimateBridge(vec(0, 64, 0), vec(30, 64, 30));
  t.is(estimate.diagonalBlocks, 30, "a 30x30 diagonal gap costs 30 blocks");
  t.is(estimate.straightBlocks, 60, "going around the two axes costs 60");
  t.is(estimate.minimumBlocks, 30);
  t.true(estimate.estimatedSeconds > 0);
});

test("pathfinding walks a corridor and reports the detour", (t) => {
  const vol = Volume.of(30, 8, 8);
  vol.fill(region(vec(0, 0, 0), vec(29, 0, 7)), block("stone"));
  // A wall with a gap forces a detour.
  vol.fill(region(vec(15, 1, 0), vec(15, 3, 5)), block("stone"));
  const path = findWalkPath(vol, vec(1, 1, 1), vec(28, 1, 1));
  t.true(path.reachable);
  t.true(path.steps >= 27);
  t.true(path.detourRatio >= 1);
});

// -- Domain generators -----------------------------------------------------------------------------------

test("the BedWars layout puts adjacent bases at the requested rush distance", (t) => {
  const layout = planBedwarsLayout({ teams: 8, rushDistance: 48 });
  t.is(layout.teamIslands.length, 8);
  const distances: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = layout.teamIslands[i]!.spawn;
    const b = layout.teamIslands[(i + 1) % 8]!.spawn;
    distances.push(Math.hypot(a.x - b.x, a.z - b.z));
  }
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  t.true(max - min < 1.5, `adjacent rush distances agree (${min.toFixed(1)}-${max.toFixed(1)})`);
});

test("a generated BedWars map is fair, valid and reproducible", (t) => {
  const spec = { teams: 4 as const, seed: 4242, theme: "garden", rushDistance: 44 };
  const first = buildBedwarsMap(spec);

  t.is(first.layout.teamIslands.length, 4);
  t.true(first.volume.countNonAir() > 20_000, "the map has real content");
  t.is(first.analysis.rushDistance.spread, 0, "every team faces the same rush");
  t.deepEqual(
    first.analysis.heightAdvantage.map((h) => h.delta),
    [0, 0, 0, 0],
    "no team has a height advantage",
  );
  t.true(first.analysis.symmetry > 0.7, `radial symmetry ${first.analysis.symmetry}`);
  t.is(
    first.violations.filter((v) => v.severity === "error").length,
    0,
    `no constraint errors: ${first.violations.map((v) => v.message).join("; ")}`,
  );

  const second = buildBedwarsMap(spec);
  t.deepEqual([...second.volume.cells], [...first.volume.cells], "the same seed rebuilds the same map");
});

test("every block a generated map uses exists in 1.8", (t) => {
  const result = buildBedwarsMap({ teams: 4, seed: 99, rushDistance: 40 });
  const report = inspectRegion(result.volume);
  const unknown = report.issues.find((i) => i.kind === "unknown_block");
  t.is(unknown, undefined, unknown?.message);
});

test("a generated map round-trips through the schematic format unchanged", (t) => {
  const result = buildBedwarsMap({ teams: 2, seed: 5, rushDistance: 40 });
  const reloaded = readSchematic(writeSchematic(result.volume));
  t.deepEqual([...reloaded.volume.cells], [...result.volume.cells]);
});

test("a duels arena is mirror-symmetric with two spawns", (t) => {
  const arena = buildDuelsArena({ kit: "boxing", seed: 7, playableRadius: 14 });
  t.is(arena.spawns.length, 2);
  t.true(arena.symmetry > 0.95, `symmetry ${arena.symmetry}`);
  t.true(arena.volume.countNonAir() > 1000);
});

// -- Rendering and output --------------------------------------------------------------------------------

test("rendering produces valid PNGs for every view", (t) => {
  const vol = Volume.of(24, 16, 24);
  buildCylinder(vol, { base: vec(12, 0, 12), radius: 8, height: 3, block: block("grass") });
  buildSphere(vol, { center: vec(12, 8, 12), radius: 4, block: block("red_wool") });

  const views = renderViews(vol, { views: ["perspective", "top"], width: 160, height: 120, supersample: 1 });
  t.is(views.length, 2);
  for (const view of views) {
    t.is(view.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
    t.true(view.png.length > 200);
  }
});

test("the top view shows the top of the build, not its underside", (t) => {
  // A regression guard: orthographic depth once collapsed to a constant, so whichever face was
  // rasterized first won and every plan view rendered the undersides.
  const vol = Volume.of(16, 12, 16);
  vol.fill(region(vec(0, 0, 0), vec(15, 8, 15)), block("black_wool"));
  vol.fill(region(vec(0, 9, 0), vec(15, 9, 15)), block("white_wool"));

  const [view] = renderViews(vol, { views: ["top"], width: 64, height: 64, supersample: 1 });
  const png = view!.png;
  t.true(png.length > 100);

  // Re-render through the low-level path so the pixels can be inspected directly.
  const result = renderVolume(vol, {
    width: 64,
    height: 64,
    supersample: 1,
    camera: { azimuthDegrees: 0, elevationDegrees: 89.9, projection: "orthographic", upAzimuthDegrees: 0 },
  });
  const centre = (32 * 64 + 32) * 4;
  const r = result.framebuffer.color[centre]!;
  t.true(r > 128, `centre pixel should be the white top face, got r=${r}`);
});

test("a build folder contains everything needed to load and judge the map", (t) => {
  const dir = join(scratch(), "carousel_map_01");
  const result = buildBedwarsMap({ teams: 4, seed: 2024, theme: "carousel", rushDistance: 40 });
  const written = writeBuildOutput({
    dir,
    name: "carousel_map_01",
    volume: result.volume,
    seed: result.seed,
    palette: result.palette,
    graph: result.graph,
    theme: "carousel",
    spec: { teams: 4, seed: 2024 },
    analysis: result.analysis,
    inspection: result.inspection,
    violations: result.violations,
    views: ["top"],
    viewSize: { width: 200, height: 200 },
    now: "2026-01-01T00:00:00.000Z",
  });

  for (const expected of ["build.schematic", "manifest.json", "build.json", "palette.json", "analysis.json", "README.md"]) {
    t.true(written.files.includes(expected), `${expected} was written`);
    t.true(existsSync(join(dir, expected)));
  }
  t.is(written.previews.length, 1);

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  t.is(manifest["minecraftVersion"], "1.8.9");
  t.is(manifest["seed"], 2024);

  // The schematic in the folder must be the map, not a placeholder.
  const reloaded = readSchematic(readFileSync(join(dir, "build.schematic")));
  t.deepEqual([...reloaded.volume.cells], [...result.volume.cells]);
});

// -- Observation ------------------------------------------------------------------------------------------

test("palette observation separates buried material from visible material", (t) => {
  const vol = Volume.of(12, 12, 12);
  vol.fill(region(vec(0, 0, 0), vec(11, 11, 11)), block("stone"));
  // A single-block shell of quartz would be entirely visible; the stone core mostly is not.
  vol.fill(region(vec(0, 11, 0), vec(11, 11, 11)), block("quartz_block"));

  const observations = observePalette(vol);
  const stone = observations.find((o) => o.name === "stone")!;
  const quartz = observations.find((o) => o.name === "quartz_block")!;
  t.true(stone.count > quartz.count, "stone is more numerous");
  t.true(quartz.exposure > stone.exposure, "but quartz is more exposed");
});

test("packing and unpacking a block is lossless across the whole legacy range", (t) => {
  for (let id = 0; id <= 197; id++) {
    for (let data = 0; data <= 15; data += 5) {
      const packed = pack(id, data);
      t.is((packed >> 4) & 0xfff, id);
      t.is(packed & 0xf, data);
    }
  }
});
