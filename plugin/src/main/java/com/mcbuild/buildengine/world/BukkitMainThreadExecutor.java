package com.mcbuild.buildengine.world;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.plugin.Plugin;

/**
 * Regular-Paper {@link MainThreadExecutor}: everything runs on the single main server thread via the
 * Bukkit scheduler. The {@link Location} argument is ignored because there is exactly one world thread.
 *
 * <p><b>Folia seam:</b> a future {@code FoliaMainThreadExecutor} would implement the same interface but
 * dispatch through {@code Bukkit.getRegionScheduler()} using the {@code Location} to pick the owning
 * region thread — e.g.
 * <pre>{@code
 *   getRegionScheduler().execute(plugin, location, task);
 *   getRegionScheduler().runDelayed(plugin, location, t -> task.run(), delayTicks);
 * }</pre>
 * No caller changes are needed; that is the whole point of taking {@code Location} everywhere (§3.4).
 */
public final class BukkitMainThreadExecutor implements MainThreadExecutor {

    private final Plugin plugin;

    public BukkitMainThreadExecutor(Plugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public void execute(Location location, Runnable task) {
        Bukkit.getScheduler().runTask(plugin, task);
    }

    @Override
    public void executeLater(Location location, Runnable task, long delayTicks) {
        Bukkit.getScheduler().runTaskLater(plugin, task, delayTicks);
    }
}
