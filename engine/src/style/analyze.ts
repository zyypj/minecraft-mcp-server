/**
 * Reading a reference schematic into a {@link StyleProfile}.
 *
 * Everything here is a measurement over the voxel data. No step guesses at intent; each one asks a
 * question a builder would ask when looking at someone else's map:
 *
 *  - *What is it made of, and what can you actually see?* -> palette observation weighted by surface
 *    exposure, then clustered by colour.
 *  - *Does it have material progressions?* -> co-adjacency chains ordered by luminance.
 *  - *Is it symmetric, and how?* -> mirror and rotational scores.
 *  - *How are the masses arranged?* -> connected components on a coarse grid, then a layout
 *    classification (radial / linear / grid / clustered) and a focal ratio.
 *  - *What are its islands like?* -> void ratio, edge roughness, thickness, relief.
 *  - *How detailed is it?* -> shares of stairs/slabs, plants, glass.
 *  - *What repeats?* -> chunk hashing, including rotations, so eight copies of one pillar are
 *    recognised as one motif used eight times rather than eight unrelated things.
 */

import { type Region, type Vec3, region, vec } from "../core/vec.js";
import { AIR, type PackedBlock, Volume } from "../core/volume.js";
import { blockColor, blockName, materialKey, renderClass } from "../mc18/blocks.js";
import { type PaletteJson, type PaletteRole, observePalette } from "../mc18/palette.js";
import { measureMirrorSymmetry, measureRadialSymmetry } from "../ops/symmetry.js";
import { rotateVolume } from "../ops/transform.js";
import type {
  BlockObservationJson,
  ColorCluster,
  CompositionProfile,
  DensityProfile,
  DetectedRamp,
  LayoutKind,
  MassCluster,
  Motif,
  StyleProfile,
  SymmetryProfile,
  TerrainProfile,
} from "./profile.js";

export interface AnalyzeOptions {
  readonly id: string;
  readonly name?: string;
  readonly sourceFiles?: readonly string[];
  readonly substitutions?: readonly { from: string; to: string; count: number }[];
  /** Coarse-grid cell size for clustering. Larger is faster and merges nearby masses. */
  readonly clusterCell?: number;
  /** Chunk size for motif detection. 8 finds building-scale repeats; 4 finds detail repeats. */
  readonly motifSize?: number;
  /** Cap on how many observations and motifs are kept. */
  readonly topN?: number;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

/** Analyze a reference volume into a style profile. */
export function analyzeStyle(vol: Volume, opts: AnalyzeOptions): StyleProfile {
  const topN = opts.topN ?? 24;
  const observations = observePalette(vol);
  const solid = observations.reduce((sum, o) => sum + o.count, 0);
  const surfaceTotal = observations.reduce((sum, o) => sum + o.count * o.exposure, 0);

  const observationJson: BlockObservationJson[] = observations.slice(0, topN).map((o) => ({
    block: o.name,
    count: o.count,
    share: round(o.share, 5),
    exposure: round(o.exposure, 4),
    surfaceShare: round(surfaceTotal === 0 ? 0 : (o.count * o.exposure) / surfaceTotal, 5),
    color: hex(o.color),
  }));

  const colors = clusterColors(observations, surfaceTotal);
  const ramps = detectRamps(vol, observations);
  const palette = derivePalette(opts.id, observations, surfaceTotal, ramps);
  const symmetry = measureSymmetry(vol);
  const clusters = findMassClusters(vol, opts.clusterCell ?? 6);
  const composition = classifyComposition(vol, clusters);
  const terrain = measureTerrain(vol);
  const density = measureDensity(vol, observations, solid);
  const motifs = detectMotifs(vol, opts.motifSize ?? 8, Math.min(topN, 12));

  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    schemaVersion: 1,
    minecraftVersion: "1.8.9",
    source: {
      files: opts.sourceFiles ?? [],
      dimensions: { width: vol.width, height: vol.height, length: vol.length },
      solidBlocks: solid,
      substitutions: opts.substitutions ?? [],
    },
    palette,
    observations: observationJson,
    colors,
    ramps,
    symmetry,
    composition,
    terrain,
    density,
    motifs,
    summary: summarize({ symmetry, composition, terrain, density, colors, ramps, observationJson }),
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// -- Colour clustering ---------------------------------------------------------------------------

interface Observation {
  block: PackedBlock;
  name: string;
  count: number;
  share: number;
  exposure: number;
  color: number;
}

/**
 * Group visible blocks into dominant colours.
 *
 * Weighted k-means in RGB, seeded deterministically by taking the most-visible blocks as initial
 * centroids. Weighting by *surface* contribution rather than raw count is the whole point: the
 * stone filling an island's interior must not be reported as the style's dominant colour.
 */
function clusterColors(observations: readonly Observation[], surfaceTotal: number): ColorCluster[] {
  const visible = observations
    .map((o) => ({ ...o, weight: o.count * o.exposure }))
    .filter((o) => o.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  if (visible.length === 0) return [];

  const k = Math.min(6, visible.length);
  let centroids = visible.slice(0, k).map((o) => rgb(o.color));

  let assignment: number[] = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    assignment = visible.map((o) => nearestCentroid(rgb(o.color), centroids));
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    visible.forEach((o, i) => {
      const c = sums[assignment[i]!]!;
      const p = rgb(o.color);
      c.r += p[0] * o.weight;
      c.g += p[1] * o.weight;
      c.b += p[2] * o.weight;
      c.w += o.weight;
    });
    const next = sums.map((s, i) =>
      s.w === 0 ? centroids[i]! : ([s.r / s.w, s.g / s.w, s.b / s.w] as [number, number, number]),
    );
    const moved = next.some((c, i) => distSq(c, centroids[i]!) > 1);
    centroids = next;
    if (!moved) break;
  }

  const groups = centroids.map(() => ({ weight: 0, blocks: [] as { name: string; weight: number }[] }));
  visible.forEach((o, i) => {
    const g = groups[assignment[i]!]!;
    g.weight += o.weight;
    g.blocks.push({ name: o.name, weight: o.weight });
  });

  return groups
    .map((g, i) => ({
      color: hex(pack(centroids[i]!)),
      share: round(surfaceTotal === 0 ? 0 : g.weight / surfaceTotal, 4),
      blocks: g.blocks.sort((a, b) => b.weight - a.weight).slice(0, 4).map((b) => b.name),
    }))
    .filter((g) => g.blocks.length > 0)
    .sort((a, b) => b.share - a.share);
}

const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const pack = (c: [number, number, number]): number =>
  (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
const distSq = (a: [number, number, number], b: [number, number, number]): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function nearestCentroid(p: [number, number, number], centroids: [number, number, number][]): number {
  let best = 0;
  let bestDist = Infinity;
  centroids.forEach((c, i) => {
    const d = distSq(p, c);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

const luminance = (c: number): number => {
  const [r, g, b] = rgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// -- Ramp detection ------------------------------------------------------------------------------

/**
 * Find material progressions.
 *
 * Two blocks are "related" when they touch far more often than their independent frequencies
 * predict — a lift ratio, the same statistic used for market-basket association. Chains are then
 * grown greedily by following the strongest relation that keeps luminance monotone, which is what
 * separates a *gradient* (stone bricks -> cracked -> cobblestone -> andesite) from two materials
 * that merely happen to meet along a wall.
 */
function detectRamps(vol: Volume, observations: readonly Observation[]): DetectedRamp[] {
  const considered = observations.filter((o) => o.share > 0.004 && o.exposure > 0.05).slice(0, 16);
  if (considered.length < 3) return [];
  const index = new Map<PackedBlock, number>();
  considered.forEach((o, i) => index.set(o.block, i));

  const n = considered.length;
  const adjacency = new Float64Array(n * n);
  let pairs = 0;
  for (const { pos, block } of vol.iterateSolid()) {
    const a = index.get(materialKey(block));
    if (a === undefined) continue;
    // Only +X, +Y, +Z, so each pair is counted once.
    for (const d of [vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)]) {
      const other = vol.get(pos.x + d.x, pos.y + d.y, pos.z + d.z);
      if (other === AIR) continue;
      const b = index.get(materialKey(other));
      if (b === undefined || b === a) continue;
      adjacency[a * n + b] = adjacency[a * n + b]! + 1;
      adjacency[b * n + a] = adjacency[b * n + a]! + 1;
      pairs++;
    }
  }
  if (pairs === 0) return [];

  const shares = considered.map((o) => o.share);
  const lift = (a: number, b: number): number => {
    const observed = adjacency[a * n + b]! / (pairs * 2);
    const expected = 2 * shares[a]! * shares[b]!;
    return expected <= 0 ? 0 : observed / expected;
  };

  const ramps: DetectedRamp[] = [];
  const used = new Set<number>();
  // Start each chain from the most-used block not already in one.
  for (let start = 0; start < n; start++) {
    if (used.has(start)) continue;
    const chain = [start];
    let strengthSum = 0;
    for (;;) {
      const tail = chain[chain.length - 1]!;
      const tailLum = luminance(considered[tail]!.color);
      const headLum = luminance(considered[chain[0]!]!.color);
      const direction = chain.length === 1 ? 0 : Math.sign(tailLum - headLum);
      let best = -1;
      let bestLift = 1.35; // Below this, "adjacent" is just coincidence.
      for (let candidate = 0; candidate < n; candidate++) {
        if (chain.includes(candidate) || used.has(candidate)) continue;
        const candidateLum = luminance(considered[candidate]!.color);
        // Keep the chain monotone once a direction is established.
        if (direction !== 0 && Math.sign(candidateLum - tailLum) !== direction) continue;
        if (direction === 0 && Math.abs(candidateLum - tailLum) < 4) continue;
        const l = lift(tail, candidate);
        if (l > bestLift) {
          bestLift = l;
          best = candidate;
        }
      }
      if (best < 0) break;
      strengthSum += bestLift;
      chain.push(best);
      if (chain.length >= 5) break;
    }
    if (chain.length < 3) continue;
    chain.forEach((i) => used.add(i));
    // Present the ramp dark-to-light so a gradient reads consistently between profiles.
    const ordered = chain
      .map((i) => considered[i]!)
      .sort((a, b) => luminance(a.color) - luminance(b.color));
    ramps.push({
      name: `ramp_${ramps.length + 1}`,
      blocks: ordered.map((o) => o.name),
      strength: round(Math.min(1, strengthSum / (chain.length - 1) / 4), 3),
    });
    if (ramps.length >= 4) break;
  }
  return ramps;
}

// -- Palette derivation --------------------------------------------------------------------------

const TERRAIN_TOP_BLOCKS = new Set(["grass", "sand", "red_sand", "mycelium", "podzol", "snow", "gravel"]);
const TERRAIN_MID_BLOCKS = new Set(["dirt", "coarse_dirt", "clay", "sandstone", "red_sandstone"]);
const TERRAIN_BASE_BLOCKS = new Set(["stone", "andesite", "granite", "diorite", "cobblestone", "netherrack", "end_stone"]);

/**
 * Assign observed blocks to palette roles.
 *
 * A heuristic, and deliberately a legible one: terrain blocks are recognised by name, glass and
 * plants and light sources by render class, and everything else is ranked by *surface* share into
 * primary / secondary / accent / trim. It gets the common cases right and the JSON it writes is
 * meant to be edited when it does not.
 */
function derivePalette(
  id: string,
  observations: readonly Observation[],
  surfaceTotal: number,
  ramps: readonly DetectedRamp[],
): PaletteJson {
  const roles: Record<string, { block: string; weight: number }[]> = {};
  const push = (role: PaletteRole, name: string, weight: number): void => {
    (roles[role] ??= []).push({ block: name, weight: round(weight, 3) });
  };

  const structural: Observation[] = [];
  for (const o of observations) {
    if (o.share < 0.0015) continue;
    const cls = renderClass(o.block);
    const surfaceShare = surfaceTotal === 0 ? 0 : (o.count * o.exposure) / surfaceTotal;
    if (TERRAIN_TOP_BLOCKS.has(o.name)) push("TERRAIN_TOP", o.name, surfaceShare * 100);
    else if (TERRAIN_MID_BLOCKS.has(o.name)) push("TERRAIN_MID", o.name, surfaceShare * 100);
    else if (TERRAIN_BASE_BLOCKS.has(o.name)) push("TERRAIN_BASE", o.name, o.share * 100);
    else if (cls === "translucent" && o.name.includes("glass")) push("GLASS", o.name, surfaceShare * 100);
    else if (cls === "cross" || cls === "carpet") push("VEGETATION", o.name, surfaceShare * 100);
    else if (o.name === "glowstone" || o.name === "sea_lantern" || o.name === "torch" || o.name === "lit_redstone_lamp") {
      push("LIGHT", o.name, surfaceShare * 100);
    } else if (cls === "stairs" || cls === "slab") push("TRIM", o.name, surfaceShare * 100);
    else if (cls === "fence" || cls === "wall" || cls === "pane") push("DETAIL", o.name, surfaceShare * 100);
    else structural.push({ ...o, share: surfaceShare });
  }

  structural.sort((a, b) => b.share - a.share);
  const [primary, secondary, third, fourth, fifth] = structural;
  if (primary) push("WALL_PRIMARY", primary.name, 10);
  if (secondary) push("WALL_SECONDARY", secondary.name, 8);
  if (third) push("ACCENT", third.name, 6);
  if (fourth) push("ROOF_PRIMARY", fourth.name, 6);
  if (fifth) push("ROOF_SECONDARY", fifth.name, 4);
  // Give the primary wall some texture from whatever else is structurally common.
  for (const extra of structural.slice(1, 4)) {
    if (extra.share > 0.02) push("WALL_PRIMARY", extra.name, 3);
  }
  // Support and floor are rarely distinguishable from the outside; reuse the strongest neighbours.
  if (secondary) push("SUPPORT", secondary.name, 5);
  if (third) push("FLOOR", third.name, 5);
  if (structural[1]) push("PATH", structural[1].name, 5);

  const rampJson: Record<string, string[]> = {};
  for (const r of ramps) rampJson[r.name] = [...r.blocks];

  return { id: `${id}-palette`, roles: roles as PaletteJson["roles"], ramps: rampJson };
}

// -- Symmetry ------------------------------------------------------------------------------------

function measureSymmetry(vol: Volume): SymmetryProfile {
  const mirrorX = round(measureMirrorSymmetry(vol, "x"), 4);
  const mirrorZ = round(measureMirrorSymmetry(vol, "z"), 4);
  const center = vec((vol.width - 1) / 2, 0, (vol.length - 1) / 2);
  const radial: Record<string, number> = {};
  for (const fold of [2, 3, 4, 5, 6, 8]) {
    radial[String(fold)] = round(measureRadialSymmetry(vol, center, fold), 4);
  }

  let dominant = "none";
  let dominantScore = 0;
  const consider = (label: string, score: number): void => {
    if (score > dominantScore) {
      dominant = label;
      dominantScore = score;
    }
  };
  consider("mirror-x", mirrorX);
  consider("mirror-z", mirrorZ);
  for (const [fold, score] of Object.entries(radial)) consider(`radial-${fold}`, score);
  // Below this, "symmetric" is not a meaningful description of the build.
  if (dominantScore < 0.55) dominant = "asymmetric";

  return { mirrorX, mirrorZ, radial, dominant, dominantScore: round(dominantScore, 4) };
}

// -- Mass clustering -----------------------------------------------------------------------------

/**
 * Find the separate masses in a reference by flood-filling a coarse occupancy grid.
 *
 * Coarse on purpose: at full resolution a single bridge block would fuse two islands into one
 * cluster, and the whole point is to recover "eight team islands, four diamond islands, one middle"
 * from an undifferentiated block soup.
 */
export function findMassClusters(vol: Volume, cell: number): MassCluster[] {
  const gw = Math.ceil(vol.width / cell);
  const gh = Math.ceil(vol.height / cell);
  const gl = Math.ceil(vol.length / cell);
  const counts = new Int32Array(gw * gh * gl);
  const gi = (x: number, y: number, z: number): number => (y * gl + z) * gw + x;

  for (const { pos } of vol.iterateSolid()) {
    const ci = gi(Math.floor(pos.x / cell), Math.floor(pos.y / cell), Math.floor(pos.z / cell));
    counts[ci] = counts[ci]! + 1;
  }
  // A coarse cell counts as occupied only if it holds a meaningful amount of material, which stops
  // a trail of scattered decoration from bridging two masses.
  const threshold = Math.max(2, Math.floor(cell ** 3 * 0.04));
  const occupied = new Uint8Array(counts.length);
  for (let i = 0; i < counts.length; i++) occupied[i] = counts[i]! >= threshold ? 1 : 0;

  const label = new Int32Array(counts.length).fill(-1);
  const clusters: MassCluster[] = [];
  const centreX = (vol.width - 1) / 2;
  const centreZ = (vol.length - 1) / 2;

  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start] || label[start]! >= 0) continue;
    const id = clusters.length;
    const stack = [start];
    label[start] = id;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let blocks = 0;
    const footprint = new Set<number>();

    while (stack.length > 0) {
      const current = stack.pop()!;
      const x = current % gw;
      const rest = (current - x) / gw;
      const z = rest % gl;
      const y = (rest - z) / gl;
      blocks += counts[current]!;
      footprint.add(z * gw + x);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= gw || ny >= gh || nz >= gl) continue;
        const ni = gi(nx, ny, nz);
        if (!occupied[ni] || label[ni]! >= 0) continue;
        label[ni] = id;
        stack.push(ni);
      }
    }

    // Discard specks: below this a "mass" is a scattered prop, not part of the composition.
    if (blocks < 200) continue;
    const cx = ((minX + maxX + 1) / 2) * cell;
    const cy = ((minY + maxY + 1) / 2) * cell;
    const cz = ((minZ + maxZ + 1) / 2) * cell;
    clusters.push({
      id: `mass_${clusters.length}`,
      center: { x: Math.round(cx), y: Math.round(cy), z: Math.round(cz) },
      bounds: {
        min: { x: minX * cell, y: minY * cell, z: minZ * cell },
        max: { x: (maxX + 1) * cell - 1, y: (maxY + 1) * cell - 1, z: (maxZ + 1) * cell - 1 },
      },
      blockCount: blocks,
      radius: Math.round(Math.sqrt((footprint.size * cell * cell) / Math.PI)),
      height: (maxY - minY + 1) * cell,
      distanceFromCentre: Math.round(Math.hypot(cx - centreX, cz - centreZ)),
    });
  }

  return clusters.sort((a, b) => b.blockCount - a.blockCount);
}

const NEIGHBOR_OFFSETS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// -- Composition ---------------------------------------------------------------------------------

function classifyComposition(vol: Volume, clusters: readonly MassCluster[]): CompositionProfile {
  if (clusters.length === 0) {
    return {
      layout: "single",
      layoutConfidence: 0,
      satelliteCount: 0,
      satelliteRingRatio: 0,
      focalRatio: 1,
      clusters: [],
    };
  }
  if (clusters.length === 1) {
    return {
      layout: "single",
      layoutConfidence: 1,
      satelliteCount: 0,
      satelliteRingRatio: 0,
      focalRatio: 1,
      landmark: clusters[0],
      clusters,
    };
  }

  const volumes = clusters.map((c) => c.blockCount).sort((a, b) => a - b);
  const median = volumes[Math.floor(volumes.length / 2)]!;
  const focalRatio = median === 0 ? 1 : round(clusters[0]!.blockCount / median, 2);

  // Satellites are everything but the largest mass, if that mass sits near the centre.
  const half = Math.max(vol.width, vol.length) / 2;
  const centreMass = clusters.find((c) => c.distanceFromCentre < half * 0.25);
  const satellites = clusters.filter((c) => c !== centreMass);
  const ringRadii = satellites.map((c) => c.distanceFromCentre);
  const meanRadius = ringRadii.length === 0 ? 0 : ringRadii.reduce((a, b) => a + b, 0) / ringRadii.length;
  const radiusSpread =
    ringRadii.length === 0
      ? 1
      : Math.sqrt(ringRadii.reduce((s, r) => s + (r - meanRadius) ** 2, 0) / ringRadii.length) /
        Math.max(1, meanRadius);

  // Radial: satellites all at a similar distance from centre, spread around it.
  const angles = satellites.map((c) =>
    Math.atan2(c.center.x - (vol.width - 1) / 2, -(c.center.z - (vol.length - 1) / 2)),
  );
  const angularSpread = circularSpread(angles);

  let layout: LayoutKind = "clustered";
  let confidence = 0.4;
  if (satellites.length >= 3 && radiusSpread < 0.22 && angularSpread > 0.6) {
    layout = "radial";
    confidence = round(Math.min(1, (1 - radiusSpread) * angularSpread), 3);
  } else if (satellites.length >= 3 && collinearity(clusters) > 0.85) {
    layout = "linear";
    confidence = round(collinearity(clusters), 3);
  } else if (satellites.length >= 4 && gridScore(clusters) > 0.7) {
    layout = "grid";
    confidence = round(gridScore(clusters), 3);
  }

  return {
    layout,
    layoutConfidence: confidence,
    satelliteCount: satellites.length,
    satelliteRingRatio: round(meanRadius / Math.max(1, half), 3),
    focalRatio,
    landmark: focalRatio >= 2.5 ? clusters[0] : centreMass,
    clusters: clusters.slice(0, 32),
  };
}

/** How evenly a set of angles covers the circle, in `[0, 1]`. 1 means perfectly spread. */
function circularSpread(angles: readonly number[]): number {
  if (angles.length < 2) return 0;
  // The resultant vector length is near 0 for evenly spread angles and near 1 for clustered ones.
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return 1 - Math.hypot(sx, sy) / angles.length;
}

function collinearity(clusters: readonly MassCluster[]): number {
  if (clusters.length < 3) return 0;
  const n = clusters.length;
  const mx = clusters.reduce((s, c) => s + c.center.x, 0) / n;
  const mz = clusters.reduce((s, c) => s + c.center.z, 0) / n;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const c of clusters) {
    sxx += (c.center.x - mx) ** 2;
    szz += (c.center.z - mz) ** 2;
    sxz += (c.center.x - mx) * (c.center.z - mz);
  }
  // Ratio of the principal eigenvalues of the 2x2 covariance: 1 means a perfect line.
  const trace = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  const major = (trace + disc) / 2;
  const minor = (trace - disc) / 2;
  return major <= 0 ? 0 : 1 - minor / major;
}

function gridScore(clusters: readonly MassCluster[]): number {
  const xs = [...new Set(clusters.map((c) => Math.round(c.center.x / 8)))];
  const zs = [...new Set(clusters.map((c) => Math.round(c.center.z / 8)))];
  const expected = xs.length * zs.length;
  return expected === 0 ? 0 : Math.min(1, clusters.length / expected);
}

// -- Terrain and density -------------------------------------------------------------------------

function measureTerrain(vol: Volume): TerrainProfile {
  const heightmap = vol.heightmap();
  let occupiedColumns = 0;
  let thicknessSum = 0;
  let heightSum = 0;
  const heights: number[] = [];
  let perimeter = 0;

  for (let z = 0; z < vol.length; z++) {
    for (let x = 0; x < vol.width; x++) {
      const top = heightmap[z * vol.width + x]!;
      if (top < 0) continue;
      occupiedColumns++;
      const bottom = vol.bottomSolidY(x, z);
      thicknessSum += top - bottom + 1;
      heightSum += top;
      heights.push(top);
      // A column on the boundary of the footprint contributes to the perimeter.
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= vol.width || nz >= vol.length || heightmap[nz * vol.width + nx]! < 0) {
          perimeter++;
          break;
        }
      }
    }
  }

  const totalColumns = vol.width * vol.length;
  const meanHeight = occupiedColumns === 0 ? 0 : heightSum / occupiedColumns;
  const relief =
    occupiedColumns === 0
      ? 0
      : Math.sqrt(heights.reduce((s, h) => s + (h - meanHeight) ** 2, 0) / occupiedColumns);

  // A perfect disc of area A has perimeter 2*sqrt(pi*A); anything more is roughness.
  const idealPerimeter = occupiedColumns === 0 ? 1 : 2 * Math.sqrt(Math.PI * occupiedColumns);
  return {
    voidRatio: round(1 - occupiedColumns / totalColumns, 4),
    edgeRoughness: round(Math.max(0, perimeter / idealPerimeter - 1), 3),
    meanThickness: round(occupiedColumns === 0 ? 0 : thicknessSum / occupiedColumns, 2),
    surfaceRelief: round(relief, 2),
    heightLevels: countPlateaus(heights),
  };
}

/** Number of distinct height plateaus, from peaks in a coarse histogram of surface heights. */
function countPlateaus(heights: readonly number[]): number {
  if (heights.length === 0) return 0;
  const max = Math.max(...heights);
  const bins = new Int32Array(Math.max(1, Math.ceil((max + 1) / 4)));
  for (const h of heights) bins[Math.floor(h / 4)]!++;
  const threshold = heights.length * 0.03;
  let levels = 0;
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i]!;
    if (v < threshold) continue;
    if (v >= (bins[i - 1] ?? 0) && v >= (bins[i + 1] ?? 0)) levels++;
  }
  return Math.max(1, levels);
}

function measureDensity(
  vol: Volume,
  observations: readonly Observation[],
  solid: number,
): DensityProfile {
  let decoration = 0;
  let detail = 0;
  let glass = 0;
  for (const o of observations) {
    const cls = renderClass(o.block);
    if (cls === "cross" || cls === "thin" || cls === "carpet" || cls === "other") decoration += o.count;
    if (cls === "stairs" || cls === "slab") detail += o.count;
    if (cls === "translucent" || cls === "pane") glass += o.count;
  }
  const surface = observations.reduce((s, o) => s + o.count * o.exposure, 0);
  const boxVolume = vol.cellCount;
  return {
    fillRatio: round(solid / boxVolume, 4),
    surfaceRatio: round(solid === 0 ? 0 : surface / solid, 4),
    decorationDensity: round(solid === 0 ? 0 : decoration / solid, 4),
    detailBlockRatio: round(solid === 0 ? 0 : detail / solid, 4),
    glassRatio: round(solid === 0 ? 0 : glass / solid, 4),
  };
}

// -- Motif detection -----------------------------------------------------------------------------

/**
 * Find repeated arrangements by hashing fixed-size chunks, including their rotations.
 *
 * Professional maps are full of repeats: eight identical team islands, four identical pillars, a
 * window design used forty times. Recognising that "these eight things are one thing rotated" is
 * what turns a reference into a reusable component library rather than a pile of blocks.
 */
export function detectMotifs(vol: Volume, size: number, limit: number): Motif[] {
  if (size < 2) return [];
  const buckets = new Map<string, { count: number; rotated: boolean; sample: Region }>();
  const stride = size;

  for (let y = 0; y + size <= vol.height; y += stride) {
    for (let z = 0; z + size <= vol.length; z += stride) {
      for (let x = 0; x + size <= vol.width; x += stride) {
        const box = region(vec(x, y, z), vec(x + size - 1, y + size - 1, z + size - 1));
        const chunk = vol.crop(box);
        const filled = chunk.countNonAir();
        // Skip near-empty and completely solid chunks: neither is a motif.
        const cells = size ** 3;
        if (filled < cells * 0.12 || filled > cells * 0.97) continue;

        // Canonical hash over the four rotations, so a rotated copy lands in the same bucket.
        let canonical = hashVolume(chunk);
        let rotated = false;
        let current = chunk;
        for (let turn = 1; turn < 4; turn++) {
          current = rotateVolume(current, 90);
          const h = hashVolume(current);
          if (h < canonical) {
            canonical = h;
            rotated = true;
          }
        }
        const entry = buckets.get(canonical);
        if (entry) {
          entry.count++;
          entry.rotated ||= rotated;
        } else {
          buckets.set(canonical, { count: 1, rotated, sample: box });
        }
      }
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([hash, v]) => ({
      hash: hash.slice(0, 16),
      size,
      occurrences: v.count,
      rotated: v.rotated,
      dominantBlocks: dominantBlocksIn(vol, v.sample),
    }));
}

function hashVolume(vol: Volume): string {
  // FNV-1a over the packed cells: cheap, well-distributed, and stable across runs.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < vol.cells.length; i++) {
    const c = vol.cells[i]!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function dominantBlocksIn(vol: Volume, box: Region): string[] {
  const hist = vol.histogram(box);
  return [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([b]) => blockName(b));
}

// -- Summary -------------------------------------------------------------------------------------

function summarize(parts: {
  symmetry: SymmetryProfile;
  composition: CompositionProfile;
  terrain: TerrainProfile;
  density: DensityProfile;
  colors: readonly ColorCluster[];
  ramps: readonly DetectedRamp[];
  observationJson: readonly BlockObservationJson[];
}): string[] {
  const out: string[] = [];
  const { symmetry, composition, terrain, density, colors, ramps, observationJson } = parts;

  out.push(
    `Layout is ${composition.layout}` +
      (composition.layout === "radial"
        ? ` with ${composition.satelliteCount} satellite masses at ${Math.round(composition.satelliteRingRatio * 100)}% of the half-extent`
        : ""),
  );
  if (composition.focalRatio >= 2.5 && composition.landmark) {
    out.push(
      `A dominant landmark ${composition.landmark.height} blocks tall carries ${composition.focalRatio}x the median mass volume`,
    );
  } else {
    out.push("No single mass dominates; the composition is evenly weighted");
  }
  out.push(
    symmetry.dominant === "asymmetric"
      ? "The build is not strongly symmetric"
      : `Strongest symmetry is ${symmetry.dominant} at ${Math.round(symmetry.dominantScore * 100)}%`,
  );
  out.push(
    `Terrain shows ${Math.round(terrain.voidRatio * 100)}% void, edge roughness ${terrain.edgeRoughness}, mean thickness ${terrain.meanThickness} blocks over ${terrain.heightLevels} height levels`,
  );
  out.push(
    `Detailing: ${Math.round(density.detailBlockRatio * 100)}% stairs and slabs, ${Math.round(density.decorationDensity * 100)}% decoration, ${Math.round(density.glassRatio * 100)}% glass`,
  );
  if (colors.length > 0) {
    out.push(
      `Dominant surface colours: ${colors
        .slice(0, 4)
        .map((c) => `${c.color} (${Math.round(c.share * 100)}%, ${c.blocks[0]})`)
        .join(", ")}`,
    );
  }
  if (ramps.length > 0) {
    out.push(`Material ramps: ${ramps.map((r) => r.blocks.join(" -> ")).join(" | ")}`);
  }
  if (observationJson.length > 0) {
    out.push(
      `Most visible blocks: ${observationJson
        .slice(0, 6)
        .map((o) => o.block)
        .join(", ")}`,
    );
  }
  return out;
}
