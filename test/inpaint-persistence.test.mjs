import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-inpaint-persistence-'));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = join(directory, 'fixture.cjs');
await build({
  stdin: {
    contents: `
      export { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from './src/utils/adjustments';
      export { useEditorStore } from './src/store/useEditorStore';
      export { preparePreviewAdjustments } from './src/utils/previewPipeline';
    `,
    resolveDir: resolve('.'),
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
});
const { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, useEditorStore, preparePreviewAdjustments } = createRequire(
  import.meta.url,
)(outfile);
const candidate = {
  id: 'candidate',
  method: 'generative',
  patch: {
    id: 'patch',
    subMasks: [],
    patchData: { color: 'repair', mask: 'alpha' },
    generationOptions: { seed: 17, referenceImagesBase64: ['reference'] },
  },
};

test('photo sidecar JSON retains candidates, reference and native patch data through normal loading', () => {
  const saved = { ...INITIAL_ADJUSTMENTS, inpaintHistory: [candidate] };
  const restored = normalizeLoadedAdjustments(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.inpaintHistory, [candidate]);
  assert.deepEqual(restored.aiPatches, []);
});
test('undo, redo and history navigation do not delete newly generated candidates or resurrect deleted ones', () => {
  useEditorStore.getState().resetHistory(INITIAL_ADJUSTMENTS);
  useEditorStore.getState().pushHistory({ ...INITIAL_ADJUSTMENTS, exposure: 1 });
  useEditorStore
    .getState()
    .setEditor({ adjustments: { ...INITIAL_ADJUSTMENTS, exposure: 1, inpaintHistory: [candidate] } });
  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().adjustments.inpaintHistory, [candidate]);
  useEditorStore.getState().redo();
  assert.deepEqual(useEditorStore.getState().adjustments.inpaintHistory, [candidate]);
  useEditorStore.getState().setEditor({ adjustments: { ...INITIAL_ADJUSTMENTS, inpaintHistory: [] } });
  useEditorStore.getState().goToHistoryIndex(0);
  assert.deepEqual(useEditorStore.getState().adjustments.inpaintHistory, []);
});
test('interactive render IPC omits archived candidates and reference images without mutating saved settings', () => {
  const adjustments = { ...INITIAL_ADJUSTMENTS, inpaintHistory: [candidate], aiPatches: [candidate.patch] };
  const { payload } = preparePreviewAdjustments(adjustments, new Set());
  assert.equal(payload.inpaintHistory, undefined);
  assert.equal(payload.aiPatches[0].generationOptions.referenceImagesBase64, undefined);
  assert.equal(payload.aiPatches[0].generationOptions.seed, 17);
  assert.deepEqual(adjustments.aiPatches[0].generationOptions.referenceImagesBase64, ['reference']);
  assert.equal(adjustments.inpaintHistory[0], candidate);
});
