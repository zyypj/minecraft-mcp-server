/**
 * Organic floating terrain.
 *
 * This is the single biggest visual difference between a generated map and a built one. A disc of
 * grass on a cylinder of stone reads as programmer art no matter how good the buildings on top of
 * it are; a real island has an irregular outline, a tapered underside with overhangs, thickness
 * that varies, and a stratified edge you can see the layers of.
 *
 * The generator is a field evaluation, not a mesh:
 *
 *  - a **warped-noise edge field** gives the outline its irregularity without angular seams,
 *  - a **depth profile** tapers the underside from thick at the centre to nothing at the rim,
 *  - **3D noise on the underside** produces bulges and overhangs, because the depth at one height
 *    is allowed to exceed the depth above it,
 *  - the **top stays nearly flat**, because gameplay needs a buildable plateau, with relief pushed
 *    to a narrow band near the rim where it costs nothing.
 *
 * Everything is driven by a seeded {@link Noise}, so an island is reproducible from its seed, and
 * four "same but different" diamond islands are four forks of one noise field.
 */

import { Noise } from "../core/noise.js";
import { clamp, clamp01, type Prng, smoothstep } from "../core/prng.js";
import { type Region, type Vec3, region, vec } from "../core/vec.js";
import { AIR, type Mask, type PackedBlock, type Volume } from "../core/volume.js";
import { type Palette } from "../mc18/palette.js";

export interface IslandOptions {
  /** Centre of the island, at the height of its top surface. */
  readonly center: Vec3;
  /** Mean radius of the plateau, in blocks. */
  readonly radius: number;
  /** Maximum thickness below the surface at the centre. */
  readonly depth: number;
  readonly palette: Palette;
  readonly seed: number | string;

  /**
   * How irregular the outline is, in `[0, 1]`. 0 gives a circle; 0.25 is the sweet spot for a
   * themed map (clearly organic, still obviously an island); above 0.5 starts producing lobes.
   */
  readonly edgeNoise?: number;
  /** Vertical relief on the top surface, in blocks. Kept small so the plateau stays buildable. */
  readonly topRelief?: number;
  /** How much of the radius stays perfectly flat for building. `0.7` leaves relief to the outer 30%. */
  readonly flatCoreRatio?: number;
  /** Strength of underside bulges, in blocks. 0 gives a smooth cone. */
  readonly overhang?: number;
  /** Thickness of the top soil layer (grass over dirt). */
  readonly topsoil?: number;
  /** How sharply the underside tapers. Below 1 is a blunt slab, above 1 a pointed cone. */
  readonly taper?: number;
  /** Independent scale factors, for oval islands. */
  readonly stretchX?: number;
  readonly stretchZ?: number;
  /**
   * Per-instance variation in `[0, 1]`, applied on top of the seed. Four islands sharing a seed but
   * differing in `variation` look like siblings rather than copies.
   */
  readonly variation?: number;
  readonly mask?: Mask;
}

export interface IslandResult {
  /** Top surface height per column, indexed `z * width + x`; `-1` where the island is absent. */
  readonly surface: Int32Array;
  /** The region the island occupies. */
  readonly bounds: Region;
  /** Columns flat and wide enough to build on. */
  readonly buildable: Region;
  readonly blocksPlaced: number;
  /** Mean surface Y over the buildable core — the datum a structure should sit on. */
  readonly datumY: number;
}

/**
 * Generate an organic floating island.
 *
 * Returns the surface heightmap, which everything placed on the island afterwards (buildings,
 * paths, decoration) reads instead of guessing at a flat Y.
 */
export function buildOrganicIsland(vol: Volume, opts: IslandOptions): IslandResult {
  const {
    center,
    radius,
    depth,
    palette,
    edgeNoise = 0.22,
    topRelief = 2,
    flatCoreRatio = 0.68,
    overhang = 2.5,
    topsoil = 3,
    taper = 0.75,
    stretchX = 1,
    stretchZ = 1,
    variation = 0,
  } = opts;

  const noise = new Noise(opts.seed).fork(`island-${variation.toFixed(3)}`);
  const edgeField = noise.fork("edge");
  const reliefField = noise.fork("relief");
  const undersideField = noise.fork("underside");
  const bulgeField = noise.fork("bulge");
  const strataField = noise.fork("strata");

  const top = palette.source("TERRAIN_TOP", { scale: 3 });
  const mid = palette.source("TERRAIN_MID", { scale: 3 });
  const base = palette.source("TERRAIN_BASE", { scale: 4 });
  const edgeMaterial = palette.source("TERRAIN_EDGE", { scale: 2 });

  const reach = Math.ceil(radius * Math.max(stretchX, stretchZ) * (1 + edgeNoise) + overhang + 2);
  const box = region(
    vec(center.x - reach, center.y - depth - overhang - 2, center.z - reach),
    vec(center.x + reach, center.y + topRelief + 1, center.z + reach),
  );

  const width = vol.width;
  const surface = new Int32Array(width * vol.length).fill(-1);

  /** Radius of the outline in the direction of a given column, including its noise. */
  const outlineRadius = (x: number, z: number): number => {
    if (edgeNoise <= 0) return radius;
    // Domain-warped noise sampled in world space: no angular seam, and the lobes curl.
    const n = edgeField.warped2((x - center.x) * 0.045, (z - center.z) * 0.045, 1.6, {
      octaves: 3,
      persistence: 0.55,
    });
    return radius * (1 + edgeNoise * n);
  };

  let placed = 0;
  const minX = Math.max(0, box.min.x);
  const maxX = Math.min(vol.width - 1, box.max.x);
  const minZ = Math.max(0, box.min.z);
  const maxZ = Math.min(vol.length - 1, box.max.z);

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = (x - center.x) / stretchX;
      const dz = (z - center.z) / stretchZ;
      const dist = Math.hypot(dx, dz);
      const rEdge = outlineRadius(x, z);
      if (dist > rEdge) continue;
      const rNorm = rEdge <= 0 ? 1 : clamp01(dist / rEdge);

      // Top surface: flat across the core, gently falling and roughening toward the rim.
      const rimFactor = smoothstep((rNorm - flatCoreRatio) / Math.max(0.001, 1 - flatCoreRatio));
      const relief = reliefField.fbm2(x * 0.09, z * 0.09, { octaves: 3 }) * topRelief * rimFactor;
      const surfaceY = Math.round(center.y + relief - rimFactor * 0.8);

      // Underside: a tapered profile, roughened by ridged noise so it reads as eroded rock.
      const profile = Math.pow(Math.max(0, 1 - rNorm * rNorm), taper);
      const rough = 0.72 + 0.55 * undersideField.ridged2(x * 0.07, z * 0.07, { octaves: 3 });
      const columnDepth = Math.max(1, depth * profile * rough);
      let bottomY = Math.round(surfaceY - columnDepth);

      // Overhangs: a low-frequency 3D bulge pushes the underside outward in places, so some cells
      // hang below and beyond what the column above them would allow.
      if (overhang > 0) {
        const bulge = bulgeField.fbm3(x * 0.06, bottomY * 0.09, z * 0.06, { octaves: 2 });
        bottomY -= Math.round(clamp(bulge, -0.4, 1) * overhang);
      }

      for (let y = bottomY; y <= surfaceY; y++) {
        if (!vol.inBounds(x, y, z)) continue;
        const fromTop = surfaceY - y;
        let source: PackedBlock | ((p: Vec3, v: Volume) => PackedBlock);
        if (fromTop === 0) source = top;
        else if (fromTop <= topsoil) source = mid;
        else {
          // Near the outer rim the base material shows as an exposed band; strata noise breaks the
          // boundary so the two layers interlock instead of forming a clean stripe.
          const strata = strataField.fbm3(x * 0.11, y * 0.16, z * 0.11, { octaves: 2 });
          source = rNorm > 0.82 && strata > 0.1 ? edgeMaterial : base;
        }
        if (vol.plot(vec(x, y, z), source, opts.mask)) placed++;
      }
      surface[z * width + x] = surfaceY;
    }
  }

  // The buildable core is the axis-aligned box inside the flat ratio, which is what a structure
  // placer needs: a rectangle it can trust rather than a noisy outline it has to test per cell.
  const coreRadius = Math.floor(radius * flatCoreRatio * 0.72);
  const buildable = region(
    vec(center.x - Math.floor(coreRadius * stretchX), center.y, center.z - Math.floor(coreRadius * stretchZ)),
    vec(center.x + Math.floor(coreRadius * stretchX), center.y, center.z + Math.floor(coreRadius * stretchZ)),
  );

  let datumSum = 0;
  let datumCount = 0;
  for (let z = buildable.min.z; z <= buildable.max.z; z++) {
    for (let x = buildable.min.x; x <= buildable.max.x; x++) {
      if (x < 0 || z < 0 || x >= vol.width || z >= vol.length) continue;
      const y = surface[z * width + x]!;
      if (y >= 0) {
        datumSum += y;
        datumCount++;
      }
    }
  }

  return {
    surface,
    bounds: box,
    buildable,
    blocksPlaced: placed,
    datumY: datumCount === 0 ? center.y : Math.round(datumSum / datumCount),
  };
}

export interface FlattenOptions {
  readonly region: Region;
  readonly y: number;
  readonly surfaceBlock: PackedBlock | ((p: Vec3, v: Volume) => PackedBlock);
  readonly fillBlock?: PackedBlock | ((p: Vec3, v: Volume) => PackedBlock);
  /** Blend the flattened area into the surrounding terrain over this many blocks. */
  readonly feather?: number;
}

/**
 * Flatten a patch of terrain to a fixed height.
 *
 * Needed wherever gameplay demands a level surface — a bed platform, a shop pad, a generator
 * island — on terrain that is deliberately not level. Feathering ramps the transition so the patch
 * does not read as a rectangle stamped into a hillside.
 */
export function flattenTerrain(vol: Volume, opts: FlattenOptions): number {
  const feather = Math.max(0, Math.floor(opts.feather ?? 0));
  const fill = opts.fillBlock ?? opts.surfaceBlock;
  let changed = 0;
  const outer = region(
    vec(opts.region.min.x - feather, opts.region.min.y, opts.region.min.z - feather),
    vec(opts.region.max.x + feather, opts.region.max.y, opts.region.max.z + feather),
  );
  for (let z = outer.min.z; z <= outer.max.z; z++) {
    for (let x = outer.min.x; x <= outer.max.x; x++) {
      if (!vol.inBounds(x, 0, z)) continue;
      const existing = vol.topSolidY(x, z);
      if (existing < 0) continue;
      // Outside the core, interpolate between the target height and the natural surface.
      const outsideX = Math.max(0, opts.region.min.x - x, x - opts.region.max.x);
      const outsideZ = Math.max(0, opts.region.min.z - z, z - opts.region.max.z);
      const outside = Math.max(outsideX, outsideZ);
      const t = feather === 0 ? (outside > 0 ? 1 : 0) : clamp01(outside / (feather + 1));
      const targetY = Math.round(opts.y + (existing - opts.y) * smoothstep(t));

      for (let y = existing; y > targetY; y--) {
        if (vol.set(x, y, z, AIR)) changed++;
      }
      for (let y = existing + 1; y <= targetY; y++) {
        if (vol.plot(vec(x, y, z), fill)) changed++;
      }
      if (vol.plot(vec(x, targetY, z), opts.surfaceBlock)) changed++;
    }
  }
  return changed;
}

export interface VegetationOptions {
  readonly surface: Int32Array;
  readonly volumeWidth: number;
  readonly region: Region;
  readonly palette: Palette;
  readonly prng: Prng;
  /** Fraction of surface cells that receive a plant. 0.06-0.12 reads as "planted, not overgrown". */
  readonly density?: number;
  /** Keep vegetation this far away from these regions (bed platforms, generator pads, paths). */
  readonly avoid?: readonly Region[];
}

/** Scatter vegetation over an island's surface, respecting gameplay clearances. */
export function plantVegetation(vol: Volume, opts: VegetationOptions): number {
  const density = opts.density ?? 0.08;
  const source = opts.palette.source("VEGETATION", { scale: 5 });
  let placed = 0;
  for (let z = opts.region.min.z; z <= opts.region.max.z; z++) {
    for (let x = opts.region.min.x; x <= opts.region.max.x; x++) {
      if (!vol.inBounds(x, 0, z)) continue;
      const surfaceY = opts.surface[z * opts.volumeWidth + x];
      if (surfaceY === undefined || surfaceY < 0) continue;
      const above = vec(x, surfaceY + 1, z);
      if (vol.getAt(above) !== AIR) continue;
      if (!opts.prng.chance(density)) continue;
      if (opts.avoid?.some((r) => x >= r.min.x - 1 && x <= r.max.x + 1 && z >= r.min.z - 1 && z <= r.max.z + 1)) {
        continue;
      }
      if (vol.plot(above, source)) placed++;
    }
  }
  return placed;
}
