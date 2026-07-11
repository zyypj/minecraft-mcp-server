package com.mcbuild.buildengine;

import com.mcbuild.buildengine.region.RegionRegistry;
import com.mcbuild.buildengine.rpc.RpcServer;
import com.mcbuild.buildengine.world.BukkitMainThreadExecutor;
import com.mcbuild.buildengine.world.BukkitWorldEditor;
import com.mcbuild.buildengine.world.FaweWorldEditor;
import com.mcbuild.buildengine.world.MainThreadExecutor;
import com.mcbuild.buildengine.world.WorldEditor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * BuildEngine — the "Committer" (§3.1(a)). On enable it reads config, picks a {@link WorldEditor}
 * backend (FAWE off-thread if present, else the main-thread Bukkit fallback — §3.4), and starts the
 * localhost JSON-RPC {@link RpcServer} the Node MCP process drives.
 */
public final class BuildEnginePlugin extends JavaPlugin implements CommandExecutor {

    private RpcServer rpcServer;
    private WorldEditor worldEditor;
    private RegionRegistry regionRegistry;
    private ExecutorService faweWorker; // non-null only on the FAWE path
    private RpcServer.Config rpcConfig;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        FileConfiguration cfg = getConfig();

        String host = cfg.getString("rpc.host", "127.0.0.1");
        int port = cfg.getInt("rpc.port", 25566);
        String token = cfg.getString("rpc.token", "CHANGE_ME");
        long maxRegionVolume = cfg.getLong("limits.maxRegionVolume", 8_000_000L);
        int budgetPerTick = cfg.getInt("limits.budgetPerTick", 32_768);
        double tpsFloor = cfg.getDouble("limits.tpsFloor", 18.0);
        List<String> worldAllowlist = cfg.getStringList("worldAllowlist");

        if ("CHANGE_ME".equals(token)) {
            getLogger().warning("rpc.token is still 'CHANGE_ME' — set a real token in config.yml. "
                    + "The RPC endpoint can edit the world; do not run it with the default token.");
        }

        this.regionRegistry = new RegionRegistry();

        // §3.4: choose the backend AND its threading model together.
        boolean faweInstalled = getServer().getPluginManager().getPlugin("FastAsyncWorldEdit") != null;
        if (faweInstalled) {
            // FAWE edits OFF-THREAD. Give it a dedicated worker pool; NEVER the main thread (§3.4).
            this.faweWorker = Executors.newFixedThreadPool(
                    Math.max(2, Runtime.getRuntime().availableProcessors() / 2),
                    r -> {
                        Thread t = new Thread(r, "buildengine-fawe-worker");
                        t.setDaemon(true);
                        return t;
                    });
            this.worldEditor = new FaweWorldEditor(faweWorker);
            getLogger().info("FastAsyncWorldEdit detected -> FaweWorldEditor (off-thread, default backend).");
        } else {
            // Fallback: main-thread writes with a budgetPerTick self-rescheduling drain + TPS guard (§3.4).
            MainThreadExecutor mainThread = new BukkitMainThreadExecutor(this);
            this.worldEditor = new BukkitWorldEditor(this, mainThread, budgetPerTick, tpsFloor);
            getLogger().warning("FastAsyncWorldEdit not found -> BukkitWorldEditor (main-thread + budget). "
                    + "Install FAWE for off-thread bulk edits.");
        }

        this.rpcConfig = new RpcServer.Config(host, port, token, maxRegionVolume, budgetPerTick,
                worldAllowlist, worldEditor.isFawe());
        this.rpcServer = new RpcServer(getLogger(), rpcConfig, worldEditor, regionRegistry);

        try {
            rpcServer.start();
            getLogger().info("BuildEngine RPC listening on " + host + ":" + port
                    + " (HTTP /rpc, WebSocket /ws). Backend: " + (worldEditor.isFawe() ? "FAWE" : "Bukkit") + ".");
        } catch (Exception e) {
            getLogger().severe("Failed to start RPC server on " + host + ":" + port + " -> " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        PluginCommand command = getCommand("buildengine");
        if (command != null) {
            command.setExecutor(this);
        }
    }

    @Override
    public void onDisable() {
        if (rpcServer != null) {
            rpcServer.stop();
            rpcServer = null;
        }
        if (regionRegistry != null) {
            regionRegistry.releaseAll(); // release locks/reservations
        }
        if (faweWorker != null) {
            faweWorker.shutdownNow();
            faweWorker = null;
        }
        getLogger().info("BuildEngine disabled; RPC stopped and region locks released.");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!command.getName().equalsIgnoreCase("buildengine")) {
            return false;
        }
        String sub = args.length > 0 ? args[0].toLowerCase(Locale.ROOT) : "status";
        switch (sub) {
            case "status" -> {
                sender.sendMessage("BuildEngine: RPC " + rpcConfig.host() + ":" + rpcConfig.port()
                        + " | backend " + (worldEditor != null && worldEditor.isFawe() ? "FAWE (off-thread)" : "Bukkit (main-thread)")
                        + " | selections " + regionRegistry.all().size());
            }
            case "reload" -> {
                reloadConfig();
                sender.sendMessage("BuildEngine: config reloaded. Restart the server to re-bind the RPC port.");
            }
            default -> sender.sendMessage("Usage: /buildengine <status|reload>");
        }
        return true;
    }
}
