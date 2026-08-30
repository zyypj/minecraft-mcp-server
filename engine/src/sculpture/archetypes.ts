/**
 * A library of parametric sculpture archetypes.
 *
 * These are **generic forms**, not likenesses: a cartoon dog, a chick, a round-eared rodent, a
 * flower, an orb. They exist so a plan can say "a 45-block mascot in the middle, cartoon dog
 * archetype, in the map's palette" and get a landmark with the right proportions and colour regions
 * without anybody naming a coordinate.
 *
 * For a *specific* character, use the silhouette path instead: trace the reference into front and
 * side masks and call `carveFromSilhouettes`, or extract the shape out of a reference schematic
 * with `extractSilhouettes`. That keeps the specific likeness in the builder's own source material,
 * where it belongs, and keeps this library about form.
 *
 * Coordinates are normalized: x across (0 left, 1 right), y up, z depth with the front at z=1.
 * Every model faces south, which is the engine's canonical forward.
 */

import { type SculptureModel } from "./voxel-sculpture.js";

/**
 * The material keys archetypes use. A caller maps these to blocks; anything unmapped is skipped,
 * so a two-colour palette still produces a coherent sculpture.
 */
export const SCULPTURE_MATERIALS = [
  "body",
  "belly",
  "detail",
  "accent",
  "eye",
  "limb",
  "highlight",
] as const;

export type SculptureMaterial = (typeof SCULPTURE_MATERIALS)[number];

const MATERIALS = [...SCULPTURE_MATERIALS];

/** A standing cartoon dog: big head, long muzzle, floppy ears, collar. */
const cartoonDog: SculptureModel = {
  id: "cartoon_dog",
  aspect: { width: 0.62, height: 1, depth: 0.58 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "leg", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.42, 0.15, 0.5], to: [0.42, 0.03, 0.52], radius: 0.055 } },
    { name: "foot", material: "body", mirrorX: true, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.42, 0.035, 0.57], radii: [0.06, 0.028, 0.075] } },
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.33, 0.5], radii: [0.17, 0.23, 0.16] } },
    { name: "belly", material: "belly", order: 1, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.3, 0.62], radii: [0.11, 0.16, 0.08] } },
    { name: "arm", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.35, 0.45, 0.5], to: [0.27, 0.27, 0.55], radius: 0.05 } },
    { name: "tail", material: "body", minDetail: "medium", shape: { kind: "capsule", from: [0.5, 0.32, 0.35], to: [0.5, 0.44, 0.24], radius: 0.038, endScale: 0.6 } },
    { name: "neck", material: "body", shape: { kind: "capsule", from: [0.5, 0.5, 0.5], to: [0.5, 0.62, 0.5], radius: 0.07 } },
    { name: "collar", material: "accent", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.59, 0.5], radii: [0.095, 0.022, 0.095] } },
    { name: "head", material: "body", order: 3, shape: { kind: "ellipsoid", center: [0.5, 0.79, 0.47], radii: [0.23, 0.18, 0.21] } },
    { name: "muzzle", material: "body", order: 4, shape: { kind: "ellipsoid", center: [0.5, 0.735, 0.68], radii: [0.115, 0.085, 0.11] } },
    { name: "ear", material: "detail", mirrorX: true, order: 5, shape: { kind: "capsule", from: [0.25, 0.85, 0.44], to: [0.18, 0.63, 0.44], radius: 0.055, endScale: 0.85 } },
    { name: "eye", material: "eye", mirrorX: true, order: 6, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.61, 0.84, 0.6], radii: [0.038, 0.05, 0.035] } },
    { name: "nose", material: "eye", order: 7, shape: { kind: "ellipsoid", center: [0.5, 0.765, 0.775], radii: [0.05, 0.04, 0.045] } },
    { name: "brow", material: "detail", mirrorX: true, order: 8, minDetail: "high", shape: { kind: "ellipsoid", center: [0.615, 0.885, 0.58], radii: [0.045, 0.014, 0.03] } },
  ],
};

/** A round chick: body and head almost the same sphere, small beak, side wings. */
const cartoonBird: SculptureModel = {
  id: "cartoon_bird",
  aspect: { width: 0.72, height: 1, depth: 0.66 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "foot", material: "accent", mirrorX: true, shape: { kind: "capsule", from: [0.44, 0.1, 0.5], to: [0.44, 0.02, 0.6], radius: 0.035 } },
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.42, 0.5], radii: [0.3, 0.3, 0.28] } },
    { name: "wing", material: "body", mirrorX: true, order: 1, shape: { kind: "ellipsoid", center: [0.19, 0.44, 0.5], radii: [0.07, 0.17, 0.14] } },
    { name: "head", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.77, 0.5], radii: [0.23, 0.21, 0.22] } },
    { name: "tuft", material: "highlight", order: 3, minDetail: "medium", shape: { kind: "capsule", from: [0.5, 0.95, 0.48], to: [0.57, 1.0, 0.42], radius: 0.032 } },
    { name: "beak", material: "accent", order: 4, shape: { kind: "capsule", from: [0.5, 0.765, 0.66], to: [0.5, 0.74, 0.85], radius: 0.065, endScale: 0.18 } },
    { name: "eye", material: "eye", mirrorX: true, order: 5, shape: { kind: "ellipsoid", center: [0.62, 0.83, 0.65], radii: [0.033, 0.04, 0.03] } },
    { name: "cheek", material: "accent", mirrorX: true, order: 4, minDetail: "high", shape: { kind: "ellipsoid", center: [0.68, 0.76, 0.6], radii: [0.045, 0.03, 0.035] } },
  ],
};

/** A round-eared rodent mascot: pear body, big round ears, cheek patches, zigzag tail. */
const cartoonRodent: SculptureModel = {
  id: "cartoon_rodent",
  aspect: { width: 0.7, height: 1, depth: 0.6 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "foot", material: "body", mirrorX: true, shape: { kind: "ellipsoid", center: [0.4, 0.05, 0.56], radii: [0.075, 0.045, 0.09] } },
    { name: "leg", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.41, 0.2, 0.5], to: [0.4, 0.06, 0.53], radius: 0.06 } },
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.36, 0.5], radii: [0.21, 0.22, 0.19] } },
    { name: "arm", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.31, 0.44, 0.5], to: [0.24, 0.3, 0.56], radius: 0.05 } },
    { name: "tail", material: "highlight", order: 1, minDetail: "medium", shape: { kind: "capsule", from: [0.5, 0.36, 0.33], to: [0.68, 0.62, 0.24], radius: 0.05, endScale: 1.6 } },
    { name: "head", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.72, 0.48], radii: [0.24, 0.2, 0.22] } },
    { name: "ear", material: "body", mirrorX: true, order: 3, shape: { kind: "capsule", from: [0.32, 0.86, 0.45], to: [0.22, 1.0, 0.4], radius: 0.055, endScale: 0.8 } },
    { name: "ear_tip", material: "detail", mirrorX: true, order: 4, shape: { kind: "ellipsoid", center: [0.22, 0.985, 0.4], radii: [0.05, 0.035, 0.045] } },
    { name: "cheek", material: "accent", mirrorX: true, order: 5, shape: { kind: "ellipsoid", center: [0.68, 0.68, 0.6], radii: [0.06, 0.05, 0.045] } },
    { name: "eye", material: "eye", mirrorX: true, order: 6, shape: { kind: "ellipsoid", center: [0.6, 0.77, 0.64], radii: [0.035, 0.045, 0.03] } },
    { name: "nose", material: "eye", order: 7, shape: { kind: "ellipsoid", center: [0.5, 0.715, 0.7], radii: [0.028, 0.022, 0.028] } },
  ],
};

/** A sitting bear: heavy body, small round ears, muzzle patch. */
const bear: SculptureModel = {
  id: "bear",
  aspect: { width: 0.78, height: 1, depth: 0.7 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.34, 0.5], radii: [0.28, 0.3, 0.26] } },
    { name: "belly", material: "belly", order: 1, shape: { kind: "ellipsoid", center: [0.5, 0.3, 0.65], radii: [0.17, 0.19, 0.1] } },
    { name: "leg", material: "body", mirrorX: true, shape: { kind: "ellipsoid", center: [0.32, 0.1, 0.58], radii: [0.11, 0.09, 0.14] } },
    { name: "arm", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.26, 0.42, 0.52], to: [0.2, 0.2, 0.6], radius: 0.075 } },
    { name: "head", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.76, 0.5], radii: [0.22, 0.19, 0.21] } },
    { name: "ear", material: "body", mirrorX: true, order: 3, shape: { kind: "ellipsoid", center: [0.3, 0.92, 0.48], radii: [0.075, 0.075, 0.06] } },
    { name: "ear_inner", material: "accent", mirrorX: true, order: 4, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.3, 0.92, 0.56], radii: [0.04, 0.04, 0.03] } },
    { name: "muzzle", material: "belly", order: 5, shape: { kind: "ellipsoid", center: [0.5, 0.71, 0.67], radii: [0.1, 0.07, 0.08] } },
    { name: "nose", material: "eye", order: 6, shape: { kind: "ellipsoid", center: [0.5, 0.735, 0.73], radii: [0.04, 0.03, 0.035] } },
    { name: "eye", material: "eye", mirrorX: true, order: 6, shape: { kind: "ellipsoid", center: [0.6, 0.8, 0.65], radii: [0.03, 0.035, 0.025] } },
  ],
};

/** A rabbit: upright body, long ears, round tail. */
const rabbit: SculptureModel = {
  id: "rabbit",
  aspect: { width: 0.6, height: 1, depth: 0.62 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "foot", material: "body", mirrorX: true, shape: { kind: "ellipsoid", center: [0.4, 0.06, 0.6], radii: [0.08, 0.05, 0.13] } },
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.33, 0.5], radii: [0.19, 0.26, 0.18] } },
    { name: "belly", material: "belly", order: 1, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.3, 0.63], radii: [0.11, 0.16, 0.08] } },
    { name: "arm", material: "body", mirrorX: true, shape: { kind: "capsule", from: [0.34, 0.44, 0.55], to: [0.31, 0.26, 0.62], radius: 0.045 } },
    { name: "tail", material: "belly", order: 1, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.28, 0.31], radii: [0.07, 0.07, 0.06] } },
    { name: "head", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.68, 0.5], radii: [0.17, 0.15, 0.17] } },
    { name: "ear", material: "body", mirrorX: true, order: 3, shape: { kind: "capsule", from: [0.42, 0.8, 0.48], to: [0.36, 1.0, 0.44], radius: 0.05, endScale: 0.75 } },
    { name: "ear_inner", material: "accent", mirrorX: true, order: 4, minDetail: "high", shape: { kind: "capsule", from: [0.42, 0.82, 0.53], to: [0.37, 0.98, 0.49], radius: 0.026 } },
    { name: "eye", material: "eye", mirrorX: true, order: 5, shape: { kind: "ellipsoid", center: [0.59, 0.71, 0.62], radii: [0.03, 0.038, 0.025] } },
    { name: "nose", material: "accent", order: 6, shape: { kind: "ellipsoid", center: [0.5, 0.66, 0.67], radii: [0.025, 0.02, 0.025] } },
  ],
};

/** A simple egg-shaped mascot — the most forgiving base for a new theme. */
const mascotEgg: SculptureModel = {
  id: "mascot_egg",
  aspect: { width: 0.72, height: 1, depth: 0.7 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "body", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.45, 0.5], radii: [0.34, 0.44, 0.33] } },
    { name: "band", material: "accent", order: 1, shape: { kind: "ellipsoid", center: [0.5, 0.42, 0.5], radii: [0.35, 0.06, 0.34] } },
    { name: "arm", material: "limb", mirrorX: true, order: 2, shape: { kind: "capsule", from: [0.18, 0.5, 0.5], to: [0.06, 0.34, 0.55], radius: 0.05 } },
    { name: "foot", material: "limb", mirrorX: true, order: 2, shape: { kind: "ellipsoid", center: [0.4, 0.03, 0.56], radii: [0.09, 0.035, 0.11] } },
    { name: "eye", material: "eye", mirrorX: true, order: 3, shape: { kind: "ellipsoid", center: [0.62, 0.62, 0.76], radii: [0.05, 0.06, 0.04] } },
    { name: "smile", material: "eye", order: 3, minDetail: "high", shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.81], radii: [0.09, 0.016, 0.03] } },
  ],
};

/** A blocky humanoid — for maps whose landmark is a person or a statue rather than a creature. */
const humanoid: SculptureModel = {
  id: "humanoid",
  aspect: { width: 0.56, height: 1, depth: 0.36 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "leg", material: "limb", mirrorX: true, shape: { kind: "box", min: [0.36, 0.0, 0.4], max: [0.47, 0.46, 0.6] } },
    { name: "torso", material: "body", shape: { kind: "box", min: [0.3, 0.45, 0.38], max: [0.7, 0.75, 0.62] } },
    { name: "arm", material: "limb", mirrorX: true, shape: { kind: "box", min: [0.19, 0.44, 0.4], max: [0.3, 0.75, 0.6] } },
    { name: "head", material: "belly", order: 2, shape: { kind: "box", min: [0.34, 0.76, 0.36], max: [0.66, 1.0, 0.64] } },
    { name: "eye", material: "eye", mirrorX: true, order: 3, shape: { kind: "box", min: [0.56, 0.88, 0.62], max: [0.62, 0.92, 0.66] } },
    { name: "belt", material: "accent", order: 3, minDetail: "medium", shape: { kind: "box", min: [0.29, 0.45, 0.37], max: [0.71, 0.5, 0.63] } },
  ],
};

/** A banded orb — reads as a ball, a capsule, a planet, or a fairground finial. */
const orb: SculptureModel = {
  id: "orb",
  aspect: { width: 1, height: 1, depth: 1 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "lower", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.5], radii: [0.48, 0.48, 0.48] } },
    { name: "upper", material: "accent", order: 1, shape: { kind: "ellipsoid", center: [0.5, 0.72, 0.5], radii: [0.48, 0.26, 0.48] } },
    { name: "band", material: "detail", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.5], radii: [0.5, 0.045, 0.5] } },
    { name: "button", material: "belly", order: 3, shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.94], radii: [0.11, 0.11, 0.06] } },
    { name: "button_ring", material: "detail", order: 4, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.9], radii: [0.15, 0.15, 0.04] } },
  ],
};

/** An oversized flower — the decoration prop that defines a garden or candy theme. */
const giantFlower: SculptureModel = {
  id: "giant_flower",
  aspect: { width: 0.8, height: 1, depth: 0.8 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "stem", material: "limb", shape: { kind: "capsule", from: [0.5, 0.0, 0.5], to: [0.5, 0.72, 0.5], radius: 0.035 } },
    { name: "leaf", material: "limb", mirrorX: true, order: 1, shape: { kind: "ellipsoid", center: [0.32, 0.34, 0.5], radii: [0.13, 0.045, 0.08] } },
    { name: "petal_n", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.84, 0.26], radii: [0.15, 0.13, 0.16] } },
    { name: "petal_s", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.84, 0.74], radii: [0.15, 0.13, 0.16] } },
    { name: "petal_e", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.76, 0.84, 0.5], radii: [0.16, 0.13, 0.15] } },
    { name: "petal_w", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.24, 0.84, 0.5], radii: [0.16, 0.13, 0.15] } },
    { name: "petal_up", material: "body", order: 2, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.97, 0.5], radii: [0.14, 0.1, 0.14] } },
    { name: "core", material: "accent", order: 3, shape: { kind: "ellipsoid", center: [0.5, 0.86, 0.5], radii: [0.14, 0.12, 0.14] } },
  ],
};

/** A giant mushroom — stem, flared cap, spots. */
const mushroom: SculptureModel = {
  id: "mushroom",
  aspect: { width: 1, height: 1, depth: 1 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "stem", material: "belly", shape: { kind: "capsule", from: [0.5, 0.0, 0.5], to: [0.5, 0.62, 0.5], radius: 0.11, endScale: 0.8 } },
    { name: "cap", material: "body", order: 1, shape: { kind: "ellipsoid", center: [0.5, 0.62, 0.5], radii: [0.46, 0.34, 0.46] } },
    { name: "cap_trim", material: "accent", order: 2, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.62, 0.5], radii: [0.48, 0.05, 0.48] } },
    { name: "spot_a", material: "highlight", order: 3, shape: { kind: "ellipsoid", center: [0.68, 0.82, 0.62], radii: [0.09, 0.06, 0.09] } },
    { name: "spot_b", material: "highlight", order: 3, shape: { kind: "ellipsoid", center: [0.32, 0.78, 0.38], radii: [0.08, 0.06, 0.08] } },
    { name: "spot_c", material: "highlight", order: 3, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.5, 0.92, 0.44], radii: [0.07, 0.05, 0.07] } },
  ],
};

/** A wrapped gift box with a ribbon and bow. */
const giftBox: SculptureModel = {
  id: "gift_box",
  aspect: { width: 1, height: 1, depth: 1 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "box", material: "body", shape: { kind: "box", min: [0.05, 0.0, 0.05], max: [0.95, 0.78, 0.95] } },
    { name: "lid", material: "belly", order: 1, shape: { kind: "box", min: [0.02, 0.72, 0.02], max: [0.98, 0.82, 0.98] } },
    { name: "ribbon_x", material: "accent", order: 2, shape: { kind: "box", min: [0.44, 0.0, 0.02], max: [0.56, 0.83, 0.98] } },
    { name: "ribbon_z", material: "accent", order: 2, shape: { kind: "box", min: [0.02, 0.0, 0.44], max: [0.98, 0.83, 0.56] } },
    { name: "bow_a", material: "accent", order: 3, shape: { kind: "ellipsoid", center: [0.36, 0.9, 0.5], radii: [0.16, 0.09, 0.1] } },
    { name: "bow_b", material: "accent", order: 3, shape: { kind: "ellipsoid", center: [0.64, 0.9, 0.5], radii: [0.16, 0.09, 0.1] } },
    { name: "bow_knot", material: "highlight", order: 4, shape: { kind: "ellipsoid", center: [0.5, 0.9, 0.5], radii: [0.07, 0.07, 0.07] } },
  ],
};

/** A stylized tree: trunk plus three overlapping canopy lobes. */
const stylizedTree: SculptureModel = {
  id: "stylized_tree",
  aspect: { width: 0.9, height: 1, depth: 0.9 },
  facing: "south",
  materials: MATERIALS,
  parts: [
    { name: "trunk", material: "limb", shape: { kind: "capsule", from: [0.5, 0.0, 0.5], to: [0.5, 0.5, 0.5], radius: 0.07, endScale: 0.7 } },
    { name: "branch", material: "limb", mirrorX: true, order: 1, minDetail: "medium", shape: { kind: "capsule", from: [0.5, 0.4, 0.5], to: [0.3, 0.58, 0.42], radius: 0.035, endScale: 0.6 } },
    { name: "canopy_main", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.5, 0.74, 0.5], radii: [0.36, 0.26, 0.36] } },
    { name: "canopy_left", material: "body", order: 2, shape: { kind: "ellipsoid", center: [0.28, 0.62, 0.44], radii: [0.24, 0.19, 0.24] } },
    { name: "canopy_right", material: "belly", order: 2, shape: { kind: "ellipsoid", center: [0.72, 0.66, 0.58], radii: [0.24, 0.19, 0.24] } },
    { name: "canopy_top", material: "belly", order: 3, minDetail: "medium", shape: { kind: "ellipsoid", center: [0.54, 0.92, 0.5], radii: [0.2, 0.14, 0.2] } },
  ],
};

/** A five-pointed star, extruded — reads from any angle as a landmark or a prop. */
const star: SculptureModel = {
  id: "star",
  aspect: { width: 1, height: 1, depth: 0.22 },
  facing: "south",
  materials: MATERIALS,
  parts: (() => {
    const parts: SculptureModel["parts"] = [];
    const points = 5;
    const list: SculptureModel["parts"][number][] = [
      { name: "core", material: "body", shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.5], radii: [0.2, 0.2, 0.5] } },
    ];
    for (let i = 0; i < points; i++) {
      // Points radiate from the centre, first one straight up.
      const angle = -Math.PI / 2 + (i / points) * Math.PI * 2;
      const tipX = 0.5 + Math.cos(angle) * 0.46;
      const tipY = 0.5 - Math.sin(angle) * 0.46;
      list.push({
        name: `point_${i}`,
        material: "body",
        order: 1,
        shape: {
          kind: "capsule",
          from: [0.5, 0.5, 0.5],
          to: [tipX, tipY, 0.5],
          radius: 0.15,
          endScale: 0.08,
        },
      });
    }
    list.push({
      name: "face",
      material: "highlight",
      order: 2,
      minDetail: "medium",
      shape: { kind: "ellipsoid", center: [0.5, 0.5, 0.9], radii: [0.16, 0.16, 0.08] },
    });
    return [...parts, ...list];
  })(),
};

export const ARCHETYPES: Readonly<Record<string, SculptureModel>> = {
  cartoon_dog: cartoonDog,
  cartoon_bird: cartoonBird,
  cartoon_rodent: cartoonRodent,
  bear,
  rabbit,
  mascot_egg: mascotEgg,
  humanoid,
  orb,
  giant_flower: giantFlower,
  mushroom,
  gift_box: giftBox,
  stylized_tree: stylizedTree,
  star,
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

export function getArchetype(id: string): SculptureModel {
  const model = ARCHETYPES[id];
  if (!model) {
    throw new Error(
      `Unknown sculpture archetype "${id}". Available: ${ARCHETYPE_IDS.join(", ")}. ` +
        "For a specific character, carve it from silhouettes or extract it from a reference schematic instead.",
    );
  }
  return model;
}
