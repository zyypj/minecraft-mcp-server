/**
 * Wiring for the legacy Mineflayer player-bot backend.
 *
 * Pulled out of `main.ts` into its own module for one practical reason: it is the only part of the
 * server that needs `mineflayer` and `minecraft-data`, and those are a quarter of a gigabyte. Kept
 * behind a dynamic import, the build-engine backend can run from an image that never installed
 * them, while `--backend=bot` still behaves exactly as it always has.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BotConnection } from "../bot-connection.js";
import type { ServerConfig } from "../config.js";
import { log } from "../logger.js";
import { MessageStore } from "../message-store.js";
import { ToolFactory } from "../tool-factory.js";
import { registerBlockTools } from "../tools/block-tools.js";
import { registerChatTools } from "../tools/chat-tools.js";
import { registerCraftingTools } from "../tools/crafting-tools.js";
import { registerEntityTools } from "../tools/entity-tools.js";
import { registerFlightTools } from "../tools/flight-tools.js";
import { registerFurnaceTools } from "../tools/furnace-tools.js";
import { registerGameStateTools } from "../tools/gamestate-tools.js";
import { registerInventoryTools } from "../tools/inventory-tools.js";
import { registerPositionTools } from "../tools/position-tools.js";

export function registerBotBackend(config: ServerConfig, messageStore: MessageStore): McpServer {
  const connection = new BotConnection(config, {
    onLog: log,
    onChatMessage: (username, message) => messageStore.addMessage(username, message),
  });

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4",
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

  process.stdin.on("end", () => {
    connection.cleanup();
    log("info", "MCP Client has disconnected. Shutting down...");
    process.exit(0);
  });

  return server;
}
