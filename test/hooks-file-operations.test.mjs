import { extendUpstreamBoundaries } from './fixtures/upstream-boundaries.mjs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-file-operations-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: 'export const useCallback = fn => fn;',
  '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__fileOperations.invoke(...args);',
  '@tauri-apps/plugin-dialog': 'export const open = () => null;',
  'react-toastify': 'export const toast = {error: message => globalThis.__fileOperations.errors.push(message)};',
  '../components/ui/AppProperties':
    'export const Invokes = {RenameFiles:"rename_files", RenameFolder:"rename_folder"};',
  '../components/ui/ExportImportProperties': 'export const Status = {Error:"error"};',
};
for (const name of ['Editor', 'Library', 'UI', 'Process', 'Settings']) {
  stubs[`../store/use${name}Store`] =
    `export const use${name}Store = {getState: () => globalThis.__fileOperations.${name.toLowerCase()}};`;
}
extendUpstreamBoundaries(stubs);
const output = join(directory, 'operations.mjs');
await build({
  entryPoints: ['src/hooks/useFileOperations.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'file-operation-boundaries',
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
const { useFileOperations } = await import(pathToFileURL(output));

function environment(images = []) {
  const state = {
    errors: [],
    selections: [],
    calls: [],
    returnedPaths: [],
    returnedToLibrary: false,
    ui: { activeView: 'library' },
    editor: { selectedImage: null },
    library: { libraryActivePath: null, rootPaths: [], currentFolderPath: null },
    process: {},
    settings: { appSettings: { pinnedFolders: [] } },
    async invoke(command, args) {
      state.calls.push({ command, args });
      if (command === 'rename_files') return state.returnedPaths;
    },
  };
  for (const key of ['ui', 'editor', 'library']) {
    const setter = { ui: 'setUI', editor: 'setEditor', library: 'setLibrary' }[key];
    state[key][setter] = (update) => Object.assign(state[key], update);
  }
  state.settings.handleSettingsChange = (settings) => {
    state.settings.appSettings = settings;
  };
  globalThis.__fileOperations = state;
  state.operations = useFileOperations(
    async () => {},
    async () => {},
    (...args) => state.selections.push(args),
    () => {
      state.returnedToLibrary = true;
    },
    images.map((path) => ({ path })),
  );
  return state;
}

test('deleting an original skips its virtual copies when selecting a neighbour', async () => {
  for (const view of ['library', 'editor']) {
    const state = environment(['photo.CR3', 'photo.CR3?vc=abcdef', 'next.CR3']);
    state.ui.activeView = view;
    state.library.libraryActivePath = 'photo.CR3';
    state.editor.selectedImage = view === 'editor' ? { path: 'photo.CR3' } : null;
    await state.operations.executeDelete(['photo.CR3']);
    if (view === 'editor') assert.deepEqual(state.selections, [['next.CR3']]);
    else assert.equal(state.library.libraryActivePath, 'next.CR3');
    assert.deepEqual(state.errors, []);
  }
});

test('deleting the only physical photo leaves the editor instead of opening a deleted copy', async () => {
  const state = environment(['photo.CR3?vc=abcdef', 'photo.CR3']);
  state.ui.activeView = 'editor';
  state.editor.selectedImage = { path: 'photo.CR3' };
  await state.operations.executeDelete(['photo.CR3']);
  assert.equal(state.returnedToLibrary, true);
  assert.deepEqual(state.selections, []);
});

test('renaming a photo keeps the active view and the virtual copy identity', async () => {
  for (const view of ['library', 'editor']) {
    const state = environment();
    const oldPath = 'photo.CR3?vc=abcdef';
    const newPath = 'renamed.CR3?vc=abcdef';
    state.ui.activeView = view;
    state.ui.renameTargetPaths = [oldPath, 'other.CR3'];
    state.editor.selectedImage = { path: oldPath };
    state.library.libraryActivePath = oldPath;
    state.returnedPaths = [newPath, 'other.CR3'];
    await state.operations.handleSaveRename('renamed');
    assert.deepEqual(state.selections, [[newPath, view === 'editor']]);
    assert.equal(state.library.libraryActivePath, newPath);
    assert.deepEqual(state.library.multiSelectedPaths, [newPath, 'other.CR3']);
    assert.deepEqual(state.ui.renameTargetPaths, []);
  }
});

test('folder rename remaps nested roots and pins but leaves a sibling with the same prefix alone', async () => {
  for (const separator of ['/', '\\']) {
    const oldPath = ['photos', 'trip'].join(separator);
    const nested = `${oldPath}${separator}day1`;
    const sibling = `${oldPath}2`;
    const expected = ['photos', 'renamed', 'day1'].join(separator);
    const state = environment();
    state.ui.folderActionTarget = oldPath;
    state.library.rootPaths = [nested, sibling];
    state.library.currentFolderPath = sibling;
    state.settings.appSettings.pinnedFolders = [nested, sibling];
    await state.operations.handleRenameFolder('renamed');
    assert.deepEqual(state.library.rootPaths, [expected, sibling]);
    assert.equal(state.library.currentFolderPath, sibling);
    assert.deepEqual(
      state.settings.appSettings.pinnedFolders,
      [expected, sibling].sort((a, b) => a.localeCompare(b)),
    );
    state.library.currentFolderPath = nested;
    await state.operations.handleRenameFolder('renamed');
    assert.equal(state.library.currentFolderPath, expected);
    assert.deepEqual(state.errors, []);
  }
});
