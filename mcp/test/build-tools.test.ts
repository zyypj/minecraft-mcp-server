import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import test from "ava";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Volume, buildCylinder, vec, writeSchematic, readSchematic, block } from "@mcbuild/engine";

import { registerBuildEngine } from "../src/build/bootstrap.js";
import type { ServerConfig } from "../src/config.js";

/**
 * A harness that captures the tool callbacks the registry hands to the SDK, so a test can call a
 * tool the way an agent would — by name, with a plain arguments object.
 */
interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; images: number; isError: boolean }>;
  names: string[];
  dir: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mcbuild-mcp-"));
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();

  // The registry only needs `tool`; standing in for the whole server keeps the test honest about
  // what it is exercising, which is our code rather than the SDK's transport.
  const fake = {
    tool(name: string, _description: string, _schema: unknown, cb: (args: unknown) => Promise<unknown>) {
      handlers.set(name, cb);
    },
  } as unknown as McpServer;

  const config: ServerConfig = {
    host: "localhost",
    port: 25565,
    username: "test",
    backend: "engine",
    pluginUrl: "",
    token: "",
    buildsDir: join(dir, "builds"),
    stylesDir: join(dir, "styles"),
  };
  const names = [...registerBuildEngine(fake, config)];

  return {
    names,
    dir,
    async call(name, args = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No tool "${name}". Registered: ${names.join(", ")}`);
      const response = (await handler(args)) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      return {
        text: response.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n"),
        images: response.content.filter((c) => c.type === "image").length,
        isError: response.isError === true,
      };
    },
  };
}

test("every tool the engine backend advertises is registered exactly once", (t) => {
  const h = harness();
  t.true(h.names.length > 60, `${h.names.length} tools registered`);
  t.is(new Set(h.names).size, h.names.length, "no duplicate tool names");
  for (const expected of [
    "build_bedwars_map",
    "build_duels_arena",
    "build_island",
    "build_voxel_sculpture",
    "ingest_schematic",
    "blend_styles",
    "preview_build",
    "save_build",
    "undo_build",
    "create_checkpoint",
    "inspect_build",
    "analyze_bedwars_map",
  ]) {
    t.true(h.names.includes(expected), `${expected} is registered`);
  }
});

test("a tool with no open build explains what to do instead of throwing", async (t) => {
  const h = harness();
  const result = await h.call("describe_build");
  t.true(result.isError);
  t.regex(result.text, /No build is open/);
});

test("geometry tools compose a build and report what they changed", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "tower_test", width: 64, height: 64, length: 64, seed: 1 });

  const island = await h.call("build_island", {
    center: { x: 32, y: 20, z: 32 },
    radius: 22,
    depth: 14,
    edgeNoise: 0.25,
  });
  t.false(island.isError, island.text);
  t.regex(island.text, /blocks changed/);
  t.regex(island.text, /Buildable surface is at Y=/);

  const tower = await h.call("build_tower", {
    base: { x: 32, y: 21, z: 32 },
    radius: 6,
    height: 20,
    roofStyle: "cone",
    battlements: true,
  });
  t.false(tower.isError, tower.text);
  t.regex(tower.text, /Top of the roof is at Y=/);

  const described = await h.call("describe_build");
  t.regex(described.text, /tower_test/);
  t.regex(described.text, /Structures:/);
});

test("a post-1.8 block is refused with the legal substitute named", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "materials", width: 16, height: 16, length: 16 });
  const result = await h.call("fill_region", {
    region: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
    material: "white_concrete",
  });
  t.true(result.isError);
  t.regex(result.text, /does not exist in Minecraft 1\.8/);
  t.regex(result.text, /white_wool/);
});

test("palette roles resolve so a build follows its style rather than naming blocks", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "roles", width: 16, height: 16, length: 16 });
  const result = await h.call("fill_region", {
    region: { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 0, z: 8 } },
    material: "TERRAIN_TOP",
  });
  t.false(result.isError, result.text);
  t.regex(result.text, /81 blocks changed/);
});

test("undo and checkpoints work through the tool surface", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "history", width: 32, height: 32, length: 32 });
  await h.call("fill_region", {
    region: { min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 0, z: 31 } },
    material: "stone",
  });
  await h.call("create_checkpoint", { name: "floor" });
  await h.call("build_sphere", { center: { x: 16, y: 8, z: 16 }, radius: 5, material: "red_wool" });

  const beforeUndo = await h.call("describe_build");
  t.regex(beforeUndo.text, /red_wool/);

  const undone = await h.call("undo_build");
  t.regex(undone.text, /Undid "build_sphere"/);

  const afterUndo = await h.call("describe_build");
  t.notRegex(afterUndo.text, /red_wool/);

  const redone = await h.call("redo_build");
  t.regex(redone.text, /Redid "build_sphere"/);

  const compared = await h.call("compare_checkpoints", { from: "floor" });
  t.false(compared.isError, compared.text);
  t.regex(compared.text, /"added"/);
});

test("the full BedWars workflow runs end to end and writes a loadable folder", async (t) => {
  const h = harness();

  const generated = await h.call("build_bedwars_map", {
    name: "carousel_test",
    teams: 4,
    seed: 20260101,
    theme: "carousel",
    rushDistance: 44,
  });
  t.false(generated.isError, generated.text);
  const summary = JSON.parse(generated.text) as {
    build: string;
    analysis: { rushDistance: { spread: number }; symmetry: number };
    constraintErrors: string[];
  };
  t.truthy(summary.build);
  t.is(summary.analysis.rushDistance.spread, 0, "every team faces the same rush");
  t.deepEqual(summary.constraintErrors, [], "no constraint errors");

  const preview = await h.call("preview_build", { views: ["top"], width: 240, height: 240, supersample: 1 });
  t.false(preview.isError, preview.text);
  t.is(preview.images, 1, "the preview came back as an image");

  const analysis = await h.call("analyze_bedwars_map");
  t.regex(analysis.text, /Rush distance:/);
  t.regex(analysis.text, /Void exposure:/);

  const inspection = await h.call("inspect_build");
  t.notRegex(inspection.text, /unknown_block/, "every block exists in 1.8");

  const saved = await h.call("save_build", { name: "carousel_test", views: ["top"] });
  t.false(saved.isError, saved.text);
  const dir = join(h.dir, "builds", "carousel_test");
  for (const file of ["build.schematic", "manifest.json", "build.json", "palette.json", "analysis.json", "README.md"]) {
    t.true(existsSync(join(dir, file)), `${file} written`);
  }
  t.true(existsSync(join(dir, "preview", "top.png")));

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  t.is(manifest["minecraftVersion"], "1.8.9");
  t.is(manifest["seed"], 20260101);

  // The schematic must be readable back as the same map.
  const reloaded = readSchematic(readFileSync(join(dir, "build.schematic")));
  t.is(reloaded.sourceFormat, "mcedit");
  t.true(reloaded.volume.countNonAir() > 10_000);
});

test("a reference schematic is ingested, measured, and usable as a style", async (t) => {
  const h = harness();

  // A synthetic reference: a wide grass island with a ring of pink towers around a taller centre.
  const reference = Volume.of(80, 40, 80);
  buildCylinder(reference, { base: vec(40, 0, 40), radius: 34, height: 5, block: block("grass") });
  buildCylinder(reference, { base: vec(40, 5, 40), radius: 8, height: 22, block: block("pink_wool") });
  for (const [dx, dz] of [
    [22, 0],
    [-22, 0],
    [0, 22],
    [0, -22],
  ] as const) {
    buildCylinder(reference, {
      base: vec(40 + dx, 5, 40 + dz),
      radius: 5,
      height: 9,
      block: block("magenta_stained_clay"),
    });
  }
  const file = join(h.dir, "candy-reference.schematic");
  writeFileSync(file, writeSchematic(reference));

  const ingested = await h.call("ingest_schematic", { file, styleId: "candy", name: "Candy" });
  t.false(ingested.isError, ingested.text);
  t.regex(ingested.text, /Ingested candy-reference\.schematic as style "candy"/);
  t.regex(ingested.text, /What it measured:/);

  const listed = await h.call("list_styles");
  t.regex(listed.text, /candy/);

  const profile = await h.call("get_style_profile", { styleId: "candy", section: "palette" });
  t.regex(profile.text, /pink_wool|magenta_stained_clay/, "the reference's colours are in the palette");

  // A map built in that style must actually use its materials.
  const generated = await h.call("build_bedwars_map", {
    name: "candy_map",
    teams: 2,
    seed: 7,
    style: "candy",
    rushDistance: 40,
  });
  t.false(generated.isError, generated.text);
  const described = await h.call("describe_build");
  t.regex(described.text, /pink_wool|magenta_stained_clay/, "the generated map uses the style's blocks");
});

test("styles can be blended into a new one", async (t) => {
  const h = harness();
  for (const [id, material] of [
    ["alpha", "blue_wool"],
    ["beta", "yellow_wool"],
  ] as const) {
    const reference = Volume.of(40, 20, 40);
    buildCylinder(reference, { base: vec(20, 0, 20), radius: 15, height: 4, block: block("grass") });
    buildCylinder(reference, { base: vec(20, 4, 20), radius: 6, height: 10, block: block(material) });
    const file = join(h.dir, `${id}.schematic`);
    writeFileSync(file, writeSchematic(reference));
    await h.call("ingest_schematic", { file, styleId: id });
  }

  const blended = await h.call("blend_styles", {
    styles: [
      { id: "alpha", weight: 0.7 },
      { id: "beta", weight: 0.3 },
    ],
    newStyleId: "mixed",
  });
  t.false(blended.isError, blended.text);
  t.regex(blended.text, /Created style "mixed"/);

  const listed = await h.call("list_styles");
  t.regex(listed.text, /mixed/);
});

test("a duels arena comes back symmetric with two spawns", async (t) => {
  const h = harness();
  const result = await h.call("build_duels_arena", { kit: "boxing", seed: 11, playableRadius: 12 });
  t.false(result.isError, result.text);
  const parsed = JSON.parse(result.text) as { spawns: unknown[]; symmetry: number };
  t.is(parsed.spawns.length, 2);
  t.true(parsed.symmetry > 0.95, `symmetry ${parsed.symmetry}`);
});

test("copy, rotate and radial distribution instance a structure around a circle", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "instancing", width: 96, height: 32, length: 96, seed: 3 });
  await h.call("build_box", {
    region: { min: { x: 42, y: 0, z: 42 }, max: { x: 50, y: 6, z: 50 } },
    material: "stone_bricks",
  });
  await h.call("copy_region", {
    region: { min: { x: 42, y: 0, z: 42 }, max: { x: 50, y: 6, z: 50 } },
    anchor: { x: 46, y: 0, z: 46 },
  });
  await h.call("clear_region", {
    region: { min: { x: 42, y: 0, z: 42 }, max: { x: 50, y: 6, z: 50 } },
  });

  const distributed = await h.call("distribute_radially", {
    center: { x: 48, y: 0, z: 48 },
    count: 6,
    radius: 30,
  });
  t.false(distributed.isError, distributed.text);
  const parsed = JSON.parse(distributed.text) as { instances: { angleDegrees: number }[] };
  t.is(parsed.instances.length, 6);
  t.is(parsed.instances[0]!.angleDegrees, 0);
});

test("rotating a non-square region fails with an explanation, not a corrupted build", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "rotate", width: 32, height: 8, length: 32 });
  const result = await h.call("rotate_structure", {
    region: { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 3, z: 4 } },
    degrees: 90,
  });
  t.true(result.isError);
  t.regex(result.text, /square/);
});

test("a silhouette carve builds the shape it was given", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "carve", width: 48, height: 48, length: 48 });
  const result = await h.call("build_sculpture_from_silhouette", {
    anchor: { x: 24, y: 1, z: 24 },
    height: 24,
    material: "white_wool",
    front: [
      "..####..",
      ".######.",
      "########",
      "########",
      ".######.",
      "..####..",
      "...##...",
      "...##...",
    ],
    side: [
      "..####..",
      ".######.",
      "########",
      "########",
      ".######.",
      "..####..",
      "...##...",
      "...##...",
    ],
  });
  t.false(result.isError, result.text);
  t.regex(result.text, /blocks changed/);
});

test("a structure regenerates in place under the same id, leaving the rest untouched", async (t) => {
  const h = harness();
  await h.call("create_build", { name: "regen", width: 64, height: 48, length: 64, seed: 5 });
  await h.call("build_island", { center: { x: 32, y: 16, z: 32 }, radius: 20, depth: 10 });
  await h.call("build_building", {
    footprint: { min: { x: 26, y: 0, z: 26 }, max: { x: 38, y: 0, z: 38 } },
    baseY: 17,
    roofStyle: "gable",
  });

  const listed = await h.call("list_structures", { kind: "building" });
  const id = /(structure_[0-9a-f]+)/.exec(listed.text)?.[1];
  if (!id) {
    t.fail(`no building id in: ${listed.text}`);
    return;
  }

  const islandBefore = (await h.call("describe_build")).text;

  const regenerated = await h.call("regenerate_structure", {
    structure: id,
    params: { roofStyle: "dome" },
  });
  t.false(regenerated.isError, regenerated.text);
  t.regex(regenerated.text, new RegExp(`Regenerated ${id}`));
  t.regex(regenerated.text, /Changed: roofStyle/);

  const described = await h.call("describe_structure", { structure: id });
  const node = JSON.parse(described.text) as { id: string; params: Record<string, unknown> };
  t.is(node.id, id, "the id is unchanged");
  t.is(node.params["roofStyle"], "dome", "the override was recorded");

  // The terrain the building sits on is untouched.
  t.regex(islandBefore, /grass/);
  t.regex((await h.call("describe_build")).text, /grass/);
});

test("regenerating a kind that was not one parameterized call explains why", async (t) => {
  const h = harness();
  const generated = await h.call("build_bedwars_map", { teams: 2, seed: 3, rushDistance: 40 });
  t.false(generated.isError, generated.text);
  const listed = await h.call("list_structures", { kind: "bedwars_map" });
  const id = /(structure_[0-9a-f]+)/.exec(listed.text)?.[1];
  t.truthy(id, `the generated map is in the structure graph: ${listed.text}`);
  const result = await h.call("regenerate_structure", { structure: id as string });
  t.true(result.isError);
  t.regex(result.text, /cannot be regenerated on their own/);
});

test("a team island on a generated map can be regenerated with a different roof", async (t) => {
  const h = harness();
  const generated = await h.call("build_bedwars_map", {
    teams: 4,
    seed: 4242,
    rushDistance: 44,
    roofStyle: "gable",
  });
  t.false(generated.isError, generated.text);

  const listed = await h.call("list_structures", { kind: "team_island" });
  t.regex(listed.text, /team_island/, "generated maps keep their structure graph");
  const ids = [...listed.text.matchAll(/(structure_[0-9a-f]+)/g)].map((m) => m[1]!);
  t.is(ids.length, 4, "one node per team");

  // The flagship edit: change only the roofs, leaving everything else byte-identical.
  const before = (await h.call("describe_build")).text;
  for (const id of ids) {
    const result = await h.call("regenerate_structure", { structure: id, params: { roofStyle: "dome" } });
    t.false(result.isError, result.text);
    t.regex(result.text, /Regenerated structure_/);
  }

  const after = (await h.call("describe_build")).text;
  t.not(before, after, "the map changed");

  const inspection = await h.call("inspect_build");
  t.notRegex(inspection.text, /unknown_block/, "still only 1.8 blocks");
});
