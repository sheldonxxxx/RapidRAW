/** Native ONNX session-provider regression and operation benchmark.
 * Supply RAPIDRAW_BINARY, RAPIDRAW_TEST_IMAGE (real RAW), and a fresh
 * RAPIDRAW_WORKSPACE with verified assets in models/ or available in the app.
 * Run with RAPIDRAW_ONNX_PROVIDER=cpu|auto|cuda; an absent value tests default CPU.
 * Optional RAPIDRAW_ONNX_EXPECTED_PROVIDERS is JSON {"model.onnx":"cpu|cuda"}.
 * RAPIDRAW_ONNX_RUNS defaults to 4 (first call plus 3 model-warm calls).
 * RAPIDRAW_ONNX_BASELINE points to another run's onnx-provider-results.json.
 * RAPIDRAW_ONNX_TOLERANCE accepts JSON {mean_absolute,p99_absolute}, normalized
 * to [0,1]; defaults are 0.01 and 0.05. These are regression gates, not a
 * certification of photographic quality or proof of individual GPU operators.
 * This runner never downloads models, uses generative services, or edits a RAW.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createNativeHarness, hashBytes, hashFile } from './coverage-evidence.mjs';
import { decodePng, pixelDifference } from './png-fixtures.mjs';
import { snapshotCudaMaps } from './cuda-lib-maps.mjs';

for (const key of ['RAPIDRAW_BINARY', 'RAPIDRAW_TEST_IMAGE', 'RAPIDRAW_WORKSPACE']) {
  assert.ok(process.env[key] && isAbsolute(process.env[key]), `Set ${key} to an absolute path`);
}
const source = resolve(process.env.RAPIDRAW_TEST_IMAGE);
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE);
const requested = process.env.RAPIDRAW_ONNX_PROVIDER ?? 'cpu';
assert.ok(['cpu', 'auto', 'cuda'].includes(requested), 'Invalid RAPIDRAW_ONNX_PROVIDER');
const runs = Number(process.env.RAPIDRAW_ONNX_RUNS ?? 4);
assert.ok(Number.isInteger(runs) && runs >= 2 && runs <= 20, 'RAPIDRAW_ONNX_RUNS must be 2..20');
const expected = JSON.parse(process.env.RAPIDRAW_ONNX_EXPECTED_PROVIDERS ?? '{}');
assert.ok(expected && !Array.isArray(expected) && typeof expected === 'object');
for (const [name, provider] of Object.entries(expected)) {
  assert.ok(
    name.endsWith('.onnx') && !/[\\/]/.test(name) && ['cpu', 'cuda'].includes(provider),
    'Expected providers must map model basenames to cpu or cuda',
  );
}
const tolerance = {
  mean_absolute: 0.01,
  p99_absolute: 0.05,
  ...JSON.parse(process.env.RAPIDRAW_ONNX_TOLERANCE ?? '{}'),
};
assert.deepEqual(Object.keys(tolerance).sort(), ['mean_absolute', 'p99_absolute']);
assert.ok(Object.values(tolerance).every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
const baselinePath = process.env.RAPIDRAW_ONNX_BASELINE && resolve(process.env.RAPIDRAW_ONNX_BASELINE);
const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
if (baseline) assert.equal(baseline.status, 'passed', 'A failed run is not a comparison baseline');
await mkdir(join(workspace, 'artifacts'), { recursive: true });
const resultPath = join(workspace, 'onnx-provider-results.json');
await writeFile(resultPath, '', { flag: 'wx' });
const report = {
  schema: 'rapidraw-onnx-provider-v1',
  status: 'running',
  requested_provider: requested,
  provider_explicitly_set: process.env.RAPIDRAW_ONNX_PROVIDER !== undefined,
  platform: process.platform,
  source,
  source_sha256: await hashFile(source),
  runs,
  operations: {},
  artifacts: {},
  comparisons: {},
  tolerance,
  baseline: baselinePath ?? null,
  ld_library_path: process.env.LD_LIBRARY_PATH ?? null,
  library_context: 'native-torch-free',
  timing_scope:
    'Native MCP operation wall time including preparation and serialization; excludes separate open/render/diagnostic calls. First calls include lazy initialization where applicable. Warm means model sessions retained, with a fresh source working path for each operation.',
  provider_scope: 'Session registration diagnostics do not prove that every graph operator ran on GPU.',
  photographic_quality: 'not reviewed',
};
const persist = () => writeFile(resultPath, JSON.stringify(report, null, 2));
const h = await createNativeHarness({ suite: 'onnx-provider', workspace, timeout: 1800000 });
let failure, seed, dimensions;
const workingPaths = new Set();
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
async function snapshot() {
  const data = (await h.call('models')).data;
  assert.ok(data.onnx_execution, 'Native binary must expose models.onnx_execution');
  assert.equal(data.onnx_execution.configuration_error, null);
  assert.equal(data.onnx_execution.configuration.requested_provider, requested);
  assert.equal(data.onnx_execution.cuda_supported_platform, process.platform === 'linux');
  // Absence and null mean uninitialized/failed, never an inferred CPU provider.
  for (const status of Object.values(data.onnx_execution.models)) {
    assert.ok(status.session_provider === null || ['cpu', 'cuda'].includes(status.session_provider));
  }
  return data;
}
async function fresh() {
  const opened = (await h.call('open_photo', { path: seed, inherit_sidecar: false })).data;
  assert.deepEqual(opened.dimensions, dimensions);
  assert.ok(
    opened.working_path && !workingPaths.has(opened.working_path),
    'Each inference must receive a new path to avoid SAM/depth cache reuse',
  );
  workingPaths.add(opened.working_path);
  return opened;
}
async function timed(label, iteration, method, args) {
  process.stdout.write(`${label} ${iteration + 1}/${runs}\n`);
  const start = performance.now(),
    response = await h.call(method, args);
  const elapsed_ms = performance.now() - start;
  const record = (report.operations[label] ??= { method, calls: [] });
  record.calls.push({ iteration, elapsed_ms, call_id: response.call_id });
  record.first_ms = record.calls[0].elapsed_ms;
  if (record.calls.length > 1) record.warm_median_ms = median(record.calls.slice(1).map((call) => call.elapsed_ms));
  await persist();
  return response;
}
function difference(a, b) {
  const result = pixelDifference(a, b),
    histogram = new Uint32Array(256);
  for (let i = 0; i < a.pixels.length; i++) histogram[Math.round(Math.abs(a.pixels[i] - b.pixels[i]) * 255)]++;
  let count = 0,
    p99 = 0;
  for (; p99 < 255; p99++) {
    count += histogram[p99];
    if (count >= a.pixels.length * 0.99) break;
  }
  return { ...result, p99_absolute: p99 / 255 };
}
async function artifact(name, response, expectedDimensions) {
  assert.equal(response.images.length, 1, `${name}: require one native image`);
  assert.equal(response.images[0].mimeType, 'image/png');
  const bytes = Buffer.from(response.images[0].data, 'base64'),
    decoded = decodePng(bytes);
  assert.equal(decoded.bitDepth, 8);
  assert.deepEqual([decoded.width, decoded.height], expectedDimensions, `${name}: unexpected output size`);
  const relativePath = `artifacts/${name}.png`,
    path = join(workspace, relativePath);
  await writeFile(path, bytes, { flag: 'wx' });
  report.artifacts[name] = {
    path: relativePath,
    sha256: hashBytes(bytes),
    width: decoded.width,
    height: decoded.height,
    bit_depth: decoded.bitDepth,
  };
  if (baseline) {
    const reference = baseline.artifacts[name];
    assert.ok(reference, `Baseline lacks ${name}`);
    const referencePath = resolve(dirname(baselinePath), reference.path);
    assert.equal(await hashFile(referencePath), reference.sha256, `Baseline ${name} changed`);
    const metrics = difference(decoded, decodePng(await readFile(referencePath)));
    report.comparisons[name] = metrics;
    await persist();
    assert.ok(
      metrics.mean_absolute <= tolerance.mean_absolute,
      `${name}: MAE ${metrics.mean_absolute} exceeds ${tolerance.mean_absolute}`,
    );
    assert.ok(
      metrics.p99_absolute <= tolerance.p99_absolute,
      `${name}: p99 ${metrics.p99_absolute} exceeds ${tolerance.p99_absolute}`,
    );
  }
  return decoded;
}
async function render(id, region) {
  const result = await h.call('render', { session_id: id, format: 'png', cache: false, ...(region ? { region } : {}) });
  assert.equal(result.data.cache.hit, false);
  return result;
}
function inpaintTensor(region) {
  const padX = Math.max(128, Math.trunc(region.width * 1.5));
  const padY = Math.max(128, Math.trunc(region.height * 1.5));
  const cropWidth =
    Math.min(dimensions.width - 1, region.x + region.width - 1 + padX) - Math.max(0, region.x - padX) + 1;
  const cropHeight =
    Math.min(dimensions.height - 1, region.y + region.height - 1 + padY) - Math.max(0, region.y - padY) + 1;
  return Math.ceil(Math.min(768, Math.max(cropWidth, cropHeight)) / 64) * 64;
}
try {
  await h.fixture(source, 'Preserved real RAW source for bounded native ONNX regression');
  const original = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data;
  assert.equal(original.is_raw, true, 'Supply a real RAW source, not a synthetic raster');
  report.source_dimensions = original.dimensions;
  const exported = (
    await h.call('export', {
      session_id: original.session_id,
      path: 'onnx-fixture.png',
      format: 'png',
      bit_depth: 8,
      long_edge: 1024,
      color_profile: 'none',
      keep_metadata: false,
    })
  ).data;
  await h.call('close_session', { session_id: original.session_id });
  seed = exported.path;
  const pixels = decodePng(await readFile(seed));
  dimensions = { width: pixels.width, height: pixels.height };
  assert.ok(
    Math.max(pixels.width, pixels.height) === 1024 && Math.min(pixels.width, pixels.height) >= 448,
    'Use a RAW with enough pixels and an aspect ratio suitable for both inpaint crop sizes',
  );
  assert.deepEqual([exported.width, exported.height], [pixels.width, pixels.height]);
  report.fixture = {
    dimensions,
    sha256: await hashFile(seed),
    pixels_sha256: hashBytes(Buffer.from(pixels.pixels.buffer)),
  };
  await h.fixture(seed, '1024px native rendering of the original RAW; inference uses display-referred pixels', {
    parent_sha256: report.source_sha256,
  });
  report.before = await snapshot();
  assert.deepEqual(
    report.before.onnx_execution.models,
    {},
    'Use a fresh native process; model diagnostics should be uninitialized before inference',
  );
  for (const kind of ['masks', 'inpaint', 'denoise']) {
    assert.ok(
      report.before.groups[kind].assets.every((asset) => asset.verified || asset.installed_app_copy_available),
      `Install ${kind} assets before running; this suite never downloads models`,
    );
  }
  report.model_sha256 = Object.fromEntries(
    Object.values(report.before.groups).flatMap((group) =>
      group.assets.map((asset) => [asset.name, asset.expected_sha256]),
    ),
  );
  assert.equal(Object.keys(report.model_sha256).length, 7);
  if (baseline) {
    assert.equal(baseline.schema, report.schema);
    assert.equal(baseline.source_sha256, report.source_sha256, 'Baseline must use the same RAW');
    assert.equal(
      baseline.fixture.pixels_sha256,
      report.fixture.pixels_sha256,
      'Compare providers using identical native fixture pixels',
    );
    assert.deepEqual(baseline.model_sha256, report.model_sha256, 'Baseline must use identical model assets');
  }
  for (const name of Object.keys(expected))
    assert.ok(Object.hasOwn(report.model_sha256, name), `Unknown expected model: ${name}`);
  const fixtureSession = await fresh();
  await artifact('fixture', await render(fixtureSession.session_id), [dimensions.width, dimensions.height]);
  await h.call('close_session', { session_id: fixtureSession.session_id });

  for (const kind of ['subject', 'foreground', 'sky', 'depth']) {
    for (let iteration = 0; iteration < runs; iteration++) {
      const session = await fresh();
      const generated = await timed(`mask-${kind}`, iteration, 'mask_generate', {
        session_id: session.session_id,
        expected_revision: session.revision,
        kind,
        ...(kind === 'subject'
          ? {
              region: {
                x: dimensions.width * 0.1,
                y: dimensions.height * 0.05,
                width: dimensions.width * 0.8,
                height: dimensions.height * 0.9,
              },
            }
          : {}),
        parameters:
          kind === 'depth'
            ? { minDepth: 20, maxDepth: 80, minFade: 10, maxFade: 10, feather: 0 }
            : { grow: 0, feather: 0 },
      });
      assert.equal(generated.data.mask_statistics.empty, false, `Choose a fixture with a useful ${kind} selection`);
      assert.deepEqual(
        [generated.data.mask_statistics.width, generated.data.mask_statistics.height],
        [dimensions.width, dimensions.height],
      );
      assert.deepEqual(generated.data.dimensions, dimensions);
      if (iteration === runs - 1) await artifact(`mask-${kind}`, generated, [dimensions.width, dimensions.height]);
      await h.call('close_session', { session_id: session.session_id });
    }
    report.operations[`mask-${kind}`].diagnostics_after = (await snapshot()).onnx_execution;
  }
  for (const tensor of [448, 768]) {
    for (let iteration = 0; iteration < runs; iteration++) {
      const session = await fresh(),
        radius = tensor === 448 ? 54 : 128;
      const retouched = await timed(`inpaint-${tensor}`, iteration, 'retouch', {
        session_id: session.session_id,
        expected_revision: session.revision,
        mode: 'inpaint',
        sub_masks: [
          {
            id: `inpaint-${tensor}-${iteration}`,
            type: 'radial',
            visible: true,
            mode: 'additive',
            parameters: {
              centerX: Math.floor(dimensions.width / 2),
              centerY: Math.floor(dimensions.height / 2),
              radiusX: radius,
              radiusY: radius,
              rotation: 0,
              feather: 0,
            },
          },
        ],
      });
      assert.equal(retouched.data.remote_generation, false);
      assert.equal(retouched.data.mask_statistics.empty, false);
      assert.deepEqual(retouched.data.dimensions, dimensions);
      const state = (await h.call('get_session', { session_id: session.session_id, include_adjustments: true })).data;
      const patch = state.adjustments.aiPatches.find((item) => item.id === retouched.data.patch_id).patchData;
      const region = { x: patch.offsetX, y: patch.offsetY, width: patch.width, height: patch.height };
      assert.ok(Object.values(region).every(Number.isInteger) && region.width > 0 && region.height > 0);
      assert.ok(
        region.x >= 0 &&
          region.y >= 0 &&
          region.x + region.width <= dimensions.width &&
          region.y + region.height <= dimensions.height,
      );
      assert.equal(inpaintTensor(region), tensor, 'Patch bounds must exercise the requested native LaMa tensor size');
      report.operations[`inpaint-${tensor}`].crop = {
        affected_region: region,
        tensor_dimensions_from_native_crop_policy: [tensor, tensor],
      };
      if (iteration === runs - 1) {
        await artifact(`inpaint-${tensor}-mask`, retouched, [region.width, region.height]);
        await artifact(`inpaint-${tensor}-result`, await render(session.session_id), [
          dimensions.width,
          dimensions.height,
        ]);
        await artifact(`inpaint-${tensor}-affected-region`, await render(session.session_id, region), [
          region.width,
          region.height,
        ]);
      }
      await h.call('close_session', { session_id: session.session_id });
    }
    report.operations[`inpaint-${tensor}`].diagnostics_after = (await snapshot()).onnx_execution;
  }
  for (let iteration = 0; iteration < runs; iteration++) {
    const session = await fresh();
    const result = await timed('denoise-ai', iteration, 'denoise', {
      session_id: session.session_id,
      expected_revision: session.revision,
      method: 'ai',
      intensity: 50,
    });
    assert.notEqual(result.data.session_id, session.session_id);
    assert.equal(result.data.parent_session_id, session.session_id);
    assert.equal(result.data.source_domain_preserved, true);
    assert.equal(
      result.data.is_raw,
      false,
      'The bounded test uses a native display-referred export, not full RAW denoise',
    );
    assert.deepEqual(result.data.dimensions, dimensions);
    assert.equal((await h.call('get_session', { session_id: session.session_id })).data.revision, session.revision);
    if (iteration === runs - 1)
      await artifact('denoise-ai-result', await render(result.data.session_id), [dimensions.width, dimensions.height]);
    for (const session_id of [session.session_id, result.data.session_id])
      await h.call('close_session', { session_id });
  }
  report.operations['denoise-ai'].native_tile_policy = {
    tensor: [1, 3, 504, 504],
    stride: 480,
    overlap: 6,
    intensity: 50,
    scope: 'Current balanced native tile policy; this is not an operator trace',
  };
  report.after = await snapshot();
  {
    // Actual CUDA library identity from the live engine process. All seven
    // model sessions are initialized by now, so late-loaded cuDNN/cuBLAS
    // mappings are present. The binary path plus our workspace in the
    // cmdline disambiguates our engine from unrelated processes.
    const binary = resolve(process.env.RAPIDRAW_BINARY);
    const candidates = execSync(`pgrep -f '${binary}' || true`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const ours = candidates.filter((pid) => {
      try {
        const cmdline = execSync(`tr '\\0' ' ' < /proc/${pid}/cmdline`, { encoding: 'utf8' });
        // The binary path alone also matches launcher wrappers whose
        // command line embeds it; require the bridge invocation itself.
        return cmdline.includes(binary) && cmdline.includes('--mcp-bridge') && cmdline.includes(workspace);
      } catch {
        return false;
      }
    });
    assert.ok(ours.length >= 1, `Expected a live engine for ${workspace}; pgrep found: ${candidates}`);
    report.native_cuda_libraries = { engine_pid: ours[0], ...snapshotCudaMaps(ours[0]) };
    await persist();
  }
  await h.check(
    'all_seven_model_sessions_have_explicit_provider_diagnostics',
    ['tool:models', 'tool:mask_generate', 'tool:retouch', 'tool:denoise'],
    async () => {
      for (const [name, sha256] of Object.entries(report.model_sha256)) {
        const status = report.after.onnx_execution.models[name];
        assert.ok(status, `${name}: absent status is uninitialized, not CPU success`);
        assert.ok(['cpu', 'cuda'].includes(status.session_provider), `${name}: model did not initialize`);
        assert.equal(status.error, null, `${name}: model initialization failed`);
        const expectedProvider =
          expected[name] ?? (requested === 'cpu' || process.platform !== 'linux' ? 'cpu' : undefined);
        if (expectedProvider)
          assert.equal(status.session_provider, expectedProvider, `${name}: provider differs from expectation`);
        assert.equal(await hashFile(join(workspace, 'models', name)), sha256);
      }
      return {
        actual: report.after.onnx_execution.models,
        expected,
        successful_operations: Object.keys(report.operations),
        provider_scope: report.provider_scope,
      };
    },
  );
  assert.equal(await hashFile(source), report.source_sha256);
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = String(error);
  try {
    report.after_failure = await snapshot();
  } catch (diagnosticError) {
    report.diagnostics_error = String(diagnosticError);
  }
} finally {
  try {
    await h.close(failure);
  } catch (error) {
    failure ??= error;
    report.status = 'failed';
    report.error ??= String(error);
  }
  await persist();
}
if (failure) throw failure;
console.log(
  JSON.stringify(
    {
      status: report.status,
      results: resultPath,
      timings: Object.fromEntries(
        Object.entries(report.operations).map(([name, operation]) => [
          name,
          { first_ms: operation.first_ms, warm_median_ms: operation.warm_median_ms },
        ]),
      ),
    },
    null,
    2,
  ),
);
