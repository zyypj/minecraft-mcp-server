/**
 * Gameplay analysis: pathfinding, bridging cost, and the BedWars report.
 *
 * A map is competitive or it is not, and the answer is arithmetic: how far is a rush, how far is
 * the diamond island, who has the height advantage, how exposed to void is the route. This module
 * computes those numbers from the voxels so the question can be settled before anyone opens
 * Minecraft.
 *
 * Two distance metrics, and the difference between them is the whole point:
 *
 *  - **Walk distance** — the real path a player can take over existing blocks, from a Dijkstra
 *    search over standable positions with Minecraft's own movement rules (step up 1, fall up to 3).
 *  - **Bridge cost** — when there is no walkable path, how many blocks a player must place, computed
 *    for straight, diagonal and staircase bridging separately, because those are three different
 *    amounts of resources and three different amounts of time.
 */

import { type Vec3, distanceXZ, vec } from "../core/vec.js";
import { AIR, type Volume } from "../core/volume.js";
import { isObstructing, isStandable } from "../mc18/blocks.js";

// -- Walkability ---------------------------------------------------------------------------------

/** Can a player stand with their feet at `p`? */
export function isStandingSpot(vol: Volume, p: Vec3): boolean {
  if (p.y <= 0) return false;
  if (!isStandable(vol.get(p.x, p.y - 1, p.z))) return false;
  return !isObstructing(vol.getAt(p)) && !isObstructing(vol.get(p.x, p.y + 1, p.z));
}

export interface WalkPathOptions {
  /** How far a player may step up without jumping over a gap. Minecraft allows 1. */
  readonly maxStepUp?: number;
  /** How far a player may fall without damage. 3 is the safe limit. */
  readonly maxFall?: number;
  /** Allow diagonal movement. Players can, so this defaults on. */
  readonly diagonal?: boolean;
  /** Search budget. A map-sized search visits tens of thousands of nodes; this bounds the worst case. */
  readonly maxNodes?: number;
  /** Snap the start and goal down to the nearest standable spot within this many blocks. */
  readonly snapRadius?: number;
}

export interface PathResult {
  readonly reachable: boolean;
  /** Number of moves. Diagonal moves count as one, as they do in play. */
  readonly steps: number;
  /** Straight-line horizontal distance, for comparison. */
  readonly directDistance: number;
  /** How much longer the walk is than the straight line. 1 means a clear run. */
  readonly detourRatio: number;
  readonly path: readonly Vec3[];
  readonly nodesVisited: number;
}

/**
 * Shortest walkable path between two points.
 *
 * Dijkstra over standable positions rather than A*: the heuristic gains little on a map-sized
 * search that is mostly open, and exact costs make the "is there any path at all" answer
 * trustworthy, which is the question that actually matters here.
 */
export function findWalkPath(vol: Volume, from: Vec3, to: Vec3, opts: WalkPathOptions = {}): PathResult {
  const maxStepUp = opts.maxStepUp ?? 1;
  const maxFall = opts.maxFall ?? 3;
  const diagonal = opts.diagonal ?? true;
  const maxNodes = opts.maxNodes ?? 400_000;
  const snapRadius = opts.snapRadius ?? 6;

  const start = snapToGround(vol, from, snapRadius);
  const goal = snapToGround(vol, to, snapRadius);
  const direct = distanceXZ(from, to);
  if (!start || !goal) {
    return { reachable: false, steps: 0, directDistance: direct, detourRatio: Infinity, path: [], nodesVisited: 0 };
  }

  const key = (p: Vec3): number => vol.index(p.x, p.y, p.z);
  const dist = new Map<number, number>();
  const prev = new Map<number, Vec3>();
  // A bucket queue keyed by integer cost: every move costs 1, so this is a plain BFS frontier and
  // needs no heap.
  let frontier: Vec3[] = [start];
  dist.set(key(start), 0);
  let steps = 0;
  let visited = 0;
  const goalKey = key(goal);

  const offsets: [number, number][] = diagonal
    ? [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]
    : [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];

  while (frontier.length > 0 && visited < maxNodes) {
    const next: Vec3[] = [];
    for (const current of frontier) {
      visited++;
      if (key(current) === goalKey) {
        return buildResult(current, prev, dist, direct, visited);
      }
      for (const [dx, dz] of offsets) {
        const target = stepTo(vol, current, dx, dz, maxStepUp, maxFall);
        if (!target) continue;
        const k = key(target);
        if (dist.has(k)) continue;
        dist.set(k, steps + 1);
        prev.set(k, current);
        next.push(target);
      }
    }
    frontier = next;
    steps++;
  }

  return { reachable: false, steps: 0, directDistance: direct, detourRatio: Infinity, path: [], nodesVisited: visited };

  function buildResult(
    end: Vec3,
    parents: Map<number, Vec3>,
    costs: Map<number, number>,
    directDistance: number,
    nodesVisited: number,
  ): PathResult {
    const path: Vec3[] = [end];
    let cursor = end;
    for (;;) {
      const parent = parents.get(key(cursor));
      if (!parent) break;
      path.push(parent);
      cursor = parent;
    }
    path.reverse();
    const total = costs.get(key(end)) ?? path.length - 1;
    return {
      reachable: true,
      steps: total,
      directDistance: Math.round(directDistance * 10) / 10,
      detourRatio: directDistance <= 0 ? 1 : Math.round((total / directDistance) * 100) / 100,
      path,
      nodesVisited,
    };
  }
}

/** Where a player ends up moving one cell horizontally, accounting for step-up and fall. */
function stepTo(
  vol: Volume,
  from: Vec3,
  dx: number,
  dz: number,
  maxStepUp: number,
  maxFall: number,
): Vec3 | null {
  const x = from.x + dx;
  const z = from.z + dz;
  if (!vol.inBounds(x, from.y, z)) return null;
  // Diagonal moves must not cut a corner through a solid block.
  if (dx !== 0 && dz !== 0) {
    if (isObstructing(vol.get(from.x + dx, from.y, from.z)) && isObstructing(vol.get(from.x, from.y, from.z + dz))) {
      return null;
    }
  }
  for (let up = maxStepUp; up >= 0; up--) {
    const candidate = vec(x, from.y + up, z);
    if (isStandingSpot(vol, candidate)) {
      // Stepping up requires headroom above the origin too.
      if (up > 0 && isObstructing(vol.get(from.x, from.y + 2, from.z))) continue;
      return candidate;
    }
  }
  for (let down = 1; down <= maxFall; down++) {
    const candidate = vec(x, from.y - down, z);
    if (!vol.inBounds(x, candidate.y, z)) break;
    if (isStandingSpot(vol, candidate)) return candidate;
  }
  return null;
}

function snapToGround(vol: Volume, p: Vec3, radius: number): Vec3 | null {
  if (isStandingSpot(vol, p)) return p;
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const q = vec(p.x + dx, p.y + dy, p.z + dz);
          if (vol.containsPoint(q) && isStandingSpot(vol, q)) return q;
        }
      }
    }
  }
  return null;
}

// -- Bridging ------------------------------------------------------------------------------------

export interface BridgeEstimate {
  readonly horizontalDistance: number;
  readonly verticalDelta: number;
  /** Blocks needed bridging along the axes only (the safe, slow way). */
  readonly straightBlocks: number;
  /** Blocks needed bridging diagonally (fewer blocks, harder to walk). */
  readonly diagonalBlocks: number;
  /** Extra blocks needed to gain or lose the height difference as a staircase. */
  readonly staircaseBlocks: number;
  /** The cheapest total a competent player would actually spend. */
  readonly minimumBlocks: number;
  /** Rough seconds at typical sprint-bridge speed. */
  readonly estimatedSeconds: number;
}

/**
 * Estimate what it costs to bridge between two points.
 *
 * Euclidean distance is the wrong number for BedWars: bridging is a block-by-block action, so what
 * matters is how many blocks the player must carry and how long they are exposed. Diagonal bridging
 * covers a straight-line gap in `max(|dx|,|dz|)` blocks rather than `|dx|+|dz|`, which is often a
 * third fewer wool — the difference between one purchase and two.
 */
export function estimateBridge(from: Vec3, to: Vec3): BridgeEstimate {
  const dx = Math.abs(to.x - from.x);
  const dz = Math.abs(to.z - from.z);
  const dy = to.y - from.y;
  const horizontal = Math.round(Math.hypot(dx, dz) * 10) / 10;

  const straight = dx + dz;
  const diagonal = Math.max(dx, dz);
  // Going up costs one extra block per level (the block you stand on); going down costs nothing.
  const staircase = Math.max(0, dy);
  const minimum = diagonal + staircase;
  // Sprint-bridging runs at roughly 4.3 blocks/second; placing blocks while climbing is slower.
  const seconds = Math.round((diagonal / 4.3 + staircase / 2.2) * 10) / 10;

  return {
    horizontalDistance: horizontal,
    verticalDelta: dy,
    straightBlocks: straight + staircase,
    diagonalBlocks: diagonal,
    staircaseBlocks: staircase,
    minimumBlocks: minimum,
    estimatedSeconds: seconds,
  };
}

// -- The BedWars report --------------------------------------------------------------------------

export interface AnalysisPoint {
  readonly label: string;
  readonly pos: Vec3;
  /** `team`, `diamond`, `emerald`, `mid`, `shop`... */
  readonly role: string;
  /** Team index, for team-scoped points. */
  readonly team?: number;
}

export interface RouteAnalysis {
  readonly from: string;
  readonly to: string;
  readonly directDistance: number;
  readonly walkable: boolean;
  readonly walkSteps?: number;
  readonly bridge: BridgeEstimate;
}

export interface BedwarsAnalysis {
  readonly teams: number;
  readonly routes: readonly RouteAnalysis[];
  readonly rushDistance: { readonly min: number; readonly max: number; readonly mean: number; readonly spread: number };
  readonly baseToDiamond: { readonly min: number; readonly max: number; readonly mean: number };
  readonly diamondToMid: { readonly min: number; readonly max: number; readonly mean: number };
  /** Height of each team's base relative to the mean, so an unfair height advantage is visible. */
  readonly heightAdvantage: readonly { readonly team: string; readonly delta: number }[];
  /** Share of the map footprint that is empty void. */
  readonly voidExposure: number;
  readonly symmetry: number;
  /** Positions high above their surroundings with only one approach. */
  readonly campingSpots: readonly Vec3[];
  /** Gaps of 2-4 blocks between platforms, which players will treat as a jump route. */
  readonly unintendedJumps: readonly { readonly from: Vec3; readonly to: Vec3; readonly gap: number }[];
  readonly warnings: readonly string[];
}

export interface AnalyzeGameplayOptions {
  readonly points: readonly AnalysisPoint[];
  readonly teams: number;
  /** Run the (much slower) walkable-path search as well as the straight-line estimates. */
  readonly walkPaths?: boolean;
  readonly symmetryScore?: number;
}

/** Produce the competitive report for a BedWars map. */
export function analyzeBedwarsMap(vol: Volume, opts: AnalyzeGameplayOptions): BedwarsAnalysis {
  const teamPoints = opts.points.filter((p) => p.role === "team");
  const diamondPoints = opts.points.filter((p) => p.role === "diamond");
  const midPoint = opts.points.find((p) => p.role === "mid");
  const warnings: string[] = [];

  const routes: RouteAnalysis[] = [];
  const addRoute = (a: AnalysisPoint, b: AnalysisPoint): RouteAnalysis => {
    const bridge = estimateBridge(a.pos, b.pos);
    let walkable = false;
    let walkSteps: number | undefined;
    if (opts.walkPaths) {
      const path = findWalkPath(vol, a.pos, b.pos, { maxNodes: 150_000 });
      walkable = path.reachable;
      walkSteps = path.reachable ? path.steps : undefined;
    }
    const route: RouteAnalysis = {
      from: a.label,
      to: b.label,
      directDistance: Math.round(distanceXZ(a.pos, b.pos) * 10) / 10,
      walkable,
      walkSteps,
      bridge,
    };
    routes.push(route);
    return route;
  };

  // Rush routes: each team to its nearest neighbours, which is the pairing that decides the meta.
  const rushDistances: number[] = [];
  for (let i = 0; i < teamPoints.length; i++) {
    const a = teamPoints[i]!;
    const b = teamPoints[(i + 1) % teamPoints.length]!;
    if (a === b) continue;
    rushDistances.push(addRoute(a, b).directDistance);
  }
  // Also the opposite team, which is the long rush.
  if (teamPoints.length >= 4) {
    const opposite = teamPoints[Math.floor(teamPoints.length / 2)]!;
    addRoute(teamPoints[0]!, opposite);
  }

  const baseToDiamondDistances: number[] = [];
  for (const team of teamPoints) {
    let nearest: { point: AnalysisPoint; distance: number } | null = null;
    for (const diamond of diamondPoints) {
      const d = distanceXZ(team.pos, diamond.pos);
      if (!nearest || d < nearest.distance) nearest = { point: diamond, distance: d };
    }
    if (nearest) baseToDiamondDistances.push(addRoute(team, nearest.point).directDistance);
  }

  const diamondToMidDistances: number[] = [];
  if (midPoint) {
    for (const diamond of diamondPoints) {
      diamondToMidDistances.push(addRoute(diamond, midPoint).directDistance);
    }
  }

  const meanY =
    teamPoints.length === 0 ? 0 : teamPoints.reduce((s, p) => s + p.pos.y, 0) / teamPoints.length;
  const heightAdvantage = teamPoints.map((p) => ({
    team: p.label,
    delta: Math.round((p.pos.y - meanY) * 10) / 10,
  }));
  const maxHeightDelta = Math.max(0, ...heightAdvantage.map((h) => Math.abs(h.delta)));
  if (maxHeightDelta > 2) {
    warnings.push(
      `Team bases differ in height by up to ${maxHeightDelta} blocks. On a symmetric map this should be zero; anything above 2 is a real advantage.`,
    );
  }

  const rushStats = summarize(rushDistances);
  if (rushStats.spread > 6) {
    warnings.push(
      `Rush distances vary by ${rushStats.spread} blocks between team pairs; some teams are rushed sooner than others.`,
    );
  }
  if (rushStats.min > 0 && rushStats.min < 24) {
    warnings.push(`Closest rush is only ${rushStats.min} blocks — expect very early aggression.`);
  }

  const campingSpots = findCampingSpots(vol);
  const unintendedJumps = findUnintendedJumps(vol);

  return {
    teams: opts.teams,
    routes,
    rushDistance: rushStats,
    baseToDiamond: summarize(baseToDiamondDistances),
    diamondToMid: summarize(diamondToMidDistances),
    heightAdvantage,
    voidExposure: measureVoidExposure(vol),
    symmetry: opts.symmetryScore ?? 0,
    campingSpots,
    unintendedJumps,
    warnings,
  };
}

function summarize(values: readonly number[]): { min: number; max: number; mean: number; spread: number } {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, spread: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  return { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10, mean, spread: Math.round((max - min) * 10) / 10 };
}

function measureVoidExposure(vol: Volume): number {
  let empty = 0;
  const heightmap = vol.heightmap();
  for (let i = 0; i < heightmap.length; i++) if (heightmap[i]! < 0) empty++;
  return Math.round((empty / heightmap.length) * 1000) / 1000;
}

/**
 * Positions that sit well above everything nearby and have only one way in.
 *
 * The classic BedWars problem: a decorative tower with a single ladder becomes a spot one player
 * holds all game. Detected as a local height maximum with a small standable footprint.
 */
function findCampingSpots(vol: Volume): Vec3[] {
  const heightmap = vol.heightmap();
  const out: Vec3[] = [];
  const step = 4; // Sampling: a camping spot big enough to matter is bigger than 4 blocks.
  for (let z = step; z < vol.length - step; z += step) {
    for (let x = step; x < vol.width - step; x += step) {
      const h = heightmap[z * vol.width + x]!;
      if (h < 0) continue;
      let higherNeighbours = 0;
      let lowerBy8 = 0;
      let samples = 0;
      for (let dz = -step * 2; dz <= step * 2; dz += step) {
        for (let dx = -step * 2; dx <= step * 2; dx += step) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= vol.width || nz >= vol.length) continue;
          const nh = heightmap[nz * vol.width + nx]!;
          samples++;
          if (nh > h) higherNeighbours++;
          if (nh < h - 8) lowerBy8++;
        }
      }
      // Isolated high ground: nothing around is higher, and most of it is far below.
      if (samples >= 6 && higherNeighbours === 0 && lowerBy8 >= samples * 0.75) {
        out.push(vec(x, h + 1, z));
      }
    }
  }
  return out.slice(0, 12);
}

/**
 * Gaps a player can cross without bridging.
 *
 * A 4-block gap is a sprint jump; a 3-block gap is a walk-off jump. Either one between two islands
 * that were meant to be separated changes the map's routes completely, and it is almost always
 * accidental — a decoration that reached one block too far.
 */
function findUnintendedJumps(vol: Volume): { from: Vec3; to: Vec3; gap: number }[] {
  const heightmap = vol.heightmap();
  const found: { from: Vec3; to: Vec3; gap: number }[] = [];
  const seen = new Set<string>();

  const scanLine = (fixed: number, along: "x" | "z"): void => {
    const limit = along === "x" ? vol.width : vol.length;
    let lastSolid = -1;
    for (let i = 0; i < limit; i++) {
      const x = along === "x" ? i : fixed;
      const z = along === "x" ? fixed : i;
      const h = heightmap[z * vol.width + x]!;
      if (h < 0) continue;
      if (lastSolid >= 0) {
        const gap = i - lastSolid - 1;
        if (gap >= 2 && gap <= 4) {
          const ax = along === "x" ? lastSolid : fixed;
          const az = along === "x" ? fixed : lastSolid;
          const ah = heightmap[az * vol.width + ax]!;
          // Only count it if the two sides are at a jumpable relative height.
          if (Math.abs(ah - h) <= 1) {
            const key = `${Math.floor(ax / 8)},${Math.floor(az / 8)},${Math.floor(x / 8)},${Math.floor(z / 8)}`;
            if (!seen.has(key)) {
              seen.add(key);
              found.push({ from: vec(ax, ah + 1, az), to: vec(x, h + 1, z), gap });
            }
          }
        }
      }
      lastSolid = i;
    }
  };

  const stride = 6;
  for (let z = 0; z < vol.length; z += stride) scanLine(z, "x");
  for (let x = 0; x < vol.width; x += stride) scanLine(x, "z");
  return found.slice(0, 16);
}

/** Format a BedWars analysis as readable lines. */
export function formatAnalysis(analysis: BedwarsAnalysis): string[] {
  const lines: string[] = [
    `Teams: ${analysis.teams}`,
    `Rush distance: ${analysis.rushDistance.min}-${analysis.rushDistance.max} blocks (mean ${analysis.rushDistance.mean}, spread ${analysis.rushDistance.spread})`,
    `Base to diamond: ${analysis.baseToDiamond.min}-${analysis.baseToDiamond.max} (mean ${analysis.baseToDiamond.mean})`,
    `Diamond to mid: ${analysis.diamondToMid.min}-${analysis.diamondToMid.max} (mean ${analysis.diamondToMid.mean})`,
    `Height advantage: ${analysis.heightAdvantage.map((h) => `${h.team} ${h.delta >= 0 ? "+" : ""}${h.delta}`).join(", ") || "n/a"}`,
    `Void exposure: ${(analysis.voidExposure * 100).toFixed(1)}% of the footprint`,
    `Symmetry: ${(analysis.symmetry * 100).toFixed(1)}%`,
    `Potential camping spots: ${analysis.campingSpots.length}`,
    `Unintended jump gaps: ${analysis.unintendedJumps.length}`,
  ];
  for (const w of analysis.warnings) lines.push(`WARNING: ${w}`);
  const sample = analysis.routes.slice(0, 6);
  if (sample.length > 0) {
    lines.push("Routes:");
    for (const r of sample) {
      lines.push(
        `  ${r.from} -> ${r.to}: ${r.directDistance} blocks direct, ${r.bridge.minimumBlocks} blocks to bridge (${r.bridge.estimatedSeconds}s)${r.walkable ? `, walkable in ${r.walkSteps} steps` : ""}`,
      );
    }
  }
  return lines;
}
