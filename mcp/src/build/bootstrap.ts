/**
 * Wiring for the build-engine backend.
 *
 * One function that stands up the workspace and registers every build tool. It exists so `main.ts`
 * stays a router between backends rather than accumulating the details of any one of them.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StyleLibrary } from "@mcbuild/engine";

import type { ServerConfig } from "../config.js";
import { BuildToolRegistry } from "./registry.js";
import { BuildWorkspace } from "./session.js";
import { registerBuildGeometryTools } from "../tools/build-geometry-tools.js";
import { registerBuildStructureTools } from "../tools/build-structure-tools.js";
import { registerBuildProjectTools } from "../tools/build-project-tools.js";

export function registerBuildEngine(server: McpServer, config: ServerConfig): readonly string[] {
  const buildsDir = absolute(config.buildsDir);
  const stylesDir = absolute(config.stylesDir);
  const schematicsDir = absolute(config.schematicsDir);
  // Created up front so the first `save_build` or `ingest_schematic` does not fail on a missing
  // parent, and so the operator can see where output will land before running anything. In a
  // container these are the mount points, so an empty one is a signal that nothing was mounted.
  mkdirSync(buildsDir, { recursive: true });
  mkdirSync(stylesDir, { recursive: true });
  mkdirSync(schematicsDir, { recursive: true });

  const workspace = new BuildWorkspace(buildsDir, new StyleLibrary(stylesDir), schematicsDir);
  const registry = new BuildToolRegistry(server);

  registerBuildProjectTools(registry, workspace);
  registerBuildStructureTools(registry, workspace);
  registerBuildGeometryTools(registry, workspace);

  return registry.registered();
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
