import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-preview-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'preview.mjs');
await build({
  entryPoints: ['src/utils/previewPipeline.ts'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
});
const { PreviewPipeline, preparePreviewAdjustments, interactivePreviewResolution } = await import(
  pathToFileURL(output)
);
const drain = () => new Promise((resolve) => setImmediate(resolve));

function renderer() {
  const started = [];
  const completions = [];
  const pipeline = new PreviewPipeline((request) => {
    started.push(request);
    return new Promise((resolve, reject) => completions.push({ resolve, reject }));
  });
  return { pipeline, started, completions };
}

test('a slow renderer skips intermediate slider positions and renders the exact release value at full quality', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue({ exposure: 0.1, interactive: true });
  await drain();
  for (let i = 2; i <= 100; i++) pipeline.enqueue({ exposure: i / 100, interactive: true });
  pipeline.enqueue({ exposure: 1, interactive: false });
  assert.deepEqual(started, [{ exposure: 0.1, interactive: true }]);
  completions[0].resolve();
  await drain();
  assert.deepEqual(started, [
    { exposure: 0.1, interactive: true },
    { exposure: 1, interactive: false },
  ]);
  completions[1].resolve();
  await drain();
});

test('resuming a drag replaces an obsolete queued final render without waiting for another animation frame', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue('running');
  await drain();
  pipeline.enqueue('old release');
  pipeline.enqueue('new slider position');
  completions[0].resolve();
  await drain();
  assert.deepEqual(started, ['running', 'new slider position']);
  completions[1].resolve();
  await drain();
});

test('photo changes clear pending work and renderer failures do not leave the next photo stuck', async () => {
  const { pipeline, started, completions } = renderer();
  pipeline.enqueue('old photo running');
  await drain();
  pipeline.enqueue('old photo pending');
  pipeline.clear();
  pipeline.enqueue('new photo');
  completions[0].reject(new Error('old render failed'));
  await drain();
  assert.deepEqual(started, ['old photo running', 'new photo']);
  completions[1].resolve();
  await drain();
  pipeline.enqueue('later edit');
  await drain();
  assert.equal(started.at(-1), 'later edit');
  completions[2].resolve();
  await drain();
});

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('unmounting before dispatch cancels a reserved request without calling the renderer', async () => {
  const { pipeline, started } = renderer();
  pipeline.enqueue('photo being closed');
  pipeline.clear();
  await drain();
  assert.deepEqual(started, []);
});

test('preview payloads omit only acknowledged assets and preserve frozen recipes, strokes and repair provenance', () => {
  const strokes = [{ points: [{ x: 1, y: 2 }], size: 12 }];
  const subMasks = [
    { id: 'cached-mask', parameters: { mask_data_base64: 'large snake bitmap', lines: strokes } },
    { id: 'new-mask', parameters: { maskDataBase64: 'new camel bitmap' } },
  ];
  const patchData = { color: 'large repair', mask: 'large mask', generation: { seed: 123 } };
  const adjustments = freeze({
    exposure: 1.25,
    masks: [{ id: 'mask-container', opacity: 80, subMasks }],
    aiPatches: [
      { id: 'cached-patch', patchData, subMasks },
      { id: 'new-patch', patchData, subMasks: [] },
      { id: 'loading-patch', patchData, isLoading: true, subMasks: [] },
    ],
  });
  const cached = new Set(['cached-mask', 'cached-patch', 'loading-patch']);
  const { payload, sentAssets } = preparePreviewAdjustments(adjustments, cached);
  assert.equal(payload.masks[0].subMasks[0].parameters.mask_data_base64, null);
  assert.equal(payload.masks[0].subMasks[1].parameters.maskDataBase64, 'new camel bitmap');
  assert.equal(payload.aiPatches[0].patchData, null);
  assert.equal(payload.aiPatches[1].patchData, patchData);
  assert.equal(payload.aiPatches[2].patchData, patchData);
  assert.equal(payload.masks[0].subMasks[0].parameters.lines, strokes);
  assert.equal(adjustments.masks[0].subMasks[0].parameters.mask_data_base64, 'large snake bitmap');
  assert.equal(adjustments.aiPatches[0].patchData, patchData);
  assert.deepEqual([...sentAssets].sort(), ['new-mask', 'new-patch']);
  assert.deepEqual([...cached], ['cached-mask', 'cached-patch', 'loading-patch']);
});

test('drag previews bound zoom cost while preserving smaller images and the Full quality choice', () => {
  assert.equal(interactivePreviewResolution(5120, 'high'), 1920);
  assert.equal(interactivePreviewResolution(5120, 'performance'), 1920);
  assert.equal(interactivePreviewResolution(5120), 1920);
  assert.equal(interactivePreviewResolution(960, 'high'), 960);
  assert.equal(interactivePreviewResolution(5120, 'full'), 5120);
});
