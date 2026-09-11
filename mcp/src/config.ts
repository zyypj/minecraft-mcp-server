import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  /**
   * Which backend to run.
   *
   * `engine` is the default and needs no Minecraft server at all: it edits an in-memory volume and
   * writes `.schematic` files and preview images. `bot` is the legacy Mineflayer player-bot path,
   * kept selectable; `plugin` is the JSON-RPC client seam for the Java plugin.
   */
  backend: 'engine' | 'bot' | 'plugin';
  /** Where `save_build` writes build folders. */
  buildsDir: string;
  /** Where the style knowledge base lives. */
  stylesDir: string;
  /**
   * Where reference `.schematic` files are read from.
   *
   * Tools that take a file path resolve a relative path against this directory as well as the
   * working directory, so a Docker user can drop `snoopy.schematic` into a mounted folder and refer
   * to it by name alone.
   */
  schematicsDir: string;
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
      choices: ['engine', 'bot', 'plugin'] as const,
      description:
        'Backend: the offline build engine (default, no Minecraft server needed), the Mineflayer player bot, or the Java plugin RPC client',
      default: 'engine'
    })
    .option('builds-dir', {
      type: 'string',
      description: 'Directory that save_build writes build folders into',
      default: 'builds'
    })
    .option('styles-dir', {
      type: 'string',
      description: 'Directory holding the style knowledge base built from reference schematics',
      default: 'styles'
    })
    .option('schematics-dir', {
      type: 'string',
      description: 'Directory to look in for reference .schematic files named by a relative path',
      default: 'schematics'
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
    backend: argv.backend as ServerConfig['backend'],
    pluginUrl: argv['plugin-url'],
    token: argv.token,
    buildsDir: argv['builds-dir'],
    stylesDir: argv['styles-dir'],
    schematicsDir: argv['schematics-dir']
  };
}
