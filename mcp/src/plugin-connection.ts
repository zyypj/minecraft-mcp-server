import type { MethodName, MethodParams, MethodResult } from '@mcbuild/protocol';
import type { Connection } from './connection.js';

/**
 * Connection options for the plugin backend (from `--plugin-url` / `--token`).
 */
export interface PluginConnectionOptions {
  /** WebSocket URL of the Java plugin's JSON-RPC endpoint, e.g. `ws://127.0.0.1:25566`. */
  url: string;
  /** Bearer token used to `authenticate` with the plugin. */
  token: string;
}

export interface PluginConnectionCallbacks {
  onLog: (level: string, message: string) => void;
}

/**
 * A WebSocket JSON-RPC client for the Java Paper plugin, speaking the
 * `@mcbuild/protocol` contract (BUILD_ENGINE_PLAN.md §3.3).
 *
 * STUB (M0): this is the backend seam only — there is **no** networking yet.
 * `checkConnectionAndReconnect()` reports the plugin backend as unavailable, and
 * {@link PluginConnection.call} throws. Real transport (open socket, authenticate,
 * frame/await JSON-RPC 2.0, stream `job.progress`) lands in M1/M2.
 */
export class PluginConnection implements Connection {
  private readonly url: string;
  private readonly token: string;
  private readonly callbacks: PluginConnectionCallbacks;

  constructor(options: PluginConnectionOptions, callbacks: PluginConnectionCallbacks) {
    this.url = options.url;
    this.token = options.token;
    this.callbacks = callbacks;
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    // TODO M1/M2: open the WebSocket to `this.url`, `authenticate` with `this.token`,
    // and report real connectivity (reconnecting on drop). No sockets exist yet.
    this.callbacks.onLog(
      'info',
      `Plugin backend requested (${this.url}) but not yet implemented (M1/M2).`,
    );
    return {
      connected: false,
      message:
        `Plugin backend is not yet implemented (arrives in M1/M2). ` +
        `Configured endpoint: ${this.url}. ` +
        `Use --backend=bot (the default) for the working Mineflayer backend.`,
    };
  }

  /**
   * Typed JSON-RPC call into the plugin, keyed by the `@mcbuild/protocol` method
   * registry so params/result types are checked at every call site.
   *
   * TODO M1/M2: frame a `{ jsonrpc: "2.0", id, method, params }` request over the
   * authenticated WebSocket, await the matching response, and validate it with
   * `parseMethodResult(method, ...)` from `@mcbuild/protocol`.
   */
  async call<M extends MethodName>(
    method: M,
    params: MethodParams[M],
  ): Promise<MethodResult[M]> {
    // TODO M1/M2: real socket transport. No networking exists yet.
    void this.token;
    void params;
    throw new Error(
      `PluginConnection.call('${method}') is not implemented yet (M1/M2 stub).`,
    );
  }
}
