package com.mcbuild.buildengine.model;

import java.util.List;

/**
 * An engine-authored change set and its inverse (§7.4).
 *
 * <p><b>The engine's {@code worldDiff} is the single source of truth for build-level undo</b> — FAWE is
 * only the <em>write mechanism</em> ({@code applyDiff}/{@code undoDiff} RPCs), never a second history
 * (§3.1, §7.4). {@code applyDiff} writes {@code after}; {@code undoDiff} writes {@code before}. The
 * plugin stores no history of its own.
 *
 * @param id     stable diff id (undo/redo key)
 * @param world  target world
 * @param before exact prior block states the commit overwrote (the inverse patch)
 * @param after  block states the commit wrote
 */
public record WorldDiff(
        String id,
        String world,
        List<BlockChange> before,
        List<BlockChange> after
) {}
