/**
 * Style-pack registry.
 *
 * Loads and validates the shipped style-pack JSON through {@link loadStylePack} so an invalid pack
 * fails loudly at startup, and exposes lookup for the `list-styles` / `get-style-pack` MCP tools and
 * the `generateBuild` orchestrator. JSON is read via `fs` relative to `import.meta.url` (robust
 * across Node versions and under `tsx`), rather than an import attribute.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadStylePack, type StylePack } from "./style-pack.js";

function loadShipped(fileName: string): StylePack {
  const path = fileURLToPath(new URL(`./${fileName}`, import.meta.url));
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return loadStylePack(raw);
}

/** The Tudor launch pack (§5.5), validated at module load. */
export const tudor: StylePack = loadShipped("tudor.json");

/**
 * All shipped, validated style packs by id. The launch set (§5.5) is Medieval/Tudor, Rustic
 * Cottage, Elven/Fantasy, Nordic/Viking, Japanese/Pagoda, Mediterranean, Modern, Desert/Adobe,
 * Gothic/Dark, Steampunk/Industrial, Mesa/Badlands — only Tudor is authored so far.
 */
export const STYLE_PACKS: ReadonlyMap<string, StylePack> = new Map([[tudor.id, tudor]]);

/** Look up a validated style pack by id. */
export function getStylePack(id: string): StylePack | undefined {
  return STYLE_PACKS.get(id);
}

/** Enumerate available style packs (id + displayName) for the `list-styles` tool. */
export function listStyles(): Array<{ id: string; displayName: string }> {
  return [...STYLE_PACKS.values()].map((s) => ({ id: s.id, displayName: s.displayName }));
}

export * from "./style-pack.js";
