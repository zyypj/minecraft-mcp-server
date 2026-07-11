/**
 * The backend-agnostic connection surface the {@link ToolFactory} depends on.
 *
 * `ToolFactory` gates every tool call through {@link Connection.checkConnectionAndReconnect}
 * and nothing else — so this interface is deliberately tiny. Backend-specific
 * capabilities live on the concrete classes, not here:
 *   - `BotConnection.getBot()` returns a mineflayer `Bot` (bot backend, today).
 *   - `PluginConnection.call(method, params)` speaks `@mcbuild/protocol` JSON-RPC
 *     to the Java plugin (plugin backend, arriving M1/M2).
 *
 * Making the factory depend on this interface — rather than on `BotConnection` —
 * is the core M0 goal (BUILD_ENGINE_PLAN.md §9, M0 row).
 */
export type ConnectionKind = 'bot' | 'plugin';

export interface Connection {
  /**
   * Report whether the backend is ready to serve a tool call, attempting a
   * reconnect if it is not. Resolves `{ connected: true }` when ready, or
   * `{ connected: false, message }` with a human-readable explanation otherwise.
   */
  checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }>;
}
