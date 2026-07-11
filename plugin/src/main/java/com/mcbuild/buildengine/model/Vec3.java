package com.mcbuild.buildengine.model;

/**
 * Integer block coordinate. Mirrors {@code protocol} {@code {x,y,z}} (§3.3).
 */
public record Vec3(int x, int y, int z) {

    public Vec3 add(int dx, int dy, int dz) {
        return new Vec3(x + dx, y + dy, z + dz);
    }
}
