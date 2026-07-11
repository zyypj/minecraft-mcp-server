package com.mcbuild.buildengine.world;

import com.mcbuild.buildengine.model.BlockChange;
import com.mcbuild.buildengine.model.CaptureResult;
import com.mcbuild.buildengine.model.Pattern;
import com.mcbuild.buildengine.model.Region;
import com.mcbuild.buildengine.model.RpcOptions;
import com.mcbuild.buildengine.model.WorldDiff;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * The bulk world-edit backend abstraction (§3.1). Two implementations exist with <b>different threading
 * models</b> (§3.4 — "the whole ballgame"):
 *
 * <ul>
 *   <li>{@link FaweWorldEditor} (default): submits an {@code EditSession} <b>off-thread</b> and awaits
 *       its future. NOT tick-budgeted, NOT wrapped in {@link MainThreadExecutor}.</li>
 *   <li>{@link BukkitWorldEditor} (fallback): mutates on the <b>main thread</b> via
 *       {@link MainThreadExecutor}, spreading large jobs across ticks with a {@code budgetPerTick}
 *       self-rescheduling drain and a TPS guard.</li>
 * </ul>
 *
 * <p><b>Threading contract for callers:</b> every method returns a {@link CompletableFuture} and must
 * NOT block. The caller (the RPC layer) holds the per-region lock until the returned future completes
 * (§3.4 — edits are serialized per region). The returned {@code Integer} is the number of blocks changed.
 *
 * <p><b>Not an undo authority.</b> {@link #applyDiff}/{@link #undoDiff} are pure write mechanisms; the
 * engine's {@code worldDiff} is the single undo history (§3.1, §7.4).
 */
public interface WorldEditor {

    /** Fill {@code region} with a (weighted) {@code pattern}. Returns blocks changed. */
    CompletableFuture<Integer> fill(Region region, Pattern pattern, RpcOptions options);

    /** Write an explicit list of block changes. Returns blocks changed. */
    CompletableFuture<Integer> setBlocks(String world, List<BlockChange> blocks, RpcOptions options);

    /** Extract region data to {@code .schem}/JSON for the renderer (§6.1). The plugin never renders. */
    CompletableFuture<CaptureResult> capture(Region region, String format);

    /** Apply an engine change set (writes {@code diff.after()}). Returns blocks changed (§7.4). */
    CompletableFuture<Integer> applyDiff(WorldDiff diff);

    /** Undo a previously applied change set by writing its stored inverse ({@code before}). Returns blocks restored. */
    CompletableFuture<Integer> undoDiff(String diffId);

    /** {@code true} if this backend is FAWE (off-thread). Reported by {@code authenticate} as {@code faweAvailable}. */
    boolean isFawe();
}
