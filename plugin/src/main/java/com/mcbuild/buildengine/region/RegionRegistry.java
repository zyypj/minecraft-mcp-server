package com.mcbuild.buildengine.region;

import com.mcbuild.buildengine.model.Region;

import java.util.Collection;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry of named {@link Selection}s and their per-region locks (§3.3 {@code selectRegion}/
 * {@code releaseRegion}, §3.4 per-region serialization, §7.2 reservation).
 *
 * <p>Thread-safe: RPCs arrive on off-thread Netty/HTTP handlers, so registration and lookup must be
 * concurrent. Edit <em>serialization</em> itself lives on each {@link Selection} (its {@code editTail});
 * this registry owns lifecycle (register / get / release) and overlap/reservation policy.
 */
public final class RegionRegistry {

    private final ConcurrentHashMap<String, Selection> byId = new ConcurrentHashMap<>();

    /**
     * Register (lock) a region as a new selection.
     *
     * @param region the region to lock
     * @param name   optional human name (nullable)
     * @param reserve if true, mark reserved and reject if it overlaps an existing reserved selection (§7.2)
     * @return the created selection
     * @throws IllegalStateException if {@code reserve} and the region overlaps an existing reservation
     */
    public Selection register(Region region, String name, boolean reserve) {
        if (reserve) {
            for (Selection existing : byId.values()) {
                if (existing.isReserved() && existing.region().overlaps(region)) {
                    throw new IllegalStateException(
                            "Region overlaps reserved selection '" + existing.id() + "'");
                }
            }
        }
        String id = "sel-" + UUID.randomUUID();
        Selection selection = new Selection(id, name, region);
        selection.setReserved(reserve);
        byId.put(id, selection);
        return selection;
    }

    /** @return the selection, or {@code null} if unknown. */
    public Selection get(String selectionId) {
        return byId.get(selectionId);
    }

    /**
     * Release a selection (unlock/reservation). Note: an in-flight edit chain is not force-cancelled;
     * callers should ensure edits have drained (or accept that queued edits still run) before releasing.
     *
     * @return true if a selection was removed.
     */
    public boolean release(String selectionId) {
        return byId.remove(selectionId) != null;
    }

    /** Release everything (plugin shutdown). */
    public void releaseAll() {
        byId.clear();
    }

    public Collection<Selection> all() {
        return Collections.unmodifiableCollection(byId.values());
    }
}
