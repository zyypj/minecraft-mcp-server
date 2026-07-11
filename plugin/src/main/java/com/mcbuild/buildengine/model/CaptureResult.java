package com.mcbuild.buildengine.model;

/**
 * Result of {@code captureRegion} (§3.3, §6.1): a reference to extracted region <em>data</em> — never
 * an image. Exactly one of {@code schematicId} / {@code jsonRef} is set, per the requested format.
 *
 * <p>Per §6.1 the plugin only extracts; the Node renderer meshes/photographs this data. {@code schem}
 * is a Sponge {@code .schem} v3 blob (§7.3); {@code json} is compact RLE for tight render loops.
 *
 * @param format     {@code "schem"} or {@code "json"}
 * @param schematicId reference to a stored {@code .schem} (null for json format)
 * @param jsonRef     reference to stored compact JSON (null for schem format)
 * @param region     the captured region
 * @param blockCount number of non-air blocks captured (advisory)
 */
public record CaptureResult(
        String format,
        String schematicId,
        String jsonRef,
        Region region,
        long blockCount
) {}
