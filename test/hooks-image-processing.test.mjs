import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-image-processing-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: `export default {};
    export const useRef = value => globalThis.__previewTest.hook(() => ({current:value}));
    export const useMemo = (fn, deps) => globalThis.__previewTest.hook(fn, deps);
    export const useCallback = (fn, deps) => useMemo(() => fn, deps);
    export const useEffect = (fn, deps) => globalThis.__previewTest.effect(fn, deps);`,
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__previewTest.invoke(...args);',
  './useEditorActions': 'export const debouncedSave = () => {};',
  '../components/panel/right/Masks':
    'export const SubMaskMode = {Additive:"additive", Subtractive:"subtractive", Intersect:"intersect"};',
  '../components/ui/AppProperties':
    'export const Panel = {Crop:"crop"}; export const Invokes = {ApplyAdjustments:"apply_adjustments", GenerateUncroppedPreview:"generate_uncropped_preview", ApplyAdjustmentsToPaths:"apply_adjustments_to_paths"};',
};
for (const name of ['Editor', 'UI', 'Settings', 'Library']) {
  stubs[`../store/use${name}Store`] = `export const use${name}Store = fn => fn(globalThis.__previewTest.${name});
     use${name}Store.getState = () => globalThis.__previewTest.${name};`;
}
const output = join(directory, 'processing.mjs');
await build({
  stdin: {
    contents: `export {useImageProcessing} from './src/hooks/useImageProcessing';
      export {INITIAL_ADJUSTMENTS} from './src/utils/adjustments';`,
    resolveDir: process.cwd(),
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'preview-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    },
  ],
});
const { useImageProcessing, INITIAL_ADJUSTMENTS } = await import(pathToFileURL(output));
const drain = () => new Promise((resolve) => setImmediate(resolve));

function environment(t) {
  const slots = [];
  let index = 0;
  let effects = [];
  const same = (a, b) => a?.length === b?.length && a?.every((value, i) => Object.is(value, b[i]));
  const state = {
    calls: [],
    Editor: {
      selectedImage: { path: 'a.png', isReady: true },
      adjustments: structuredClone(INITIAL_ADJUSTMENTS),
      previewOverride: null,
      isWaveformVisible: false,
      activeWaveformChannel: 'luma',
      displaySize: { width: 0, height: 0 },
      baseRenderSize: null,
      originalSize: { width: 6000, height: 4000 },
      isSliderDragging: true,
      patchesSentToBackend: new Set(),
      interactivePatch: null,
    },
    UI: { activeView: 'editor', activePanel: 'adjustments' },
    Settings: { appSettings: { editorPreviewResolution: 5120, livePreviewQuality: 'high' } },
    Library: { multiSelectedPaths: [] },
    hook(factory, deps) {
      const i = index++;
      if (!slots[i] || (deps && !same(slots[i].deps, deps))) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    effect(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        effects.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
      }
    },
    invoke(command, payload) {
      if (command !== 'apply_adjustments') return Promise.resolve();
      return new Promise((resolve, reject) => state.calls.push({ payload, resolve, reject }));
    },
  };
  state.Editor.setEditor = (value) =>
    Object.assign(state.Editor, typeof value === 'function' ? value(state.Editor) : value);
  globalThis.__previewTest = state;
  const refs = {
    previewJobIdRef: { current: 0 },
    latestRenderedJobIdRef: { current: 0 },
    currentResRef: { current: 0 },
  };
  const transform = { current: null };
  const previous = { current: null };
  state.render = () => {
    index = 0;
    effects = [];
    const result = useImageProcessing(transform, previous, refs);
    effects.forEach((effect) => effect());
    return result;
  };
  state.finish = (i) => state.calls[i].resolve(new TextEncoder().encode('WGPU_RENDER').buffer);
  t.after(() => slots.forEach((slot) => slot?.cleanup?.()));
  return state;
}

test('the editor sends a bounded drag render, skips obsolete values and restores requested detail on release', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  assert.equal(state.calls[0].payload.targetResolution, 1920);
  assert.equal(state.calls[0].payload.isInteractive, true);
  for (const exposure of [0.25, 0.5, 0.75]) {
    state.Editor.adjustments = { ...state.Editor.adjustments, exposure };
    state.render();
  }
  state.Editor.isSliderDragging = false;
  state.render();
  assert.equal(state.calls.length, 1);
  state.finish(0);
  await drain();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.jsAdjustments.exposure, 0.75);
  assert.equal(state.calls[1].payload.targetResolution, 5120);
  assert.equal(state.calls[1].payload.isInteractive, false);
  state.finish(1);
  await drain();
});

test('failed old-photo renders cannot clear the next photo preview or stall its pending render', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  const currentPatch = { url: 'current-photo-preview' };
  state.Editor.interactivePatch = currentPatch;
  state.render();
  state.calls[0].reject(new Error('previous photo failed'));
  await drain();
  assert.equal(state.Editor.interactivePatch, currentPatch);
  assert.equal(state.calls.length, 2);
  state.finish(1);
  await drain();
});

test('returning to the same filename cannot accept a response from the earlier photo session', async (t) => {
  const state = environment(t);
  state.render();
  await drain();
  state.Editor.selectedImage = { path: 'b.png', isReady: true };
  state.render();
  state.Editor.selectedImage = { path: 'a.png', isReady: true };
  state.render();
  const currentPatch = { url: 'reopened-photo-preview' };
  state.Editor.interactivePatch = currentPatch;
  state.finish(0);
  await drain();
  assert.equal(state.Editor.interactivePatch, currentPatch);
  assert.equal(state.calls.length, 2);
  state.finish(1);
  await drain();
});
