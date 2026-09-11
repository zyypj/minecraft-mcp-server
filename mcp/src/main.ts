#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { MessageStore } from './message-store.js';
import { registerBuildEngine } from './build/bootstrap.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

/**
 * Report a missing optional dependency in terms of what the operator can do about it.
 *
 * `mineflayer` and `minecraft-data` are optional dependencies, so an image built for the build
 * engine can leave them out. Selecting a backend that needs them then has to fail with an
 * instruction rather than a module-resolution stack trace.
 */
function missingBackendDependency(backend: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find (module|package)/i.test(message)) {
    return new Error(
      `The "${backend}" backend needs dependencies that are not installed in this environment ` +
        `(${message}). They are optional, so a build-engine-only install or Docker image omits them. ` +
        `Run "npm install" without --omit=optional, or use --backend=engine, which needs no Minecraft server at all.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function main() {
  const config = parseConfig();

  let server: McpServer;

  if (config.backend === 'engine') {
    // The build engine needs no connection to anything: it edits an in-memory volume and writes
    // schematics and preview images. That is the whole point — a map is judged before it is loaded.
    server = new McpServer({
      name: "minecraft-build-mcp",
      version: "3.0.0"
    });

    const registered = registerBuildEngine(server, config);
    log(
      'info',
      `Build engine ready: ${registered.length} tools | schematics <- ${config.schematicsDir} | builds -> ${config.buildsDir} | styles -> ${config.stylesDir}`,
    );

    process.stdin.on('end', () => {
      log('info', 'MCP Client has disconnected. Shutting down...');
      process.exit(0);
    });
  } else if (config.backend === 'plugin') {
    // Plugin backend (M1/M2): construct the WS JSON-RPC client seam. No bot-
    // specific tools are registered; plugin-backed tools arrive in M2.
    let PluginConnection;
    try {
      ({ PluginConnection } = await import('./plugin-connection.js'));
    } catch (error) {
      throw missingBackendDependency('plugin', error);
    }

    const connection = new PluginConnection(
      { url: config.pluginUrl, token: config.token },
      { onLog: log }
    );

    server = new McpServer({
      name: "minecraft-mcp-server",
      version: "2.0.4"
    });

    // The generalized ToolFactory accepts any Connection; wiring it to the
    // PluginConnection here is where M2 will register region/block/build/render/
    // schematic tools. None are registered yet.
    const { ToolFactory } = await import('./tool-factory.js');
    new ToolFactory(server, connection);

    log('info', `Plugin backend selected (endpoint: ${config.pluginUrl}). Plugin-backed tools arrive in M2; none are registered yet.`);
  } else {
    // Bot backend: the original Mineflayer path, unchanged. Imported dynamically so its heavy
    // dependencies are only required when it is actually the selected backend.
    let registerBotBackend;
    try {
      ({ registerBotBackend } = await import('./bot/bootstrap.js'));
    } catch (error) {
      throw missingBackendDependency('bot', error);
    }
    server = registerBotBackend(config, new MessageStore());
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
