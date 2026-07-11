package com.mcbuild.buildengine.world;

import org.bukkit.Location;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Runs tasks on the thread that is allowed to mutate the world <em>at a given location</em>.
 *
 * <p><b>This one abstraction is the entire cost of Folia-readiness</b> (§3.4): on regular Paper the
 * "correct" thread is the single main thread and the {@link Location} is ignored; on Folia it is the
 * region thread that owns that location, obtained via {@code RegionScheduler}. Every method takes a
 * {@code Location} so a future {@code FoliaMainThreadExecutor} can route to the right region without
 * changing any caller.
 *
 * <p><b>Only the {@code BukkitWorldEditor} uses this.</b> The {@code FaweWorldEditor} deliberately does
 * NOT — FAWE edits chunk sections off-thread and must never be marshalled here (§3.4). Wrapping FAWE in
 * a main-thread executor defeats its performance and risks a deadlock.
 */
public interface MainThreadExecutor {

    /** Run {@code task} on the correct thread for {@code location}, as soon as possible (next tick). */
    void execute(Location location, Runnable task);

    /**
     * Run {@code task} on the correct thread for {@code location} after {@code delayTicks} ticks.
     * Used by the Bukkit editor's self-rescheduling budget drain (§3.4) to yield between batches.
     */
    void executeLater(Location location, Runnable task, long delayTicks);

    /**
     * Submit a value-returning task to the correct thread and get a future that completes with its
     * result (or exception). Convenience over {@link #execute} for one-shot main-thread reads.
     */
    default <T> CompletableFuture<T> submit(Location location, Supplier<T> task) {
        CompletableFuture<T> future = new CompletableFuture<>();
        execute(location, () -> {
            try {
                future.complete(task.get());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        return future;
    }
}
