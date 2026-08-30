/**
 * The on-disk Style Library.
 *
 * ```
 * styles/
 *   carousel/
 *     profile.json        <- everything measured from the references
 *     palette.json        <- the derived palette, editable by hand
 *     references.json     <- what was ingested, with dimensions and substitutions
 *     components/
 *       index.json
 *       component_0.schematic
 * ```
 *
 * Plain JSON and plain schematics, on purpose. A builder can open `palette.json`, disagree with the
 * role the analyzer picked for a block, change it, and every map generated afterwards uses their
 * choice. That is the practical difference between a knowledge base and a black box.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Volume } from "../core/volume.js";
import { Palette, type PaletteJson } from "../mc18/palette.js";
import { readSchematic, writeSchematic } from "../schematic/schematic.js";
import { analyzeStyle } from "./analyze.js";
import { type ExtractOptions, type ExtractedComponent, extractComponents } from "./components.js";
import type { StyleProfile } from "./profile.js";

export interface ComponentIndexEntry {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly size: { readonly width: number; readonly height: number; readonly length: number };
  readonly blockCount: number;
  readonly symmetry: number;
  readonly terrainShare: number;
  readonly dominantBlocks: readonly string[];
  /** Which reference this component came from. */
  readonly source: string;
}

export interface IngestResult {
  readonly profile: StyleProfile;
  readonly components: readonly ComponentIndexEntry[];
  readonly warnings: readonly string[];
}

export interface IngestOptions {
  readonly styleId: string;
  readonly name?: string;
  /** Pull reusable components out of the reference as well as profiling it. */
  readonly extractComponents?: boolean;
  readonly componentOptions?: ExtractOptions;
  /** Merge into an existing profile of the same id rather than replacing it. */
  readonly merge?: boolean;
  readonly analyze?: { clusterCell?: number; motifSize?: number; topN?: number };
}

export class StyleLibrary {
  constructor(readonly root: string) {}

  private styleDir(id: string): string {
    return join(this.root, sanitizeId(id));
  }

  /** Style ids currently on disk. */
  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, "profile.json")))
      .map((e) => e.name)
      .sort();
  }

  has(id: string): boolean {
    return existsSync(join(this.styleDir(id), "profile.json"));
  }

  load(id: string): StyleProfile {
    const file = join(this.styleDir(id), "profile.json");
    if (!existsSync(file)) {
      const available = this.list();
      throw new Error(
        `Style "${id}" is not in the library at ${this.root}.` +
          (available.length ? ` Available: ${available.join(", ")}.` : " The library is empty."),
      );
    }
    return JSON.parse(readFileSync(file, "utf8")) as StyleProfile;
  }

  /** The palette for a style, preferring a hand-edited `palette.json` over the derived one. */
  loadPalette(id: string): Palette {
    const overrideFile = join(this.styleDir(id), "palette.json");
    const json: PaletteJson = existsSync(overrideFile)
      ? (JSON.parse(readFileSync(overrideFile, "utf8")) as PaletteJson)
      : this.load(id).palette;
    return Palette.fromJson(json);
  }

  save(profile: StyleProfile): void {
    const dir = this.styleDir(profile.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
    const paletteFile = join(dir, "palette.json");
    // Never clobber a hand-edited palette on re-ingest.
    if (!existsSync(paletteFile)) {
      writeFileSync(paletteFile, `${JSON.stringify(profile.palette, null, 2)}\n`);
    }
    writeFileSync(
      join(dir, "references.json"),
      `${JSON.stringify({ source: profile.source, summary: profile.summary }, null, 2)}\n`,
    );
  }

  remove(id: string): void {
    const dir = this.styleDir(id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  components(id: string): ComponentIndexEntry[] {
    const file = join(this.styleDir(id), "components", "index.json");
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8")) as ComponentIndexEntry[];
  }

  loadComponent(id: string, componentId: string): Volume {
    const entry = this.components(id).find((c) => c.id === componentId);
    if (!entry) {
      throw new Error(`Style "${id}" has no component "${componentId}"`);
    }
    const file = join(this.styleDir(id), "components", entry.file);
    return readSchematic(readFileSync(file)).volume;
  }

  /**
   * Read a `.schematic`, profile it, and write the result into the library.
   *
   * Ingestion is forgiving about the input format — Sponge files are accepted and mapped back onto
   * 1.8 — but every approximation it had to make is recorded in the profile and returned as a
   * warning, so a reference that leaned on post-1.8 blocks does not quietly become a style whose
   * colours are wrong.
   */
  ingestFile(filePath: string, opts: IngestOptions): IngestResult {
    const read = readSchematic(readFileSync(filePath));
    return this.ingestVolume(read.volume, {
      ...opts,
      sourceFile: filePath,
      substitutions: read.substitutions,
    });
  }

  /** Ingest an already-loaded volume. */
  ingestVolume(
    vol: Volume,
    opts: IngestOptions & {
      sourceFile?: string;
      substitutions?: readonly { from: string; to: string; count: number }[];
    },
  ): IngestResult {
    const warnings: string[] = [];
    for (const sub of opts.substitutions ?? []) {
      warnings.push(
        `"${sub.from}" does not exist in 1.8 and was read as "${sub.to}" (${sub.count} cells). ` +
          "The profile's colours for that material are an approximation.",
      );
    }

    const fresh = analyzeStyle(vol, {
      id: opts.styleId,
      name: opts.name ?? opts.styleId,
      sourceFiles: opts.sourceFile ? [opts.sourceFile] : [],
      substitutions: opts.substitutions ?? [],
      ...opts.analyze,
    });

    const profile =
      opts.merge && this.has(opts.styleId) ? mergeProfiles(this.load(opts.styleId), fresh) : fresh;
    this.save(profile);

    let components: ComponentIndexEntry[] = [];
    if (opts.extractComponents ?? true) {
      components = this.writeComponents(
        opts.styleId,
        extractComponents(vol, opts.componentOptions),
        opts.sourceFile ? basename(opts.sourceFile) : "inline",
        opts.merge ?? false,
      );
    }

    return { profile, components, warnings };
  }

  private writeComponents(
    styleId: string,
    extracted: readonly ExtractedComponent[],
    source: string,
    append: boolean,
  ): ComponentIndexEntry[] {
    const dir = join(this.styleDir(styleId), "components");
    mkdirSync(dir, { recursive: true });
    const existing = append ? this.components(styleId) : [];
    const entries: ComponentIndexEntry[] = [...existing];
    const prefix = `${sanitizeId(source.replace(/\.[^.]+$/, ""))}_`;

    for (const component of extracted) {
      const id = `${prefix}${component.kind}_${entries.length}`;
      const file = `${id}.schematic`;
      writeFileSync(join(dir, file), writeSchematic(component.volume));
      entries.push({
        id,
        kind: component.kind,
        file,
        size: component.size,
        blockCount: component.blockCount,
        symmetry: component.symmetry,
        terrainShare: component.terrainShare,
        dominantBlocks: component.dominantBlocks,
        source,
      });
    }

    writeFileSync(join(dir, "index.json"), `${JSON.stringify(entries, null, 2)}\n`);
    return entries;
  }
}

function sanitizeId(id: string): string {
  const clean = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (clean === "") throw new Error(`"${id}" is not a usable style id`);
  return clean;
}

/**
 * Merge a newly analyzed reference into an existing profile.
 *
 * Numeric traits are averaged weighted by block count, which is the right thing when a style is
 * defined by several maps of different sizes: a 2M-block map should shape the profile more than a
 * 200k-block one. Palettes union their roles, keeping the heaviest entries. Motifs concatenate.
 */
export function mergeProfiles(existing: StyleProfile, incoming: StyleProfile): StyleProfile {
  const wA = Math.max(1, existing.source.solidBlocks);
  const wB = Math.max(1, incoming.source.solidBlocks);
  const total = wA + wB;
  const mix = (a: number, b: number): number => Math.round(((a * wA + b * wB) / total) * 10000) / 10000;

  const roles: Record<string, { block: string; weight: number }[]> = {};
  const addRoles = (json: PaletteJson, scale: number): void => {
    for (const [role, entries] of Object.entries(json.roles)) {
      if (!entries) continue;
      const bucket = (roles[role] ??= []);
      for (const e of entries) {
        const name = typeof e === "string" ? e : e.block;
        const weight = (typeof e === "string" ? 1 : e.weight) * scale;
        const found = bucket.find((b) => b.block === name);
        if (found) found.weight = Math.round((found.weight + weight) * 100) / 100;
        else bucket.push({ block: name, weight: Math.round(weight * 100) / 100 });
      }
    }
  };
  addRoles(existing.palette, wA / total);
  addRoles(incoming.palette, wB / total);
  for (const bucket of Object.values(roles)) {
    bucket.sort((a, b) => b.weight - a.weight);
    bucket.splice(6); // Beyond six entries a role stops being a palette and becomes a histogram.
  }

  const ramps = { ...(existing.palette.ramps ?? {}) };
  Object.entries(incoming.palette.ramps ?? {}).forEach(([name, blocks], i) => {
    ramps[ramps[name] ? `${name}_${i + existing.ramps.length + 1}` : name] = blocks;
  });

  const observations = mergeObservations(existing, incoming, wA / total, wB / total);

  return {
    ...existing,
    name: existing.name,
    source: {
      files: [...existing.source.files, ...incoming.source.files],
      dimensions: incoming.source.dimensions,
      solidBlocks: total,
      substitutions: [...existing.source.substitutions, ...incoming.source.substitutions],
    },
    palette: { id: existing.palette.id, roles: roles as PaletteJson["roles"], ramps },
    observations,
    colors: wB > wA ? incoming.colors : existing.colors,
    ramps: [...existing.ramps, ...incoming.ramps].slice(0, 6),
    symmetry: {
      mirrorX: mix(existing.symmetry.mirrorX, incoming.symmetry.mirrorX),
      mirrorZ: mix(existing.symmetry.mirrorZ, incoming.symmetry.mirrorZ),
      radial: Object.fromEntries(
        Object.keys(incoming.symmetry.radial).map((k) => [
          k,
          mix(existing.symmetry.radial[k] ?? 0, incoming.symmetry.radial[k] ?? 0),
        ]),
      ),
      dominant: wB > wA ? incoming.symmetry.dominant : existing.symmetry.dominant,
      dominantScore: mix(existing.symmetry.dominantScore, incoming.symmetry.dominantScore),
    },
    // Composition is a property of one map's layout, so the larger reference wins outright rather
    // than being averaged into something neither map has.
    composition: wB > wA ? incoming.composition : existing.composition,
    terrain: {
      voidRatio: mix(existing.terrain.voidRatio, incoming.terrain.voidRatio),
      edgeRoughness: mix(existing.terrain.edgeRoughness, incoming.terrain.edgeRoughness),
      meanThickness: mix(existing.terrain.meanThickness, incoming.terrain.meanThickness),
      surfaceRelief: mix(existing.terrain.surfaceRelief, incoming.terrain.surfaceRelief),
      heightLevels: Math.round(mix(existing.terrain.heightLevels, incoming.terrain.heightLevels)),
    },
    density: {
      fillRatio: mix(existing.density.fillRatio, incoming.density.fillRatio),
      surfaceRatio: mix(existing.density.surfaceRatio, incoming.density.surfaceRatio),
      decorationDensity: mix(existing.density.decorationDensity, incoming.density.decorationDensity),
      detailBlockRatio: mix(existing.density.detailBlockRatio, incoming.density.detailBlockRatio),
      glassRatio: mix(existing.density.glassRatio, incoming.density.glassRatio),
    },
    motifs: [...existing.motifs, ...incoming.motifs]
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 16),
    summary: [
      `Merged from ${existing.source.files.length + incoming.source.files.length} references.`,
      ...incoming.summary,
    ],
  };
}

function mergeObservations(
  a: StyleProfile,
  b: StyleProfile,
  wA: number,
  wB: number,
): StyleProfile["observations"] {
  const merged = new Map<string, { count: number; share: number; exposure: number; surfaceShare: number; color: string }>();
  const add = (profile: StyleProfile, weight: number): void => {
    for (const o of profile.observations) {
      const found = merged.get(o.block);
      if (found) {
        found.count += o.count;
        found.share += o.share * weight;
        found.exposure = (found.exposure + o.exposure) / 2;
        found.surfaceShare += o.surfaceShare * weight;
      } else {
        merged.set(o.block, {
          count: o.count,
          share: o.share * weight,
          exposure: o.exposure,
          surfaceShare: o.surfaceShare * weight,
          color: o.color,
        });
      }
    }
  };
  add(a, wA);
  add(b, wB);
  return [...merged.entries()]
    .map(([block, v]) => ({
      block,
      count: v.count,
      share: Math.round(v.share * 100000) / 100000,
      exposure: Math.round(v.exposure * 10000) / 10000,
      surfaceShare: Math.round(v.surfaceShare * 100000) / 100000,
      color: v.color,
    }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 24);
}
