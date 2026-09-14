import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../dist/tools.js';
const tool = (name) => toolDefinitions.find((entry) => entry.method === name);
test('enhancement requires revision and preserves explicit performance and region controls', () => {
  const args = {
    session_id: 'source',
    expected_revision: 4,
    request: {
      operation: 'refine_mask',
      profile: 'quality',
      provider: 'coreml',
      boundary_radius: 64,
      region: [10, 20, 512, 512],
    },
    mask_id: 'bird',
    sub_mask_id: 'subject',
  };
  assert.deepEqual(tool('enhance').schema.parse(args), args);
  assert.throws(() => tool('enhance').schema.parse({ ...args, expected_revision: undefined }));
  for (const patch of [
    { provider: 'gpu' },
    { profile: 'ultra' },
    { boundary_radius: 0 },
    { region: [0, 0, 0, 1] },
    { region: [0.5, 0, 1, 1] },
    { strength: NaN },
    { confidence: 2 },
    { tile_szie: 128 },
  ]) {
    assert.throws(() => tool('enhance').schema.parse({ ...args, request: { ...args.request, ...patch } }));
  }
});
test('enhancement model imports accept only known roles and valid digests', () => {
  assert.ok(tool('enhancement_models').readOnly);
  assert.equal(
    tool('install_enhancement_model').schema.parse({
      model_id: 'upscale',
      path: '/models/model.onnx',
      sha256: 'a'.repeat(64),
    }).model_id,
    'upscale',
  );
  for (const args of [{ model_id: 'unknown' }, { model_id: 'upscale', sha256: 'wrong' }])
    assert.throws(() => tool('install_enhancement_model').schema.parse(args));
  assert.equal(tool('start_operation').schema.parse({ operation: 'enhance', arguments: {} }).operation, 'enhance');
});
