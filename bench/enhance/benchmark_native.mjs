/** Measure the native enhancement path with private, caller-supplied fixtures.
 * No models are downloaded. A fresh output directory preserves previous runs.
 * Set RAPIDRAW_BINARY, RAPIDRAW_WORKSPACE and RAPIDRAW_ENHANCEMENT_MANIFEST.
 * Each case declares id, path, request, optional mask_path, profiles, runs and
 * expected_error and review_long_edge. Inference timings include native rendering and result creation;
 * source opening and final TIFF export are recorded separately.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NativeBridge } from '../../mcp/dist/bridge.js';

assert.ok(process.env.RAPIDRAW_BINARY, 'RAPIDRAW_BINARY is required');
assert.ok(process.env.RAPIDRAW_WORKSPACE, 'RAPIDRAW_WORKSPACE is required');
assert.ok(process.env.RAPIDRAW_ENHANCEMENT_MANIFEST, 'RAPIDRAW_ENHANCEMENT_MANIFEST is required');
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE);
await mkdir(workspace, { recursive: false });
const manifest = JSON.parse(await readFile(resolve(process.env.RAPIDRAW_ENHANCEMENT_MANIFEST), 'utf8'));
const bridge = new NativeBridge({ binary: resolve(process.env.RAPIDRAW_BINARY), workspace, timeoutMs: 1_800_000 });
const call = (method, args = {}) => bridge.request(method, args);
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const report = { schema_version: 1, scope: 'Native enhancement including render, model and derived state; export measured separately', started: new Date().toISOString(), cases: [] };
const record = async () => writeFile(join(workspace, 'benchmark-native.json'), JSON.stringify(report, null, 2));

try {
  await call('capabilities');
  for (const model of manifest.models) {
    await call('install_enhancement_model', { model_id: model.id, path: resolve(model.path), sha256: model.sha256 ?? await hash(resolve(model.path)) });
  }
  for (const fixture of manifest.cases) {
    assert.match(fixture.id, /^[a-zA-Z0-9_-]+$/);
    const reviewLongEdge = fixture.review_long_edge ?? 1600;
    assert.ok(Number.isInteger(reviewLongEdge) && reviewLongEdge >= 128 && reviewLongEdge <= 8192);
    const source = resolve(fixture.path), sourceHash = await hash(source);
    const profiles = fixture.profiles ?? [fixture.request.profile ?? 'balanced'];
    for (const profile of profiles) {
      assert.ok(['fast', 'balanced', 'quality'].includes(profile));
      for (let iteration = 0; iteration < (fixture.runs ?? 2); iteration += 1) {
        const id = `${fixture.id}-${profile}-${iteration}`;
        const entry = { id, profile, iteration, source_sha256: sourceHash, request: { ...fixture.request, profile, provider: process.env.RAPIDRAW_ENHANCEMENT_PROVIDER ?? 'cpu' } };
        const started = performance.now();
        const opened = await call('open_photo', { path: source, inherit_sidecar: false });
        let parent = await call('get_session', { session_id: opened.session_id, include_adjustments: true });
        entry.open_ms = performance.now() - started;
        let maskId;
        if (fixture.mask_path) {
          const bitmap = await readFile(resolve(fixture.mask_path));
          maskId = randomUUID();
          const created = await call('set_adjustments', {
            session_id: parent.session_id, expected_revision: parent.revision, mode: 'merge',
            patch: { masks: [{ id: maskId, name: 'Benchmark source selection', visible: true, invert: false, opacity: 100, adjustments: {},
              subMasks: [{ id: randomUUID(), type: 'ai-subject', visible: true, invert: false, opacity: 100, mode: 'additive', parameters: {
                startX: 0, startY: 0, endX: parent.dimensions.width, endY: parent.dimensions.height,
                maskDataBase64: `data:image/png;base64,${bitmap.toString('base64')}`, rotation: 0, orientationSteps: 0, flipHorizontal: false, flipVertical: false, grow: 0, feather: 0,
              } }] }] },
          });
          parent = await call('get_session', { session_id: created.session_id, include_adjustments: true });
        }
        const before = performance.now();
        let result;
        try {
          result = await call('enhance', { session_id: parent.session_id, expected_revision: parent.revision, request: entry.request, ...(maskId ? { mask_id: maskId } : {}) });
          entry.enhance_ms = performance.now() - before;
          assert.ok(!fixture.expected_error, `Expected ${fixture.expected_error} but the model was accepted`);
          entry.result = result;
          const exporting = performance.now();
          entry.export = await call('export', { session_id: result.session_id, path: `${id}.tiff`, format: 'tiff', bit_depth: 16, color_profile: 'srgb' });
          entry.export_ms = performance.now() - exporting;
          const rendered = await call('render', { session_id: result.session_id, format: 'png', long_edge: reviewLongEdge, ...(result.mask_id ? { mask_id: result.mask_id, mask_mode: 'grayscale' } : {}) });
          const png = join(workspace, `${id}.png`);
          await writeFile(png, Buffer.from(rendered.image.data, 'base64'));
          entry.preview = png;
          entry.status = 'completed';
        } catch (error) {
          entry.enhance_ms ??= performance.now() - before;
          entry.error = String(error);
          entry.error_code = error?.code ?? null;
          if (!fixture.expected_error || !(entry.error.includes(fixture.expected_error) || entry.error_code === fixture.expected_error)) {
            entry.status = 'error'; report.cases.push(entry); await record();
            throw new Error(`${id}: ${entry.error_code ?? ''} ${entry.error}`, { cause: error });
          }
          entry.status = 'expected_rejection';
          const current = await call('get_session', { session_id: parent.session_id, include_adjustments: true });
          assert.equal(current.revision, parent.revision);
          assert.deepEqual(current.adjustments, parent.adjustments);
        }
        assert.equal(await hash(source), sourceHash, 'Original source changed');
        if (result && result.session_id !== parent.session_id) await call('close_session', { session_id: result.session_id });
        await call('close_session', { session_id: parent.session_id });
        report.cases.push(entry);
        await record();
        process.stdout.write(`${id}: ${entry.status}, enhance ${Math.round(entry.enhance_ms)}ms, export ${Math.round(entry.export_ms ?? 0)}ms\n`);
      }
    }
  }
  report.status = 'completed';
} catch (error) {
  report.status = 'error'; report.error = String(error); process.exitCode = 1;
} finally {
  await bridge.close();
  report.finished = new Date().toISOString();
  await record();
}
