import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-inpaint-test-'));
after(() => rm(directory, { recursive: true, force: true }));
async function bundled(entry, name, stubs = {}) {
  const outfile = join(directory, `${name}.mjs`);
  await build({
    entryPoints: [resolve(entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'fixtures',
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
  return import(pathToFileURL(outfile));
}
const { variationOptions, inpaintSpatialKey, applyInpaintCandidate, toggleInpaintCandidate } = await bundled(
  'src/utils/inpaintHistory.ts',
  'history',
);
test('batch seeds remain distinct at the exact safe integer boundary and preserve references', () => {
  const options = Object.freeze({ seed: Number.MAX_SAFE_INTEGER, referenceImagesBase64: ['reference'] });
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => variationOptions(options, index).seed),
    [Number.MAX_SAFE_INTEGER, 1, 2, 3],
  );
  assert.deepEqual(variationOptions(options, 2).referenceImagesBase64, ['reference']);
  assert.equal(variationOptions(undefined, 2), undefined);
  assert.deepEqual(variationOptions({ profile: 'edit' }, 1), { profile: 'edit' });
});
test('applying a saved result restores its own mask without overwriting unrelated patches', () => {
  const adjustments = { aiPatches: [{ id: 'one', patchData: null }, { id: 'other' }], orientationSteps: 0 };
  const candidate = {
    spatialKey: inpaintSpatialKey(adjustments),
    patch: { id: 'one', subMasks: ['saved selection'], patchData: { color: 'result' } },
  };
  const updated = applyInpaintCandidate(adjustments, candidate);
  assert.equal(adjustments.aiPatches[0].patchData, null);
  assert.deepEqual(updated.aiPatches[0].subMasks, ['saved selection']);
  assert.equal(updated.aiPatches[1], adjustments.aiPatches[1]);
  assert.throws(() => applyInpaintCandidate({ ...adjustments, orientationSteps: 1 }, candidate));
  assert.throws(() => applyInpaintCandidate({ ...adjustments, transformDistortion: 4 }, candidate));
  assert.equal(applyInpaintCandidate({ ...adjustments, aiPatches: [] }, candidate).aiPatches.length, 1);
});
const stubs = {
  react:
    'export const useEffect=()=>{}; export const useRef=(current)=>({current}); export const useState=(v)=>[v,()=>{}];',
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__inpaint.invoke(...args);',
  '@clerk/react': 'export const useAuth=()=>({getToken:async()=>null});',
  'react-toastify': 'export const toast={error:(message)=>globalThis.__inpaint.errors.push(message)};',
  '../store/useEditorStore':
    'export const useEditorStore={getState:()=>globalThis.__inpaint.state,subscribe:(fn)=>{globalThis.__inpaint.subscriber=fn;return()=>{}}};',
  './useEditorActions': 'export const debouncedSave={flush:()=>{}};',
  '../components/ui/AppProperties':
    'export const Invokes={InvokeGenerativeReplaseWithMaskDef:"generate",SaveMetadataAndUpdateThumbnail:"save"};',
};
const { useInpaintCandidates } = await bundled('src/hooks/useInpaintCandidates.ts', 'hook', stubs);
function environment() {
  const env = {
    errors: [],
    calls: [],
    state: {
      selectedImage: { path: 'photo.raw' },
      adjustments: { aiPatches: [{ id: 'one', subMasks: ['mask'], patchData: { color: 'applied' } }] },
      isGeneratingAi: false,
    },
  };
  env.state.setEditor = (value) => {
    Object.assign(env.state, value);
    env.subscriber?.(env.state);
  };
  env.invoke = async (name, payload) => {
    env.calls.push({ name, payload });
    return JSON.stringify({ color: 'candidate', mask: 'mask' });
  };
  globalThis.__inpaint = env;
  return env;
}
test('batch uses an immutable source and saves all results without applying any', async () => {
  const env = environment();
  const source = env.state.adjustments;
  await useInpaintCandidates().generate('one', 'repair', false, { seed: 7 }, 3);
  const calls = env.calls.filter((entry) => entry.name === 'generate');
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((entry) => entry.payload.patchDefinition.generationOptions.seed),
    [7, 8, 9],
  );
  assert.ok(calls.every((entry) => entry.payload.currentAdjustments === calls[0].payload.currentAdjustments));
  assert.equal(env.state.adjustments.aiPatches, source.aiPatches);
  assert.equal(env.state.adjustments.inpaintHistory.length, 3);
  assert.equal(env.calls.filter((entry) => entry.name === 'save').length, 3);
  assert.equal(env.state.isGeneratingAi, false);
});
test('stop after current retains the running result and never submits remaining variations', async () => {
  const env = environment();
  const hook = useInpaintCandidates();
  const invoke = env.invoke;
  env.invoke = async (...args) => {
    if (args[0] === 'generate') hook.stop();
    return invoke(...args);
  };
  await hook.generate('one', 'repair', false, undefined, 4);
  assert.equal(env.state.adjustments.inpaintHistory.length, 1);
});
test('partial failures preserve completed candidates and release the generation lock', async () => {
  const env = environment();
  const invoke = env.invoke;
  let count = 0;
  env.invoke = async (...args) => {
    if (args[0] === 'generate' && ++count === 2) throw new Error('backend unavailable');
    return invoke(...args);
  };
  await useInpaintCandidates().generate('one', 'repair', false, undefined, 4);
  assert.equal(env.state.adjustments.inpaintHistory.length, 1);
  assert.equal(env.state.isGeneratingAi, false);
  assert.match(env.errors[0], /1\/4/);
});
test('changing photos saves the running result to its original photo without contaminating the new photo', async () => {
  const env = environment();
  const invoke = env.invoke;
  env.invoke = async (...args) => {
    if (args[0] === 'generate')
      env.state.setEditor({ selectedImage: { path: 'other.raw' }, adjustments: { aiPatches: [] } });
    return invoke(...args);
  };
  await useInpaintCandidates().generate('one', 'repair', false, undefined, 3);
  assert.equal(env.state.adjustments.inpaintHistory, undefined);
  const save = env.calls.find((entry) => entry.name === 'save');
  assert.equal(save.payload.path, 'photo.raw');
  assert.equal(save.payload.adjustments.inpaintHistory.length, 1);
  assert.equal(env.calls.filter((entry) => entry.name === 'generate').length, 1);
});

test('result clicks apply, disable, and reapply without changing unrelated edits or saved results', () => {
  const original = { aiPatches: [{ id: 'other', visible: true }], inpaintHistory: [], exposure: 2 };
  const candidate = { id: 'result', spatialKey: inpaintSpatialKey(original), patch: { id: 'repair' } };
  const applied = toggleInpaintCandidate(original, candidate);
  assert.equal(applied.aiPatches[1].visible, true);
  const undone = toggleInpaintCandidate(applied, candidate);
  assert.equal(undone.aiPatches[1].visible, false);
  assert.equal(undone.aiPatches[0], original.aiPatches[0]);
  assert.equal(undone.inpaintHistory, original.inpaintHistory);
  assert.equal(undone.exposure, 2);
  assert.equal(toggleInpaintCandidate(undone, candidate).aiPatches[1].visible, true);
  assert.equal(toggleInpaintCandidate({ ...applied, rotation: 90 }, candidate).aiPatches[1].visible, false);
});
