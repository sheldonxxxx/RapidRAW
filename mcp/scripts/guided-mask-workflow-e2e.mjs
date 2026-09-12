/** Reproduce AI selection, brush repairs, and a manual mask on inspected regression photos. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashBytes, hashFile } from './coverage-evidence.mjs';
import { decodePng, mean, pixelDifference } from './png-fixtures.mjs';
import { readEditableMaskSession } from './fresh-mask-contract.mjs';
import { isDisconnected, recoverCompletedResponse } from './photo-review-policy.mjs';
import { validateGuidedMaskManifest, validateGuidedNativeBounds, correctionCoverageDelta } from './guided-mask-workflow-contract.mjs';

assert.ok(process.env.RAPIDRAW_PHOTO_MANIFEST, 'Set RAPIDRAW_PHOTO_MANIFEST to an annotated guided-mask regression manifest');
const manifestText = await readFile(resolve(process.env.RAPIDRAW_PHOTO_MANIFEST), 'utf8');
const manifest = await validateGuidedMaskManifest(JSON.parse(manifestText));
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/guided-mask-workflow-${Date.now()}`);
const h = await createNativeHarness({ suite: 'guided-mask-workflow', workspace, timeout: 1800000 });
const failures = [], cases = []; let disconnected;
const exclusive = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' });
const state = (id) => readEditableMaskSession(h, id);
const digest = (value) => hashBytes(JSON.stringify(value));
const maskFrom = (session, id) => { const mask = session.adjustments.masks.find((m) => m.id === id); assert.ok(mask, 'Expected mask must remain present'); return mask; };
const decoded = async (view, role) => decodePng(await readFile(view.images.find((a) => a.role === role).path));
async function mutate(method, args, required = ['session_id']) {
  const response = await h.call(method, args, { allowError: /RESPONSE_TOO_LARGE/ });
  return response.data?.error?.code === 'RESPONSE_TOO_LARGE' ? recoverCompletedResponse(response.data, required) : response.data;
}
async function assessed(name, requirements, fn, level = 'native_assertion') {
  try { return await h.check(name, requirements, fn, level); }
  catch (error) { failures.push({ name, error: String(error) }); }
}
async function renderView(directory, label, session_id, mask_id, geometry, options = {}) {
  await mkdir(directory, { recursive: true });
  const args = { session_id, format: 'png', ...geometry, ...options, ...(mask_id ? { mask_id, mask_mode: 'overlay' } : {}) };
  const response = await h.call('render', args, { allowError: /RESPONSE_TOO_LARGE/ });
  if (response.data?.error?.code === 'RESPONSE_TOO_LARGE') return null;
  assert.equal(response.images.length, mask_id ? 3 : 1);
  const images = []; let dimensions;
  for (const [index, block] of response.images.entries()) {
    const role = mask_id ? ['overlay', 'photo', 'mask'][index] : 'photo';
    const bytes = Buffer.from(block.data, 'base64'), image = decodePng(bytes);
    assert.equal(image.bitDepth, 8);
    if (geometry.region) assert.deepEqual([image.width, image.height], [geometry.region.width, geometry.region.height], 'A native review region must never be resized');
    if (dimensions) assert.deepEqual([image.width, image.height], dimensions); else dimensions = [image.width, image.height];
    const path = join(directory, `${label}-${role}.png`); await writeFile(path, bytes, { flag: 'wx' });
    images.push({ path, role, sha256: hashBytes(bytes), width: image.width, height: image.height });
  }
  const metadata = join(directory, `${label}-render.json`); await exclusive(metadata, response.data);
  return { id: label, request: args, images, metadata: { path: metadata, sha256: await hashFile(metadata) } };
}
async function nativeView(directory, label, sid, mid, region) {
  const view = await renderView(directory, label, sid, mid, { region });
  assert.ok(view, 'Explicit native regions at most 512px must fit the response budget; preserve failure instead of resizing');
  return view;
}
async function snapshot(directory, phase, sid, mid, group, probes, overview = true) {
  const path = join(directory, phase); await mkdir(path, { recursive: true }); const views = [];
  if (overview) {
    let view;
    for (const edge of [1024, 768, 512, 256]) { view = await renderView(path, 'overview', sid, mid, { long_edge: edge }); if (view) break; }
    assert.ok(view, 'Bounded overview exceeds the response budget'); views.push(view);
    for (const item of group.review_regions) views.push(await nativeView(path, `review-${item.id}`, sid, mid, item.region));
  }
  for (const key of ['selected', 'protected']) views.push(await nativeView(path, `effect-${key}`, sid, mid, probes[key].region));
  const current = await state(sid), statePath = join(path, 'editable-state.json'); await exclusive(statePath, current);
  const record = { phase, session_id: sid, mask_id: mid, revision: current.revision, local_adjustments: maskFrom(current, mid).adjustments, views, editable_state: { path: statePath, sha256: await hashFile(statePath), adjustments_sha256: digest(current.adjustments) }, photographic_quality: 'not_reviewed' };
  await exclusive(join(path, 'stage.json'), record); return record;
}
async function samePixels(a, b, roles = ['photo', 'mask', 'overlay']) {
  for (const role of roles) {
    const left = a.images.find((image) => image.role === role), right = b.images.find((image) => image.role === role);
    assert.ok(left && right); assert.equal(left.sha256, right.sha256, `Saved ${role} PNG bytes changed`);
    assert.equal(pixelDifference(await decoded(a, role), await decoded(b, role)).maximum, 0);
  }
}
async function gradeHistoryPersistence(directory, label, sid, mid, group, probes, stages) {
  const prior = await state(sid);
  await mutate('mask_update', { session_id: sid, mask_id: mid, expected_revision: prior.revision, patch: { adjustments: { exposure: 0, shadows: 0 } } });
  const neutral = await snapshot(directory, `${label}-ungraded`, sid, mid, group, probes, false); stages.push(neutral);
  const neutralState = await state(sid);
  const graded = await mutate('mask_update', { session_id: sid, mask_id: mid, expected_revision: neutralState.revision, patch: { adjustments: group.local_adjustments } });
  assert.ok(graded.revision > neutralState.revision);
  const final = await snapshot(directory, `${label}-graded`, sid, mid, group, probes); stages.push(final);
  const finalState = await state(sid);
  await assessed(`${group.id}_${label}_local_grade_changes_only_intended_probe`, ['tool:mask_update', 'tool:render'], async () => {
    const restoredGrade = structuredClone(finalState.adjustments);
    restoredGrade.masks.find((mask) => mask.id === mid).adjustments = maskFrom(neutralState, mid).adjustments;
    assert.deepEqual(restoredGrade, neutralState.adjustments, 'Applying the local grade must preserve every other adjustment and mask field');
    const differences = {};
    for (const key of ['selected', 'protected']) {
      const before = neutral.views.find((v) => v.id === `effect-${key}`), after = final.views.find((v) => v.id === `effect-${key}`);
      const difference = pixelDifference(await decoded(before, 'photo'), await decoded(after, 'photo'));
      const opacity = mean(await decoded(after, 'mask')); differences[key] = { ...difference, mean_opacity: opacity };
      assert.equal(pixelDifference(await decoded(before, 'mask'), await decoded(after, 'mask')).maximum, 0, 'Changing the local grade must preserve selection');
      if (key === 'selected') assert.ok(difference.mean_absolute >= probes[key].minimum_mean_absolute_difference, 'The local grade must visibly affect the selected native probe');
      else assert.ok(difference.mean_absolute <= probes[key].maximum_mean_absolute_difference, 'The protected native probe must stay within its declared effect bound');
    }
    return { differences, photographic_quality: 'not_reviewed' };
  }, 'pixel_assertion');
  await h.check(`${group.id}_${label}_revision_history_and_exact_redo`, ['tool:mask_update', 'tool:undo', 'tool:redo', 'tool:history'], async () => {
    const rejected = await h.call('mask_update', { session_id: sid, mask_id: mid, expected_revision: neutralState.revision, patch: { opacity: 1 } }, { expectError: true });
    assert.match(JSON.stringify(rejected.data), /REVISION_CONFLICT/);
    let current = await state(sid); assert.equal(current.revision, finalState.revision); assert.deepEqual(current.adjustments, finalState.adjustments);
    const historyBefore = (await h.call('history', { session_id: sid })).data;
    await mutate('undo', { session_id: sid, expected_revision: current.revision }); current = await state(sid);
    assert.ok(current.revision > finalState.revision); assert.deepEqual(current.adjustments, neutralState.adjustments);
    const undone = await snapshot(directory, `${label}-undo`, sid, mid, group, probes, false);
    for (const view of neutral.views) await samePixels(view, undone.views.find((v) => v.id === view.id));
    await mutate('redo', { session_id: sid, expected_revision: current.revision }); current = await state(sid);
    assert.deepEqual(current.adjustments, finalState.adjustments);
    const redone = await snapshot(directory, `${label}-redo`, sid, mid, group, probes, false);
    for (const view of redone.views) await samePixels(final.views.find((v) => v.id === view.id), view);
    return { stale_edit_rejected: true, exact_adjustments_and_pixels: true, history_before: historyBefore, history_after: (await h.call('history', { session_id: sid })).data };
  }, 'pixel_assertion');
  await mutate('save_session', { session_id: sid }); const saved = await state(sid);
  await h.reconnect();
  await h.check(`${group.id}_${label}_saved_restart_state_and_pixels`, ['tool:save_session', 'tool:get_session', 'tool:render'], async () => {
    const restored = await state(sid); assert.equal(restored.revision, saved.revision); assert.deepEqual(restored.adjustments, saved.adjustments);
    const reopened = await snapshot(directory, `${label}-reopened`, sid, mid, group, probes); stages.push(reopened);
    for (const view of final.views) await samePixels(view, reopened.views.find((v) => v.id === view.id));
    return { session_id: sid, exact_state_and_png_parity: true, compared_views: final.views.length };
  }, 'pixel_assertion');
  return final;
}
async function runCase(group) {
  const directory = join(workspace, 'regressions', group.id); await mkdir(directory, { recursive: true });
  await exclusive(join(directory, 'fixture-manifest.json'), group); const stages = [], corrections = [];
  const opened = (await h.call('open_photo', { path: group.sources[0].path, inherit_sidecar: false })).data;
  assert.equal(opened.source_sha256, group.sources[0].sha256); validateGuidedNativeBounds(group, opened.dimensions);
  assert.equal((await state(opened.session_id)).adjustments.masks.length, 0);
  const original = await renderView(directory, 'original', opened.session_id, null, { long_edge: 1024 }); assert.ok(original);
  const generated = await mutate('mask_generate', { session_id: opened.session_id, expected_revision: opened.revision, kind: group.ai.kind, ...(group.ai.region ? { region: group.ai.region } : {}), ...(group.ai.parameters ? { parameters: group.ai.parameters } : {}), adjustments: group.local_adjustments }, ['session_id', 'mask_id']);
  const baseline = await snapshot(directory, 'ai-baseline', generated.session_id, generated.mask_id, group, group.effect_probes); stages.push(baseline);
  const baselineState = await state(generated.session_id);
  const version = await mutate('save_version', { session_id: generated.session_id, expected_revision: baselineState.revision, label: 'AI starting selection with local grade' }, ['session_id', 'version_id']);
  await mutate('save_session', { session_id: generated.session_id });
  const fork = await mutate('fork_session', { session_id: generated.session_id, expected_revision: baselineState.revision, version_id: version.version_id, label: 'Manual corrections to AI starting selection' });
  assert.notEqual(fork.session_id, generated.session_id); const sid = fork.session_id, mid = generated.mask_id;
  if (group.ai.refinement) {
    const current = await state(sid);
    const refined = await mutate('mask_generate', { session_id: sid, expected_revision: current.revision, kind: 'subject', refine: { mask_id: mid }, ...group.ai.refinement }, ['session_id', 'mask_id']);
    await h.check(`${group.id}_optional_points_preserve_mask_and_grade`, ['tool:mask_generate'], async () => {
      const after = await state(sid); assert.equal(refined.mask_id, mid); assert.ok(after.revision > current.revision);
      assert.deepEqual(maskFrom(after, mid).adjustments, maskFrom(current, mid).adjustments);
      assert.deepEqual(maskFrom(after, mid).subMasks.map((m) => m.id), maskFrom(current, mid).subMasks.map((m) => m.id));
      return { mask_id: mid, refinement: refined.refinement, photographic_quality: 'not_reviewed' };
    });
    stages.push(await snapshot(directory, 'point-refined', sid, mid, group, group.effect_probes));
  }
  for (const item of group.corrections) {
    const path = join(directory, 'brush-corrections', item.id), beforeState = await state(sid), beforeMask = maskFrom(beforeState, mid);
    const before = await nativeView(path, 'before', sid, mid, item.probe.region);
    const result = await mutate('mask_update', { session_id: sid, expected_revision: beforeState.revision, mask_id: mid, submask_operations: [{ operation: 'add', submask: { type: 'brush', name: item.id, mode: item.mode, parameters: item.parameters } }] });
    const after = await nativeView(path, 'after', sid, mid, item.probe.region), afterState = await state(sid), afterMask = maskFrom(afterState, mid);
    await h.check(`${group.id}_${item.id}_preserves_existing_selection_and_grade`, ['tool:mask_update'], async () => {
      assert.ok(afterState.revision > beforeState.revision); assert.equal(afterMask.id, beforeMask.id); assert.deepEqual(afterMask.adjustments, beforeMask.adjustments);
      assert.deepEqual(afterMask.subMasks.slice(0, beforeMask.subMasks.length), beforeMask.subMasks);
      assert.equal(afterMask.subMasks.length, beforeMask.subMasks.length + 1); assert.deepEqual(result.submask_ids, [afterMask.subMasks.at(-1).id]);
      return { stable_mask_id: mid, new_submask_id: result.submask_ids[0], mode: item.mode };
    });
    const beforeOpacity = mean(await decoded(before, 'mask')), afterOpacity = mean(await decoded(after, 'mask'));
    const change = correctionCoverageDelta(item.mode, beforeOpacity, afterOpacity);
    const correction = { ...item, before, after, before_opacity: beforeOpacity, after_opacity: afterOpacity, signed_opacity_delta: change, new_submask_id: result.submask_ids[0], photographic_quality: 'not_reviewed' }; corrections.push(correction);
    await exclusive(join(path, 'correction.json'), correction);
    await assessed(`${group.id}_${item.id}_native_coverage_change`, ['tool:mask_update', 'tool:render'], async () => { assert.ok(change >= item.probe.minimum_opacity_delta, `Correction changed its annotated probe by ${change}`); return correction; }, 'pixel_assertion');
  }
  await gradeHistoryPersistence(directory, 'brush-corrected', sid, mid, group, group.effect_probes, stages);
  await h.check(`${group.id}_original_ai_baseline_stays_unchanged`, ['tool:save_version', 'tool:fork_session', 'tool:get_session'], async () => {
    const current = await state(generated.session_id); assert.equal(current.revision, baselineState.revision); assert.deepEqual(current.adjustments, baselineState.adjustments);
    const repeated = await renderView(join(directory, 'baseline-preservation'), 'overview', generated.session_id, generated.mask_id, { long_edge: baseline.views[0].request.long_edge }); assert.ok(repeated);
    await samePixels(baseline.views[0], repeated);
    assert.equal(await hashFile(baseline.editable_state.path), baseline.editable_state.sha256);
    return { baseline_session_id: generated.session_id, corrected_session_id: sid, baseline_version_id: version.version_id, baseline_state_and_pixels_unchanged: true };
  }, 'pixel_assertion');
  const manualSource = (await h.call('open_photo', { path: group.sources[0].path, inherit_sidecar: false })).data;
  assert.equal(manualSource.source_sha256, group.sources[0].sha256); assert.equal((await state(manualSource.session_id)).adjustments.masks.length, 0);
  const manual = await mutate('mask_create', { session_id: manualSource.session_id, expected_revision: manualSource.revision, name: group.manual.intent, type: 'brush', parameters: group.manual.parameters }, ['session_id', 'mask_id']);
  await h.check(`${group.id}_manual_mask_starts_from_brush_only`, ['tool:mask_create'], async () => {
    const current = await state(manual.session_id); assert.equal(current.adjustments.masks.length, 1);
    const mask = maskFrom(current, manual.mask_id); assert.equal(mask.subMasks.length, 1); assert.equal(mask.subMasks[0].type, 'brush'); assert.deepEqual(mask.subMasks[0].parameters, group.manual.parameters);
    return { manual_session_id: manual.session_id, manual_mask_id: manual.mask_id, ai_submasks: 0 };
  });
  await gradeHistoryPersistence(directory, 'manual', manual.session_id, manual.mask_id, group, group.manual.effect_probes, stages);
  const inventory = JSON.parse(await readFile(join(workspace, 'inventory.json'), 'utf8'));
  const record = { fixture: group.id, partition: 'regression', sources: group.sources, manifest_sha256: hashBytes(manifestText), provenance: inventory.provenance, original, baseline_version_id: version.version_id, stages, corrections, manual_intent: group.manual.intent, review_regions: group.review_regions, criteria: group.review_criteria, status: 'not_reviewed', photographic_quality: 'not_reviewed', limitations: ['Coverage deltas and local-grade probes measure only annotated regions, not full-mask quality.', 'Point refinement is optional and may need rollback; it is not a prerequisite for manual correction.', 'Baseline and corrected overviews use the same declared local grade. Manual selection is an independent targeted edit, not a claim of complete subject extraction.'] };
  const recordPath = join(directory, 'review-required.json'); await exclusive(recordPath, record);
  return { fixture: group.id, review_path: recordPath, photographic_quality: 'not_reviewed' };
}
try {
  await writeFile(join(workspace, 'input-manifest.json'), manifestText, { flag: 'wx' });
  for (const group of manifest.groups) assert.equal((await h.fixture(group.sources[0].path, 'Guided mask workflow regression', { capture_group: group.capture_group, partition: group.partition })).sha256, group.sources[0].sha256);
  await h.call('models');
  for (const group of manifest.groups) {
    if (disconnected) { await h.skip(group.id, ['tool:mask_generate', 'tool:mask_create'], disconnected); continue; }
    try { cases.push(await runCase(group)); }
    catch (error) { failures.push({ fixture: group.id, error: String(error) }); if (isDisconnected(error)) disconnected = String(error); }
  }
  await exclusive(join(workspace, 'workflow-review-index.json'), { cases, failures, photographic_quality: 'not_reviewed' });
} catch (error) { failures.push({ phase: 'setup_or_recording', error: String(error) }); }
finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
