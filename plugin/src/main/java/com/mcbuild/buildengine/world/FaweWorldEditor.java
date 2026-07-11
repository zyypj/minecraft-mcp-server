package com.mcbuild.buildengine.world;

import com.mcbuild.buildengine.model.BlockChange;
import com.mcbuild.buildengine.model.CaptureResult;
import com.mcbuild.buildengine.model.Pattern;
import com.mcbuild.buildengine.model.Region;
import com.mcbuild.buildengine.model.RpcOptions;
import com.mcbuild.buildengine.model.WorldDiff;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;

/**
 * Default {@link WorldEditor}: FastAsyncWorldEdit (§3.4 FAWE model).
 *
 * <p><b>FAWE's whole reason to exist is that it does NOT use the Bukkit API and does NOT marshal to the
 * main thread</b> — it edits chunk sections directly off-thread and relights/resends them itself. So the
 * model here is deliberately the opposite of {@link BukkitWorldEditor}:
 *
 * <ul>
 *   <li>Run the {@code EditSession} on a dedicated worker thread (never the main thread).</li>
 *   <li>Return a {@link CompletableFuture} that completes when the edit is flushed; the RPC layer holds
 *       the per-region lock until then (§3.4).</li>
 *   <li><b>Do NOT wrap this in {@link MainThreadExecutor}, and do NOT tick-budget it.</b> Marshalling
 *       FAWE onto the main thread — or waiting on a main-thread task from a FAWE worker — defeats its
 *       performance and can deadlock (main thread waiting on FAWE waiting on the main thread). This is
 *       the single most important threading rule in the design (§3.4, §12 "FAWE threading misuse").</li>
 * </ul>
 *
 * <p>The actual {@code EditSession} calls are stubbed with {@code TODO M1/M2} markers; the off-thread
 * submission/await shape is correct and is the point of this class.
 */
public final class FaweWorldEditor implements WorldEditor {

    /**
     * Dedicated worker pool for FAWE edits. MUST NOT be the main thread and MUST NOT be a pool whose
     * tasks ever block on the main thread. (FAWE also maintains its own internal parallelism; this pool
     * just keeps our submit/await off the Netty/RPC threads.)
     */
    private final ExecutorService worker;

    public FaweWorldEditor(ExecutorService worker) {
        this.worker = worker;
    }

    @Override
    public boolean isFawe() {
        return true;
    }

    @Override
    public CompletableFuture<Integer> fill(Region region, Pattern pattern, RpcOptions options) {
        return CompletableFuture.supplyAsync(() -> {
            // TODO M1: build and run the EditSession OFF-THREAD, e.g.:
            //   BukkitWorld world = new BukkitWorld(Bukkit.getWorld(region.world()));
            //   try (EditSession session = WorldEdit.getInstance().newEditSessionBuilder()
            //            .world(world)
            //            .fastMode(!options.physics())         // physics=false -> fast mode
            //            .build()) {
            //       CuboidRegion r = toWorldEditRegion(region);
            //       com.sk89q.worldedit.function.pattern.Pattern p = toWorldEditPattern(pattern);
            //       int changed = session.setBlocks((Region) r, p);
            //       session.flushQueue();                      // FAWE relights/resends asynchronously
            //       return changed;
            //   }
            throw new UnsupportedOperationException("TODO M1: FaweWorldEditor.fill not yet implemented");
        }, worker);
    }

    @Override
    public CompletableFuture<Integer> setBlocks(String world, List<BlockChange> blocks, RpcOptions options) {
        return CompletableFuture.supplyAsync(() -> {
            // TODO M1: one EditSession over the whole batch, off-thread; parse each block state string
            //   via WorldEdit's BlockState parser, session.setBlock(BlockVector3, state), flushQueue().
            throw new UnsupportedOperationException("TODO M1: FaweWorldEditor.setBlocks not yet implemented");
        }, worker);
    }

    @Override
    public CompletableFuture<CaptureResult> capture(Region region, String format) {
        return CompletableFuture.supplyAsync(() -> {
            // TODO M4: copy the region into a FAWE Clipboard off-thread and hand it to RegionCapture,
            //   which serializes Sponge .schem v3 (native to FAWE) or compact JSON. Plugin never renders (§6.1).
            throw new UnsupportedOperationException("TODO M4: FaweWorldEditor.capture not yet implemented");
        }, worker);
    }

    @Override
    public CompletableFuture<Integer> applyDiff(WorldDiff diff) {
        return CompletableFuture.supplyAsync(() -> {
            // TODO M5: write diff.after() via a single off-thread EditSession (FAWE = write mechanism only, §7.4).
            throw new UnsupportedOperationException("TODO M5: FaweWorldEditor.applyDiff not yet implemented");
        }, worker);
    }

    @Override
    public CompletableFuture<Integer> undoDiff(String diffId) {
        return CompletableFuture.supplyAsync(() -> {
            // TODO M5: the engine supplies the inverse patch (`before` states); FAWE just writes them.
            // NB: use the engine worldDiff, NOT FAWE's own EditSession.undo() — one undo authority (§7.4).
            throw new UnsupportedOperationException("TODO M5: FaweWorldEditor.undoDiff not yet implemented");
        }, worker);
    }
}
