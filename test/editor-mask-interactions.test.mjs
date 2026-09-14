import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-mask-interactions-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'interactions.mjs');
await build({
  stdin: {
    contents: `export * from './src/components/panel/right/maskInteractions';
      export { INITIAL_MASK_ADJUSTMENTS } from './src/utils/adjustments';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
});
const { applyLinearFalloffSelection, applyMaskAdjustmentUpdate, insertCreatedSubMask, INITIAL_MASK_ADJUSTMENTS } =
  await import(pathToFileURL(output));

test('all three native fade curves reach the mask update, including Extra smooth', () => {
  const updates = [];
  for (const value of ['linear', 'smoothstep', 'smootherstep']) {
    applyLinearFalloffSelection(value, (parameters) => updates.push(parameters));
  }
  assert.deepEqual(updates, [{ falloff: 'linear' }, { falloff: 'smoothstep' }, { falloff: 'smootherstep' }]);
  applyLinearFalloffSelection('unsupported', (parameters) => updates.push(parameters));
  assert.equal(updates.length, 3);
});

test('dropping a new component before the second mask preserves order and additive mode', () => {
  const container = { id: 'mask-group', subMasks: [{ id: 'first' }, { id: 'second' }] };
  const addSubMask = (containerId, type, mode, index) => {
    assert.equal(containerId, container.id);
    container.subMasks.splice(index, 0, { id: 'new', type, mode });
  };
  insertCreatedSubMask(container, 'second', 'brush', addSubMask);
  assert.deepEqual(
    container.subMasks.map((mask) => mask.id),
    ['first', 'new', 'second'],
  );
  assert.equal(container.subMasks[1].type, 'brush');
  assert.equal(container.subMasks[1].mode, 'additive');
});

test('drop insertion preserves zero and append sentinel indices', () => {
  const container = { id: 'mask-group', subMasks: [{ id: 'first' }] };
  const calls = [];
  insertCreatedSubMask(container, 'first', 'radial', (...args) => calls.push(args));
  insertCreatedSubMask(container, 'removed-target', 'linear', (...args) => calls.push(args));
  assert.deepEqual(calls, [
    ['mask-group', 'radial', 'additive', 0],
    ['mask-group', 'linear', 'additive', -1],
  ]);
});

test('shared adjustment controls update a local mask without adding global settings', () => {
  const current = structuredClone(INITIAL_MASK_ADJUSTMENTS);
  current.exposure = 0.5;
  const updated = applyMaskAdjustmentUpdate(current, (previous) => ({ ...previous, exposure: previous.exposure + 1 }));
  assert.equal(updated.exposure, 1.5);
  assert.equal(current.exposure, 0.5);
  assert.deepEqual(Object.keys(updated).sort(), Object.keys(current).sort());
  assert.equal('crop' in updated, false);
  assert.equal('aiPatches' in updated, false);
  assert.equal('toneMapper' in updated, false);
});

test('partial mask adjustments preserve untouched values and curve state', () => {
  const current = structuredClone(INITIAL_MASK_ADJUSTMENTS);
  current.exposure = 2;
  current.curveMode = 'parametric';
  const updated = applyMaskAdjustmentUpdate(current, {
    contrast: 25,
    crop: { unit: '%', x: 0, y: 0, width: 50, height: 50 },
  });
  assert.equal(updated.contrast, 25);
  assert.equal(updated.exposure, 2);
  assert.equal(updated.curveMode, 'parametric');
  assert.deepEqual(updated.parametricCurve, current.parametricCurve);
  assert.equal('crop' in updated, false);
});
