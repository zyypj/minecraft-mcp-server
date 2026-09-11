/**
 * The build output folder.
 *
 * A generated map is not a schematic; it is a schematic *plus everything needed to judge it, trust
 * it and regenerate it*. So every build writes a self-describing directory:
 *
 * ```
 * builds/carousel_map_01/
 *   build.schematic     the 1.8 MCEdit file, ready for //schem load
 *   manifest.json       name, version, dimensions, block count, theme, seed, full spec
 *   build.json          the structure graph, with permanent ids for later edits
 *   palette.json        the palette it was built in, editable and re-usable
 *   analysis.json       gameplay report, structural inspection, constraint violations
 *   README.md           the same information for a person
 *   preview/
 *     perspective.png front.png side.png top.png gameplay.png
 * ```
 *
 * The manifest carries the seed and the whole spec, which is what makes the pipeline honest: a
 * build can always be reproduced from the folder that describes it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Volume } from "../core/volume.js";
import { blockName } from "../mc18/blocks.js";
import { type Palette } from "../mc18/palette.js";
import { writeSchematic } from "../schematic/schematic.js";
import { type BuildGraph } from "../history/graph.js";
import { type Annotation, type RenderedView, type ViewName, renderViews } from "../render/views.js";
import { type BedwarsAnalysis, formatAnalysis } from "../validate/gameplay.js";
import { type InspectionReport, formatInspection } from "../validate/inspect.js";
import { type Violation } from "../validate/constraints.js";

export interface BuildManifest {
  readonly name: string;
  readonly minecraftVersion: "1.8.9";
  readonly generator: string;
  readonly createdAt: string;
  readonly seed: number;
  readonly theme?: string;
  readonly style?: string;
  readonly dimensions: { readonly width: number; readonly height: number; readonly length: number };
  readonly blocks: number;
  readonly distinctBlocks: number;
  /** The exact input the build was generated from, so it can be reproduced. */
  readonly spec?: unknown;
  /** WorldEdit paste offset written into the schematic. */
  readonly offset?: { readonly x: number; readonly y: number; readonly z: number };
}

export interface WriteBuildOptions {
  /** Directory to create. Existing files with the same names are overwritten. */
  readonly dir: string;
  readonly name: string;
  readonly volume: Volume;
  readonly seed: number;
  readonly palette?: Palette;
  readonly graph?: BuildGraph;
  readonly theme?: string;
  readonly style?: string;
  readonly spec?: unknown;
  readonly analysis?: BedwarsAnalysis;
  readonly inspection?: InspectionReport;
  readonly violations?: readonly Violation[];
  /** Views to render. Pass an empty array to skip rendering entirely. */
  readonly views?: readonly ViewName[];
  readonly annotation?: Annotation;
  readonly viewSize?: { readonly width: number; readonly height: number };
  /** Timestamp for the manifest. Injected so tests can produce byte-stable output. */
  readonly now?: string;
}

export interface WriteBuildResult {
  readonly dir: string;
  readonly manifest: BuildManifest;
  readonly files: readonly string[];
  readonly previews: readonly { readonly name: ViewName; readonly file: string }[];
}

/** Write a complete build folder. */
export function writeBuildOutput(opts: WriteBuildOptions): WriteBuildResult {
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (relative: string, data: string | Buffer): void => {
    writeFileSync(join(dir, relative), data);
    files.push(relative);
  };

  const histogram = opts.volume.histogram();
  const blocks = [...histogram.values()].reduce((a, b) => a + b, 0);

  const manifest: BuildManifest = {
    name: opts.name,
    minecraftVersion: "1.8.9",
    generator: "@mcbuild/engine",
    createdAt: opts.now ?? new Date().toISOString(),
    seed: opts.seed,
    theme: opts.theme,
    style: opts.style,
    dimensions: {
      width: opts.volume.width,
      height: opts.volume.height,
      length: opts.volume.length,
    },
    blocks,
    distinctBlocks: histogram.size,
    spec: opts.spec,
    offset: { x: 0, y: 0, z: 0 },
  };

  write("build.schematic", writeSchematic(opts.volume));
  write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  if (opts.graph) {
    write("build.json", `${JSON.stringify({ structures: opts.graph.toJson() }, null, 2)}\n`);
  }
  if (opts.palette) {
    write("palette.json", `${JSON.stringify(opts.palette.toJson(), null, 2)}\n`);
  }

  const blockUsage = [...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([b, count]) => ({ block: blockName(b), count }));

  write(
    "analysis.json",
    `${JSON.stringify(
      {
        blockUsage,
        gameplay: opts.analysis ?? null,
        inspection: opts.inspection ?? null,
        violations: opts.violations ?? [],
      },
      null,
      2,
    )}\n`,
  );

  const previews: { name: ViewName; file: string }[] = [];
  const views = opts.views ?? (["perspective", "front", "side", "top", "gameplay"] as ViewName[]);
  if (views.length > 0) {
    mkdirSync(join(dir, "preview"), { recursive: true });
    const rendered: RenderedView[] = renderViews(opts.volume, {
      views,
      annotation: opts.annotation,
      width: opts.viewSize?.width,
      height: opts.viewSize?.height,
    });
    for (const view of rendered) {
      const relative = `preview/${view.name}.png`;
      write(relative, view.png);
      previews.push({ name: view.name, file: relative });
    }
  }

  write("README.md", renderReadme(manifest, opts, previews, blockUsage));

  return { dir, manifest, files, previews };
}

function renderReadme(
  manifest: BuildManifest,
  opts: WriteBuildOptions,
  previews: readonly { name: ViewName; file: string }[],
  blockUsage: readonly { block: string; count: number }[],
): string {
  const lines: string[] = [
    `# ${manifest.name}`,
    "",
    `Generated by \`${manifest.generator}\` for **Minecraft ${manifest.minecraftVersion}**.`,
    "",
    "| | |",
    "|---|---|",
    `| Seed | \`${manifest.seed}\` |`,
    `| Dimensions | ${manifest.dimensions.width} x ${manifest.dimensions.height} x ${manifest.dimensions.length} |`,
    `| Blocks | ${manifest.blocks.toLocaleString("en-US")} (${manifest.distinctBlocks} distinct types) |`,
  ];
  if (manifest.theme) lines.push(`| Theme | ${manifest.theme} |`);
  if (manifest.style) lines.push(`| Style | ${manifest.style} |`);
  lines.push("", "## Loading it", "", "```", "//schem load build", "//paste -a", "```", "");
  lines.push(
    "The schematic is legacy MCEdit format with numeric 1.8 block ids, which is what 1.8-era",
    "WorldEdit reads. Every block in it exists in 1.8.",
    "",
  );

  if (previews.length > 0) {
    lines.push("## Preview", "");
    for (const preview of previews) {
      lines.push(`### ${preview.name}`, "", `![${preview.name}](${preview.file})`, "");
    }
  }

  if (opts.analysis) {
    lines.push("## Gameplay analysis", "", "```");
    lines.push(...formatAnalysis(opts.analysis));
    lines.push("```", "");
  }

  if (opts.inspection) {
    lines.push("## Structural inspection", "", "```");
    lines.push(...formatInspection(opts.inspection));
    lines.push("```", "");
  }

  const violations = opts.violations ?? [];
  lines.push("## Constraints", "");
  if (violations.length === 0) {
    lines.push("All declared constraints are satisfied.", "");
  } else {
    for (const v of violations) lines.push(`- **${v.severity}** \`${v.rule}\`: ${v.message}`);
    lines.push("");
  }

  lines.push("## Block usage", "", "| Block | Count |", "|---|---:|");
  for (const entry of blockUsage.slice(0, 20)) {
    lines.push(`| \`${entry.block}\` | ${entry.count.toLocaleString("en-US")} |`);
  }
  lines.push("");

  if (opts.graph) {
    lines.push(
      "## Structure tree",
      "",
      "Each id is permanent: it can be passed to `regenerate_structure` or `delete_structure`.",
      "",
      "```",
      ...opts.graph.toOutline(),
      "```",
      "",
    );
  }

  return lines.join("\n");
}

/** Slugify a name into something safe for a directory. */
export function buildSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "build" : slug;
}
