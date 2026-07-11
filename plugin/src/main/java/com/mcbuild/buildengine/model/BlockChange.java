package com.mcbuild.buildengine.model;

/**
 * A single block write: position + block-state string. The unit of {@code setBlocks} (§3.3) and of
 * the before/after arrays in a {@link WorldDiff}.
 *
 * @param data block-state string, e.g. {@code "minecraft:spruce_stairs[facing=east,half=top]"}.
 */
public record BlockChange(int x, int y, int z, String data) {}
