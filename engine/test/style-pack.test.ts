/**
 * CI gate: every shipped style pack must pass every hard gate **by construction** (§5.5 note).
 *
 * These assertions check the pack's declared parameters against the hard-gate thresholds so a pack
 * can never be shipped in a state that guarantees a slop failure. (Build-time gates — flatness,
 * grounding contact, etc. — are validated separately against generated geometry.)
 */

import test from "ava";
import { STYLE_PACKS, loadStylePack, type StylePack } from "../src/styles/index.js";
import { ROOF_PITCH_RATIO_MIN, EAVE_OVERHANG_MIN } from "../src/rules/roof.js";
import { DETAIL_COVERAGE_MIN, DETAIL_COVERAGE_MAX } from "../src/rules/palette.js";
import { DEFAULT_WALL_THICKNESS } from "../src/rules/facade.js";
import { MIN_SIGNATURE_FEATURES } from "../src/features/feature-kit.js";

const packs: StylePack[] = [...STYLE_PACKS.values()];

test("at least one style pack ships", (t) => {
  t.true(packs.length >= 1);
});

for (const pack of packs) {
  test(`[${pack.id}] re-validates through loadStylePack`, (t) => {
    t.notThrows(() => loadStylePack(pack));
  });

  test(`[${pack.id}] palette has non-empty base/secondary/accent/detail (60-30-10 + trim/detail)`, (t) => {
    t.true(pack.palette.base.length > 0);
    t.true(pack.palette.secondary.length > 0);
    t.true(pack.palette.accent.length > 0);
    t.true(pack.palette.detail.length > 0);
  });

  test(`[${pack.id}] detailDensity is within the §5.6 40–60% coverage band`, (t) => {
    t.true(
      pack.detailDensity >= DETAIL_COVERAGE_MIN && pack.detailDensity <= DETAIL_COVERAGE_MAX,
      `detailDensity=${pack.detailDensity} must be in [${DETAIL_COVERAGE_MIN}, ${DETAIL_COVERAGE_MAX}]`,
    );
  });

  test(`[${pack.id}] wallThickness satisfies the depth gate`, (t) => {
    t.true(pack.massing.wallThickness >= 1);
    // Styles thinner than the default rely on the §5.4.2 reveal exception; note it explicitly.
    if (pack.massing.wallThickness < DEFAULT_WALL_THICKNESS) {
      t.true(pack.openings.recessDepth >= 1, "thin-wall styles must still recess reveals");
    }
  });

  test(`[${pack.id}] roof passes the roof gate by construction`, (t) => {
    if (pack.roof.type === "flat") {
      // Flat styles satisfy a parapet check instead of pitch/overhang (§5.4.3).
      t.pass();
    } else {
      t.true(pack.roof.pitchRatio >= ROOF_PITCH_RATIO_MIN, `pitchRatio ${pack.roof.pitchRatio} >= ${ROOF_PITCH_RATIO_MIN}`);
      t.true(pack.roof.overhang >= EAVE_OVERHANG_MIN, `overhang ${pack.roof.overhang} >= ${EAVE_OVERHANG_MIN}`);
    }
    t.true(pack.roof.material.length > 0, "roof must blend materials, not use one block");
  });

  test(`[${pack.id}] declares ≥3 signature features (the "3+ tells" gate is achievable)`, (t) => {
    t.true(pack.signatureFeatures.length >= MIN_SIGNATURE_FEATURES);
  });

  test(`[${pack.id}] does not forbid its own palette blocks`, (t) => {
    const forbidden = new Set(pack.forbiddenBlocks);
    const used = new Set<string>();
    for (const role of Object.values(pack.palette)) {
      for (const wb of role) used.add(wb.block);
    }
    for (const roof of pack.roof.material) used.add(roof.block);
    const conflicts = [...used].filter((b) => forbidden.has(b));
    t.deepEqual(conflicts, [], `palette blocks must not appear in forbiddenBlocks: ${conflicts.join(", ")}`);
  });

  test(`[${pack.id}] colorCentroids (if present) are Lab triples`, (t) => {
    if (!pack.colorCentroids) {
      t.pass();
      return;
    }
    for (const c of pack.colorCentroids) t.is(c.length, 3);
  });

  test(`[${pack.id}] groundingMode is not itself a forbidden feature`, (t) => {
    const forbidden = new Set(pack.forbiddenFeatures ?? []);
    t.false(forbidden.has(pack.massing.groundingMode));
  });
}
