import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-generation-test-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
async function bundled(entry, name, plugins = []) {
  const output = join(directory, name + '.mjs');
  await build({
    entryPoints: [resolve(entry)],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins,
  });
  return import(pathToFileURL(output));
}
const { generationDraft, scopedCapabilities, resolveGenerationOptions } = await bundled(
  'src/utils/generationOptions.ts',
  'options',
);
const ready = {
  scope: 'a',
  status: 'ready',
  data: {
    seed: true,
    defaultProfile: 'balanced',
    profiles: [{ id: 'balanced', label: 'Balanced editing', defaultMegapixels: 1, megapixels: [1, 2, 4] }],
  },
};

const { syncMarigoldOrientation } = await bundled('src/utils/marigoldGeometry.ts', 'marigold-geometry');
test('rotating a saved Marigold map follows the photo while preserving built-in masks and history', () => {
  const builtin = { type: 'ai-depth', parameters: { rotation: 0, orientationSteps: 0 } };
  const marigold = {
    type: 'ai-depth',
    parameters: { depthProvider: 'marigold', orientationSteps: 0, maskDataBase64: 'saved-map' },
  };
  const old = {
    rotation: 0,
    orientationSteps: 1,
    flipHorizontal: true,
    flipVertical: false,
    masks: [{ subMasks: [builtin, marigold] }],
  };
  const updated = syncMarigoldOrientation(old);
  assert.equal(updated.masks[0].subMasks[0], builtin);
  assert.equal(updated.masks[0].subMasks[1].parameters.orientationSteps, 1);
  assert.equal(updated.masks[0].subMasks[1].parameters.flipHorizontal, true);
  assert.equal(updated.masks[0].subMasks[1].parameters.maskDataBase64, 'saved-map');
  assert.equal(marigold.parameters.orientationSteps, 0);
  assert.equal(syncMarigoldOrientation(updated), updated);
  const legacy = { ...old, masks: [{ subMasks: [builtin] }] };
  assert.equal(syncMarigoldOrientation(legacy), legacy);
});

test('advertised defaults and saved options remain explicit and immutable', () => {
  assert.deepEqual(resolveGenerationOptions(ready, generationDraft()), {
    options: { profile: 'balanced', megapixels: 1 },
  });
  const saved = { profile: 'balanced', megapixels: 2, seed: 104729 };
  assert.deepEqual(resolveGenerationOptions(ready, generationDraft(saved)), { options: saved });
  assert.deepEqual(saved, { profile: 'balanced', megapixels: 2, seed: 104729 });
});
test('seed validation preserves the safe integer boundary without rounding', () => {
  for (const text of ['0', '-1', '1.5', '9007199254740992', '1e3', 'NaN', '001']) {
    assert.equal(resolveGenerationOptions(ready, { seedText: text }).error, 'seed', text);
  }
  assert.equal(resolveGenerationOptions(ready, { seedText: '9007199254740991' }).options.seed, 9007199254740991);
  assert.equal(resolveGenerationOptions(ready, { seedText: ' ' }).options.seed, undefined);
});
test('unsupported saved workflows, detail and seed cannot silently fall through', () => {
  assert.equal(resolveGenerationOptions(ready, { seedText: '', profile: 'missing' }).error, 'profile');
  assert.equal(resolveGenerationOptions(ready, { seedText: '', megapixels: 3 }).error, 'detail');
  assert.equal(
    resolveGenerationOptions({ ...ready, data: { ...ready.data, seed: false } }, { seedText: '7' }).error,
    'seedUnsupported',
  );
});
test('legacy defaults remain compatible and error fallback is explicit', () => {
  assert.deepEqual(resolveGenerationOptions({ scope: 'a', status: 'legacy' }, generationDraft()), {});
  assert.equal(
    resolveGenerationOptions({ scope: 'a', status: 'legacy' }, generationDraft({ seed: 7 })).error,
    'unavailable',
  );
  assert.equal(resolveGenerationOptions({ scope: 'a', status: 'error' }, generationDraft()).error, 'unavailable');
  assert.deepEqual(resolveGenerationOptions({ scope: 'a', status: 'error' }, { seedText: '', useDefault: true }), {});
});
test('new server/provider scope hides old capabilities before effects run', () => {
  const pending = scopedCapabilities(ready, 'other-address', true);
  assert.deepEqual(pending, { scope: 'other-address', status: 'loading' });
  assert.equal(resolveGenerationOptions(pending, generationDraft({ profile: 'balanced' })).error, 'loading');
  assert.deepEqual(scopedCapabilities(ready, 'cloud', false), { scope: 'cloud', status: 'inactive' });
});

const stubs = {
  react: 'export const useCallback=(fn)=>fn; export const useEffect=()=>{};',
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__generationTest.invoke(...args);',
  'react-toastify':
    'export const toast={error:(message)=>globalThis.__generationTest.errors.push(message),info:()=>{}};',
  '@clerk/react': 'export const useAuth=()=>({getToken:()=>globalThis.__generationTest.token()});',
  '../store/useEditorStore':
    'export const useEditorStore=(selector)=>selector(globalThis.__generationTest.state); useEditorStore.getState=()=>globalThis.__generationTest.state;',
  './useEditorActions':
    'export const useEditorActions=()=>({setAdjustments:(fn)=>{const t=globalThis.__generationTest;t.state.adjustments=fn(t.state.adjustments)}});',
  '../components/ui/AppProperties':
    'export const Invokes={InvokeGenerativeReplaseWithMaskDef:"invoke_generative_replace_with_mask_def"};',
};
const hook = await bundled('src/hooks/useAiMasking.ts', 'hook', [
  {
    name: 'native-call-boundary-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
      );
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
    },
  },
]);
function environment() {
  const original = { color: 'previous-patch', generation: { seed: 3 } };
  const env = {
    errors: [],
    calls: [],
    original,
    token: async () => null,
    state: {
      selectedImage: { path: '/fixture/photo.raw' },
      adjustments: {
        aiPatches: [
          {
            id: 'patch',
            prompt: 'old',
            generationOptions: { seed: 3, profile: 'old' },
            patchData: original,
            subMasks: [],
            isLoading: false,
          },
        ],
      },
      isGeneratingAi: false,
      patchesSentToBackend: new Set(['patch']),
    },
  };
  env.state.setEditor = (value) => Object.assign(env.state, value);
  env.invoke = async (name, payload) => {
    env.calls.push({ name, payload });
    return JSON.stringify({ color: 'new-patch' });
  };
  globalThis.__generationTest = env;
  return env;
}
test('click-time options reach native request and patch state despite old stored settings', async () => {
  const env = environment();
  const chosen = { profile: 'balanced', megapixels: 2, seed: 104729 };
  const pending = hook.useAiMasking().handleGenerativeReplace('patch', 'new prompt', false, chosen);
  assert.equal(env.state.isGeneratingAi, true);
  assert.equal(env.state.adjustments.aiPatches[0].patchData, env.original);
  await pending;
  assert.deepEqual(env.calls[0].payload.patchDefinition.generationOptions, chosen);
  assert.equal(env.calls[0].payload.patchDefinition.prompt, 'new prompt');
  assert.deepEqual(env.state.adjustments.aiPatches[0].generationOptions, chosen);
  assert.equal(env.state.adjustments.aiPatches[0].patchData.color, 'new-patch');
  assert.equal(env.state.isGeneratingAi, false);
});
test('generation failure preserves previous patch and clears busy state', async () => {
  const env = environment();
  env.invoke = async () => {
    throw new Error('Fixture rejection');
  };
  await hook.useAiMasking().handleGenerativeReplace('patch', 'new', false, { profile: 'balanced', seed: 9 });
  assert.equal(env.state.adjustments.aiPatches[0].patchData, env.original);
  assert.equal(env.state.adjustments.aiPatches[0].isLoading, false);
  assert.equal(env.state.isGeneratingAi, false);
  assert.equal(env.errors.length, 1);
});
test('basic inpaint and legacy requests omit saved explicit options', async () => {
  for (const fast of [true, false]) {
    const env = environment();
    await hook.useAiMasking().handleGenerativeReplace('patch', '', fast);
    assert.equal(env.calls[0].payload.patchDefinition.generationOptions, undefined);
    assert.equal(env.state.adjustments.aiPatches[0].generationOptions, undefined);
  }
});

test('Marigold is explicit, merges current range controls, and never invokes the built-in command', async () => {
  const env = environment();
  env.state.adjustments.masks = [{ id: 'depth', subMasks: [{ id: 'd1', parameters: { minDepth: 10, maxDepth: 90 } }] }];
  let finish;
  env.invoke = (name) => {
    env.calls.push(name);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = hook.useAiMasking().handleGenerateAiDepthMask('d1', { depthProvider: 'marigold' });
  env.state.adjustments.masks[0].subMasks[0].parameters.minDepth = 25;
  finish({ depthProvider: 'marigold', maskDataBase64: 'map16', depthArtifact: { version: 1 } });
  await pending;
  assert.deepEqual(env.calls, ['generate_marigold_depth_mask']);
  assert.equal(env.state.adjustments.masks[0].subMasks[0].parameters.minDepth, 25);
  assert.equal(env.state.adjustments.masks[0].subMasks[0].parameters.maskDataBase64, 'map16');
});
test('late Marigold results cannot overwrite switched photos, changed geometry, or cancelled masks', async () => {
  for (const change of ['photo', 'geometry', 'cancel']) {
    const env = environment();
    env.state.adjustments.masks = [
      { id: 'depth', subMasks: [{ id: 'd1', parameters: { maskDataBase64: 'original' } }] },
    ];
    let finish;
    env.invoke = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = hook.useAiMasking().handleGenerateAiDepthMask('d1', { depthProvider: 'marigold' });
    if (change === 'photo') env.state.selectedImage = { path: '/fixture/other.raw' };
    if (change === 'geometry') env.state.adjustments.rotation = 5;
    if (change === 'cancel') hook.discardMarigoldResult('d1');
    finish({ depthProvider: 'marigold', maskDataBase64: 'late' });
    await pending;
    assert.equal(env.state.adjustments.masks[0].subMasks[0].parameters.maskDataBase64, 'original');
    assert.equal(env.state.isGeneratingAiMask, false);
  }
});

test('surface generation reuses the shared connector command and merges controls changed in flight', async () => {
  const env = environment();
  env.state.adjustments.masks = [
    { id: 'm', subMasks: [{ id: 's', type: 'ai-albedo', parameters: { surfaceAmount: 0 } }] },
  ];
  let finish;
  env.invoke = (name, args) => {
    env.calls.push({ name, args });
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = hook.useAiMasking().handleGenerateSurfaceMask('s', 'albedo');
  env.state.adjustments.masks[0].subMasks[0].parameters.surfaceAmount = 0.7;
  finish({ maskDataBase64: 'rgb16', surfaceArtifact: { kind: 'albedo' } });
  await pending;
  assert.equal(env.calls[0].name, 'generate_marigold_surface_mask');
  assert.equal(env.calls[0].args.kind, 'albedo');
  assert.deepEqual(env.calls[0].args.jsAdjustments.aiPatches, env.state.adjustments.aiPatches);
  assert.equal(env.state.adjustments.masks[0].subMasks[0].parameters.surfaceAmount, 0.7);
  assert.equal(env.state.adjustments.masks[0].subMasks[0].parameters.maskDataBase64, 'rgb16');
});

test('surface results cannot overwrite replaced photos, warp, retouch, crop, cancelled or deleted masks', async () => {
  for (const change of ['photo', 'geometry', 'retouch', 'crop', 'cancel', 'delete']) {
    const env = environment();
    const part = { id: 's', type: 'ai-normals', parameters: { maskDataBase64: 'original' } };
    env.state.adjustments.masks = [{ id: 'm', subMasks: [part] }];
    let finish;
    env.invoke = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = hook.useAiMasking().handleGenerateSurfaceMask('s', 'normals');
    if (change === 'photo') env.state.selectedImage = { path: '/fixture/photo.raw' };
    if (change === 'geometry') env.state.adjustments.guidedPerspective = { enabled: true };
    if (change === 'retouch') env.state.adjustments.aiPatches = [];
    if (change === 'crop') env.state.adjustments.crop = { x: 20 };
    if (change === 'cancel') hook.discardMarigoldResult('s');
    if (change === 'delete') env.state.adjustments.masks = [];
    finish({ maskDataBase64: 'late' });
    await pending;
    assert.equal(part.parameters.maskDataBase64, 'original', change);
    assert.equal(env.state.isGeneratingAiMask, false);
  }
});

const surface = await bundled('src/utils/surfaceGeometry.ts', 'surface-geometry');
test('surface signatures ignore display transforms, include warp and retouch, and sort nested keys', async () => {
  const a = { transformRotate: 0, guidedPerspective: { z: 1, a: 2.5 } };
  const b = { transformRotate: 0, guidedPerspective: { a: 2.5, z: 1 }, rotation: 30, crop: { x: 2 } };
  assert.equal(surface.surfaceGeometrySnapshot(a), surface.surfaceGeometrySnapshot(b));
  assert.notEqual(surface.surfaceRequestSnapshot(a), surface.surfaceRequestSnapshot(b));
  assert.notEqual(surface.surfaceGeometrySnapshot(a), surface.surfaceGeometrySnapshot({ ...a, aiPatches: [] }));
  assert.equal((await surface.surfaceGeometryHash(surface.surfaceGeometrySnapshot(a))).length, 64);
  const normals = { type: 'ai-normals', parameters: { maskDataBase64: 'rgb16', normalAngle: 30 } };
  const adjusted = syncMarigoldOrientation({
    rotation: 10,
    orientationSteps: 1,
    flipHorizontal: true,
    flipVertical: false,
    masks: [{ subMasks: [normals] }],
  });
  assert.equal(adjusted.masks[0].subMasks[0].parameters.normalAngle, 30);
  assert.equal(adjusted.masks[0].subMasks[0].parameters.maskDataBase64, 'rgb16');
  assert.equal(adjusted.masks[0].subMasks[0].parameters.orientationSteps, 1);
});

test('surface layout protects render capacity and rejects mixed surface components without restricting legacy masks', () => {
  const normal = { type: 'ai-normals', parameters: {} };
  const albedo = { type: 'ai-albedo', parameters: {} };
  const legacy = Array.from({ length: 32 }, () => ({ subMasks: [{ type: 'brush' }] }));
  assert.equal(surface.surfaceLayoutError({ masks: legacy }), null);
  assert.equal(surface.surfaceLayoutError({ masks: [...legacy.slice(1), { subMasks: [normal] }] }), 'slots');
  assert.equal(surface.surfaceLayoutError({ masks: [...legacy.slice(2), { subMasks: [normal] }] }), null);
  assert.equal(surface.surfaceLayoutError({ masks: [{ subMasks: [normal, albedo] }] }), 'multiple');
  assert.equal(surface.surfaceLayoutError({ masks: [], aiPatches: [{ subMasks: [albedo] }] }), 'multiple');
});
