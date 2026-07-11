package com.mcbuild.buildengine.model;

/**
 * Shared edit {@code options} flags (§3.3), mirroring the GDMC-style flag set.
 *
 * <p>{@code notifyClients} must default {@code true} or placed blocks stay invisible to
 * connected players. {@code budgetPerTick} is only honoured by the main-thread Bukkit editor;
 * the FAWE editor ignores it (§3.4).
 */
public record RpcOptions(
        boolean physics,
        boolean updateLighting,
        boolean notifyClients,
        boolean spawnDrops,
        Integer budgetPerTick // nullable: fall back to config default
) {

    /** §3.3 defaults: {@code physics:false, updateLighting:true, notifyClients:true, spawnDrops:false}. */
    public static RpcOptions defaults() {
        return new RpcOptions(false, true, true, false, null);
    }

    /** Effective per-tick budget: the caller-supplied override, else the provided fallback. */
    public int budgetOr(int fallback) {
        return (budgetPerTick == null || budgetPerTick <= 0) ? fallback : budgetPerTick;
    }
}
