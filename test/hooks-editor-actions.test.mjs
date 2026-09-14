import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-editor-actions-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: 'export const useCallback = (fn) => fn;',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__editorActionsTest.invoke(...args);',
  'react-toastify': 'export const toast = {error: (message) => globalThis.__editorActionsTest.errors.push(message)};',
  'lodash.debounce': 'export default (fn) => Object.assign(fn, {flush(){}, cancel(){}});',
  '../components/ui/AppProperties':
    'export const Invokes = {LoadMetadata: "load_metadata", ApplyAdjustmentsToPaths: "apply_adjustments_to_paths"};',
  '../components/panel/right/Masks': 'export const SubMaskMode = {Additive:"additive", Subtractive:"subtractive"};',
};
for (const name of ['Editor', 'Library', 'Settings', 'Process']) {
  stubs[`../store/use${name}Store`] =
    `export const use${name}Store = selector => selector(globalThis.__editorActionsTest.${name.toLowerCase()}); use${name}Store.getState = () => globalThis.__editorActionsTest.${name.toLowerCase()};`;
}
const output = join(directory, 'actions.mjs');
await build({
  stdin: {
    contents:
      'export * from "./src/hooks/useEditorActions"; export {INITIAL_ADJUSTMENTS} from "./src/utils/adjustments";',
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'editor-state-fixture',
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
const { useEditorActions, INITIAL_ADJUSTMENTS } = await import(pathToFileURL(output));
function environment() {
  const state = {
    errors: [],
    calls: [],
    editor: {
      selectedImage: { path: 'image.dng' },
      adjustments: structuredClone(INITIAL_ADJUSTMENTS),
      copiedAdjustments: null,
      showOriginal: false,
      pushHistory() {},
    },
    library: { multiSelectedPaths: [], libraryActivePath: null },
    settings: {
      appSettings: {
        copyPasteSettings: {
          mode: 'replace',
          includedAdjustments: ['exposure', 'lensMaker'],
          knownAdjustments: [],
          autoSync: false,
        },
      },
    },
    process: {},
    async invoke(command, args) {
      state.calls.push({ command, args });
      if (command === 'load_metadata') return { adjustments: state.metadata ?? {} };
    },
  };
  state.editor.setEditor = (updater) =>
    Object.assign(state.editor, typeof updater === 'function' ? updater(state.editor) : updater);
  state.process.setProcess = (update) => Object.assign(state.process, update);
  globalThis.__editorActionsTest = state;
  return state;
}

test('copy keeps nested adjustment data independent from later edits', async () => {
  const state = environment();
  state.editor.adjustments.curves.luma = [
    { x: 0, y: 0 },
    { x: 255, y: 210 },
  ];
  await useEditorActions().handleCopyAdjustments();
  const copied = structuredClone(state.editor.copiedAdjustments.curves);
  state.editor.adjustments.curves.luma[1].y = 5;
  assert.deepEqual(state.editor.copiedAdjustments.curves, copied);
  assert.equal(state.process.isCopied, true);
});

test('paste before copy-paste settings load is a harmless no-op', () => {
  const state = environment();
  state.settings.appSettings = {};
  state.editor.copiedAdjustments = { exposure: 2 };
  assert.doesNotThrow(() => useEditorActions().handlePasteAdjustments());
  assert.deepEqual(state.calls, []);
  assert.equal(state.editor.adjustments.exposure, 0);
});

test('partial metadata refresh preserves absent lens values and allows explicit clearing', async () => {
  const state = environment();
  state.editor.adjustments.lensMaker = 'Example';
  state.editor.adjustments.lensModel = '50mm';
  state.editor.copiedAdjustments = { exposure: 2 };
  useEditorActions().handlePasteAdjustments();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.editor.adjustments.lensMaker, 'Example');
  assert.equal(state.editor.adjustments.lensModel, '50mm');
  assert.equal(state.editor.adjustments.exposure, 2);
  state.metadata = { lensMaker: null, lensModel: null, lensDistortionParams: null };
  useEditorActions().handlePasteAdjustments();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.editor.adjustments.lensMaker, null);
  assert.equal(state.editor.adjustments.lensModel, null);
  assert.deepEqual(state.errors, []);
});
