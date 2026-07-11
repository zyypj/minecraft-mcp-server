package com.mcbuild.buildengine.model;

import java.util.List;

/**
 * A weighted block pattern for {@code fillRegion} (§3.3 — "FAWE weighted {@code Pattern}").
 *
 * <p>Each entry is a block state string (e.g. {@code "minecraft:oak_stairs[facing=north]"}) with a
 * relative weight; the fill samples per-block from the weighted distribution to produce texture
 * variation (§5.6). The FAWE editor converts this to a WorldEdit
 * {@code com.sk89q.worldedit.function.pattern.Pattern}; the Bukkit editor samples it directly.
 */
public record Pattern(List<WeightedBlock> blocks) {

    public record WeightedBlock(String block, double weight) {}

    /** Convenience for a single, uniform block. */
    public static Pattern single(String block) {
        return new Pattern(List.of(new WeightedBlock(block, 1.0)));
    }

    public double totalWeight() {
        double sum = 0;
        for (WeightedBlock b : blocks) sum += b.weight();
        return sum;
    }
}
