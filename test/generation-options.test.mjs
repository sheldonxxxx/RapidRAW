import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-generation-test-'));
after(() => rm(directory, { recursive: true, force: true }));
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
  'react-toastify': 'export const toast={error:(message)=>globalThis.__generationTest.errors.push(message)};',
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
