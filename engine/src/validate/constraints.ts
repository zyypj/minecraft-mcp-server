/**
 * Gameplay constraints — the rules aesthetics is not allowed to break.
 *
 * On a competitive map this is the part that matters most and gets thought about least. A giant
 * carousel in the middle is a great idea right up to the point where its base blocks the rush lane,
 * its roof gives one team a sightline the others do not have, or a decorative arch lands inside a
 * bed's protection zone.
 *
 * So constraints are declared up front and enforced two ways: as a **write mask** that physically
 * prevents a generator from placing blocks where it must not, and as a **post-build check** that
 * catches everything a mask cannot express (distances, symmetry, totals).
 */

import { type Region, type Vec3, contains, distanceXZ, expand, intersects, regionVolume, vec } from "../core/vec.js";
import { AIR, type Mask, type Volume } from "../core/volume.js";
import { measureMirrorSymmetry, measureRadialSymmetry } from "../ops/symmetry.js";

export type Severity = "error" | "warning" | "info";

export interface NamedRegion {
  readonly label: string;
  readonly region: Region;
}

export interface Constraints {
  /** Nothing may be placed above this Y. In 1.8 the world ceiling is 255. */
  readonly maxHeight?: number;
  readonly minHeight?: number;
  /** The whole build must fit inside this box. */
  readonly mapBounds?: Region;
  /** Where players can actually go. Used for reachability checks, not as a write mask. */
  readonly playableArea?: Region;
  /** Regions that must not be modified at all (an existing spawn, a neighbouring build). */
  readonly protectedRegions?: readonly NamedRegion[];
  /** Regions that must stay empty (rush lanes, drop zones). */
  readonly noBuildZones?: readonly NamedRegion[];
  /** Clear air required around each spawn point, in blocks. */
  readonly spawnClearance?: number;
  /** Clear air required around each generator, in blocks. */
  readonly generatorClearance?: number;
  /** Shortest permitted straight-line distance between two team bases. */
  readonly minRushDistance?: number;
  readonly maxRushDistance?: number;
  /** Required symmetry, with the minimum score that counts as satisfied. */
  readonly symmetry?: { readonly kind: "mirror-x" | "mirror-z" | "radial"; readonly folds?: number; readonly minScore: number };
  /** Hard cap on total blocks, so a map stays loadable and pasteable. */
  readonly maxBlocks?: number;
}

/** Key positions the checker needs in order to evaluate gameplay constraints. */
export interface GameplayContext {
  readonly spawns?: readonly { readonly label: string; readonly pos: Vec3 }[];
  readonly generators?: readonly { readonly label: string; readonly pos: Vec3 }[];
  readonly beds?: readonly { readonly label: string; readonly pos: Vec3 }[];
  readonly center?: Vec3;
}

export interface Violation {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  readonly where?: Vec3 | Region;
  /** How far outside the constraint the build is, when that is meaningful. */
  readonly amount?: number;
}

/**
 * A write mask that enforces the spatial constraints.
 *
 * Pass this into every generator and the map physically cannot violate them — which is much better
 * than discovering after a twenty-second generation that a decoration pass filled the rush lane.
 * Clearances are applied here too, so a decoration scatter cannot creep into a spawn.
 */
export function constraintMask(constraints: Constraints, context: GameplayContext = {}): Mask {
  const blocked: Region[] = [];
  for (const zone of constraints.noBuildZones ?? []) blocked.push(zone.region);
  for (const zone of constraints.protectedRegions ?? []) blocked.push(zone.region);

  const clearances: { center: Vec3; radius: number }[] = [];
  if (constraints.spawnClearance) {
    for (const spawn of context.spawns ?? []) {
      clearances.push({ center: spawn.pos, radius: constraints.spawnClearance });
    }
  }
  if (constraints.generatorClearance) {
    for (const generator of context.generators ?? []) {
      clearances.push({ center: generator.pos, radius: constraints.generatorClearance });
    }
  }

  return (p) => {
    if (constraints.maxHeight !== undefined && p.y > constraints.maxHeight) return false;
    if (constraints.minHeight !== undefined && p.y < constraints.minHeight) return false;
    if (constraints.mapBounds && !contains(constraints.mapBounds, p)) return false;
    for (const zone of blocked) if (contains(zone, p)) return false;
    for (const clear of clearances) {
      // A clearance is a cylinder, not a sphere: a build must not intrude sideways, but the ground
      // under a spawn and a roof well above it are both fine.
      if (distanceXZ(p, clear.center) <= clear.radius && p.y >= clear.center.y && p.y < clear.center.y + 4) {
        return false;
      }
    }
    return true;
  };
}

/** Check a finished build against its constraints. */
export function checkConstraints(
  vol: Volume,
  constraints: Constraints,
  context: GameplayContext = {},
): Violation[] {
  const violations: Violation[] = [];
  const occupied = vol.occupiedBounds();

  if (occupied) {
    if (constraints.maxHeight !== undefined && occupied.max.y > constraints.maxHeight) {
      violations.push({
        rule: "maxHeight",
        severity: "error",
        message: `Build reaches Y=${occupied.max.y}, ${occupied.max.y - constraints.maxHeight} above the limit of ${constraints.maxHeight}`,
        amount: occupied.max.y - constraints.maxHeight,
      });
    }
    if (constraints.minHeight !== undefined && occupied.min.y < constraints.minHeight) {
      violations.push({
        rule: "minHeight",
        severity: "error",
        message: `Build reaches Y=${occupied.min.y}, below the floor of ${constraints.minHeight}`,
        amount: constraints.minHeight - occupied.min.y,
      });
    }
    if (constraints.mapBounds && !containsRegion(constraints.mapBounds, occupied)) {
      violations.push({
        rule: "mapBounds",
        severity: "error",
        message: "Build extends outside the declared map bounds",
        where: occupied,
      });
    }
  }

  for (const zone of constraints.noBuildZones ?? []) {
    const intruding = countSolidIn(vol, zone.region);
    if (intruding > 0) {
      violations.push({
        rule: "noBuildZone",
        severity: "error",
        message: `${intruding} blocks were placed inside the no-build zone "${zone.label}"`,
        where: zone.region,
        amount: intruding,
      });
    }
  }

  if (constraints.spawnClearance) {
    for (const spawn of context.spawns ?? []) {
      const blocked = countSolidIn(vol, clearanceBox(spawn.pos, constraints.spawnClearance));
      if (blocked > 0) {
        violations.push({
          rule: "spawnClearance",
          severity: "error",
          message: `Spawn "${spawn.label}" has ${blocked} blocks inside its ${constraints.spawnClearance}-block clearance`,
          where: spawn.pos,
          amount: blocked,
        });
      }
    }
  }

  if (constraints.generatorClearance) {
    for (const generator of context.generators ?? []) {
      const blocked = countSolidIn(vol, clearanceBox(generator.pos, constraints.generatorClearance));
      if (blocked > 0) {
        violations.push({
          rule: "generatorClearance",
          severity: "warning",
          message: `Generator "${generator.label}" has ${blocked} blocks inside its ${constraints.generatorClearance}-block clearance; drops may be blocked`,
          where: generator.pos,
          amount: blocked,
        });
      }
    }
  }

  // Rush distance means *nearest neighbour*, not any pair. On an eight-team ring the two opposite
  // teams are three times further apart than adjacent ones, and comparing that against a rush
  // budget would flag every well-formed map as broken.
  const spawns = context.spawns ?? [];
  if ((constraints.minRushDistance || constraints.maxRushDistance) && spawns.length >= 2) {
    let shortest = Infinity;
    let shortestPair = "";
    let longest = 0;
    let longestPair = "";
    for (let i = 0; i < spawns.length; i++) {
      let nearest = Infinity;
      let nearestLabel = "";
      for (let j = 0; j < spawns.length; j++) {
        if (i === j) continue;
        const d = distanceXZ(spawns[i]!.pos, spawns[j]!.pos);
        if (d < nearest) {
          nearest = d;
          nearestLabel = `${spawns[i]!.label} -> ${spawns[j]!.label}`;
        }
      }
      if (nearest < shortest) {
        shortest = nearest;
        shortestPair = nearestLabel;
      }
      if (nearest > longest) {
        longest = nearest;
        longestPair = nearestLabel;
      }
    }
    if (constraints.minRushDistance !== undefined && shortest < constraints.minRushDistance) {
      violations.push({
        rule: "minRushDistance",
        severity: "error",
        message: `Closest bases (${shortestPair}) are ${Math.round(shortest)} blocks apart, below the minimum of ${constraints.minRushDistance}`,
        amount: Math.round(constraints.minRushDistance - shortest),
      });
    }
    if (constraints.maxRushDistance !== undefined && longest > constraints.maxRushDistance) {
      violations.push({
        rule: "maxRushDistance",
        severity: "warning",
        message: `The most isolated base (${longestPair}) is ${Math.round(longest)} blocks from its nearest neighbour, above the maximum of ${constraints.maxRushDistance}`,
        amount: Math.round(longest - constraints.maxRushDistance),
      });
    }
  }

  if (constraints.symmetry) {
    const { kind, folds = 8, minScore } = constraints.symmetry;
    const center = context.center ?? vec((vol.width - 1) / 2, 0, (vol.length - 1) / 2);
    const score =
      kind === "radial"
        ? measureRadialSymmetry(vol, center, folds)
        : measureMirrorSymmetry(vol, kind === "mirror-x" ? "x" : "z");
    if (score < minScore) {
      violations.push({
        rule: "symmetry",
        severity: "error",
        message: `${kind}${kind === "radial" ? ` (${folds}-fold)` : ""} symmetry is ${(score * 100).toFixed(1)}%, below the required ${(minScore * 100).toFixed(1)}%`,
        amount: Math.round((minScore - score) * 1000) / 1000,
      });
    }
  }

  if (constraints.maxBlocks !== undefined) {
    const total = vol.countNonAir();
    if (total > constraints.maxBlocks) {
      violations.push({
        rule: "maxBlocks",
        severity: "warning",
        message: `Build uses ${total} blocks, ${total - constraints.maxBlocks} over the budget of ${constraints.maxBlocks}`,
        amount: total - constraints.maxBlocks,
      });
    }
  }

  return violations;
}

function containsRegion(outer: Region, inner: Region): boolean {
  return (
    inner.min.x >= outer.min.x &&
    inner.min.y >= outer.min.y &&
    inner.min.z >= outer.min.z &&
    inner.max.x <= outer.max.x &&
    inner.max.y <= outer.max.y &&
    inner.max.z <= outer.max.z
  );
}

function clearanceBox(center: Vec3, radius: number): Region {
  return {
    min: vec(center.x - radius, center.y, center.z - radius),
    max: vec(center.x + radius, center.y + 3, center.z + radius),
  };
}

function countSolidIn(vol: Volume, r: Region): number {
  if (!intersects(r, vol.bounds)) return 0;
  // Guard against a caller passing an absurd region by accident.
  if (regionVolume(r) > 20_000_000) return 0;
  let n = 0;
  for (const p of vol.iterate(r)) if (vol.getAt(p) !== AIR) n++;
  return n;
}

/** Combine several masks; a write must pass all of them. */
export function allMasks(...masks: readonly (Mask | undefined)[]): Mask {
  const active = masks.filter((m): m is Mask => Boolean(m));
  if (active.length === 0) return () => true;
  if (active.length === 1) return active[0]!;
  return (p, current, vol) => active.every((m) => m(p, current, vol));
}

/** Expand a region by a margin, clamped to a volume. Useful when declaring clearances. */
export function marginAround(r: Region, margin: number): Region {
  return expand(r, margin);
}
