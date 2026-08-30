/**
 * The Minecraft 1.8 block registry.
 *
 * 1.8 predates flattening: a block is a numeric id (0-255 for vanilla) plus a 4-bit data value, and
 * the *same* id means different things at different data values (`wool:14` is red wool, `stone:1`
 * is granite). Modern block names do not exist here, and roughly a third of the blocks a 2020s
 * builder reaches for — concrete, terracotta glazing, copper, deepslate, mud bricks — were not in
 * the game yet. This registry is the single source of truth for what 1.8 actually had.
 *
 * Every entry carries:
 *  - the canonical 1.8 name (the string the 1.8 `.schematic`/WorldEdit world used),
 *  - a render class, which the preview renderer uses to decide cube vs cross vs pane vs slab,
 *  - an average texture colour, which is what makes a flat-shaded preview readable.
 *
 * Colours are eyeball-calibrated averages of the 1.8 textures. They exist for preview legibility
 * and for palette analysis (clustering a reference schematic's colours), not for photorealism.
 */

import { type PackedBlock, blockData, blockId, pack } from "../core/volume.js";

/** How the renderer should draw a block, and how the geometry validator should treat it. */
export type RenderClass =
  | "air" // nothing
  | "cube" // full opaque cube
  | "translucent" // full cube, see-through (glass, ice)
  | "liquid" // water/lava
  | "slab" // half-height (data bit 3 selects top/bottom)
  | "stairs" // drawn as a full cube in preview; flagged for validation
  | "pane" // thin cross-section panel (glass pane, iron bars)
  | "fence" // post + arms
  | "wall" // cobblestone wall
  | "cross" // plant billboard (flowers, grass, saplings)
  | "carpet" // 1/16 height
  | "thin" // torches, levers, buttons, rails
  | "other"; // functional blocks with irregular shape

export interface LegacyBlock {
  /** Numeric 1.8 id. */
  readonly id: number;
  /** Canonical 1.8 name, without the `minecraft:` namespace. */
  readonly name: string;
  readonly render: RenderClass;
  /** Average texture colour as `0xRRGGBB`. */
  readonly color: number;
  /** Alpha in `[0,1]` used by the preview renderer for translucent blocks. */
  readonly alpha?: number;
  /** Per-data-value overrides. Keyed by the raw data nibble. */
  readonly variants?: Readonly<Record<number, { readonly name: string; readonly color?: number }>>;
  /** Data bits that encode orientation rather than material (masked off when comparing palettes). */
  readonly orientationMask?: number;
}

/** The 16 dye colours, in 1.8 data order. Used by wool, clay, glass, carpet and banners. */
export const DYE_ORDER = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "silver",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

export type DyeColor = (typeof DYE_ORDER)[number];

const WOOL_COLORS = [
  0xdddddd, 0xdb7d3e, 0xb350bc, 0x6b8ac9, 0xb1a627, 0x41ae38, 0xd08499, 0x404040, 0x9aa1a1,
  0x2e6e89, 0x7e3db5, 0x2e388d, 0x4f321f, 0x35461b, 0x963430, 0x191616,
];

const CLAY_COLORS = [
  0xd1b2a1, 0xa15325, 0x95586c, 0x716c89, 0xba8523, 0x677534, 0xa14e4e, 0x392a23, 0x876b62,
  0x565b5b, 0x764656, 0x4a3b5b, 0x4d3323, 0x4c532a, 0x8f3d2e, 0x251610,
];

/** Build a 16-entry variant table from a name prefix/suffix pattern and a colour ramp. */
function dyeVariants(
  toName: (dye: DyeColor) => string,
  colors: readonly number[],
): Record<number, { name: string; color?: number }> {
  const out: Record<number, { name: string; color?: number }> = {};
  DYE_ORDER.forEach((dye, i) => {
    out[i] = { name: toName(dye), color: colors[i] };
  });
  return out;
}

const WOOD_NAMES = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"] as const;
const WOOD_COLORS = [0xa2824e, 0x725430, 0xc4b37b, 0xa07351, 0xa85a32, 0x422b14];

function woodVariants(suffix: string, count = 6): Record<number, { name: string; color?: number }> {
  const out: Record<number, { name: string; color?: number }> = {};
  for (let i = 0; i < count; i++) {
    out[i] = { name: `${WOOD_NAMES[i]}_${suffix}`, color: WOOD_COLORS[i] };
  }
  return out;
}

/**
 * The registry. Ordered by id so the table reads like the 1.8 id list it mirrors; ids absent from
 * this table simply did not exist in 1.8 and are rejected by the material resolver.
 */
const TABLE: readonly LegacyBlock[] = [
  { id: 0, name: "air", render: "air", color: 0x000000, alpha: 0 },
  {
    id: 1,
    name: "stone",
    render: "cube",
    color: 0x7e7e7e,
    variants: {
      0: { name: "stone" },
      1: { name: "granite", color: 0x956752 },
      2: { name: "polished_granite", color: 0x9c6c5b },
      3: { name: "diorite", color: 0xcdcdd0 },
      4: { name: "polished_diorite", color: 0xd2d2d5 },
      5: { name: "andesite", color: 0x88888a },
      6: { name: "polished_andesite", color: 0x8f8f92 },
    },
  },
  { id: 2, name: "grass", render: "cube", color: 0x7cb250 },
  {
    id: 3,
    name: "dirt",
    render: "cube",
    color: 0x866043,
    variants: {
      0: { name: "dirt" },
      1: { name: "coarse_dirt", color: 0x7d5a3d },
      2: { name: "podzol", color: 0x5b401d },
    },
  },
  { id: 4, name: "cobblestone", render: "cube", color: 0x7f7f7f },
  { id: 5, name: "planks", render: "cube", color: 0xa2824e, variants: woodVariants("planks") },
  { id: 6, name: "sapling", render: "cross", color: 0x4f7a2f, orientationMask: 0x8 },
  { id: 7, name: "bedrock", render: "cube", color: 0x555555 },
  { id: 8, name: "flowing_water", render: "liquid", color: 0x3f76e4, alpha: 0.7 },
  { id: 9, name: "water", render: "liquid", color: 0x3f76e4, alpha: 0.7 },
  { id: 10, name: "flowing_lava", render: "liquid", color: 0xcf5c0f, alpha: 1 },
  { id: 11, name: "lava", render: "liquid", color: 0xcf5c0f, alpha: 1 },
  {
    id: 12,
    name: "sand",
    render: "cube",
    color: 0xdbcfa3,
    variants: { 0: { name: "sand" }, 1: { name: "red_sand", color: 0xbe6621 } },
  },
  { id: 13, name: "gravel", render: "cube", color: 0x887e7e },
  { id: 14, name: "gold_ore", render: "cube", color: 0x91856d },
  { id: 15, name: "iron_ore", render: "cube", color: 0x88827f },
  { id: 16, name: "coal_ore", render: "cube", color: 0x696969 },
  {
    id: 17,
    name: "log",
    render: "cube",
    color: 0x6d5532,
    orientationMask: 0xc,
    variants: {
      0: { name: "oak_log", color: 0x6d5532 },
      1: { name: "spruce_log", color: 0x45321c },
      2: { name: "birch_log", color: 0xd7d5ce },
      3: { name: "jungle_log", color: 0x956d46 },
    },
  },
  {
    id: 18,
    name: "leaves",
    render: "translucent",
    color: 0x4a7c30,
    alpha: 0.92,
    orientationMask: 0xc,
    variants: {
      0: { name: "oak_leaves", color: 0x4a7c30 },
      1: { name: "spruce_leaves", color: 0x395c30 },
      2: { name: "birch_leaves", color: 0x66914a },
      3: { name: "jungle_leaves", color: 0x3f8f27 },
    },
  },
  { id: 19, name: "sponge", render: "cube", color: 0xc3c04a },
  { id: 20, name: "glass", render: "translucent", color: 0xc8e1eb, alpha: 0.35 },
  { id: 21, name: "lapis_ore", render: "cube", color: 0x667086 },
  { id: 22, name: "lapis_block", render: "cube", color: 0x1e438c },
  { id: 23, name: "dispenser", render: "cube", color: 0x6f6f6f, orientationMask: 0x7 },
  {
    id: 24,
    name: "sandstone",
    render: "cube",
    color: 0xd8cb9b,
    variants: {
      0: { name: "sandstone" },
      1: { name: "chiseled_sandstone", color: 0xd5c894 },
      2: { name: "smooth_sandstone", color: 0xdacd9e },
    },
  },
  { id: 25, name: "noteblock", render: "cube", color: 0x644332 },
  { id: 26, name: "bed", render: "other", color: 0xa02a24, orientationMask: 0xf },
  { id: 27, name: "golden_rail", render: "thin", color: 0xd6bb56, orientationMask: 0xf },
  { id: 28, name: "detector_rail", render: "thin", color: 0x8f7b58, orientationMask: 0xf },
  { id: 29, name: "sticky_piston", render: "cube", color: 0x9a8b52, orientationMask: 0xf },
  { id: 30, name: "web", render: "cross", color: 0xdcdcdc },
  {
    id: 31,
    name: "tallgrass",
    render: "cross",
    color: 0x6a9a3c,
    variants: {
      0: { name: "dead_shrub" },
      1: { name: "tall_grass" },
      2: { name: "fern" },
    },
  },
  { id: 32, name: "deadbush", render: "cross", color: 0x946428 },
  { id: 33, name: "piston", render: "cube", color: 0x9a8b52, orientationMask: 0xf },
  { id: 34, name: "piston_head", render: "other", color: 0x9a8b52, orientationMask: 0xf },
  {
    id: 35,
    name: "wool",
    render: "cube",
    color: 0xdddddd,
    variants: dyeVariants((d) => `${d}_wool`, WOOL_COLORS),
  },
  { id: 36, name: "piston_extension", render: "other", color: 0x9a8b52 },
  { id: 37, name: "yellow_flower", render: "cross", color: 0xd6d33c },
  { id: 38, name: "red_flower", render: "cross", color: 0xc43c3c },
  { id: 39, name: "brown_mushroom", render: "cross", color: 0x9a7259 },
  { id: 40, name: "red_mushroom", render: "cross", color: 0xd04a42 },
  { id: 41, name: "gold_block", render: "cube", color: 0xf9ec50 },
  { id: 42, name: "iron_block", render: "cube", color: 0xdcdcdc },
  {
    id: 43,
    name: "double_stone_slab",
    render: "cube",
    color: 0xa9a9a9,
    variants: {
      0: { name: "double_stone_slab", color: 0xa9a9a9 },
      1: { name: "double_sandstone_slab", color: 0xd8cb9b },
      2: { name: "double_wood_slab", color: 0xa2824e },
      3: { name: "double_cobblestone_slab", color: 0x7f7f7f },
      4: { name: "double_brick_slab", color: 0x966153 },
      5: { name: "double_stone_brick_slab", color: 0x7a7a7a },
      6: { name: "double_nether_brick_slab", color: 0x2c161a },
      7: { name: "double_quartz_slab", color: 0xece9e2 },
    },
  },
  {
    id: 44,
    name: "stone_slab",
    render: "slab",
    color: 0xa9a9a9,
    orientationMask: 0x8,
    variants: {
      0: { name: "stone_slab", color: 0xa9a9a9 },
      1: { name: "sandstone_slab", color: 0xd8cb9b },
      2: { name: "wood_slab", color: 0xa2824e },
      3: { name: "cobblestone_slab", color: 0x7f7f7f },
      4: { name: "brick_slab", color: 0x966153 },
      5: { name: "stone_brick_slab", color: 0x7a7a7a },
      6: { name: "nether_brick_slab", color: 0x2c161a },
      7: { name: "quartz_slab", color: 0xece9e2 },
    },
  },
  { id: 45, name: "brick_block", render: "cube", color: 0x966153 },
  { id: 46, name: "tnt", render: "cube", color: 0xdb462a },
  { id: 47, name: "bookshelf", render: "cube", color: 0xaa8c5a },
  { id: 48, name: "mossy_cobblestone", render: "cube", color: 0x6e7d64 },
  { id: 49, name: "obsidian", render: "cube", color: 0x15121e },
  { id: 50, name: "torch", render: "thin", color: 0xffd966, orientationMask: 0xf },
  { id: 51, name: "fire", render: "cross", color: 0xe07b12 },
  { id: 52, name: "mob_spawner", render: "translucent", color: 0x25383f, alpha: 0.6 },
  { id: 53, name: "oak_stairs", render: "stairs", color: 0xa2824e, orientationMask: 0xf },
  { id: 54, name: "chest", render: "other", color: 0xa2824e, orientationMask: 0xf },
  { id: 55, name: "redstone_wire", render: "thin", color: 0xa01000, orientationMask: 0xf },
  { id: 56, name: "diamond_ore", render: "cube", color: 0x818c8f },
  { id: 57, name: "diamond_block", render: "cube", color: 0x62dbd6 },
  { id: 58, name: "crafting_table", render: "cube", color: 0x9a6f44 },
  { id: 59, name: "wheat", render: "cross", color: 0xa5a14e, orientationMask: 0xf },
  { id: 60, name: "farmland", render: "cube", color: 0x6b4a2c, orientationMask: 0xf },
  { id: 61, name: "furnace", render: "cube", color: 0x707070, orientationMask: 0x7 },
  { id: 62, name: "lit_furnace", render: "cube", color: 0x7a7068, orientationMask: 0x7 },
  { id: 63, name: "standing_sign", render: "thin", color: 0xa2824e, orientationMask: 0xf },
  { id: 64, name: "wooden_door", render: "other", color: 0xa2824e, orientationMask: 0xf },
  { id: 65, name: "ladder", render: "thin", color: 0x9a7a45, orientationMask: 0x7 },
  { id: 66, name: "rail", render: "thin", color: 0x8f7b58, orientationMask: 0xf },
  { id: 67, name: "stone_stairs", render: "stairs", color: 0x7f7f7f, orientationMask: 0xf },
  { id: 68, name: "wall_sign", render: "thin", color: 0xa2824e, orientationMask: 0x7 },
  { id: 69, name: "lever", render: "thin", color: 0x7a6a55, orientationMask: 0xf },
  { id: 70, name: "stone_pressure_plate", render: "carpet", color: 0x7e7e7e },
  { id: 71, name: "iron_door", render: "other", color: 0xc4c4c4, orientationMask: 0xf },
  { id: 72, name: "wooden_pressure_plate", render: "carpet", color: 0xa2824e },
  { id: 73, name: "redstone_ore", render: "cube", color: 0x8f6b6b },
  { id: 74, name: "lit_redstone_ore", render: "cube", color: 0x9b6a6a },
  { id: 75, name: "unlit_redstone_torch", render: "thin", color: 0x6b2b2b, orientationMask: 0x7 },
  { id: 76, name: "redstone_torch", render: "thin", color: 0xd63c26, orientationMask: 0x7 },
  { id: 77, name: "stone_button", render: "thin", color: 0x7e7e7e, orientationMask: 0xf },
  { id: 78, name: "snow_layer", render: "carpet", color: 0xf5f9f9, orientationMask: 0x7 },
  { id: 79, name: "ice", render: "translucent", color: 0x91b7fd, alpha: 0.6 },
  { id: 80, name: "snow", render: "cube", color: 0xf9fdfd },
  { id: 81, name: "cactus", render: "cube", color: 0x557f2d },
  { id: 82, name: "clay", render: "cube", color: 0xa0a6b3 },
  { id: 83, name: "reeds", render: "cross", color: 0x8db661 },
  { id: 84, name: "jukebox", render: "cube", color: 0x64432f },
  { id: 85, name: "fence", render: "fence", color: 0xa2824e },
  { id: 86, name: "pumpkin", render: "cube", color: 0xc07615, orientationMask: 0x3 },
  { id: 87, name: "netherrack", render: "cube", color: 0x612626 },
  { id: 88, name: "soul_sand", render: "cube", color: 0x513e32 },
  { id: 89, name: "glowstone", render: "cube", color: 0xf9dd98 },
  { id: 90, name: "portal", render: "translucent", color: 0x9d2ce0, alpha: 0.7 },
  { id: 91, name: "lit_pumpkin", render: "cube", color: 0xd08a20, orientationMask: 0x3 },
  { id: 92, name: "cake", render: "other", color: 0xe4e4e4, orientationMask: 0x7 },
  { id: 93, name: "unpowered_repeater", render: "thin", color: 0x9a9a9a, orientationMask: 0xf },
  { id: 94, name: "powered_repeater", render: "thin", color: 0xa87a7a, orientationMask: 0xf },
  {
    id: 95,
    name: "stained_glass",
    render: "translucent",
    color: 0xdddddd,
    alpha: 0.45,
    variants: dyeVariants((d) => `${d}_stained_glass`, WOOL_COLORS),
  },
  { id: 96, name: "trapdoor", render: "other", color: 0x9a7a45, orientationMask: 0xf },
  { id: 97, name: "monster_egg", render: "cube", color: 0x7a7a7a },
  {
    id: 98,
    name: "stonebrick",
    render: "cube",
    color: 0x7a7a7a,
    variants: {
      0: { name: "stone_bricks" },
      1: { name: "mossy_stone_bricks", color: 0x737969 },
      2: { name: "cracked_stone_bricks", color: 0x767676 },
      3: { name: "chiseled_stone_bricks", color: 0x787878 },
    },
  },
  { id: 99, name: "brown_mushroom_block", render: "cube", color: 0x977254, orientationMask: 0xf },
  { id: 100, name: "red_mushroom_block", render: "cube", color: 0xc73b34, orientationMask: 0xf },
  { id: 101, name: "iron_bars", render: "pane", color: 0x7b7b7b },
  { id: 102, name: "glass_pane", render: "pane", color: 0xc8e1eb, alpha: 0.35 },
  { id: 103, name: "melon_block", render: "cube", color: 0x728f2c },
  { id: 104, name: "pumpkin_stem", render: "cross", color: 0x8a9a4a, orientationMask: 0xf },
  { id: 105, name: "melon_stem", render: "cross", color: 0x8a9a4a, orientationMask: 0xf },
  { id: 106, name: "vine", render: "cross", color: 0x3b7a20, orientationMask: 0xf },
  { id: 107, name: "fence_gate", render: "fence", color: 0xa2824e, orientationMask: 0xf },
  { id: 108, name: "brick_stairs", render: "stairs", color: 0x966153, orientationMask: 0xf },
  { id: 109, name: "stone_brick_stairs", render: "stairs", color: 0x7a7a7a, orientationMask: 0xf },
  { id: 110, name: "mycelium", render: "cube", color: 0x6f6266 },
  { id: 111, name: "waterlily", render: "carpet", color: 0x2b6b1e },
  { id: 112, name: "nether_brick", render: "cube", color: 0x2c161a },
  { id: 113, name: "nether_brick_fence", render: "fence", color: 0x2c161a },
  { id: 114, name: "nether_brick_stairs", render: "stairs", color: 0x2c161a, orientationMask: 0xf },
  { id: 115, name: "nether_wart", render: "cross", color: 0x8c1c1c, orientationMask: 0x3 },
  { id: 116, name: "enchanting_table", render: "other", color: 0x8c2f2f },
  { id: 117, name: "brewing_stand", render: "thin", color: 0x8f7c60, orientationMask: 0x7 },
  { id: 118, name: "cauldron", render: "other", color: 0x4b4b4b, orientationMask: 0x3 },
  { id: 119, name: "end_portal", render: "translucent", color: 0x0b0b17, alpha: 0.9 },
  { id: 120, name: "end_portal_frame", render: "cube", color: 0x5c7f6f, orientationMask: 0x7 },
  { id: 121, name: "end_stone", render: "cube", color: 0xdddfa5 },
  { id: 122, name: "dragon_egg", render: "other", color: 0x0d0d17 },
  { id: 123, name: "redstone_lamp", render: "cube", color: 0x5f3c20 },
  { id: 124, name: "lit_redstone_lamp", render: "cube", color: 0xb99258 },
  {
    id: 125,
    name: "double_wooden_slab",
    render: "cube",
    color: 0xa2824e,
    variants: woodVariants("double_slab"),
  },
  {
    id: 126,
    name: "wooden_slab",
    render: "slab",
    color: 0xa2824e,
    orientationMask: 0x8,
    variants: woodVariants("slab"),
  },
  { id: 127, name: "cocoa", render: "other", color: 0x9a5a25, orientationMask: 0xf },
  { id: 128, name: "sandstone_stairs", render: "stairs", color: 0xd8cb9b, orientationMask: 0xf },
  { id: 129, name: "emerald_ore", render: "cube", color: 0x6c8a72 },
  { id: 130, name: "ender_chest", render: "other", color: 0x293c40, orientationMask: 0x7 },
  { id: 131, name: "tripwire_hook", render: "thin", color: 0x8a7a5a, orientationMask: 0xf },
  { id: 132, name: "tripwire", render: "thin", color: 0x8a8a8a, orientationMask: 0xf },
  { id: 133, name: "emerald_block", render: "cube", color: 0x51d975 },
  { id: 134, name: "spruce_stairs", render: "stairs", color: 0x725430, orientationMask: 0xf },
  { id: 135, name: "birch_stairs", render: "stairs", color: 0xc4b37b, orientationMask: 0xf },
  { id: 136, name: "jungle_stairs", render: "stairs", color: 0xa07351, orientationMask: 0xf },
  { id: 137, name: "command_block", render: "cube", color: 0xc39070 },
  { id: 138, name: "beacon", render: "translucent", color: 0x75cec7, alpha: 0.5 },
  {
    id: 139,
    name: "cobblestone_wall",
    render: "wall",
    color: 0x7f7f7f,
    variants: {
      0: { name: "cobblestone_wall" },
      1: { name: "mossy_cobblestone_wall", color: 0x6e7d64 },
    },
  },
  { id: 140, name: "flower_pot", render: "thin", color: 0x8a5a44, orientationMask: 0xf },
  { id: 141, name: "carrots", render: "cross", color: 0x4d8f2c, orientationMask: 0x7 },
  { id: 142, name: "potatoes", render: "cross", color: 0x4d8f2c, orientationMask: 0x7 },
  { id: 143, name: "wooden_button", render: "thin", color: 0xa2824e, orientationMask: 0xf },
  { id: 144, name: "skull", render: "other", color: 0x9a9a9a, orientationMask: 0xf },
  { id: 145, name: "anvil", render: "other", color: 0x4b4b4b, orientationMask: 0xf },
  { id: 146, name: "trapped_chest", render: "other", color: 0xa2824e, orientationMask: 0xf },
  { id: 147, name: "light_weighted_pressure_plate", render: "carpet", color: 0xf9ec50 },
  { id: 148, name: "heavy_weighted_pressure_plate", render: "carpet", color: 0xdcdcdc },
  { id: 149, name: "unpowered_comparator", render: "thin", color: 0x9a9a9a, orientationMask: 0xf },
  { id: 150, name: "powered_comparator", render: "thin", color: 0xa87a7a, orientationMask: 0xf },
  { id: 151, name: "daylight_detector", render: "carpet", color: 0x8a7a5a },
  { id: 152, name: "redstone_block", render: "cube", color: 0xab1d11 },
  { id: 153, name: "quartz_ore", render: "cube", color: 0x7a4a44 },
  { id: 154, name: "hopper", render: "other", color: 0x4b4b4b, orientationMask: 0x7 },
  {
    id: 155,
    name: "quartz_block",
    render: "cube",
    color: 0xece9e2,
    variants: {
      0: { name: "quartz_block" },
      1: { name: "chiseled_quartz_block", color: 0xe8e5dd },
      2: { name: "quartz_pillar", color: 0xeae7e0 },
      3: { name: "quartz_pillar_x", color: 0xeae7e0 },
      4: { name: "quartz_pillar_z", color: 0xeae7e0 },
    },
  },
  { id: 156, name: "quartz_stairs", render: "stairs", color: 0xece9e2, orientationMask: 0xf },
  { id: 157, name: "activator_rail", render: "thin", color: 0x8f6b58, orientationMask: 0xf },
  { id: 158, name: "dropper", render: "cube", color: 0x6f6f6f, orientationMask: 0x7 },
  {
    id: 159,
    name: "stained_hardened_clay",
    render: "cube",
    color: 0xd1b2a1,
    variants: dyeVariants((d) => `${d}_stained_clay`, CLAY_COLORS),
  },
  {
    id: 160,
    name: "stained_glass_pane",
    render: "pane",
    color: 0xdddddd,
    alpha: 0.45,
    variants: dyeVariants((d) => `${d}_stained_glass_pane`, WOOL_COLORS),
  },
  {
    id: 161,
    name: "leaves2",
    render: "translucent",
    color: 0x697d34,
    alpha: 0.92,
    orientationMask: 0xc,
    variants: {
      0: { name: "acacia_leaves", color: 0x697d34 },
      1: { name: "dark_oak_leaves", color: 0x3f6922 },
    },
  },
  {
    id: 162,
    name: "log2",
    render: "cube",
    color: 0x676056,
    orientationMask: 0xc,
    variants: {
      0: { name: "acacia_log", color: 0x676056 },
      1: { name: "dark_oak_log", color: 0x3c2e1a },
    },
  },
  { id: 163, name: "acacia_stairs", render: "stairs", color: 0xa85a32, orientationMask: 0xf },
  { id: 164, name: "dark_oak_stairs", render: "stairs", color: 0x422b14, orientationMask: 0xf },
  { id: 165, name: "slime", render: "translucent", color: 0x6fc05b, alpha: 0.7 },
  { id: 166, name: "barrier", render: "air", color: 0x000000, alpha: 0 },
  { id: 167, name: "iron_trapdoor", render: "other", color: 0xc4c4c4, orientationMask: 0xf },
  {
    id: 168,
    name: "prismarine",
    render: "cube",
    color: 0x639c97,
    variants: {
      0: { name: "prismarine" },
      1: { name: "prismarine_bricks", color: 0x63ab9e },
      2: { name: "dark_prismarine", color: 0x34594f },
    },
  },
  { id: 169, name: "sea_lantern", render: "cube", color: 0xacc7be },
  { id: 170, name: "hay_block", render: "cube", color: 0xa68a10, orientationMask: 0xc },
  {
    id: 171,
    name: "carpet",
    render: "carpet",
    color: 0xdddddd,
    variants: dyeVariants((d) => `${d}_carpet`, WOOL_COLORS),
  },
  { id: 172, name: "hardened_clay", render: "cube", color: 0x965c42 },
  { id: 173, name: "coal_block", render: "cube", color: 0x101010 },
  { id: 174, name: "packed_ice", render: "cube", color: 0x8db4fa },
  {
    id: 175,
    name: "double_plant",
    render: "cross",
    color: 0x5f8f3a,
    orientationMask: 0x8,
    variants: {
      0: { name: "sunflower", color: 0xd8c33c },
      1: { name: "lilac", color: 0xc09ac0 },
      2: { name: "double_tallgrass", color: 0x6a9a3c },
      3: { name: "large_fern", color: 0x5a8a3a },
      4: { name: "rose_bush", color: 0xb03434 },
      5: { name: "peony", color: 0xd2a8c8 },
    },
  },
  { id: 176, name: "standing_banner", render: "thin", color: 0xa2824e, orientationMask: 0xf },
  { id: 177, name: "wall_banner", render: "thin", color: 0xa2824e, orientationMask: 0x7 },
  { id: 178, name: "daylight_detector_inverted", render: "carpet", color: 0x7a6a4a },
  {
    id: 179,
    name: "red_sandstone",
    render: "cube",
    color: 0xba631d,
    variants: {
      0: { name: "red_sandstone" },
      1: { name: "chiseled_red_sandstone", color: 0xb66120 },
      2: { name: "smooth_red_sandstone", color: 0xbd6522 },
    },
  },
  { id: 180, name: "red_sandstone_stairs", render: "stairs", color: 0xba631d, orientationMask: 0xf },
  { id: 181, name: "double_stone_slab2", render: "cube", color: 0xba631d },
  { id: 182, name: "stone_slab2", render: "slab", color: 0xba631d, orientationMask: 0x8 },
  { id: 183, name: "spruce_fence_gate", render: "fence", color: 0x725430, orientationMask: 0xf },
  { id: 184, name: "birch_fence_gate", render: "fence", color: 0xc4b37b, orientationMask: 0xf },
  { id: 185, name: "jungle_fence_gate", render: "fence", color: 0xa07351, orientationMask: 0xf },
  { id: 186, name: "dark_oak_fence_gate", render: "fence", color: 0x422b14, orientationMask: 0xf },
  { id: 187, name: "acacia_fence_gate", render: "fence", color: 0xa85a32, orientationMask: 0xf },
  { id: 188, name: "spruce_fence", render: "fence", color: 0x725430 },
  { id: 189, name: "birch_fence", render: "fence", color: 0xc4b37b },
  { id: 190, name: "jungle_fence", render: "fence", color: 0xa07351 },
  { id: 191, name: "dark_oak_fence", render: "fence", color: 0x422b14 },
  { id: 192, name: "acacia_fence", render: "fence", color: 0xa85a32 },
  { id: 193, name: "spruce_door", render: "other", color: 0x725430, orientationMask: 0xf },
  { id: 194, name: "birch_door", render: "other", color: 0xc4b37b, orientationMask: 0xf },
  { id: 195, name: "jungle_door", render: "other", color: 0xa07351, orientationMask: 0xf },
  { id: 196, name: "acacia_door", render: "other", color: 0xa85a32, orientationMask: 0xf },
  { id: 197, name: "dark_oak_door", render: "other", color: 0x422b14, orientationMask: 0xf },
];

/** id -> definition. Ids not present were not in 1.8. */
export const BLOCKS_BY_ID: ReadonlyMap<number, LegacyBlock> = new Map(TABLE.map((b) => [b.id, b]));

/** The highest id 1.8 vanilla ever used. Anything above is modded or a post-1.8 block. */
export const MAX_LEGACY_ID = 197;

/** Canonical name (including every variant name) -> packed block. */
export const BLOCKS_BY_NAME: ReadonlyMap<string, PackedBlock> = (() => {
  const map = new Map<string, PackedBlock>();
  for (const b of TABLE) {
    map.set(b.name, pack(b.id, 0));
    if (b.variants) {
      for (const [dataStr, v] of Object.entries(b.variants)) {
        const data = Number(dataStr);
        map.set(v.name, pack(b.id, data));
        // The base name at data 0 must win over a variant that happens to share it.
        if (data === 0) map.set(b.name, pack(b.id, 0));
      }
    }
  }
  return map;
})();

export function blockDef(id: number): LegacyBlock | undefined {
  return BLOCKS_BY_ID.get(id);
}

/** Human-readable name for a packed block, e.g. `red_wool`, `granite`, `stone_slab`. */
export function blockName(block: PackedBlock): string {
  const def = blockDef(blockId(block));
  if (!def) return `unknown_${blockId(block)}:${blockData(block)}`;
  const data = blockData(block);
  const material = def.orientationMask ? data & ~def.orientationMask : data;
  const variant = def.variants?.[material];
  if (variant) return variant.name;
  if (def.variants && material !== 0) return `${def.name}:${material}`;
  return def.name;
}

/** Average texture colour of a packed block as `0xRRGGBB`. */
export function blockColor(block: PackedBlock): number {
  const def = blockDef(blockId(block));
  if (!def) return 0xff00ff; // magenta: an unknown block should be loud in a preview
  const data = blockData(block);
  const material = def.orientationMask ? data & ~def.orientationMask : data;
  return def.variants?.[material]?.color ?? def.color;
}

export function blockAlpha(block: PackedBlock): number {
  return blockDef(blockId(block))?.alpha ?? 1;
}

export function renderClass(block: PackedBlock): RenderClass {
  return blockDef(blockId(block))?.render ?? "cube";
}

/** True for blocks that fill their cell and stop light — the basis for "is this a wall". */
export function isSolidCube(block: PackedBlock): boolean {
  const r = renderClass(block);
  return r === "cube" || r === "stairs";
}

/** True for anything a player cannot walk through. Used by the pathfinding analyzer. */
export function isObstructing(block: PackedBlock): boolean {
  const r = renderClass(block);
  return (
    r === "cube" ||
    r === "stairs" ||
    r === "slab" ||
    r === "translucent" ||
    r === "fence" ||
    r === "wall" ||
    r === "pane" ||
    r === "other"
  );
}

/** True for blocks a player can stand on top of. */
export function isStandable(block: PackedBlock): boolean {
  const r = renderClass(block);
  return r === "cube" || r === "stairs" || r === "slab" || r === "translucent" || r === "carpet";
}

/**
 * Strip orientation bits so two blocks that differ only by which way they face compare equal.
 * Palette histograms and symmetry checks must not treat a north-facing and south-facing stair as
 * two different materials.
 */
export function materialKey(block: PackedBlock): PackedBlock {
  const def = blockDef(blockId(block));
  if (!def?.orientationMask) return block;
  return pack(blockId(block), blockData(block) & ~def.orientationMask);
}
