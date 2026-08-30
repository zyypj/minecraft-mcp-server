#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { PluginConnection } from './plugin-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerBuildEngine } from './build/bootstrap.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();

  let server: McpServer;

  if (config.backend === 'engine') {
    // The build engine needs no connection to anything: it edits an in-memory volume and writes
    // schematics and preview images. That is the whole point — a map is judged before it is loaded.
    server = new McpServer({
      name: "minecraft-build-mcp",
      version: "3.0.0"
    });

    const registered = registerBuildEngine(server, config);
    log('info', `Build engine ready: ${registered.length} tools, builds -> ${config.buildsDir}, styles -> ${config.stylesDir}`);

    process.stdin.on('end', () => {
      log('info', 'MCP Client has disconnected. Shutting down...');
      process.exit(0);
    });
  } else if (config.backend === 'plugin') {
    // Plugin backend (M1/M2): construct the WS JSON-RPC client seam. No bot-
    // specific tools are registered; plugin-backed tools arrive in M2.
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
    new ToolFactory(server, connection);

    log('info', `Plugin backend selected (endpoint: ${config.pluginUrl}). Plugin-backed tools arrive in M2; none are registered yet.`);
  } else {
    // Bot backend (default): the exact original path — unchanged behavior.
    const connection = new BotConnection(
      config,
      {
        onLog: log,
        onChatMessage: (username, message) => messageStore.addMessage(username, message)
      }
    );

    connection.connect();

    server = new McpServer({
      name: "minecraft-mcp-server",
      version: "2.0.4"
    });

    const factory = new ToolFactory(server, connection);
    const getBot = () => connection.getBot()!;

    registerPositionTools(factory, getBot);
    registerInventoryTools(factory, getBot);
    registerBlockTools(factory, getBot);
    registerEntityTools(factory, getBot);
    registerChatTools(factory, getBot, messageStore);
    registerFlightTools(factory, getBot);
    registerGameStateTools(factory, getBot);
    registerCraftingTools(factory, getBot);
    registerFurnaceTools(factory, getBot);

    process.stdin.on('end', () => {
      connection.cleanup();
      log('info', 'MCP Client has disconnected. Shutting down...');
      process.exit(0);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
