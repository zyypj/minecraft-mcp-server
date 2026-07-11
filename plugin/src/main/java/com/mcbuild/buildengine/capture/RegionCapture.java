package com.mcbuild.buildengine.capture;

import com.mcbuild.buildengine.model.CaptureResult;
import com.mcbuild.buildengine.model.Region;

/**
 * Extracts region block data for the Node renderer (§3.3 {@code captureRegion}, §6.1).
 *
 * <p><b>The plugin only extracts data — it never renders images.</b> A headless server JVM has no GPU,
 * no OpenGL, and none of the client render assets (block models, textures, blockstate mappings live in
 * the client jar), so "the plugin takes a photo" is impossible (§6.1). This class produces:
 *
 * <ul>
 *   <li>{@code "schem"} — a Sponge {@code .schem} v3 blob (§7.3): dense palette + varint {@code Data}
 *       indexed {@code x + z*W + y*W*L}, which maps 1:1 onto the engine's voxel buffer. Canonical format.</li>
 *   <li>{@code "json"} — compact RLE JSON for tight render loops.</li>
 * </ul>
 *
 * The bytes are handed to the Node renderer, which meshes them with real MC block models and photographs
 * them; the MCP relays those PNGs to Claude (§3.1(d), §6.2).
 */
public final class RegionCapture {

    /**
     * Capture {@code region} to the requested format.
     *
     * @param format {@code "schem"} or {@code "json"}
     * @return a reference to the stored extract (never an image)
     */
    public CaptureResult capture(Region region, String format) {
        // TODO M4: read every block state in `region` (via FAWE Clipboard on the FAWE path, or a
        // main-thread snapshot read on the Bukkit path), then:
        //   - "schem": write Sponge .schem v3 (palette + varint Data, index x + z*W + y*W*L; include
        //              block entities, biomes, DataVersion) to the capture store; return schematicId.
        //   - "json" : emit compact RLE JSON to the capture store; return jsonRef.
        // Store bytes under a content-addressed id so the renderer can fetch by reference.
        throw new UnsupportedOperationException(
                "TODO M4: RegionCapture.capture (" + format + ") — data extraction not yet implemented");
    }
}
