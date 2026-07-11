package com.mcbuild.buildengine.region;

import com.mcbuild.buildengine.model.Region;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * A named, locked selection over a {@link Region} (§3.3 {@code selectRegion}, §7.1).
 *
 * <p><b>Per-region edit serialization (§3.4).</b> "Edits are serialized per region behind a region lock
 * so two RPCs can't interleave." Because edits are asynchronous ({@link CompletableFuture}), a blocking
 * {@code ReentrantLock} held across an off-thread FAWE await would be wrong. Instead each edit chains
 * onto {@code editTail}: a new edit starts only after the previous edit's future completes. This is the
 * async equivalent of a per-region lock and works across both threading models.
 */
public final class Selection {

    private final String id;
    private final String name;       // optional human-facing name; may be null
    private final Region region;

    /** Reservation flag (§7.2 {@code reserved}) — prevents overlapping concurrent builds. */
    private volatile boolean reserved;

    // Tail of the per-region edit chain. Guarded by `editLock`.
    private CompletableFuture<Void> editTail = CompletableFuture.completedFuture(null);
    private final Object editLock = new Object();

    public Selection(String id, String name, Region region) {
        this.id = id;
        this.name = name;
        this.region = region;
    }

    public String id() { return id; }
    public String name() { return name; }
    public Region region() { return region; }
    public boolean isReserved() { return reserved; }
    public void setReserved(boolean reserved) { this.reserved = reserved; }

    /**
     * Serialize an edit against this region: it begins only after all previously enqueued edits for this
     * selection have completed, and its own future advances the chain. Failures do not wedge the chain —
     * a later edit still runs (its correctness is the caller's concern, not the lock's).
     *
     * @param edit supplies the edit's future (typically a {@code WorldEditor} call)
     * @return the edit's future
     */
    public <T> CompletableFuture<T> serializeEdit(Supplier<CompletableFuture<T>> edit) {
        synchronized (editLock) {
            CompletableFuture<T> result = editTail.thenCompose(ignored -> edit.get());
            // Advance the tail; map to Void and swallow failure so one bad edit doesn't block the next.
            editTail = result.<Void>handle((r, t) -> null);
            return result;
        }
    }
}
