/**
 * Edit history: undo, redo, and named checkpoints.
 *
 * `undo_build()` alone is not enough for real work. What a builder actually needs is to be able to
 * say "checkpoint this before I redesign the middle", try three things, compare them, and go back
 * to the one that worked. So there are two mechanisms with different costs:
 *
 *  - **Undo/redo** rides on the inverse patches the volume already records. Cheap — proportional to
 *    what an operation changed, not to the size of the map.
 *  - **Checkpoints** are full snapshots, deflated. A 300x80x300 map is 14 MB raw and typically well
 *    under 1 MB compressed, because voxel data is extremely repetitive. Expensive relative to a
 *    patch, cheap in absolute terms, and unlike a patch chain a checkpoint cannot drift.
 */

import { deflateSync, inflateSync } from "node:zlib";

import { type ChangeJournal, type Volume } from "../core/volume.js";
import { blockName } from "../mc18/blocks.js";

export interface HistoryEntry {
  readonly label: string;
  readonly journal: ChangeJournal;
  readonly blocksChanged: number;
  readonly index: number;
}

export interface Checkpoint {
  readonly name: string;
  readonly note?: string;
  /** Deflated snapshot of the volume's cells. */
  readonly data: Buffer;
  readonly cellCount: number;
  readonly solidBlocks: number;
  /** Position in the undo stack when the checkpoint was taken. */
  readonly historyDepth: number;
}

export interface CheckpointDiff {
  readonly from: string;
  readonly to: string;
  readonly cellsChanged: number;
  readonly added: number;
  readonly removed: number;
  readonly replaced: number;
  /** Net change per block type, largest movement first. */
  readonly byBlock: readonly { readonly block: string; readonly delta: number }[];
  readonly bounds:
    | { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
    | null;
}

export interface HistoryOptions {
  /** How many undo steps to keep. Older entries fall off the bottom. */
  readonly limit?: number;
}

export class History {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly limit: number;
  private counter = 0;

  constructor(
    private readonly volume: Volume,
    opts: HistoryOptions = {},
  ) {
    this.limit = opts.limit ?? 64;
  }

  /**
   * Run an operation as one undoable step.
   *
   * Anything that changed nothing is not pushed: an undo stack full of no-ops makes `undo` feel
   * broken, because the user presses it and nothing visible happens.
   */
  run<T>(label: string, fn: () => T): T {
    const { result, journal } = this.volume.withJournal(fn);
    if (journal.size > 0) {
      this.undoStack.push({ label, journal, blocksChanged: journal.size, index: this.counter++ });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      // Any new edit invalidates the redo branch, the same as every editor.
      this.redoStack.length = 0;
    }
    return result;
  }

  /** Record an already-captured journal as an undoable step. */
  push(label: string, journal: ChangeJournal): void {
    if (journal.size === 0) return;
    this.undoStack.push({ label, journal, blocksChanged: journal.size, index: this.counter++ });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undo the most recent step. Returns what was undone, or `null` if there was nothing. */
  undo(): { label: string; blocksRestored: number } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const inverse = this.volume.revert(entry.journal);
    this.redoStack.push({ ...entry, journal: inverse });
    return { label: entry.label, blocksRestored: entry.blocksChanged };
  }

  redo(): { label: string; blocksRestored: number } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const inverse = this.volume.revert(entry.journal);
    this.undoStack.push({ ...entry, journal: inverse });
    return { label: entry.label, blocksRestored: entry.blocksChanged };
  }

  /** Labels of the undoable steps, most recent last. */
  timeline(): { label: string; blocksChanged: number }[] {
    return this.undoStack.map((e) => ({ label: e.label, blocksChanged: e.blocksChanged }));
  }

  // -- Checkpoints -------------------------------------------------------------------------------

  createCheckpoint(name: string, note?: string): Checkpoint {
    const bytes = new Uint8Array(
      this.volume.cells.buffer,
      this.volume.cells.byteOffset,
      this.volume.cells.byteLength,
    );
    const checkpoint: Checkpoint = {
      name,
      note,
      data: deflateSync(Buffer.from(bytes), { level: 6 }),
      cellCount: this.volume.cellCount,
      solidBlocks: this.volume.countNonAir(),
      historyDepth: this.undoStack.length,
    };
    this.checkpoints.set(name, checkpoint);
    return checkpoint;
  }

  listCheckpoints(): { name: string; note?: string; solidBlocks: number; bytes: number }[] {
    return [...this.checkpoints.values()].map((c) => ({
      name: c.name,
      note: c.note,
      solidBlocks: c.solidBlocks,
      bytes: c.data.byteLength,
    }));
  }

  hasCheckpoint(name: string): boolean {
    return this.checkpoints.has(name);
  }

  /**
   * Restore a checkpoint.
   *
   * The restore itself is pushed as an undoable step, so returning to a checkpoint is not a
   * one-way door — a builder who restores by mistake can undo it.
   */
  restoreCheckpoint(name: string): { blocksChanged: number } {
    const checkpoint = this.requireCheckpoint(name);
    const restored = this.decode(checkpoint);
    return {
      blocksChanged: this.run(`restore checkpoint "${name}"`, () => {
        let changed = 0;
        for (let i = 0; i < this.volume.cells.length; i++) {
          const want = restored[i] ?? 0;
          if (this.volume.cells[i] === want) continue;
          const p = this.volume.positionOf(i);
          if (this.volume.setAt(p, want)) changed++;
        }
        return changed;
      }),
    };
  }

  /**
   * Compare two checkpoints, or a checkpoint against the current state.
   *
   * The per-block deltas are the useful part: "you added 4,200 pink wool and removed 3,100 quartz"
   * describes a redesign in a way a cell count never does.
   */
  compareCheckpoints(fromName: string, toName?: string): CheckpointDiff {
    const from = this.decode(this.requireCheckpoint(fromName));
    const to = toName ? this.decode(this.requireCheckpoint(toName)) : this.volume.cells;
    if (from.length !== to.length) {
      throw new Error(
        `Checkpoints "${fromName}" and "${toName ?? "current"}" cover different volumes (${from.length} vs ${to.length} cells)`,
      );
    }

    let added = 0;
    let removed = 0;
    let replaced = 0;
    const deltas = new Map<number, number>();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < from.length; i++) {
      const a = from[i]!;
      const b = to[i]!;
      if (a === b) continue;
      if (a === 0) added++;
      else if (b === 0) removed++;
      else replaced++;
      if (a !== 0) deltas.set(a, (deltas.get(a) ?? 0) - 1);
      if (b !== 0) deltas.set(b, (deltas.get(b) ?? 0) + 1);
      const p = this.volume.positionOf(i);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }

    return {
      from: fromName,
      to: toName ?? "current",
      cellsChanged: added + removed + replaced,
      added,
      removed,
      replaced,
      byBlock: [...deltas.entries()]
        .filter(([, d]) => d !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 16)
        .map(([block, delta]) => ({ block: blockName(block), delta })),
      bounds:
        minX === Infinity
          ? null
          : { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
    };
  }

  deleteCheckpoint(name: string): boolean {
    return this.checkpoints.delete(name);
  }

  private requireCheckpoint(name: string): Checkpoint {
    const found = this.checkpoints.get(name);
    if (!found) {
      const known = [...this.checkpoints.keys()];
      throw new Error(
        `No checkpoint named "${name}".` + (known.length ? ` Known: ${known.join(", ")}.` : " None have been created."),
      );
    }
    return found;
  }

  private decode(checkpoint: Checkpoint): Uint16Array {
    const raw = inflateSync(checkpoint.data);
    return new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  }
}
