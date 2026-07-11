package com.mcbuild.buildengine.world;

import com.mcbuild.buildengine.model.BlockChange;
import com.mcbuild.buildengine.model.CaptureResult;
import com.mcbuild.buildengine.model.Pattern;
import com.mcbuild.buildengine.model.Region;
import com.mcbuild.buildengine.model.RpcOptions;
import com.mcbuild.buildengine.model.Vec3;
import com.mcbuild.buildengine.model.WorldDiff;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.plugin.Plugin;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Main-thread {@link WorldEditor} fallback (§3.4 Bukkit model) — <b>the reference implementation of the
 * main-thread budget loop.</b>
 *
 * <p>Network handlers accept RPCs off-thread and never touch the world; they call the methods here,
 * which submit work to the {@link MainThreadExecutor}. World mutation happens only on the main thread.
 * Large jobs <b>self-reschedule</b>: they write at most {@code budgetPerTick} blocks per tick and then
 * yield, so a multi-million-block fill spreads across ticks instead of freezing the server. A
 * <b>TPS guard</b> backs off a tick whenever server TPS drops below a floor.
 *
 * <p>All writes use {@code applyPhysics = false} (§3.3 {@code physics:false}) so cascades don't fire.
 *
 * <p><b>Block writes are stubbed</b> (clear {@code TODO M1} markers) — but the threading, budgeting, TPS
 * guard and future-completion are fully wired, because that plumbing (not the {@code setBlockData} call)
 * is what §3.4 is about.
 */
public final class BukkitWorldEditor implements WorldEditor {

    private final Plugin plugin;
    private final MainThreadExecutor mainThread;
    private final int defaultBudgetPerTick;
    private final double tpsFloor;

    public BukkitWorldEditor(Plugin plugin, MainThreadExecutor mainThread, int defaultBudgetPerTick, double tpsFloor) {
        this.plugin = plugin;
        this.mainThread = mainThread;
        this.defaultBudgetPerTick = defaultBudgetPerTick;
        this.tpsFloor = tpsFloor;
    }

    @Override
    public boolean isFawe() {
        return false;
    }

    @Override
    public CompletableFuture<Integer> fill(Region region, Pattern pattern, RpcOptions options) {
        World world = Bukkit.getWorld(region.world());
        if (world == null) {
            return CompletableFuture.failedFuture(new IllegalArgumentException("Unknown world: " + region.world()));
        }
        Location anchor = new Location(world, region.min().x(), region.min().y(), region.min().z());
        int budget = options.budgetOr(defaultBudgetPerTick);

        // A resumable cursor over every cell of the region, iterated in .schem index order
        // (x fastest, then z, then y) so writes proceed foundations-first (y ascending) — gravity-safe.
        EditWork work = new EditWork() {
            private final int w = region.width(), h = region.height(), l = region.length();
            private final int x0 = region.min().x(), y0 = region.min().y(), z0 = region.min().z();
            private long i = 0;
            private final long total = (long) w * h * l;

            @Override public boolean hasNext() { return i < total; }

            @Override public void writeNext() {
                if (i >= total) throw new NoSuchElementException();
                long idx = i++;
                int x = (int) (idx % w);
                int z = (int) ((idx / w) % l);
                int y = (int) (idx / ((long) w * l));
                Vec3 pos = new Vec3(x0 + x, y0 + y, z0 + z);
                writeOne(world, pos, pattern, options);
            }

            @Override public long total() { return total; }
        };
        return drainOnMainThread(anchor, budget, work);
    }

    @Override
    public CompletableFuture<Integer> setBlocks(String worldName, List<BlockChange> blocks, RpcOptions options) {
        World world = Bukkit.getWorld(worldName);
        if (world == null) {
            return CompletableFuture.failedFuture(new IllegalArgumentException("Unknown world: " + worldName));
        }
        Location anchor = blocks.isEmpty()
                ? new Location(world, 0, world.getSeaLevel(), 0)
                : new Location(world, blocks.get(0).x(), blocks.get(0).y(), blocks.get(0).z());
        int budget = options.budgetOr(defaultBudgetPerTick);

        EditWork work = new EditWork() {
            private int i = 0;
            @Override public boolean hasNext() { return i < blocks.size(); }
            @Override public void writeNext() {
                BlockChange bc = blocks.get(i++);
                // TODO M1: apply bc.data() at (bc.x,bc.y,bc.z), see writeOne() for the physics=false note.
                writeChange(world, bc, options);
            }
            @Override public long total() { return blocks.size(); }
        };
        return drainOnMainThread(anchor, budget, work);
    }

    @Override
    public CompletableFuture<CaptureResult> capture(Region region, String format) {
        // Capturing reads block state; on the Bukkit backend that read must also run on the main thread.
        // TODO M4: read states on the main thread, hand to RegionCapture to serialize .schem/JSON.
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("TODO M4: BukkitWorldEditor.capture not yet implemented"));
    }

    @Override
    public CompletableFuture<Integer> applyDiff(WorldDiff diff) {
        // TODO M5: setBlocks(diff.world(), diff.after(), RpcOptions.defaults()) with gravity-safe ordering.
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("TODO M5: BukkitWorldEditor.applyDiff not yet implemented"));
    }

    @Override
    public CompletableFuture<Integer> undoDiff(String diffId) {
        // TODO M5: the ENGINE owns the inverse patch (§7.4). The plugin only writes the `before` states
        // handed to it; it does not resolve diffId -> patch itself. Signature kept for API symmetry.
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("TODO M5: BukkitWorldEditor.undoDiff not yet implemented"));
    }

    // ------------------------------------------------------------------------------------------------
    // The main-thread budget drain — the part §3.4 actually cares about. FULLY WIRED.
    // ------------------------------------------------------------------------------------------------

    /** A resumable unit of world-mutating work, drained across ticks by the budget loop. */
    private interface EditWork {
        boolean hasNext();
        /** Perform exactly one block write. Always invoked on the main thread. */
        void writeNext();
        long total();
    }

    /**
     * Drain {@code work} on the main thread, at most {@code budget} writes per tick, completing the
     * returned future with the number of blocks written once the work is exhausted. Never blocks the
     * calling (RPC) thread. Backs off a tick when TPS is under the floor (TPS guard).
     */
    private CompletableFuture<Integer> drainOnMainThread(Location anchor, int budget, EditWork work) {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        AtomicInteger written = new AtomicInteger();

        // Named so it can reschedule itself. Runs on the main thread each invocation.
        final class Drain implements Runnable {
            @Override
            public void run() {
                try {
                    if (belowTpsFloor()) {
                        // Server is struggling — yield this whole tick, retry next tick.
                        mainThread.executeLater(anchor, this, 1L);
                        return;
                    }
                    int thisTick = 0;
                    while (thisTick < budget && work.hasNext()) {
                        work.writeNext();
                        thisTick++;
                        written.incrementAndGet();
                    }
                    if (work.hasNext()) {
                        mainThread.executeLater(anchor, this, 1L); // more to do -> next tick
                    } else {
                        future.complete(written.get());
                    }
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            }
        }

        mainThread.execute(anchor, new Drain()); // kick off on the main thread
        return future;
    }

    /** TPS guard (§3.4): true when the 1-minute TPS average is under the configured floor. */
    private boolean belowTpsFloor() {
        try {
            double[] tps = Bukkit.getTPS(); // Paper API: [1m, 5m, 15m]
            return tps.length > 0 && tps[0] < tpsFloor;
        } catch (Throwable ignored) {
            return false; // if unavailable, don't throttle
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Actual block writes — STUBBED. Wire these at M1; the plumbing above is already correct.
    // ------------------------------------------------------------------------------------------------

    private void writeOne(World world, Vec3 pos, Pattern pattern, RpcOptions options) {
        // TODO M1: sample the pattern (seeded weighted pick) and write it, physics off:
        //   BlockData data = Bukkit.createBlockData(sample(pattern));
        //   world.getBlockAt(pos.x(), pos.y(), pos.z()).setBlockData(data, /* applyPhysics = */ false);
        // Respect options.spawnDrops()/updateLighting()/notifyClients() where the API allows.
        // (No-op stub: the drain loop still counts it so budgeting/timing can be exercised end-to-end.)
    }

    private void writeChange(World world, BlockChange bc, RpcOptions options) {
        // TODO M1: BlockData data = Bukkit.createBlockData(bc.data());
        //          world.getBlockAt(bc.x(), bc.y(), bc.z()).setBlockData(data, false);
    }
}
