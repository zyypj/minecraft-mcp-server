package com.mcbuild.buildengine.model;

/**
 * An axis-aligned block region in a named world: {@code region = {min, max, world}} (§3.3).
 *
 * <p>{@code min}/{@code max} are inclusive corners. §7.1 normalizes every selection (cuboid,
 * polygon, cylinder) to {@code (AABB, mask)}; this record is the AABB. A per-voxel mask, when
 * present, lives alongside it (not modelled in this scaffold).
 */
public record Region(Vec3 min, Vec3 max, String world) {

    public int width()  { return max.x() - min.x() + 1; } // X
    public int height() { return max.y() - min.y() + 1; } // Y
    public int length() { return max.z() - min.z() + 1; } // Z

    /** Block count of the bounding box. {@code long} because a 200^3 region already overflows nothing but big fills can. */
    public long volume() {
        return (long) width() * (long) height() * (long) length();
    }

    public Vec3 dimensions() {
        return new Vec3(width(), height(), length());
    }

    /** AABB overlap test in the same world (used for reservation/overlap checks in the region registry). */
    public boolean overlaps(Region other) {
        if (!world.equals(other.world)) return false;
        return min.x() <= other.max.x() && max.x() >= other.min.x()
            && min.y() <= other.max.y() && max.y() >= other.min.y()
            && min.z() <= other.max.z() && max.z() >= other.min.z();
    }
}
