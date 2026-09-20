import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-state-test-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const output = join(directory, 'state.cjs');
await build({
  stdin: {
    contents: `
      export { useUIStore, reconcileWorkspace } from './src/store/useUIStore';
      export { Panel } from './src/components/ui/AppProperties';
      export { normalizeLoadedAdjustments } from './src/utils/adjustments';
    `,
    resolveDir: resolve('.'),
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { useUIStore, reconcileWorkspace, Panel, normalizeLoadedAdjustments } = createRequire(import.meta.url)(output);

for (const method of ['movePanel', 'movePanelToIndex']) {
  test(`${method} selects a remaining source tab and the moved destination tab`, () => {
    useUIStore.setState(reconcileWorkspace(undefined, false));
    useUIStore.getState()[method](Panel.FolderTree, 'rightBottom', 0);
    const state = useUIStore.getState();
    assert.equal(state.activePanels.leftTop, Panel.Metadata);
    assert.equal(state.activePanels.rightBottom, Panel.FolderTree);
    assert.deepEqual(state.panelLayout.rightBottom, [Panel.FolderTree]);
    assert.equal(state.panelLayout.leftTop.includes(Panel.FolderTree), false);
    assert.equal(
      Object.values(state.panelLayout)
        .flat()
        .filter((panel) => panel === Panel.FolderTree).length,
      1,
    );
  });

  test(`${method} clears the active source tab after moving its final panel`, () => {
    useUIStore.setState(reconcileWorkspace(undefined, false));
    useUIStore.getState().movePanel(Panel.FolderTree, 'leftBottom');
    useUIStore.getState()[method](Panel.FolderTree, 'rightBottom', 0);
    assert.deepEqual(useUIStore.getState().panelLayout.leftBottom, []);
    assert.equal(useUIStore.getState().activePanels.leftBottom, null);
  });
}

test('legacy saved masks receive missing defaults without replacing explicit false or zero', () => {
  const saved = {
    exposure: 1.25,
    masks: [
      {
        id: 'mask',
        subMasks: [
          { id: 'legacy', type: 'brush' },
          {
            id: 'hidden',
            type: 'radial',
            visible: false,
            invert: true,
            opacity: 0,
            mode: 'subtractive',
            parameters: { centerX: 100, centerY: 120 },
          },
        ],
      },
    ],
    aiPatches: [
      {
        id: 'patch',
        visible: false,
        subMasks: [],
        patchData: {
          color: 'saved-color',
          mask: 'saved-mask',
          generation: { processing: 'tiled', tileSize: 512 },
        },
      },
    ],
  };
  const original = structuredClone(saved);
  const normalized = normalizeLoadedAdjustments(saved);
  assert.equal(normalized.exposure, 1.25);
  assert.deepEqual(normalized.masks[0].subMasks[0], {
    id: 'legacy',
    type: 'brush',
    visible: true,
    mode: 'additive',
    invert: false,
    opacity: 100,
    parameters: {},
  });
  assert.deepEqual(normalized.masks[0].subMasks[1], saved.masks[0].subMasks[1]);
  assert.equal(normalized.aiPatches[0].visible, false);
  assert.deepEqual(normalized.aiPatches[0].patchData, saved.aiPatches[0].patchData);
  assert.deepEqual(saved, original);
});

test('null sidecar adjustments and partial presets receive complete editor defaults', () => {
  const defaults = normalizeLoadedAdjustments(null);
  assert.equal(defaults.exposure, 0);
  assert.deepEqual(defaults.masks, []);
  const partial = normalizeLoadedAdjustments({ exposure: 2, temperature: -8 });
  assert.equal(partial.exposure, 2);
  assert.equal(partial.temperature, -8);
  assert.deepEqual(partial.curves, defaults.curves);
  assert.notEqual(partial.curves, defaults.curves);
});
