/**
 * Structural inspection — finding the mistakes that survive a pretty render.
 *
 * A preview image shows silhouette and colour. It does not show a block floating three metres off
 * the island, a sealed air pocket a player can suffocate in, a one-block hole in a roof, or a
 * decoration that quietly bridges two islands that were supposed to be separated by void. Those
 * come out of the geometry, and every one of them is a real bug that reaches the server.
 *
 * Each check answers a question with a number, not a vibe, so the report is actionable.
 */

import { NEIGHBORS_26, NEIGHBORS_6, type Region, type Vec3, vec } from "../core/vec.js";
import { AIR, type Volume } from "../core/volume.js";
import { BLOCKS_BY_ID, blockName, isStandable, renderClass } from "../mc18/blocks.js";
import { measureMirrorSymmetry } from "../ops/symmetry.js";

export type IssueKind =
  | "floating_cluster"
  | "isolated_block"
  | "sealed_pocket"
  | "surface_hole"
  | "unknown_block"
  | "exposed_interior"
  | "unintended_bridge"
  | "suffocation_risk"
  | "asymmetry"
  | "block_budget";

export interface Issue {
  readonly kind: IssueKind;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly count: number;
  /** Up to a handful of example positions, so a builder can go look. */
  readonly samples: readonly Vec3[];
}

export interface InspectOptions {
  readonly region?: Region;
  /** A detached mass smaller than this is reported as floating debris. */
  readonly floatingClusterMax?: number;
  /** Report a warning above this many blocks. */
  readonly blockBudget?: number;
  /** Expected symmetry axis, if the build should have one. */
  readonly expectSymmetry?: "x" | "z";
  readonly symmetryThreshold?: number;
  /** Cap on how many samples each issue keeps. */
  readonly maxSamples?: number;
}

export interface InspectionReport {
  readonly issues: readonly Issue[];
  readonly stats: {
    readonly solidBlocks: number;
    readonly distinctBlocks: number;
    readonly components: number;
    readonly largestComponent: number;
    readonly symmetryX: number;
    readonly symmetryZ: number;
  };
  readonly ok: boolean;
}

/** Run every structural check over a volume. */
export function inspectRegion(vol: Volume, opts: InspectOptions = {}): InspectionReport {
  const maxSamples = opts.maxSamples ?? 8;
  const issues: Issue[] = [];

  const { components, largest, floating } = findComponents(vol, opts.floatingClusterMax ?? 40);
  const solid = vol.countNonAir();
  const histogram = vol.histogram();

  if (floating.length > 0) {
    issues.push({
      kind: "floating_cluster",
      severity: "warning",
      message:
        `${floating.length} detached ${floating.length === 1 ? "mass" : "masses"} are not connected to the main build. ` +
        "On a floating-island map some of this is intentional; anything under a handful of blocks is usually debris.",
      count: floating.length,
      samples: floating.slice(0, maxSamples).map((f) => f.sample),
    });
  }

  const isolated = findIsolatedBlocks(vol, maxSamples);
  if (isolated.count > 0) {
    issues.push({
      kind: "isolated_block",
      severity: "warning",
      message: `${isolated.count} blocks have no solid neighbour at all — single floating blocks read as a glitch`,
      count: isolated.count,
      samples: isolated.samples,
    });
  }

  const pockets = findSealedPockets(vol, maxSamples);
  if (pockets.count > 0) {
    issues.push({
      kind: "sealed_pocket",
      severity: pockets.count > 40 ? "warning" : "info",
      message:
        `${pockets.count} air cells are completely sealed inside solid material across ${pockets.regions} pockets. ` +
        "Harmless in terrain; inside a building it means an interior nobody can reach.",
      count: pockets.count,
      samples: pockets.samples,
    });
  }

  const holes = findSurfaceHoles(vol, maxSamples);
  if (holes.count > 0) {
    issues.push({
      kind: "surface_hole",
      severity: "warning",
      message: `${holes.count} single-cell holes in otherwise solid surfaces — most often a missed block in a roof or wall`,
      count: holes.count,
      samples: holes.samples,
    });
  }

  const suffocation = findSuffocationRisks(vol, maxSamples);
  if (suffocation.count > 0) {
    issues.push({
      kind: "suffocation_risk",
      severity: "warning",
      message:
        `${suffocation.count} standable positions have less than two blocks of headroom. ` +
        "A player who lands there takes suffocation damage.",
      count: suffocation.count,
      samples: suffocation.samples,
    });
  }

  const unknown = findUnknownBlocks(vol, maxSamples);
  if (unknown.count > 0) {
    issues.push({
      kind: "unknown_block",
      severity: "error",
      message:
        `${unknown.count} cells use block ids that do not exist in Minecraft 1.8 (${unknown.names.join(", ")}). ` +
        "These will not load correctly on a 1.8 server.",
      count: unknown.count,
      samples: unknown.samples,
    });
  }

  const symmetryX = Math.round(measureMirrorSymmetry(vol, "x") * 1000) / 1000;
  const symmetryZ = Math.round(measureMirrorSymmetry(vol, "z") * 1000) / 1000;
  if (opts.expectSymmetry) {
    const score = opts.expectSymmetry === "x" ? symmetryX : symmetryZ;
    const threshold = opts.symmetryThreshold ?? 0.95;
    if (score < threshold) {
      issues.push({
        kind: "asymmetry",
        severity: "error",
        message: `Mirror symmetry about ${opts.expectSymmetry.toUpperCase()} is ${(score * 100).toFixed(1)}%, below the expected ${(threshold * 100).toFixed(1)}% — teams do not have equal maps`,
        count: 1,
        samples: [],
      });
    }
  }

  if (opts.blockBudget !== undefined && solid > opts.blockBudget) {
    issues.push({
      kind: "block_budget",
      severity: "warning",
      message: `${solid} blocks exceeds the budget of ${opts.blockBudget}; large schematics are slow to paste and can time out`,
      count: solid - opts.blockBudget,
      samples: [],
    });
  }

  return {
    issues,
    stats: {
      solidBlocks: solid,
      distinctBlocks: histogram.size,
      components,
      largestComponent: largest,
      symmetryX,
      symmetryZ,
    },
    ok: !issues.some((i) => i.severity === "error"),
  };
}

/**
 * Connected components over solid cells, 26-connected.
 *
 * 26-connectivity rather than 6 on purpose: two islands joined only by a diagonal touch are, for a
 * player, still two islands, but for structural purposes a diagonally-touching decoration is
 * attached and should not be reported as floating.
 */
function findComponents(
  vol: Volume,
  floatingMax: number,
): { components: number; largest: number; floating: { size: number; sample: Vec3 }[] } {
  const seen = new Uint8Array(vol.cellCount);
  const sizes: { size: number; sample: Vec3 }[] = [];

  for (let i = 0; i < vol.cells.length; i++) {
    if (vol.cells[i] === AIR || seen[i]) continue;
    const start = vol.positionOf(i);
    const stack: Vec3[] = [start];
    seen[i] = 1;
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      for (const d of NEIGHBORS_26) {
        const q = vec(p.x + d.x, p.y + d.y, p.z + d.z);
        if (!vol.containsPoint(q)) continue;
        const qi = vol.index(q.x, q.y, q.z);
        if (seen[qi] || vol.cells[qi] === AIR) continue;
        seen[qi] = 1;
        stack.push(q);
      }
    }
    sizes.push({ size, sample: start });
  }

  sizes.sort((a, b) => b.size - a.size);
  const largest = sizes[0]?.size ?? 0;
  return {
    components: sizes.length,
    largest,
    floating: sizes.slice(1).filter((s) => s.size <= floatingMax),
  };
}

function findIsolatedBlocks(vol: Volume, maxSamples: number): { count: number; samples: Vec3[] } {
  let count = 0;
  const samples: Vec3[] = [];
  for (const { pos } of vol.iterateSolid()) {
    let neighbours = 0;
    for (const d of NEIGHBORS_26) {
      if (vol.get(pos.x + d.x, pos.y + d.y, pos.z + d.z) !== AIR) {
        neighbours++;
        break;
      }
    }
    if (neighbours === 0) {
      count++;
      if (samples.length < maxSamples) samples.push(pos);
    }
  }
  return { count, samples };
}

/**
 * Air cells that cannot reach the outside.
 *
 * Found by flooding from the volume's boundary inward: whatever the flood does not reach is sealed.
 * This is the check that catches a building whose interior got walled in by a later pass.
 */
function findSealedPockets(
  vol: Volume,
  maxSamples: number,
): { count: number; regions: number; samples: Vec3[] } {
  const reached = new Uint8Array(vol.cellCount);
  const stack: number[] = [];

  const push = (x: number, y: number, z: number): void => {
    if (!vol.inBounds(x, y, z)) return;
    const i = vol.index(x, y, z);
    if (reached[i] || vol.cells[i] !== AIR) return;
    reached[i] = 1;
    stack.push(i);
  };

  for (let y = 0; y < vol.height; y++) {
    for (let z = 0; z < vol.length; z++) {
      push(0, y, z);
      push(vol.width - 1, y, z);
    }
    for (let x = 0; x < vol.width; x++) {
      push(x, y, 0);
      push(x, y, vol.length - 1);
    }
  }
  for (let z = 0; z < vol.length; z++) {
    for (let x = 0; x < vol.width; x++) {
      push(x, 0, z);
      push(x, vol.height - 1, z);
    }
  }

  while (stack.length > 0) {
    const p = vol.positionOf(stack.pop()!);
    for (const d of NEIGHBORS_6) push(p.x + d.x, p.y + d.y, p.z + d.z);
  }

  let count = 0;
  let regions = 0;
  const samples: Vec3[] = [];
  const counted = new Uint8Array(vol.cellCount);
  for (let i = 0; i < vol.cells.length; i++) {
    if (vol.cells[i] !== AIR || reached[i] || counted[i]) continue;
    regions++;
    const seed = vol.positionOf(i);
    if (samples.length < maxSamples) samples.push(seed);
    // Walk this pocket so it is counted once as a region, not once per cell.
    const local: number[] = [i];
    counted[i] = 1;
    while (local.length > 0) {
      const p = vol.positionOf(local.pop()!);
      count++;
      for (const d of NEIGHBORS_6) {
        const q = vec(p.x + d.x, p.y + d.y, p.z + d.z);
        if (!vol.containsPoint(q)) continue;
        const qi = vol.index(q.x, q.y, q.z);
        if (counted[qi] || reached[qi] || vol.cells[qi] !== AIR) continue;
        counted[qi] = 1;
        local.push(qi);
      }
    }
  }
  return { count, regions, samples };
}

/** Single air cells surrounded on five or six sides by solid — a missed block, not a window. */
function findSurfaceHoles(vol: Volume, maxSamples: number): { count: number; samples: Vec3[] } {
  let count = 0;
  const samples: Vec3[] = [];
  for (const p of vol.iterate()) {
    if (vol.getAt(p) !== AIR) continue;
    let solid = 0;
    for (const d of NEIGHBORS_6) {
      if (vol.get(p.x + d.x, p.y + d.y, p.z + d.z) !== AIR) solid++;
    }
    if (solid >= 5) {
      count++;
      if (samples.length < maxSamples) samples.push(p);
    }
  }
  return { count, samples };
}

/** Standable spots with a ceiling directly above — a player there takes suffocation damage. */
function findSuffocationRisks(vol: Volume, maxSamples: number): { count: number; samples: Vec3[] } {
  let count = 0;
  const samples: Vec3[] = [];
  for (let z = 0; z < vol.length; z++) {
    for (let x = 0; x < vol.width; x++) {
      for (let y = 1; y < vol.height - 2; y++) {
        if (!isStandable(vol.get(x, y, z))) continue;
        const head = vol.get(x, y + 1, z);
        const above = vol.get(x, y + 2, z);
        if (head !== AIR || above === AIR || renderClass(above) !== "cube") continue;
        // Only count it if a player could walk in. Under a natural overhang every cell technically
        // has a ceiling; the ones that matter are the ones with an open approach at head height.
        let openSides = 0;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          if (vol.get(x + dx, y + 1, z + dz) === AIR && vol.get(x + dx, y + 2, z + dz) === AIR) {
            openSides++;
          }
        }
        if (openSides === 0) continue;
        count++;
        if (samples.length < maxSamples) samples.push(vec(x, y + 1, z));
      }
    }
  }
  return { count, samples };
}

function findUnknownBlocks(
  vol: Volume,
  maxSamples: number,
): { count: number; samples: Vec3[]; names: string[] } {
  let count = 0;
  const samples: Vec3[] = [];
  const names = new Set<string>();
  for (const { pos, block } of vol.iterateSolid()) {
    const id = (block >> 4) & 0xfff;
    if (BLOCKS_BY_ID.has(id)) continue;
    count++;
    names.add(blockName(block));
    if (samples.length < maxSamples) samples.push(pos);
  }
  return { count, samples, names: [...names].slice(0, 8) };
}

/** Render an inspection report as lines a person or an agent can read. */
export function formatInspection(report: InspectionReport): string[] {
  const lines: string[] = [
    `${report.stats.solidBlocks} blocks, ${report.stats.distinctBlocks} distinct types, ${report.stats.components} connected masses (largest ${report.stats.largestComponent})`,
    `Mirror symmetry: X ${(report.stats.symmetryX * 100).toFixed(1)}%, Z ${(report.stats.symmetryZ * 100).toFixed(1)}%`,
  ];
  if (report.issues.length === 0) {
    lines.push("No structural issues found.");
    return lines;
  }
  for (const issue of report.issues) {
    const where =
      issue.samples.length > 0
        ? ` e.g. ${issue.samples
            .slice(0, 3)
            .map((s) => `(${s.x},${s.y},${s.z})`)
            .join(" ")}`
        : "";
    lines.push(`[${issue.severity}] ${issue.kind}: ${issue.message}${where}`);
  }
  return lines;
}
