/** Actual SDK/native operation-worker lifecycle, captured input and output assertions. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createNativeHarness } from './coverage-evidence.mjs';
import { decodePng, fixturePng, pixelDifference, exposureExifFixture } from './png-fixtures.mjs';
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/operation-jobs-${Date.now()}`);
await mkdir(workspace, { recursive: true }); const source = join(workspace, 'fixture.png'); await writeFile(source, fixturePng(192, 128, undefined, [{ type: 'eXIf', data: exposureExifFixture(100) }]));
const h = await createNativeHarness({ suite: 'operation-jobs', workspace, timeout: 900000 }); let failure;
async function wait(id) {
  const deadline = Date.now() + 300000;
  for (let attempt = 0; Date.now() < deadline; attempt++) { const job = (await h.call('get_operation_job', { job_id: id })).data; if (job.status !== 'running') return job; await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 + attempt * 100))); }
  assert.fail(`Job ${id} did not finish within 300 seconds`);
}
try {
  await h.fixture(source, 'synthetic worker capture and persistence fixture');
  const session_id = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
  const original = (await h.call('render', { session_id, format: 'png' })).images[0].data;
  await h.check('captured_export_independent_of_later_parent_edits', ['tool:start_operation', 'tool:get_operation_job', 'tool:list_operation_jobs', 'parameter:start_operation.operation="export"'], async () => {
    const start = (await h.call('start_operation', { operation: 'export', arguments: { session_id, path: 'worker.png', format: 'png', bit_depth: 8 } })).data;
    await h.call('set_adjustments', { session_id, patch: { exposure: 1 } });
    const edited = (await h.call('render', { session_id, format: 'png' })).images[0].data; assert.notEqual(edited, original);
    const done = await wait(start.job_id); assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const output = decodePng(await readFile(done.result.path)); const baseline = decodePng(Buffer.from(original, 'base64'));
    assert.ok(pixelDifference(output, baseline).mean_absolute < 0.005, 'Worker must export captured original edits');
    assert.ok((await h.call('list_operation_jobs')).data.jobs.some((job) => job.job_id === start.job_id && job.status === 'succeeded'));
    await h.reconnect(); const restored = (await h.call('get_operation_job', { job_id: start.job_id })).data; assert.deepEqual(restored.result, done.result);
    assert.equal((await h.call('render', { session_id, format: 'png' })).images[0].data, edited);
    return { job_id: start.job_id, output: done.result.path, captured_pixel_mean_absolute: pixelDifference(output, baseline).mean_absolute };
  }, 'pixel_assertion');
  await h.check('cancel_worker_parent_alive_and_explicit_resume', ['tool:cancel_operation_job', 'tool:resume_operation_job'], async () => {
    const start = (await h.call('start_operation', { operation: 'export', arguments: { session_id, path: 'cancelled-then-resumed.png', format: 'png' } })).data;
    const cancelled = (await h.call('cancel_operation_job', { job_id: start.job_id })).data;
    assert.equal(cancelled.status, 'cancelled', 'Fresh worker should still be cancellable during native startup');
    const rendered = await h.call('render', { session_id, format: 'png' }); assert.ok(rendered.images.length);
    const resumed = (await h.call('resume_operation_job', { job_id: start.job_id })).data; assert.equal(resumed.attempt, 2); assert.equal(resumed.job_id, start.job_id);
    assert.equal((await wait(start.job_id)).status, 'succeeded');
  });
  await h.check('invalid_operation_schema_does_not_create_job', ['tool:start_operation'], async () => {
    const count = (await h.call('list_operation_jobs')).data.jobs.length;
    await h.call('start_operation', { operation: 'export', arguments: { session_id, path: 'bad.png', quality: 101 } }, { expectError: true });
    assert.equal((await h.call('list_operation_jobs')).data.jobs.length, count);
  });
  await h.call('undo', { session_id });
  assert.equal((await h.call('render', { session_id, format: 'png' })).images[0].data, original);
  const originalPixels = decodePng(Buffer.from(original, 'base64'));
  const darkSource = join(workspace, 'distinct-dark-hdr-fixture.png');
  await writeFile(darkSource, fixturePng(192, 128, (x, y) => Array.from({ length: 3 }, (_, c) => Math.round(originalPixels.pixels[(y * 192 + x) * 3 + c] * 150)), [{ type: 'eXIf', data: exposureExifFixture(200) }]));
  await h.fixture(darkSource, 'distinct synthetic HDR capture input; mechanical worker test, not a genuine photographic bracket');
  const modelStatus = (await h.call('models')).data;
  let masksReady = modelStatus.groups.masks.ready;
  if (!masksReady && process.env.RAPIDRAW_TEST_WORKER_MODELS === '1') {
    await h.call('install_model', { kind: 'masks' });
    masksReady = (await h.call('models')).data.groups.masks.ready;
    assert.equal(masksReady, true, 'Required local worker models must be installed');
  }
  const scenarios = [
    { operation: 'negative_convert', arguments: { session_id, parameters: { red_weight: 1, green_weight: 1, blue_weight: 1, exposure: 0, contrast: 1 } } },
    { operation: 'merge', arguments: { kind: 'hdr', paths: [source, darkSource] } },
    { operation: 'retouch', arguments: { session_id, mode: 'clone', source_point: { x: 20, y: 20 }, sub_masks: [{ id: 'worker-clone-stroke', type: 'clone', visible: true, mode: 'additive', parameters: { lines: [{ tool: 'brush', brushSize: 28, feather: 0.4, points: [{ x: 96, y: 64 }, { x: 108, y: 68 }] }] } }] } },
    { operation: 'mask_generate', model: true, arguments: { session_id, kind: 'depth', parameters: { minDepth: 0, maxDepth: 100, minFade: 0, maxFade: 0, feather: 0 }, adjustments: { exposure: 0.6 } } },
    { operation: 'generate_depth', model: true, arguments: { session_id, enable_blur: true } },
  ];
  for (const scenario of scenarios) {
    const requirement = `parameter:start_operation.operation=${JSON.stringify(scenario.operation)}`;
    if (scenario.model && !masksReady) {
      await h.skip(`worker_${scenario.operation}_result_import_and_restart`, [requirement], 'Mask models are not installed in this isolated workspace; set RAPIDRAW_TEST_WORKER_MODELS=1 to require installation and inference');
      continue;
    }
    await h.check(`worker_${scenario.operation}_result_import_and_restart`, ['tool:start_operation', 'tool:get_operation_job', requirement], async () => {
      const parentBefore = (await h.call('get_session', { session_id, include_adjustments: true })).data;
      const parentPixels = (await h.call('render', { session_id, format: 'png' })).images[0].data;
      const started = (await h.call('start_operation', { operation: scenario.operation, arguments: scenario.arguments })).data;
      if (scenario.model) assert.deepEqual(started.captured_models, { kind: 'masks', count: modelStatus.groups.masks.assets.length }, 'Worker must capture verified parent-workspace models');
      const done = await wait(started.job_id); assert.equal(done.status, 'succeeded', JSON.stringify(done));
      assert.ok(done.result.session_id, 'Worker result must be imported as a main-workspace session');
      assert.notEqual(done.result.session_id, session_id, 'Worker result must not overwrite its parent');
      assert.ok(done.result.worker_session_id, 'Imported result must retain the worker session identity');
      assert.notEqual(done.result.session_id, done.result.worker_session_id, 'Worker and imported session identities are independent');
      const imported = (await h.call('get_session', { session_id: done.result.session_id, include_adjustments: true })).data;
      assert.ok(resolve(imported.working_path).startsWith(resolve(workspace, 'sessions') + sep), 'Result source must belong to the main workspace, not the disposable worker');
      const rendered = (await h.call('render', { session_id: imported.session_id, format: 'png' })).images[0].data;
      const difference = pixelDifference(decodePng(Buffer.from(rendered, 'base64')), decodePng(Buffer.from(parentPixels, 'base64')));
      assert.ok(difference.mean_absolute > 0.00001, `${scenario.operation}: imported result must change fixture pixels`);
      await writeFile(join(workspace, `worker-${scenario.operation}-result.png`), Buffer.from(rendered, 'base64'));
      const parentAfter = (await h.call('get_session', { session_id, include_adjustments: true })).data;
      assert.equal(parentAfter.revision, parentBefore.revision); assert.deepEqual(parentAfter.adjustments, parentBefore.adjustments);
      assert.equal((await h.call('render', { session_id, format: 'png' })).images[0].data, parentPixels);
      if (scenario.operation === 'mask_generate') assert.ok(done.result.mask_statistics.nonzero_fraction > 0);
      if (scenario.operation === 'generate_depth') assert.ok(imported.adjustments.lensBlurDepthMap);
      if (scenario.operation === 'retouch') assert.ok(done.result.patch_id);
      await h.reconnect();
      const persisted = (await h.call('get_operation_job', { job_id: started.job_id })).data; assert.equal(persisted.status, 'succeeded'); assert.deepEqual(persisted.result, done.result);
      assert.equal((await h.call('render', { session_id: imported.session_id, format: 'png' })).images[0].data, rendered, 'Imported result pixels and embedded assets must survive restart');
      assert.equal((await h.call('render', { session_id, format: 'png' })).images[0].data, parentPixels);
      return { job_id: started.job_id, imported_session_id: imported.session_id, worker_session_id: done.result.worker_session_id, changed_pixel_mean: difference.mean_absolute, parent_unchanged: true, restarted_result_identical: true, fixture_kind: 'synthetic mechanical processing; photographic quality not reviewed' };
    }, 'pixel_assertion');
  }
} catch (error) { failure = error; }
finally { await h.close(failure); }
if (failure) throw failure;
