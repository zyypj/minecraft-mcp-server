# Minecraft MCP Server

<a href="https://github.com/yuniko-software/minecraft-mcp-server/actions">
  <img alt="CI" src="https://github.com/yuniko-software/minecraft-mcp-server/actions/workflows/build.yml/badge.svg">
</a>
<a href="https://github.com/yuniko-software">
  <img alt="Contribution Welcome" src="https://img.shields.io/badge/Contribution-Welcome-blue">
</a>
<a href="https://github.com/yuniko-software/minecraft-mcp-server/releases/latest">
  <img alt="Latest Release" src="https://img.shields.io/github/v/release/yuniko-software/minecraft-mcp-server?label=Latest%20Release">
</a>

<img width="2063" height="757" alt="image" src="https://github.com/user-attachments/assets/3f0f0438-f079-4226-90bd-87b9e1311d19" />

___

> [!IMPORTANT]
> The **build engine** targets Minecraft **1.8.9** and emits legacy `.schematic` files.
> The **legacy bot backend** targets Minecraft 1.21.11.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## What this is now

Two things live in this repository, and they answer different questions.

**The build engine** (default) generates Minecraft **1.8.9** maps offline. It never connects to a
server: it composes geometry in memory, validates it, renders preview images, and writes a
`.schematic` you load yourself. The point of it is to move the level of abstraction, so an agent
decides

> *a circular tower of radius 12 and height 35*
> *an eight-team BedWars map in the carousel style with a 34-block rush and a giant mascot at mid*

instead of naming thirty thousand block coordinates.

**The legacy player bot** is the original Mineflayer server, still here and still working, now
selected with `--backend=bot`.

## Monorepo layout

| Package | Name | Role |
|---|---|---|
| [`engine/`](engine) | `@mcbuild/engine` | The build engine: 1.8 voxel core, geometry, style knowledge base, generators, validation, renderer. **Zero runtime dependencies.** |
| [`mcp/`](mcp) | `@mcbuild/mcp` | MCP server — 78 build tools, plus the legacy bot and plugin backends |
| [`protocol/`](protocol) | `@mcbuild/protocol` | JSON-RPC contract for the (unfinished) Java plugin backend |
| [`plugin/`](plugin) | (Java) | Paper plugin scaffold for a future in-world backend |

The engine's architecture is documented in [`engine/README.md`](engine/README.md).

## Quick start (build engine)

```json
{
  "mcpServers": {
    "minecraft-build": {
      "command": "npx",
      "args": ["-y", "github:yuniko-software/minecraft-mcp-server", "--backend", "engine"]
    }
  }
}
```

No Minecraft server, no world, no login. `--builds-dir` and `--styles-dir` control where output and
the style library live (they default to `builds/` and `styles/` under the working directory).

### The workflow

```
ingest_schematic          teach the library your reference maps (once, per style)
      |
build_bedwars_map         generate, with gameplay planned before decoration
      |
preview_build             look at it: perspective, top, and an annotated gameplay plan
      |
inspect_build             floating blocks, sealed pockets, suffocation, non-1.8 blocks
analyze_bedwars_map       rush distances, height advantage, symmetry, bridging cost
      |
undo_build / regenerate_structure         fix what is wrong
      |
save_build                schematic + manifest + structure graph + palette + analysis + previews
```

Nothing is written to a server at any point. Loading the result is a deliberate human step:

```
//schem load build
//paste -a
```

### The rule the tools are built around

> Never resolve a complex build through thousands of individual `set_block` calls. Always reach for
> the highest-level operation that fits — domain generator, then structure, then geometry, then
> region op. Single-block writes are for final adjustments only.

`set_block` exists and says exactly that in its own description.

### Editing what you already generated

Every structure a generator builds gets a **permanent id** and keeps the exact inverse patch of what
it wrote, the parameters it was built from, and its seed. So this works:

```
list_structures --kind team_island
  -> structure_8a2ea  team_island "RED"   5,843 blocks
     structure_ad9cb  team_island "BLUE"  5,109 blocks
     ...

regenerate_structure structure_8a2ea --params '{"roofStyle":"dome"}'
```

Only that island is reverted and rebuilt. Everything else in the map stays byte-identical.

### Tool surface

**Project** — `create_build`, `list_builds`, `select_build`, `close_build`, `describe_build`,
`set_build_palette`, `load_schematic`, `export_schematic`, `analyze_schematic`, `save_build`,
`preview_build`

**Style knowledge base** — `ingest_schematic`, `ingest_schematic_folder`, `list_styles`,
`get_style_profile`, `blend_styles`, `list_style_components`, `paste_style_component`

**History** — `undo_build`, `redo_build`, `list_history`, `create_checkpoint`, `restore_checkpoint`,
`list_checkpoints`, `compare_checkpoints`

**Structures** — `list_structures`, `describe_structure`, `delete_structure`, `regenerate_structure`

**Validation** — `inspect_build`, `check_constraints`, `analyze_bedwars_map`, `measure_route`

**Domain** — `build_bedwars_map`, `build_duels_arena`

**Composition** — `build_island`, `flatten_terrain`, `plant_vegetation`, `build_tower`,
`build_building`, `build_roof`, `build_freestanding_wall`, `build_arena`, `build_bridge`,
`build_path`, `build_stairway`, `build_voxel_sculpture`, `build_sculpture_from_silhouette`,
`list_sculpture_archetypes`

**Geometry** — `build_box`, `build_circle`, `build_sphere`, `build_cylinder`, `build_cone`,
`build_pyramid`, `build_torus`, `build_line`, `build_wall`, `build_arch`, `build_helix`,
`build_polygon`, `build_gradient`

**Regions** — `replace_region`, `hollow_region`, `outline_region`, `smooth_region`,
`scatter_decoration`, `copy_region`, `paste_region`, `rotate_structure`, `mirror_structure`,
`mirror_half`, `distribute_radially`, `radial_symmetry`, `fill_region`, `clear_region`, `set_block`,
`get_block`

### Minecraft 1.8 compatibility

The engine targets 1.8.9 in the only way that actually works: it knows the 1.8 block table (ids
0-197) and refuses everything else. Asking for `white_concrete` is an error naming `white_wool` as
the substitute, not a silent grey block. Rotation and mirroring transform the 4-bit data values, so
instanced structures keep their stairs, doors, rails and vines facing correctly. Output is legacy
MCEdit `.schematic`, which is what 1.8-era WorldEdit reads.

The Node runtime version is unaffected — only the *world format* is 1.8.

## Development

```bash
cd engine && npm install && npm test     # 44 tests
cd ../mcp && npm install && npm test     # 131 tests
```

## Legacy (bot backend)


> The sections below describe the original Mineflayer player-bot backend. It still works exactly as it did, and is now selected with `--backend=bot`. It plays the game as a character; the build engine above does not.

## Prerequisites

- Git
- Node.js (>= 20.10.0)
- A running Minecraft game (the setup below was tested with Minecraft 1.21.8 Java Edition included in Microsoft Game Pass)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

**It could take some time for Claude Desktop to boot the MCP server**. The marker that the server has booted successfully:

<img width="885" height="670" alt="image" src="https://github.com/user-attachments/assets/ccbb42f8-6544-462c-8ac1-8af13ddfcddd" />

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get information about a block
- `find-blocks` - Find one or more nearby blocks of a specific type

### Furnace
- `smelt-item` - Smelt items using a furnace-like block

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

## Contributing

Feel free to submit pull requests or open issues for improvements. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).

---

⭐ If you find this project useful, please consider giving it a star on GitHub! ⭐

Your support helps make this project more visible to other people who might benefit from it.
