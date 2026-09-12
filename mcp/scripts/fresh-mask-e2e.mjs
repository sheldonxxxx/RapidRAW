/** Fresh automatic masks first; optional point corrections are separate forked regressions. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashBytes, hashFile } from './coverage-evidence.mjs';
import { decodePng, mean } from './png-fixtures.mjs';
import { nativeReviewTiles, isDisconnected, recoverCompletedResponse } from './photo-review-policy.mjs';
import { validateFreshMaskManifest, validateNativeAnnotationBounds, annotationMetrics, unreviewedMaskRecord, readEditableMaskSession } from './fresh-mask-contract.mjs';

assert.ok(process.env.RAPIDRAW_PHOTO_MANIFEST, 'Set RAPIDRAW_PHOTO_MANIFEST to a manifest with pre-inference native include/exclude/edge annotations');
const manifestText = await readFile(resolve(process.env.RAPIDRAW_PHOTO_MANIFEST), 'utf8');
const manifest = await validateFreshMaskManifest(JSON.parse(manifestText));
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/fresh-masks-${Date.now()}`);
const h = await createNativeHarness({ suite: 'fresh-mask-native-edges', workspace, timeout: 1800000 });
const failures = [], completed = [], corrections = [], skipped = []; let unavailable;
const exclusive = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
const digest = (value) => hashBytes(JSON.stringify(value));
async function mutation(method, args, required = ['session_id']) {
  const response = await h.call(method, args, { allowError: /RESPONSE_TOO_LARGE/ });
  if (response.data?.error?.code === 'RESPONSE_TOO_LARGE') response.data = recoverCompletedResponse(response.data, required);
  return response.data;
}
async function snapshot(group, session_id, mask_id, directory, phase, baselineReference) {
  const artifacts = [], means = {};
  async function triplet(label, geometry) {
    const response = await h.call('render', { session_id, mask_id, mask_mode: 'overlay', format: 'png', ...geometry }, { allowError: /RESPONSE_TOO_LARGE/ });
    if (response.data?.error?.code === 'RESPONSE_TOO_LARGE') return null;
    assert.equal(response.images.length, 3, 'Review requires aligned overlay, photograph and grayscale selection');
    let dimensions, opacity;
    for (const [i, block] of response.images.entries()) {
      const bytes = Buffer.from(block.data, 'base64'), role = ['overlay', 'photo', 'mask'][i];
      const path = join(directory, `${label}-${role}.png`); await writeFile(path, bytes, { flag: 'wx' });
      const decoded = decodePng(bytes); assert.equal(decoded.bitDepth, 8);
      if (geometry.region) assert.deepEqual([decoded.width, decoded.height], [geometry.region.width, geometry.region.height], 'Native regions must never be resized');
      if (dimensions) assert.deepEqual([decoded.width, decoded.height], dimensions); else dimensions = [decoded.width, decoded.height];
      artifacts.push({ path, sha256: hashBytes(bytes), role, label, width: decoded.width, height: decoded.height, ...geometry });
      if (i === 2) opacity = mean(decoded);
    }
    const metadataPath = join(directory, `${label}-render.json`);
    await exclusive(metadataPath, response.data);
    artifacts.push({ path: metadataPath, sha256: await hashFile(metadataPath), role: 'render_metadata', label, ...geometry });
    return opacity;
  }
  let overview;
  for (const edge of [1024, 768, 512, 256]) { overview = await triplet('overview', { long_edge: edge }); if (overview !== null) break; }
  assert.notEqual(overview, null, 'Even explicitly bounded overview exceeds the transport budget');
  for (const annotation of group.annotations) {
    let weighted = 0, pixels = 0;
    for (const [index, region] of nativeReviewTiles(annotation.region).entries()) {
      const opacity = await triplet(`annotation-${annotation.id}-tile-${index + 1}`, { region });
      assert.notEqual(opacity, null, 'A native 512-pixel review tile exceeded the response budget');
      const area = region.width * region.height; weighted += opacity * area; pixels += area;
    }
    means[annotation.id] = Math.max(0, Math.min(1, weighted / pixels));
  }
  await mutation('save_session', { session_id });
  const state = await readEditableMaskSession(h, session_id);
  const statePath = join(directory, 'editable-state.json'); await exclusive(statePath, state);
  artifacts.push({ path: statePath, sha256: await hashFile(statePath), role: 'editable_state' });
  const metrics = annotationMetrics(group.annotations, means);
  const { provenance } = JSON.parse(await readFile(join(workspace, 'inventory.json'), 'utf8'));
  const record = unreviewedMaskRecord(group, metrics, { first_attempt: phase === 'baseline', partition: phase === 'baseline' ? 'fresh-holdout' : 'regression', phase, session_id, mask_id, revision: state.revision, sources: group.sources, manifest_sha256: hashBytes(manifestText), provenance, artifacts, baseline_reference: baselineReference ?? null, coordinate_space: 'full native mask canvas before crop; no user geometry or grade applied', source_processing: 'Full-resolution original used for native inference; only explicit overview requests resize output.' });
  const reviewPath = join(directory, 'review-required.json'); await exclusive(reviewPath, record);
  return { group, directory, session_id, mask_id, revision: state.revision, state_digest: digest(state.adjustments), review_path: reviewPath, review_sha256: await hashFile(reviewPath), record };
}
async function quantitativeCheck(result) {
  try {
    await h.check(`${result.record.phase}_annotated_coverage_${result.group.id}`, ['tool:mask_generate'], async () => {
      const failed = result.record.metrics.filter((metric) => metric.quantitative_status === 'failed');
      assert.equal(failed.length, 0, JSON.stringify(failed));
      return { metrics: result.record.metrics, photographic_quality: 'not_reviewed', review_path: result.review_path };
    }, 'pixel_assertion');
  } catch (error) { failures.push({ fixture: result.group.id, phase: result.record.phase, failure_kind: 'annotated_coverage', error: String(error) }); }
}
async function failCase(group, directory, phase, error) {
  const failure = { fixture: group.id, phase, failure_kind: 'execution', error: String(error), photographic_quality: 'not_reviewed' }; failures.push(failure);
  if (isDisconnected(error)) unavailable = String(error);
  await exclusive(join(directory, 'failure.json'), failure);
}
try {
  await writeFile(join(workspace, 'input-manifest.json'), manifestText, { flag: 'wx' });
  // Register every original/sidecar before any inference, including later cases.
  for (const group of manifest.groups) {
    const captured = await h.fixture(group.sources[0].path, group.id, { capture_group: group.capture_group, partition: group.partition, provenance: group.provenance });
    assert.equal(captured.sha256, group.sources[0].sha256, 'Original changed after annotation-manifest validation');
  }
  for (const group of manifest.groups) {
    const directory = join(workspace, 'first-attempts', group.id); await mkdir(directory, { recursive: true });
    await exclusive(join(directory, 'fixture-manifest.json'), group);
    if (unavailable) { skipped.push({ fixture: group.id, phase: 'baseline', reason: unavailable }); await h.skip(`baseline_${group.id}`, ['tool:mask_generate'], unavailable); continue; }
    try {
      const opened = (await h.call('open_photo', { path: group.sources[0].path, inherit_sidecar: false })).data;
      assert.equal(opened.source_sha256, group.sources[0].sha256, 'Opened original must match the pre-inference annotated source');
      validateNativeAnnotationBounds(group, opened.dimensions);
      const generated = await mutation('mask_generate', { session_id: opened.session_id, expected_revision: opened.revision, kind: group.mask_kind, ...(group.region ? { region: group.region } : {}), ...(group.parameters ? { parameters: group.parameters } : {}) }, ['session_id', 'mask_id']);
      const result = await snapshot(group, opened.session_id, generated.mask_id, directory, 'baseline');
      completed.push(result);
      await h.check(`baseline_artifacts_${group.id}`, ['tool:mask_generate', 'tool:render', 'tool:save_session'], async () => ({ session_id: result.session_id, mask_id: result.mask_id, review_path: result.review_path, photographic_quality: 'not_reviewed', native_regions: group.annotations.map((a) => a.region) }));
      await quantitativeCheck(result);
    } catch (error) { await failCase(group, directory, 'baseline', error); }
  }
  // Corrections reuse inspected photos, so they run only after all first attempts
  // and remain separate regression sessions; a failed probe never erases baseline evidence.
  for (const baseline of completed.filter((result) => result.group.refinement)) {
    const { group } = baseline;
    const directory = join(workspace, 'corrections', group.id, 'point-refinement'); await mkdir(directory, { recursive: true });
    await exclusive(join(directory, 'fixture-manifest.json'), { ...group, partition: 'regression', first_attempt: false });
    if (unavailable) { skipped.push({ fixture: group.id, phase: 'correction', reason: unavailable }); await h.skip(`correction_${group.id}`, ['tool:mask_generate'], unavailable); continue; }
    try {
      const fork = await mutation('fork_session', { session_id: baseline.session_id, expected_revision: baseline.revision, label: 'Independent point correction' });
      const refined = await mutation('mask_generate', { session_id: fork.session_id, expected_revision: fork.revision, kind: 'subject', refine: { mask_id: baseline.mask_id }, ...group.refinement }, ['session_id', 'mask_id']);
      const result = await snapshot(group, fork.session_id, refined.mask_id, directory, 'correction', { session_id: baseline.session_id, mask_id: baseline.mask_id, path: baseline.review_path, sha256: baseline.review_sha256 });
      corrections.push(result);
      await h.check(`correction_preserves_baseline_${group.id}`, ['tool:fork_session', 'tool:mask_generate'], async () => {
        const unchanged = await readEditableMaskSession(h, baseline.session_id);
        assert.equal(unchanged.revision, baseline.revision); assert.equal(digest(unchanged.adjustments), baseline.state_digest);
        assert.equal(await hashFile(baseline.review_path), baseline.review_sha256);
        assert.notEqual(result.session_id, baseline.session_id);
        return { baseline_session_unchanged: true, first_attempt_record_unchanged: true, corrected_session_id: result.session_id, partition: 'regression' };
      });
      await quantitativeCheck(result);
    } catch (error) { await failCase(group, directory, 'correction', error); }
  }
  const entry = (result) => ({ fixture: result.group.id, review_path: result.review_path, quantitative_status: result.record.quantitative_status });
  await exclusive(join(workspace, 'mask-review-index.json'), { status: 'not_reviewed', photographic_quality: 'not_reviewed', first_attempts: completed.map(entry), corrections: corrections.map(entry), failures, skipped, note: 'Review each preserved first attempt separately; corrections cannot replace baseline judgments.' });
} catch (error) {
  failures.push({ phase: 'setup_or_recording', failure_kind: 'execution', error: String(error), photographic_quality: 'not_reviewed' });
} finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
