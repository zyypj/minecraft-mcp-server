import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  /** Which world-effector backend to use. Defaults to the Mineflayer bot. */
  backend: 'bot' | 'plugin';
  /** WebSocket URL of the Java plugin RPC endpoint (used when backend is 'plugin'). */
  pluginUrl: string;
  /** Bearer token for the plugin RPC endpoint (used when backend is 'plugin'). */
  token: string;
}

export function parseConfig(): ServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('backend', {
      type: 'string',
      choices: ['bot', 'plugin'] as const,
      description: 'World-effector backend: the Mineflayer player bot (default) or the Java plugin RPC client',
      default: 'bot'
    })
    .option('plugin-url', {
      type: 'string',
      description: 'WebSocket URL of the Java plugin RPC endpoint (used with --backend=plugin)',
      default: 'ws://127.0.0.1:25566'
    })
    .option('token', {
      type: 'string',
      description: 'Bearer token for the plugin RPC endpoint (used with --backend=plugin)',
      default: ''
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  return {
    host: argv.host,
    port: argv.port,
    username: argv.username,
    backend: argv.backend,
    pluginUrl: argv['plugin-url'],
    token: argv.token
  };
}
