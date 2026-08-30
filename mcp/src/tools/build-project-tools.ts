/**
 * Project tools: sessions, style library, history, validation, preview and export.
 *
 * This is where the workflow lives. The intended loop is:
 *
 * ```
 * ingest_schematic (once, per reference)
 *   -> build_bedwars_map / build_* geometry
 *   -> preview_build          look at it
 *   -> inspect_build / analyze_bedwars_map   check it
 *   -> undo / regenerate_structure           fix it
 *   -> save_build             write the schematic and previews
 * ```
 *
 * Nothing writes to a Minecraft server. `save_build` produces a folder; loading it is a deliberate
 * human step with `//schem load`.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  ALL_VIEWS,
  GAMEPLAY_COLORS,
  Palette,
  TEAM_MARKER_COLORS,
  analyzeBedwarsMap,
  analyzeStyle,
  blendStyleProfiles,
  buildSlug,
  checkConstraints,
  estimateBridge,
  findWalkPath,
  formatAnalysis,
  formatInspection,
  inspectRegion,
  measureRadialSymmetry,
  readSchematic,
  renderViews,
  writeBuildOutput,
  writeSchematic,
  type Annotation,
  type TeamColor,
  type ViewName,
  type WorldMarker,
  type WorldRoute,
  blockName,
  pasteClipboard,
  vec,
} from "@mcbuild/engine";

import { type BuildToolRegistry, json, lines, text, withImages } from "../build/registry.js";
import { BuildSession, type BuildWorkspace } from "../build/session.js";
import { buildRefSchema, regionSchema, toRegion, toVec, vec3Schema } from "../build/args.js";

const viewSchema = z.enum(["perspective", "front", "side", "top", "gameplay"]);

export function registerBuildProjectTools(registry: BuildToolRegistry, workspace: BuildWorkspace): void {
  // -- Sessions ------------------------------------------------------------------------------------

  registry.register(
    "create_build",
    "Open a new empty build to work in. Sizes are in blocks; 1.8 worlds are 256 tall, so keep height under that.",
    {
      name: z.string(),
      width: z.number().int().min(1).max(2048),
      height: z.number().int().min(1).max(256),
      length: z.number().int().min(1).max(2048),
      seed: z.number().int().optional(),
      style: z.string().optional().describe("Style id from the library, used as the palette."),
    },
    (args) => {
      const styleId = args["style"] as string | undefined;
      const session = workspace.create({
        name: args["name"] as string,
        width: args["width"] as number,
        height: args["height"] as number,
        length: args["length"] as number,
        seed: args["seed"] as number | undefined,
        palette: styleId ? workspace.library.loadPalette(styleId) : undefined,
      });
      session.styleId = styleId;
      return text(`Created ${session.summary()}`);
    },
  );

  registry.register("list_builds", "List the builds currently open.", {}, () => {
    const all = workspace.list();
    if (all.length === 0) return text("No builds are open. Create one with `create_build`.");
    return lines([
      ...all.map((b) => `${b === workspace.active ? "* " : "  "}${b.summary()}`),
      "",
      "* marks the active build, used when a tool omits `build`.",
    ]);
  });

  registry.register(
    "select_build",
    "Make a build the active one, so later tools can omit `build`.",
    { build: z.string() },
    (args) => text(`Active build is now ${workspace.select(args["build"] as string).summary()}`),
  );

  registry.register(
    "close_build",
    "Discard an open build. Unsaved work is lost; `save_build` first if you want to keep it.",
    { build: z.string() },
    (args) =>
      text(workspace.close(args["build"] as string) ? `Closed ${args["build"]}.` : `No build "${args["build"]}".`),
  );

  registry.register(
    "describe_build",
    "Dimensions, block usage, palette and structure tree for a build.",
    { build: buildRefSchema },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const histogram = [...session.volume.histogram().entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      return lines([
        session.summary(),
        "",
        "Top blocks:",
        ...histogram.map(([b, n]) => `  ${blockLabel(b)}  ${n.toLocaleString("en-US")}`),
        "",
        "Structures:",
        ...(session.graph.toOutline().slice(0, 60) || ["  (none)"]),
        ...(session.history.timeline().length
          ? ["", `History: ${session.history.timeline().length} undoable steps.`]
          : []),
      ]);
    },
  );

  registry.register(
    "set_build_palette",
    "Change the palette a build is using. Later operations that name a palette role pick up the new materials; blocks already placed are unchanged (use `replace_region` for those).",
    {
      build: buildRefSchema,
      style: z.string().optional().describe("Style id from the library."),
      palette: z.record(z.array(z.union([z.string(), z.object({ block: z.string(), weight: z.number() })]))).optional()
        .describe("An inline palette: role -> materials, e.g. {\"WALL_PRIMARY\":[\"quartz_block\"]}."),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      if (args["style"]) {
        session.palette = workspace.library.loadPalette(args["style"] as string);
        session.styleId = args["style"] as string;
      } else if (args["palette"]) {
        session.palette = Palette.fromJson({
          id: `${session.id}-inline`,
          roles: args["palette"] as never,
        });
        session.styleId = undefined;
      } else {
        throw new Error("Pass either `style` or `palette`.");
      }
      return text(`Palette for ${session.id} is now ${session.palette.id}.`);
    },
  );

  // -- Style library --------------------------------------------------------------------------------

  registry.register(
    "ingest_schematic",
    "Read a reference .schematic into the style library. This MEASURES the reference — palette by surface exposure, colour clusters, material ramps, symmetry, mass layout, terrain and density traits, repeated motifs — and writes editable JSON plus reusable components. It is a knowledge base, not training: everything it learns can be read and corrected by hand.",
    {
      file: z.string().describe("Path to a .schematic (MCEdit) or .schem (Sponge) file."),
      styleId: z.string().describe("Short id, e.g. `carousel`. Reused as the folder name."),
      name: z.string().optional(),
      merge: z.boolean().optional().describe("Merge into an existing style of the same id instead of replacing it."),
      extractComponents: z.boolean().optional().describe("Default true."),
    },
    (args) => {
      const file = resolvePath(args["file"] as string);
      if (!existsSync(file)) throw new Error(`No file at ${file}`);
      const result = workspace.library.ingestFile(file, {
        styleId: args["styleId"] as string,
        name: args["name"] as string | undefined,
        merge: args["merge"] as boolean | undefined,
        extractComponents: (args["extractComponents"] as boolean | undefined) ?? true,
      });
      return lines([
        `Ingested ${basename(file)} as style "${result.profile.id}".`,
        `Source: ${result.profile.source.dimensions.width}x${result.profile.source.dimensions.height}x${result.profile.source.dimensions.length}, ${result.profile.source.solidBlocks.toLocaleString("en-US")} blocks.`,
        "",
        "What it measured:",
        ...result.profile.summary.map((s) => `  - ${s}`),
        "",
        `Components extracted: ${result.components.length}` +
          (result.components.length ? ` (${result.components.map((c) => `${c.id}[${c.kind}]`).join(", ")})` : ""),
        ...(result.warnings.length ? ["", "Warnings:", ...result.warnings.map((w) => `  - ${w}`)] : []),
      ]);
    },
  );

  registry.register(
    "ingest_schematic_folder",
    "Ingest every schematic in a folder into one style. Use this to define a style from several reference maps at once; traits are averaged weighted by size.",
    {
      folder: z.string(),
      styleId: z.string(),
      name: z.string().optional(),
    },
    (args) => {
      const dir = resolvePath(args["folder"] as string);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No folder at ${dir}`);
      const files = readdirSync(dir).filter((f) => /\.(schematic|schem)$/i.test(f));
      if (files.length === 0) throw new Error(`No .schematic or .schem files in ${dir}`);
      const summaries: string[] = [];
      files.forEach((f, index) => {
        const result = workspace.library.ingestFile(join(dir, f), {
          styleId: args["styleId"] as string,
          name: args["name"] as string | undefined,
          merge: index > 0,
        });
        summaries.push(`  ${f}: ${result.profile.source.solidBlocks.toLocaleString("en-US")} blocks, ${result.components.length} components`);
      });
      const profile = workspace.library.load(args["styleId"] as string);
      return lines([
        `Ingested ${files.length} references into style "${args["styleId"]}".`,
        ...summaries,
        "",
        ...profile.summary.map((s) => `  - ${s}`),
      ]);
    },
  );

  registry.register("list_styles", "List the styles in the knowledge base.", {}, () => {
    const ids = workspace.library.list();
    if (ids.length === 0) {
      return text(`The style library at ${workspace.library.root} is empty. Add one with \`ingest_schematic\`.`);
    }
    return lines(
      ids.map((id) => {
        const profile = workspace.library.load(id);
        return `${id} — ${profile.source.files.length} reference(s), ${profile.composition.layout} layout, ${profile.symmetry.dominant}, ${profile.source.solidBlocks.toLocaleString("en-US")} blocks`;
      }),
    );
  });

  registry.register(
    "get_style_profile",
    "Read what the library measured for a style: palette, colours, ramps, symmetry, composition, terrain, density and motifs.",
    { styleId: z.string(), section: z.enum(["all", "summary", "palette", "composition", "terrain", "motifs"]).optional() },
    (args) => {
      const profile = workspace.library.load(args["styleId"] as string);
      const section = (args["section"] as string | undefined) ?? "summary";
      if (section === "summary") {
        return lines([
          `${profile.name} (${profile.id})`,
          ...profile.summary.map((s) => `  - ${s}`),
          "",
          `Components: ${workspace.library.components(profile.id).map((c) => `${c.id}[${c.kind}]`).join(", ") || "none"}`,
        ]);
      }
      if (section === "all") return json(profile);
      if (section === "palette") return json({ palette: profile.palette, colors: profile.colors, ramps: profile.ramps });
      if (section === "composition") return json({ composition: profile.composition, symmetry: profile.symmetry });
      if (section === "terrain") return json({ terrain: profile.terrain, density: profile.density });
      return json({ motifs: profile.motifs });
    },
  );

  registry.register(
    "blend_styles",
    "Blend styles into a new one. Weights decide whose vocabulary dominates; numeric traits interpolate while the layout and dominant symmetry come from the heaviest contributor, because there is no meaningful midpoint between 'radial' and 'linear'.",
    {
      styles: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).min(2).max(5),
      newStyleId: z.string(),
    },
    (args) => {
      const inputs = (args["styles"] as { id: string; weight: number }[]).map((s) => ({
        profile: workspace.library.load(s.id),
        weight: s.weight,
      }));
      const blended = blendStyleProfiles(inputs, args["newStyleId"] as string);
      workspace.library.save(blended);
      return lines([
        `Created style "${blended.id}" from ${inputs.map((i) => i.profile.id).join(" + ")}.`,
        ...blended.summary.map((s) => `  - ${s}`),
      ]);
    },
  );

  registry.register(
    "list_style_components",
    "List the reusable components extracted from a style's references.",
    { styleId: z.string() },
    (args) => {
      const components = workspace.library.components(args["styleId"] as string);
      if (components.length === 0) return text(`Style "${args["styleId"]}" has no extracted components.`);
      return lines(
        components.map(
          (c) =>
            `${c.id}  ${c.kind}  ${c.size.width}x${c.size.height}x${c.size.length}  ${c.blockCount.toLocaleString("en-US")} blocks  symmetry ${c.symmetry}  [${c.dominantBlocks.join(", ")}]  from ${c.source}`,
        ),
      );
    },
  );

  registry.register(
    "paste_style_component",
    "Paste a component from the style library into the current build. This is how a reference's own vocabulary gets reused without copying a whole map.",
    {
      build: buildRefSchema,
      styleId: z.string(),
      componentId: z.string(),
      at: vec3Schema,
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
      ignoreAir: z.boolean().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const component = workspace.library.loadComponent(args["styleId"] as string, args["componentId"] as string);
      const changed = session.history.run("paste_style_component", () =>
        session.graph.build(
          { kind: "component", label: args["componentId"] as string, params: args },
          () =>
            pasteClipboard(
              session.volume,
              { volume: component, anchor: vec(0, 0, 0) },
              toVec(args["at"]),
              {
                transform: { rotation: ((args["rotation"] as number | undefined) ?? 0) as 0 | 90 | 180 | 270 },
                ignoreAir: (args["ignoreAir"] as boolean | undefined) ?? true,
              },
            ),
        ).result,
      );
      return text(`Pasted ${args["componentId"]} (${changed.toLocaleString("en-US")} blocks) into ${session.id}.`);
    },
  );

  // -- History ---------------------------------------------------------------------------------------

  registry.register("undo_build", "Undo the most recent operation.", { build: buildRefSchema }, (args) => {
    const session = workspace.require(args["build"] as string | undefined);
    const undone = session.history.undo();
    return text(
      undone
        ? `Undid "${undone.label}" (${undone.blocksRestored.toLocaleString("en-US")} blocks restored).`
        : "Nothing to undo.",
    );
  });

  registry.register("redo_build", "Redo the operation that was last undone.", { build: buildRefSchema }, (args) => {
    const session = workspace.require(args["build"] as string | undefined);
    const redone = session.history.redo();
    return text(redone ? `Redid "${redone.label}".` : "Nothing to redo.");
  });

  registry.register(
    "list_history",
    "The undoable steps for a build, oldest first.",
    { build: buildRefSchema },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const timeline = session.history.timeline();
      if (timeline.length === 0) return text("No operations have been recorded.");
      return lines(timeline.map((e, i) => `${i + 1}. ${e.label} (${e.blocksChanged.toLocaleString("en-US")} blocks)`));
    },
  );

  registry.register(
    "create_checkpoint",
    "Snapshot the build under a name, so a redesign can be abandoned or compared later.",
    { build: buildRefSchema, name: z.string(), note: z.string().optional() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const checkpoint = session.history.createCheckpoint(args["name"] as string, args["note"] as string | undefined);
      return text(
        `Checkpoint "${checkpoint.name}": ${checkpoint.solidBlocks.toLocaleString("en-US")} blocks, ${(checkpoint.data.byteLength / 1024).toFixed(1)} KB compressed.`,
      );
    },
  );

  registry.register(
    "restore_checkpoint",
    "Return the build to a checkpoint. The restore itself is undoable.",
    { build: buildRefSchema, name: z.string() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const result = session.history.restoreCheckpoint(args["name"] as string);
      return text(`Restored "${args["name"]}" (${result.blocksChanged.toLocaleString("en-US")} cells changed).`);
    },
  );

  registry.register("list_checkpoints", "List a build's checkpoints.", { build: buildRefSchema }, (args) => {
    const session = workspace.require(args["build"] as string | undefined);
    const checkpoints = session.history.listCheckpoints();
    if (checkpoints.length === 0) return text("No checkpoints.");
    return lines(
      checkpoints.map(
        (c) => `${c.name}${c.note ? ` — ${c.note}` : ""}: ${c.solidBlocks.toLocaleString("en-US")} blocks, ${(c.bytes / 1024).toFixed(1)} KB`,
      ),
    );
  });

  registry.register(
    "compare_checkpoints",
    "Compare two checkpoints, or a checkpoint against the current state. The per-block deltas describe a redesign in a way a cell count cannot.",
    { build: buildRefSchema, from: z.string(), to: z.string().optional() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      return json(session.history.compareCheckpoints(args["from"] as string, args["to"] as string | undefined));
    },
  );

  // -- Structure graph ---------------------------------------------------------------------------------

  registry.register(
    "list_structures",
    "The structure tree, with permanent ids. Every id can be passed to `delete_structure` or `regenerate_structure`.",
    { build: buildRefSchema, kind: z.string().optional().describe("Filter to one kind, e.g. `team_island`.") },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      if (args["kind"]) {
        const nodes = session.graph.ofKind(args["kind"] as string);
        if (nodes.length === 0) return text(`No structures of kind "${args["kind"]}".`);
        return lines(nodes.map((n) => `${n.id}  ${n.kind}${n.label ? ` "${n.label}"` : ""}  ${n.blocksPlaced} blocks`));
      }
      const outline = session.graph.toOutline();
      return outline.length ? lines(outline) : text("No structures have been recorded for this build.");
    },
  );

  registry.register(
    "describe_structure",
    "The parameters, bounds and seed a structure was built from.",
    { build: buildRefSchema, structure: z.string() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const node = session.graph.get(args["structure"] as string);
      return json({
        id: node.id,
        kind: node.kind,
        label: node.label,
        parent: node.parent,
        children: node.children,
        bounds: node.bounds,
        blocksPlaced: node.blocksPlaced,
        seed: node.seed,
        params: node.params,
      });
    },
  );

  registry.register(
    "delete_structure",
    "Remove a structure and everything under it, restoring exactly what was there before it was built.",
    { build: buildRefSchema, structure: z.string() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const reverted = session.history.run(`delete ${args["structure"]}`, () =>
        session.graph.delete(args["structure"] as string),
      );
      return text(`Deleted ${args["structure"]}: ${reverted.toLocaleString("en-US")} blocks restored.`);
    },
  );

  // -- Validation ----------------------------------------------------------------------------------------

  registry.register(
    "inspect_build",
    "Structural inspection: floating masses, isolated blocks, sealed pockets, single-cell surface holes, suffocation risks, blocks that do not exist in 1.8, and symmetry. These are the mistakes a pretty render does not show.",
    {
      build: buildRefSchema,
      expectSymmetry: z.enum(["x", "z"]).optional(),
      symmetryThreshold: z.number().min(0).max(1).optional(),
      blockBudget: z.number().int().optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const report = inspectRegion(session.volume, {
        expectSymmetry: args["expectSymmetry"] as "x" | "z" | undefined,
        symmetryThreshold: args["symmetryThreshold"] as number | undefined,
        blockBudget: args["blockBudget"] as number | undefined,
      });
      return lines([...formatInspection(report), "", report.ok ? "No blocking errors." : "There are blocking errors."]);
    },
  );

  registry.register(
    "check_constraints",
    "Check the build against gameplay constraints: height limits, no-build zones, spawn and generator clearances, rush distances between nearest bases, required symmetry and a block budget.",
    {
      build: buildRefSchema,
      maxHeight: z.number().int().optional(),
      minRushDistance: z.number().int().optional(),
      maxRushDistance: z.number().int().optional(),
      spawnClearance: z.number().int().min(0).max(16).optional(),
      generatorClearance: z.number().int().min(0).max(16).optional(),
      maxBlocks: z.number().int().optional(),
      noBuildZones: z.array(z.object({ label: z.string(), region: regionSchema })).optional(),
      symmetry: z
        .object({ kind: z.enum(["mirror-x", "mirror-z", "radial"]), folds: z.number().int().optional(), minScore: z.number() })
        .optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const violations = checkConstraints(
        session.volume,
        {
          maxHeight: args["maxHeight"] as number | undefined,
          minRushDistance: args["minRushDistance"] as number | undefined,
          maxRushDistance: args["maxRushDistance"] as number | undefined,
          spawnClearance: args["spawnClearance"] as number | undefined,
          generatorClearance: args["generatorClearance"] as number | undefined,
          maxBlocks: args["maxBlocks"] as number | undefined,
          noBuildZones: (args["noBuildZones"] as { label: string; region: unknown }[] | undefined)?.map((z2) => ({
            label: z2.label,
            region: toRegion(z2.region),
          })),
          symmetry: args["symmetry"] as never,
        },
        gameplayContextFor(session),
      );
      if (violations.length === 0) return text("All declared constraints are satisfied.");
      return lines(violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}`));
    },
  );

  registry.register(
    "analyze_bedwars_map",
    "The competitive report: rush distances, base-to-diamond and diamond-to-mid distances, height advantage, void exposure, symmetry, camping spots, unintended jump gaps, and per-route bridging cost in blocks and seconds.",
    { build: buildRefSchema, walkPaths: z.boolean().optional().describe("Also run the slower walkable-path search.") },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      if (session.points.length === 0) {
        throw new Error(
          "This build has no gameplay points. `analyze_bedwars_map` works on builds produced by `build_bedwars_map`.",
        );
      }
      const teams = session.points.filter((p) => p.role === "team").length;
      const analysis = analyzeBedwarsMap(session.volume, {
        points: session.points,
        teams,
        walkPaths: (args["walkPaths"] as boolean | undefined) ?? false,
        symmetryScore: session.layout
          ? measureRadialSymmetry(session.volume, session.layout.center, teams, "occupancy")
          : 0,
      });
      return lines(formatAnalysis(analysis));
    },
  );

  registry.register(
    "measure_route",
    "Measure one route: straight-line distance, the walkable path if there is one, and what it costs to bridge (straight, diagonal, staircase, and an estimate in seconds).",
    { build: buildRefSchema, from: vec3Schema, to: vec3Schema, walkPath: z.boolean().optional() },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const from = toVec(args["from"]);
      const to = toVec(args["to"]);
      const bridge = estimateBridge(from, to);
      const walk = (args["walkPath"] as boolean | undefined)
        ? findWalkPath(session.volume, from, to, { maxNodes: 200_000 })
        : undefined;
      return json({
        from,
        to,
        bridge,
        walk: walk ? { reachable: walk.reachable, steps: walk.steps, detourRatio: walk.detourRatio } : "not requested",
      });
    },
  );

  // -- Preview and export -----------------------------------------------------------------------------------

  registry.register(
    "preview_build",
    "Render the build and return the images. Look at these before writing anything to disk or to a server. `gameplay` is the annotated plan view with spawns, generators and rush distances — for a competitive map it is the one that matters.",
    {
      build: buildRefSchema,
      views: z.array(viewSchema).optional().describe(`Default: perspective and gameplay. All: ${ALL_VIEWS.join(", ")}.`),
      width: z.number().int().min(160).max(2048).optional(),
      height: z.number().int().min(160).max(2048).optional(),
      supersample: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const views = ((args["views"] as ViewName[] | undefined) ?? ["perspective", "gameplay"]).filter(
        // The gameplay view is only meaningful when there is gameplay to annotate.
        (v) => v !== "gameplay" || session.points.length > 0,
      );
      if (views.length === 0) views.push("perspective");

      const rendered = renderViews(session.volume, {
        views,
        width: args["width"] as number | undefined,
        height: args["height"] as number | undefined,
        supersample: (args["supersample"] as 1 | 2 | 3 | undefined) ?? 2,
        annotation: annotationFor(session),
      });

      return withImages(
        [
          `${session.summary()}`,
          `Views: ${rendered.map((r) => `${r.name} (${r.width}x${r.height})`).join(", ")}`,
        ].join("\n"),
        rendered.map((r) => ({ name: r.name, png: r.png })),
      );
    },
  );

  registry.register(
    "save_build",
    "Write the build folder: the 1.8 .schematic, a manifest carrying the seed and full spec, the structure graph, the palette, the analysis and the preview images. The manifest is what makes the build reproducible.",
    {
      build: buildRefSchema,
      name: z.string().optional().describe("Folder name. Defaults to the build's name."),
      dir: z.string().optional().describe("Parent directory. Defaults to the server's builds directory."),
      views: z.array(viewSchema).optional(),
    },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const folder = buildSlug((args["name"] as string | undefined) ?? session.name);
      const parent = args["dir"] ? resolvePath(args["dir"] as string) : workspace.buildsDir;
      const analysis =
        session.points.length > 0
          ? analyzeBedwarsMap(session.volume, {
              points: session.points,
              teams: session.points.filter((p) => p.role === "team").length,
              symmetryScore: session.layout
                ? measureRadialSymmetry(
                    session.volume,
                    session.layout.center,
                    session.points.filter((p) => p.role === "team").length,
                    "occupancy",
                  )
                : 0,
            })
          : undefined;

      const written = writeBuildOutput({
        dir: join(parent, folder),
        name: session.name,
        volume: session.volume,
        seed: session.seed,
        palette: session.palette,
        graph: session.graph,
        theme: session.theme,
        style: session.styleId,
        spec: session.spec,
        analysis,
        inspection: inspectRegion(session.volume),
        violations: checkConstraints(session.volume, {}, gameplayContextFor(session)),
        views: (args["views"] as ViewName[] | undefined) ?? [...ALL_VIEWS].filter((v) => v !== "gameplay" || session.points.length > 0),
        annotation: annotationFor(session),
      });

      return lines([
        `Wrote ${written.files.length} files to ${written.dir}`,
        ...written.files.map((f) => `  ${f}`),
        "",
        "To load it on a 1.8 server: put build.schematic in the WorldEdit schematics folder, then `//schem load build` and `//paste -a`.",
      ]);
    },
  );

  registry.register(
    "export_schematic",
    "Write just the .schematic file, for when the full build folder is not wanted.",
    { build: buildRefSchema, file: z.string().describe("Destination path, ending in .schematic.") },
    (args) => {
      const session = workspace.require(args["build"] as string | undefined);
      const target = resolvePath(args["file"] as string);
      const data = writeSchematic(session.volume);
      writeFileSync(target, data);
      return text(
        `Wrote ${(data.byteLength / 1024).toFixed(1)} KB to ${target} (${session.volume.width}x${session.volume.height}x${session.volume.length}, legacy MCEdit format for Minecraft 1.8).`,
      );
    },
  );

  registry.register(
    "load_schematic",
    "Open a .schematic as a new build, so it can be edited, analysed, previewed and re-exported.",
    { file: z.string(), name: z.string().optional() },
    (args) => {
      const file = resolvePath(args["file"] as string);
      if (!existsSync(file)) throw new Error(`No file at ${file}`);
      const read = readSchematic(readFileSync(file));
      const session = new BuildSession({
        name: (args["name"] as string | undefined) ?? basename(file).replace(/\.[^.]+$/, ""),
        width: read.volume.width,
        height: read.volume.height,
        length: read.volume.length,
        volume: read.volume,
      });
      workspace.add(session);
      return lines([
        `Loaded ${basename(file)} (${read.sourceFormat}) as ${session.summary()}`,
        ...(read.substitutions.length
          ? [
              "",
              "Post-1.8 blocks were approximated on the way in:",
              ...read.substitutions.map((s) => `  ${s.from} -> ${s.to} (${s.count} cells)`),
            ]
          : []),
      ]);
    },
  );

  registry.register(
    "analyze_schematic",
    "Measure a .schematic without adding it to the style library. Use it to understand a reference before deciding whether to ingest it.",
    { file: z.string() },
    (args) => {
      const file = resolvePath(args["file"] as string);
      if (!existsSync(file)) throw new Error(`No file at ${file}`);
      const read = readSchematic(readFileSync(file));
      const profile = analyzeStyle(read.volume, { id: "adhoc", name: basename(file) });
      return lines([
        `${basename(file)}: ${read.volume.width}x${read.volume.height}x${read.volume.length}, ${profile.source.solidBlocks.toLocaleString("en-US")} blocks`,
        ...profile.summary.map((s) => `  - ${s}`),
      ]);
    },
  );
}

function resolvePath(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

function blockLabel(packed: number): string {
  return blockName(packed);
}

function gameplayContextFor(session: BuildSession): Parameters<typeof checkConstraints>[2] {
  if (!session.layout) return {};
  return {
    spawns: session.layout.teamIslands.map((t) => ({ label: t.label, pos: t.spawn })),
    generators: [
      ...session.layout.teamIslands.map((t) => ({ label: `${t.label} iron`, pos: t.generator })),
      ...session.layout.diamondIslands.map((d) => ({ label: `diamond ${d.index}`, pos: d.generator })),
    ],
    center: session.layout.center,
  };
}

/** Build the gameplay overlay from a session's analysis points. */
function annotationFor(session: BuildSession): Annotation | undefined {
  if (session.points.length === 0) return undefined;
  const markers: WorldMarker[] = [];
  const routes: WorldRoute[] = [];

  for (const point of session.points) {
    if (point.role === "team") {
      const color =
        session.layout?.teamIslands[point.team ?? 0]?.color ?? ("red" as TeamColor);
      markers.push({
        pos: point.pos,
        color: TEAM_MARKER_COLORS[color] ?? GAMEPLAY_COLORS.spawn,
        label: point.label,
        shape: "circle",
      });
    } else if (point.role === "diamond") {
      markers.push({ pos: point.pos, color: GAMEPLAY_COLORS.diamondGenerator, shape: "diamond", radius: 5 });
    } else if (point.role === "emerald") {
      markers.push({ pos: point.pos, color: GAMEPLAY_COLORS.emeraldGenerator, shape: "diamond", radius: 5 });
    } else if (point.role === "mid") {
      markers.push({ pos: point.pos, color: GAMEPLAY_COLORS.mid, shape: "ring", radius: 7, label: "MID" });
    }
  }

  const teams = session.points.filter((p) => p.role === "team");
  for (let i = 0; i < teams.length; i++) {
    const a = teams[i]!;
    const b = teams[(i + 1) % teams.length]!;
    if (a === b) continue;
    const distance = Math.round(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
    routes.push({ from: a.pos, to: b.pos, color: GAMEPLAY_COLORS.rushRoute, label: `${distance}`, dashed: true });
  }

  return {
    markers,
    routes,
    legend: [
      { color: GAMEPLAY_COLORS.spawn, label: "Team spawn" },
      { color: GAMEPLAY_COLORS.diamondGenerator, label: "Diamond", shape: "diamond" },
      { color: GAMEPLAY_COLORS.emeraldGenerator, label: "Emerald", shape: "diamond" },
    ],
    caption: [
      `${teams.length} teams`,
      ...(session.layout ? [`rush ${session.layout.rushDistance}`] : []),
      `seed ${session.seed}`,
    ].map((s) => s.toUpperCase()),
  };
}
