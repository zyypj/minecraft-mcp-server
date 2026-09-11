/**
 * The build graph: permanent structure ids over a hierarchy of nested edits.
 *
 * Without this, a generated map is an undifferentiated block soup and the only available edit is
 * "regenerate everything". With it, the map is a tree —
 *
 * ```
 * BedWarsMap
 * +- TeamIsland[0]
 * |  +- Terrain
 * |  +- Building
 * |  |  +- Roof
 * |  +- Spawn
 * +- DiamondIsland[0..3]
 * +- Middle
 * ```
 *
 * — and "redo only the roofs of the team islands" is a real operation: find the nodes, revert their
 * journals, rebuild them from their recorded parameters, leave everything else byte-identical.
 *
 * Every node keeps three things that make that possible: the **inverse patch** of the writes it
 * made, the **parameters** it was built from, and its own **seed**. Delete is the inverse patch;
 * regenerate is the inverse patch followed by a rebuild from the parameters.
 */

import { type Region, region, vec } from "../core/vec.js";
import { hashSeed } from "../core/prng.js";
import { type ChangeJournal, type Volume } from "../core/volume.js";

export type StructureId = string;

export interface StructureNode {
  readonly id: StructureId;
  /** What kind of thing this is: `team_island`, `building`, `roof`, `sculpture`, `generator`... */
  readonly kind: string;
  readonly label?: string;
  readonly parent?: StructureId;
  readonly children: StructureId[];
  /** Tight bounds of what this node wrote, or `null` if it wrote nothing. */
  bounds: Region | null;
  /** Cells this node changed. */
  blocksPlaced: number;
  /** The parameters the node was built from, so it can be rebuilt. */
  readonly params: Record<string, unknown>;
  /** The seed this node's generation used. */
  readonly seed: number;
  /** Inverse patch of the node's writes. Cleared once the node is deleted. */
  journal: ChangeJournal | null;
  readonly createdAt: number;
}

export interface BeginOptions {
  readonly kind: string;
  readonly label?: string;
  readonly parent?: StructureId;
  readonly params?: Record<string, unknown>;
  readonly seed?: number;
}

/** Serializable form, for the build manifest. Journals are runtime-only. */
export interface StructureNodeJson {
  readonly id: StructureId;
  readonly kind: string;
  readonly label?: string;
  readonly parent?: StructureId;
  readonly children: readonly StructureId[];
  readonly bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  readonly blocksPlaced: number;
  readonly params: Record<string, unknown>;
  readonly seed: number;
}

export class BuildGraph {
  private readonly nodes = new Map<StructureId, StructureNode>();
  private readonly stack: StructureId[] = [];
  private counter = 0;

  constructor(
    private readonly volume: Volume,
    /** Seed for id generation, so ids are stable across identical runs. */
    private readonly idSeed: number | string = "build",
  ) {}

  /** The node currently being built, if any. */
  get current(): StructureNode | undefined {
    const id = this.stack[this.stack.length - 1];
    return id ? this.nodes.get(id) : undefined;
  }

  /**
   * Run `fn` as a named structure, recording everything it writes.
   *
   * The scoped form is the one to use: it guarantees the journal is closed even if the generator
   * throws, and it nests, so a caller can wrap a whole map and a single roof with the same call.
   */
  build<T>(opts: BeginOptions, fn: (node: StructureNode) => T): { id: StructureId; result: T; node: StructureNode } {
    const id = this.nextId(opts.kind);
    const parent = opts.parent ?? this.stack[this.stack.length - 1];
    const node: StructureNode = {
      id,
      kind: opts.kind,
      label: opts.label,
      parent,
      children: [],
      bounds: null,
      blocksPlaced: 0,
      params: opts.params ?? {},
      seed: opts.seed ?? hashSeed(`${this.idSeed}:${id}`),
      journal: null,
      createdAt: this.counter,
    };
    this.nodes.set(id, node);
    if (parent) this.nodes.get(parent)?.children.push(id);

    this.stack.push(id);
    try {
      const { result, journal } = this.volume.withJournal(() => fn(node));
      node.journal = journal;
      node.blocksPlaced = journal.size;
      node.bounds = boundsOf(this.volume, journal);
      return { id, result, node };
    } finally {
      this.stack.pop();
    }
  }

  private nextId(kind: string): StructureId {
    // Short, stable, human-quotable: `structure_a91f2`. Derived from the seed and an ordinal, so
    // the same generation run produces the same ids.
    const hash = hashSeed(`${this.idSeed}:${kind}:${this.counter++}`);
    return `structure_${hash.toString(16).padStart(8, "0").slice(0, 5)}`;
  }

  get(id: StructureId): StructureNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`No structure "${id}" in this build. Known ids: ${[...this.nodes.keys()].slice(0, 12).join(", ")}`);
    }
    return node;
  }

  has(id: StructureId): boolean {
    return this.nodes.has(id);
  }

  all(): StructureNode[] {
    return [...this.nodes.values()];
  }

  /** Every node of a kind, in creation order. */
  ofKind(kind: string): StructureNode[] {
    return this.all()
      .filter((n) => n.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  children(id: StructureId): StructureNode[] {
    return this.get(id).children.map((c) => this.get(c));
  }

  /** The node and all its descendants, deepest last. */
  subtree(id: StructureId): StructureNode[] {
    const out: StructureNode[] = [];
    const walk = (current: StructureId): void => {
      const node = this.get(current);
      out.push(node);
      for (const child of node.children) walk(child);
    };
    walk(id);
    return out;
  }

  /**
   * Undo a structure's writes, and its descendants' along with it.
   *
   * Children are reverted first (deepest first), because a child's journal records the state a
   * parent's write left behind; reverting the parent first would restore cells the child then
   * un-restores to the wrong value.
   */
  delete(id: StructureId): number {
    const nodes = this.subtree(id).reverse();
    let reverted = 0;
    for (const node of nodes) {
      if (node.journal) {
        reverted += node.journal.size;
        this.volume.revert(node.journal);
        node.journal = null;
      }
      node.blocksPlaced = 0;
      node.bounds = null;
    }
    // Detach from the parent, but keep the nodes so ids stay resolvable and errors stay useful.
    const root = this.get(id);
    if (root.parent && this.nodes.has(root.parent)) {
      const siblings = this.nodes.get(root.parent)!.children;
      const index = siblings.indexOf(id);
      if (index >= 0) siblings.splice(index, 1);
    }
    return reverted;
  }

  /**
   * Rebuild one structure in place.
   *
   * Reverts the subtree, then re-runs `fn` under a fresh journal attached to the same id, so
   * references to that id elsewhere stay valid. `params` are merged into the node's recorded
   * parameters, which is how "make this roof a dome instead" works without touching anything else.
   */
  regenerate<T>(
    id: StructureId,
    fn: (node: StructureNode) => T,
    paramOverrides?: Record<string, unknown>,
  ): T {
    const node = this.get(id);
    this.delete(id);
    // Drop the stale child ids: the rebuild creates its own.
    node.children.length = 0;
    if (paramOverrides) Object.assign(node.params, paramOverrides);
    if (node.parent && this.nodes.has(node.parent)) {
      const siblings = this.nodes.get(node.parent)!.children;
      if (!siblings.includes(id)) siblings.push(id);
    }

    this.stack.push(id);
    try {
      const { result, journal } = this.volume.withJournal(() => fn(node));
      node.journal = journal;
      node.blocksPlaced = journal.size;
      node.bounds = boundsOf(this.volume, journal);
      return result;
    } finally {
      this.stack.pop();
    }
  }

  toJson(): StructureNodeJson[] {
    return this.all()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        parent: n.parent,
        children: [...n.children],
        bounds: n.bounds
          ? {
              min: { x: n.bounds.min.x, y: n.bounds.min.y, z: n.bounds.min.z },
              max: { x: n.bounds.max.x, y: n.bounds.max.y, z: n.bounds.max.z },
            }
          : null,
        blocksPlaced: n.blocksPlaced,
        params: n.params,
        seed: n.seed,
      }));
  }

  /** An indented outline of the tree, for a report or a tool response. */
  toOutline(rootId?: StructureId): string[] {
    const roots = rootId ? [this.get(rootId)] : this.all().filter((n) => !n.parent);
    const lines: string[] = [];
    const walk = (node: StructureNode, depth: number): void => {
      const size = node.bounds
        ? `${node.bounds.max.x - node.bounds.min.x + 1}x${node.bounds.max.y - node.bounds.min.y + 1}x${node.bounds.max.z - node.bounds.min.z + 1}`
        : "empty";
      lines.push(
        `${"  ".repeat(depth)}${node.id}  ${node.kind}${node.label ? ` "${node.label}"` : ""}  ${node.blocksPlaced} blocks  ${size}`,
      );
      for (const child of node.children) walk(this.get(child), depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return lines;
  }
}

function boundsOf(vol: Volume, journal: ChangeJournal): Region | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const { index } of journal.entries()) {
    const p = vol.positionOf(index);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (minX === Infinity) return null;
  return region(vec(minX, minY, minZ), vec(maxX, maxY, maxZ));
}
