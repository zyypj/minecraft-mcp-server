/**
 * Small immutable value types (Java records) mirroring the shared {@code protocol/} contract.
 *
 * <p><b>Codegen note:</b> these records are hand-written for the scaffold, but are intended to be
 * <em>generated</em> from {@code protocol/schema/*.json} (the language-neutral source of truth,
 * §8) once the codegen tool exists. Keep them structurally in lockstep with the TS/zod types the
 * Node side generates; do not add plugin-only fields here — put those in the {@code rpc}/{@code world}
 * layers instead.
 */
package com.mcbuild.buildengine.model;
