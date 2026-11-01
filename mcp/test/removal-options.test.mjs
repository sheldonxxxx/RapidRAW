import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../dist/tools.js';
const retouch = toolDefinitions.find((tool) => tool.method === 'retouch');
const base = {
  session_id: 'session',
  mode: 'generative',
  sub_masks: [{ id: 'selection', type: 'radial', visible: true, mode: 'additive', parameters: {} }],
};
test('removal mask preview requires neither a prompt nor provider settings', () => {
  const parsed = retouch.schema.parse({
    ...base,
    preview_only: true,
    removal_options: { expandPixels: 12, featherPixels: 24 },
  });
  assert.equal(parsed.preview_only, true);
  assert.deepEqual(parsed.removal_options, { expandPixels: 12, featherPixels: 24 });
  assert.equal(retouch.schema.parse(base).removal_options, undefined);
});
test('removal mask widths reject unbounded, non-integral and unknown values', () => {
  for (const options of [
    { expandPixels: -1 },
    { expandPixels: 257 },
    { featherPixels: 1.5 },
    { featherPixels: Infinity },
    { featherPixels: null },
    { unknown: 2 },
  ]) {
    assert.throws(() => retouch.schema.parse({ ...base, removal_options: options }));
  }
  assert.throws(() => retouch.schema.parse({ ...base, preview_only: 'true' }));
});
test('an existing patch can be regenerated without restating its selection', () => {
  const { sub_masks, ...rest } = base;
  const parsed = retouch.schema.parse({ ...rest, replace_patch_id: 'patch-1', generation_options: { seed: 9 } });
  assert.equal(parsed.replace_patch_id, 'patch-1');
  assert.equal(parsed.sub_masks, undefined);
  assert.throws(() => retouch.schema.parse({ ...base, replace_patch_id: '' }));
  assert.throws(() => retouch.schema.parse({ ...base, replace_patch_id: 7 }));
});
