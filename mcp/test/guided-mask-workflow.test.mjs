import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../scripts/coverage-evidence.mjs';
import { validateGuidedMaskManifest, validateGuidedNativeBounds, correctionCoverageDelta } from '../scripts/guided-mask-workflow-contract.mjs';

const region = { x: 8, y: 8, width: 8, height: 8 };
const line = () => ({ tool: 'brush', brushSize: 16, feather: 0.25, points: [{ x: 12, y: 12 }] });
const effects = () => ({ selected: { region, minimum_mean_absolute_difference: 0.002 }, protected: { region: { x: 40, y: 40, width: 8, height: 8 }, maximum_mean_absolute_difference: 0.001 } });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rapidraw-guided-mask-contract-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'source'); await writeFile(path, 'Manifest-only fixture, not native or photographic evidence');
  return { version: 1, groups: [{ id: 'subject', kind: 'ai-mask', partition: 'regression', capture_group: 'capture', provenance: 'Manifest contract fixture', derived_from_same_image: false, sources: [{ path, sha256: await hashFile(path) }], review_criteria: ['Inspect correction continuity and spill'], ai: { kind: 'subject', region: { x: 0, y: 0, width: 64, height: 64 } }, corrections: ['additive', 'subtractive'].map((mode) => ({ id: mode, mode, parameters: { lines: [line()] }, probe: { region, minimum_opacity_delta: 0.1 }, review_criteria: ['Verify native boundary against source'] })), local_adjustments: { exposure: 0.4, shadows: 8 }, effect_probes: effects(), manual: { intent: 'Soft interior lift', parameters: { lines: [line(), { ...line(), tool: 'eraser', brushSize: 2 }] }, effect_probes: effects() }, review_regions: [{ id: 'edge', region, criteria: ['Inspect edge rather than judging mask completeness from probes'] }] }] };
}
test('guided workflow accepts explicit native brush modes and a separate brush/eraser manual mask', async (t) => {
  const manifest = await fixture(t); await validateGuidedMaskManifest(manifest);
  validateGuidedNativeBounds(manifest.groups[0], { width: 64, height: 64 });
  const invalid = structuredClone(manifest.groups[0]); invalid.manual.parameters.lines[0].points[0].x = 64;
  assert.throws(() => validateGuidedNativeBounds(invalid, { width: 64, height: 64 }), /point exceeds/);
  invalid.manual.parameters.lines[0].points[0].x = 12; invalid.review_regions[0].region.x = 63;
  assert.throws(() => validateGuidedNativeBounds(invalid, { width: 64, height: 64 }), /region exceeds/);
});
test('corrections reject eraser-only layers, ambiguous modes and non-native review regions', async (t) => {
  const original = await fixture(t);
  const bad = async (fn, pattern) => { const copy = structuredClone(original); fn(copy.groups[0]); await assert.rejects(validateGuidedMaskManifest(copy), pattern); };
  await bad((g) => { g.corrections[1].parameters.lines[0].tool = 'eraser'; }, /eraser alone/);
  await bad((g) => { g.corrections[1].mode = 'additive'; }, /both additive and subtractive/);
  await bad((g) => { g.review_regions[0].region.width = 513; }, /at most 512/);
  await bad((g) => { g.corrections[0].parameters.lines[0].feather = undefined; }, /feather explicitly/);
  await bad((g) => { g.corrections[0].probe.minimum_opacity_delta = 0; }, /positive opacity delta/);
  await bad((g) => { g.local_adjustments.rotation = 5; }, /unknown fields/);
  await bad((g) => { g.effect_probes.selected.minimum_mean_absolute_difference = 0; }, /nonzero effect/);
});
test('point refinement remains optional, subject-only and clearly a regression', async (t) => {
  const manifest = await fixture(t), group = manifest.groups[0];
  group.ai.refinement = { include_points: [{ x: 10, y: 12 }] }; await validateGuidedMaskManifest(manifest);
  group.ai.refinement.exclude_points = [{ x: 10, y: 12 }];
  await assert.rejects(validateGuidedMaskManifest(manifest), /both included and excluded/);
  delete group.ai.refinement.exclude_points; group.ai.kind = 'sky'; delete group.ai.region;
  await assert.rejects(validateGuidedMaskManifest(manifest), /subject masks/);
  delete group.ai.refinement; group.partition = 'fresh-holdout';
  await assert.rejects(validateGuidedMaskManifest(manifest), /regressions/);
});
test('correction gates measure intended signed coverage rather than any pixel difference', () => {
  assert.ok(correctionCoverageDelta('additive', 0.2, 0.8) > 0.5);
  assert.ok(correctionCoverageDelta('subtractive', 0.8, 0.2) > 0.5);
  assert.ok(correctionCoverageDelta('subtractive', 0.2, 0.8) < 0);
  assert.equal(correctionCoverageDelta('additive', 1, 1), 0);
  assert.throws(() => correctionCoverageDelta('additive', 0, NaN));
});
