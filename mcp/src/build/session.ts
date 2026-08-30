/**
 * The build session: the mutable state the build tools operate on.
 *
 * An agent works on *a build*, not on a pile of disconnected calls. The session holds the voxel
 * volume it is editing, the structure graph that gives every piece a permanent id, the edit history
 * that makes undo and checkpoints possible, the palette it is building in, and the style library it
 * can consult. Tools name a build by id; everything else is implicit.
 *
 * Nothing here touches a Minecraft server. A build lives in memory until it is exported, which is
 * what makes "look at the preview before it goes live" the default rather than an extra step.
 */

import { randomUUID } from "node:crypto";

import {
  BuildGraph,
  History,
  Palette,
  StyleLibrary,
  Volume,
  type AnalysisPoint,
  type BedwarsLayout,
  type BedwarsSpec,
  type Clipboard,
  type PaletteJson,
  defaultBedwarsPalette,
} from "@mcbuild/engine";

export interface BuildSessionInit {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly seed?: number;
  readonly palette?: Palette;
  readonly volume?: Volume;
  /**
   * An existing structure graph to adopt.
   *
   * A domain generator builds its own graph while journaling into its own volume. Handing both over
   * is what keeps `list_structures`, `delete_structure` and `regenerate_structure` working on a
   * generated map — without it, "redo only the roofs of the team islands" would be impossible on
   * exactly the builds where it matters most.
   */
  readonly graph?: BuildGraph;
}

/** One build an agent is working on. */
export class BuildSession {
  readonly id: string;
  name: string;
  readonly volume: Volume;
  readonly graph: BuildGraph;
  readonly history: History;
  palette: Palette;
  readonly seed: number;
  readonly createdAt: string;

  /** Gameplay layout, when this build came from a domain generator. */
  layout?: BedwarsLayout;
  points: AnalysisPoint[] = [];
  spec?: BedwarsSpec | Record<string, unknown>;
  theme?: string;
  styleId?: string;

  /** The most recent copy, so paste does not need the caller to hold the blocks. */
  clipboard?: Clipboard;

  constructor(init: BuildSessionInit) {
    this.id = `build_${randomUUID().slice(0, 8)}`;
    this.name = init.name;
    this.seed = init.seed ?? 0;
    this.volume = init.volume ?? Volume.of(init.width, init.height, init.length);
    this.graph = init.graph ?? new BuildGraph(this.volume, this.seed);
    this.history = new History(this.volume, { limit: 96 });
    this.palette = init.palette ?? defaultBedwarsPalette();
    this.createdAt = new Date().toISOString();
  }

  summary(): string {
    const solid = this.volume.countNonAir();
    const parts = [
      `${this.id} "${this.name}"`,
      `${this.volume.width}x${this.volume.height}x${this.volume.length}`,
      `${solid.toLocaleString("en-US")} blocks`,
      `palette ${this.palette.id}`,
      `seed ${this.seed}`,
    ];
    if (this.theme) parts.push(`theme ${this.theme}`);
    if (this.styleId) parts.push(`style ${this.styleId}`);
    return parts.join(" | ");
  }
}

/**
 * Every open build, plus the style library.
 *
 * A single active build is tracked so tools can omit `build` in the common case, which keeps the
 * call sites short without hiding which build is being edited — every response names it.
 */
export class BuildWorkspace {
  private readonly builds = new Map<string, BuildSession>();
  private activeId: string | null = null;

  constructor(
    /** Where build folders are written. */
    readonly buildsDir: string,
    /** Where the style knowledge base lives. */
    readonly library: StyleLibrary,
  ) {}

  create(init: BuildSessionInit): BuildSession {
    const session = new BuildSession(init);
    this.builds.set(session.id, session);
    this.activeId = session.id;
    return session;
  }

  add(session: BuildSession): BuildSession {
    this.builds.set(session.id, session);
    this.activeId = session.id;
    return session;
  }

  /** Resolve a build by id, falling back to the active one. Throws with a useful list. */
  require(id?: string): BuildSession {
    const wanted = id ?? this.activeId;
    if (!wanted) {
      throw new Error(
        "No build is open. Create one with `create_build`, or generate one with `build_bedwars_map`.",
      );
    }
    const found = this.builds.get(wanted);
    if (!found) {
      const known = [...this.builds.values()].map((b) => `${b.id} (${b.name})`);
      throw new Error(
        `No build "${wanted}".` + (known.length ? ` Open builds: ${known.join(", ")}.` : " None are open."),
      );
    }
    if (!id) return found;
    this.activeId = wanted;
    return found;
  }

  select(id: string): BuildSession {
    const session = this.require(id);
    this.activeId = session.id;
    return session;
  }

  list(): BuildSession[] {
    return [...this.builds.values()];
  }

  get active(): BuildSession | undefined {
    return this.activeId ? this.builds.get(this.activeId) : undefined;
  }

  close(id: string): boolean {
    const removed = this.builds.delete(id);
    if (this.activeId === id) this.activeId = this.list()[0]?.id ?? null;
    return removed;
  }
}

/** Parse a palette supplied inline by a tool call. */
export function paletteFromJson(json: unknown, fallback: Palette): Palette {
  if (!json || typeof json !== "object") return fallback;
  return Palette.fromJson(json as PaletteJson);
}
