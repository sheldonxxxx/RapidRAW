/** Native MCP acceptance for coordinates, sampling, mask review and exact previews. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness } from './coverage-evidence.mjs';
import { decodePng, fixturePng, pixelDifference } from './png-fixtures.mjs';

const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/geometry-review-${Date.now()}`);
await mkdir(join(workspace, 'fixtures'), { recursive: true });
const source = join(workspace, 'fixtures', 'coordinates.png');
await writeFile(source, fixturePng(160, 120, (x, y) => [x + 35, y + 50, 90]));
const neutral = join(workspace, 'fixtures', 'neutral-cast.png');
await writeFile(neutral, fixturePng(96, 80, (x, y) => x < 4 && y < 4 ? [255, 255, 255] : [138, 121, 104]));
const clipping = join(workspace, 'fixtures', 'clipping.png');
await writeFile(clipping, fixturePng(64, 48, (x) => x < 16 ? [255, 255, 255] : x > 48 ? [0, 0, 0] : [100, 120, 140]));
const h = await createNativeHarness({ suite: 'geometry-review', workspace });
const failures = [];
let sid, defaults;
async function test(name, requirements, fn, level = 'native_assertion') {
  try { const result = await h.check(name, requirements, fn, level); console.log(`PASS ${name}`); return result; }
  catch (error) { failures.push({ name, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}
async function session() { return (await h.call('get_session', { session_id: sid, include_adjustments: true })).data; }
async function mutate(patch) { const current = await session(); return (await h.call('set_adjustments', { session_id: sid, expected_revision: current.revision, patch })).data; }
async function reset() { return h.call('set_adjustments', { session_id: sid, mode: 'replace', patch: defaults }); }
async function preview(options = {}) { return h.call('render', { session_id: sid, format: 'png', ...options }); }
function decoded(response, index = 0) { return decodePng(Buffer.from(response.images[index].data, 'base64')); }
function sample(image, x, y) { return image.pixels.slice((y * image.width + x) * 3, (y * image.width + x) * 3 + 3); }
try {
  for (const path of [source, neutral, clipping]) await h.fixture(path, 'synthetic native review regression; not a photographic quality benchmark');
  sid = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
  defaults = (await session()).adjustments;
  const baseline = decoded(await preview());
  await test('map_coordinate_native_rotation_flip_crop_matrix', ['tool:map_coordinates', 'parameter:map_coordinates.points', 'parameter:map_coordinates.from="rendered"', 'parameter:map_coordinates.to="oriented_source"'], async () => {
    let maximumError = 0;
    for (let orientationSteps = 0; orientationSteps < 4; orientationSteps++) for (const flipHorizontal of [false, true]) {
      await reset();
      await mutate({ orientationSteps, flipHorizontal, flipVertical: orientationSteps % 2 === 0, crop: { unit: 'px', x: 9, y: 11, width: 90, height: 80 } });
      const points = [{ x: 7, y: 8 }, { x: 45, y: 35 }, { x: 80, y: 70 }];
      const mapped = (await h.call('map_coordinates', { session_id: sid, from: 'rendered', to: 'oriented_source', points })).data;
      const image = decoded(await preview());
      for (const [i, p] of mapped.points.entries()) {
        assert.equal(p.mapped, true);
        const expected = sample(baseline, Math.round(p.x), Math.round(p.y));
        const actual = sample(image, points[i].x, points[i].y);
        maximumError = Math.max(maximumError, ...actual.map((v, c) => Math.abs(v - expected[c])));
      }
      const reverse = (await h.call('map_coordinates', { session_id: sid, from: 'oriented_source', to: 'rendered', points: mapped.points.map(({ x, y }) => ({ x, y })) })).data;
      reverse.points.forEach((p, i) => { assert.equal(p.mapped, true); assert.ok(Math.hypot(p.x - points[i].x, p.y - points[i].y) < 0.01); });
    }
    assert.ok(maximumError < 0.012, `Mapped pixel differs from native output: ${maximumError}`);
    return { maximum_pixel_error: maximumError };
  }, 'pixel_assertion');
  await test('map_preview_strokes_regions_and_outside_status', ['tool:map_coordinates', 'parameter:map_coordinates.strokes', 'parameter:map_coordinates.regions', 'parameter:map_coordinates.preview'], async () => {
    await reset(); await mutate({ crop: { unit: 'px', x: 10, y: 15, width: 100, height: 80 } });
    const result = (await h.call('map_coordinates', { session_id: sid, from: 'preview', to: 'rendered', preview: { width: 50, height: 40 }, points: [{ x: 0, y: 0 }, { x: -1, y: 10 }], strokes: [[{ x: 2, y: 3 }, { x: 5, y: 6 }]], regions: [{ x: 10, y: 10, width: 12, height: 10 }] })).data;
    assert.equal(result.points[0].x, 0.5); assert.equal(result.points[0].y, 0.5);
    assert.equal(result.points[1].mapped, false); assert.equal(result.strokes[0].length, 2);
    assert.equal(result.regions[0].complete, true); assert.equal(result.regions[0].boundary.length, 128);
    await h.call('map_coordinates', { session_id: sid, from: 'preview', to: 'rendered', points: [{ x: 0, y: 0 }] }, { expectError: true });
    return result;
  });
  await test('map_perspective_distortion_guides_native_roundtrip', ['tool:map_coordinates', 'adjustment:guidedPerspective', 'adjustment:transformDistortion', 'adjustment:lensDistortionParams'], async () => {
    const cases = [
      { transformVertical: 9, transformHorizontal: -5, transformRotate: 3, transformScale: 115 },
      { transformDistortion: 9, rotation: 4, flipHorizontal: true },
      { lensDistortionParams: { model: 0, k1: 0.015, k2: -0.002, k3: 0 }, lensDistortionAmount: 85 },
      { lensDistortionParams: { model: 1, k1: 0.005, k2: 0.02, k3: -0.003 } },
      { guidedPerspective: { enabled: true, autoCrop: false, lines: [{ id: 'left', type: 'vertical', p1: { x: 0.2, y: 0.15 }, p2: { x: 0.1, y: 0.9 } }, { id: 'right', type: 'vertical', p1: { x: 0.8, y: 0.15 }, p2: { x: 0.9, y: 0.9 } }] } },
    ];
    let maxRoundtrip = 0, maxPixelError = 0;
    for (const patch of cases) {
      await reset(); await mutate(patch);
      const points = [{ x: 45, y: 40 }, { x: 70, y: 55 }, { x: 95, y: 75 }];
      const mapped = (await h.call('map_coordinates', { session_id: sid, from: 'rendered', to: 'oriented_source', points })).data;
      assert.ok(mapped.points.every((p) => p.mapped));
      const reverse = (await h.call('map_coordinates', { session_id: sid, from: 'oriented_source', to: 'rendered', points: mapped.points.map(({ x, y }) => ({ x, y })) })).data;
      const image = decoded(await preview());
      reverse.points.forEach((p, i) => { assert.equal(p.mapped, true); maxRoundtrip = Math.max(maxRoundtrip, Math.hypot(p.x - points[i].x, p.y - points[i].y)); });
      mapped.points.forEach((p, i) => {
        const actual = sample(image, points[i].x, points[i].y), expected = sample(baseline, Math.round(p.x), Math.round(p.y));
        maxPixelError = Math.max(maxPixelError, ...actual.map((v, c) => Math.abs(v - expected[c])));
      });
    }
    assert.ok(maxRoundtrip < 0.02); assert.ok(maxPixelError < 0.025, `Native warp disagrees with coordinate mapping: ${maxPixelError}`);
    return { max_roundtrip_pixels: maxRoundtrip, max_pixel_error: maxPixelError };
  }, 'pixel_assertion');
  await test('preflight_gpu_output_and_model_blockers', ['tool:preflight', 'parameter:preflight.operation="export"', 'parameter:preflight.model_kind="denoise"'], async () => {
    await reset();
    const ready = (await h.call('preflight', { session_id: sid, operation: 'export', format: 'png', bit_depth: 16 })).data;
    assert.equal(ready.ready, true); assert.ok(ready.gpu.max_texture_dimension_2d >= 160); assert.deepEqual(ready.rendered_dimensions, [160, 120]);
    const invalid = (await h.call('preflight', { session_id: sid, operation: 'export', format: 'jpeg', bit_depth: 16 })).data;
    assert.equal(invalid.ready, false); assert.ok(invalid.blockers.some((b) => b.code === 'UNSUPPORTED_BIT_DEPTH'));
    const models = (await h.call('preflight', { session_id: sid, operation: 'denoise', model_kind: 'denoise' })).data;
    assert.equal(models.models.kind, 'denoise'); assert.equal(models.models.status.ready, false); assert.ok(models.blockers.some((b) => b.code === 'MODEL_NOT_READY'));
  });
  await test('exact_preview_cache_and_state_invalidation', ['parameter:render.cache=true', 'parameter:render.cache=false', 'tool:render'], async () => {
    await reset(); await mutate({ exposure: 0.12 });
    const cold = await preview(), warm = await preview(), uncached = await preview({ cache: false });
    assert.equal(cold.data.cache.hit, false); assert.equal(warm.data.cache.hit, true); assert.equal(uncached.data.cache.enabled, false);
    assert.equal(warm.images[0].data, cold.images[0].data); assert.equal(uncached.images[0].data, cold.images[0].data);
    await mutate({ exposure: 0.5 });
    const changed = await preview(); assert.equal(changed.data.cache.hit, false); assert.notEqual(changed.images[0].data, cold.images[0].data);
    const roi = await preview({ region: { x: 20, y: 20, width: 40, height: 40 } }); assert.equal(roi.data.cache.hit, false);
    return { identical_cached_and_uncached_bytes: true, adjustment_invalidated: true, region_invalidated: true };
  }, 'pixel_assertion');
  await test('submask_crud_order_revision_and_atomic_failure', ['tool:mask_update', 'parameter:mask_update.submask_operations'], async () => {
    await reset();
    const created = (await h.call('mask_create', { session_id: sid, type: 'all', parameters: {}, adjustments: { exposure: 0.5 } })).data;
    let current = await session(); const first = current.adjustments.masks[0].subMasks[0].id;
    const added = (await h.call('mask_update', { session_id: sid, mask_id: created.mask_id, expected_revision: current.revision, submask_operations: [{ operation: 'add', submask: { type: 'linear', parameters: { startX: 20, startY: 0, endX: 100, endY: 0 } } }] })).data;
    assert.equal(added.submask_ids.length, 1); const second = added.submask_ids[0];
    await h.call('mask_update', { session_id: sid, mask_id: created.mask_id, expected_revision: added.revision, submask_operations: [{ operation: 'edit', submask_id: second, patch: { opacity: 25 } }, { operation: 'reorder', order: [second, first] }, { operation: 'duplicate', submask_id: second }] });
    current = await session(); assert.equal(current.adjustments.masks[0].subMasks.length, 3); assert.equal(current.adjustments.masks[0].subMasks[0].id, second); assert.equal(current.adjustments.masks[0].subMasks[1].opacity, 25);
    const before = JSON.stringify(current.adjustments);
    await h.call('mask_update', { session_id: sid, mask_id: created.mask_id, expected_revision: current.revision, submask_operations: [{ operation: 'remove', submask_id: second }, { operation: 'edit', submask_id: 'missing', patch: { opacity: 90 } }] }, { expectError: true });
    assert.equal(JSON.stringify((await session()).adjustments), before);
    await h.call('mask_update', { session_id: sid, mask_id: created.mask_id, expected_revision: current.revision - 1, submask_operations: [{ operation: 'remove', submask_id: second }] }, { expectError: true });
    await h.call('mask_update', { session_id: sid, mask_id: created.mask_id, expected_revision: current.revision, submask_operations: [{ operation: 'remove', submask_id: second }] });
    assert.equal((await session()).adjustments.masks[0].subMasks.length, 2);
  });
  await test('mask_overlay_bounds_statistics_and_matched_native_detail', ['parameter:render.mask_mode="overlay"', 'parameter:render.overlay_opacity', 'parameter:render.region'], async () => {
    await reset();
    const mask = (await h.call('mask_create', { session_id: sid, type: 'radial', parameters: { centerX: 50, centerY: 50, radiusX: 25, radiusY: 20, rotation: 0, feather: 0.2 }, adjustments: { exposure: 0.25 } })).data;
    const result = await preview({ mask_id: mask.mask_id, mask_mode: 'overlay', overlay_opacity: 0.5, region: { x: 5, y: 10, width: 90, height: 80 } });
    assert.equal(result.images.length, 3); assert.equal(result.data.mask_mode, 'overlay');
    assert.ok(result.data.mask_coverage.bounds_rendered.width > 0); assert.ok(result.data.mask_coverage.selected_rgb_statistics.weight > 0);
    const overlay = decoded(result), photograph = decoded(result, 1), selection = decoded(result, 2);
    assert.equal(overlay.width, 90); assert.equal(selection.width, 90);
    let changed = 0, outsideError = 0;
    for (let i = 0; i < overlay.pixels.length; i += 3) {
      const alpha = selection.pixels[i];
      for (let c = 0; c < 3; c++) { const difference = Math.abs(overlay.pixels[i + c] - photograph.pixels[i + c]); if (alpha === 0) outsideError = Math.max(outsideError, difference); else changed += difference; }
    }
    assert.ok(changed > 10); assert.ok(outsideError < 0.008);
    return { overlay_changed_selected_pixels: changed, unselected_max_error: outsideError, bounds: result.data.mask_coverage.bounds_rendered };
  }, 'pixel_assertion');
  await test('sample_region_quantiles_and_native_white_balance_suggestion', ['tool:sample_region', 'parameter:sample_region.suggest_white_balance=true', 'parameter:sample_region.stage="edited"'], async () => {
    const neutralId = (await h.call('open_photo', { path: neutral, inherit_sidecar: false })).data.session_id;
    const before = (await h.call('get_session', { session_id: neutralId, include_adjustments: true })).data;
    const sampled = (await h.call('sample_region', { session_id: neutralId, region: { x: 5, y: 5, width: 60, height: 50 }, suggest_white_balance: true })).data;
    assert.equal(sampled.statistics.pixels, 3000); assert.ok(sampled.statistics.median_rgb[0] > sampled.statistics.median_rgb[2]);
    const suggestion = sampled.white_balance_suggestion; assert.equal(suggestion.applied, false); assert.equal(suggestion.available, true); assert.ok(suggestion.native_candidate_renders > 0); assert.ok(suggestion.candidate_neutral_error < suggestion.initial_neutral_error * 0.2);
    const after = (await h.call('get_session', { session_id: neutralId, include_adjustments: true })).data; assert.equal(after.revision, before.revision); assert.deepEqual(after.adjustments, before.adjustments);
    await h.call('set_adjustments', { session_id: neutralId, expected_revision: after.revision, patch: suggestion.patch });
    const candidate = (await h.call('sample_region', { session_id: neutralId, region: { x: 5, y: 5, width: 60, height: 50 } })).data;
    assert.ok(Math.max(...candidate.statistics.median_rgb) - Math.min(...candidate.statistics.median_rgb) < 0.01);
    const original = (await h.call('sample_region', { session_id: neutralId, stage: 'original', region: { x: 5, y: 5, width: 60, height: 50 } })).data; assert.equal(original.stage, 'original');
    return { neutral_before: suggestion.initial_neutral_error, neutral_candidate: suggestion.candidate_neutral_error, proposed_patch: suggestion.patch };
  }, 'pixel_assertion');
  await test('show_clipping_preview_never_contaminates_export_or_analysis', ['adjustment:showClipping=true', 'parameter:render.clipping_overlay=true', 'parameter:render.clipping_overlay=false'], async () => {
    const id = (await h.call('open_photo', { path: clipping, inherit_sidecar: false })).data.session_id;
    const before = await h.call('render', { session_id: id, format: 'png', clipping_overlay: false });
    await h.call('set_adjustments', { session_id: id, patch: { showClipping: true } });
    const overlay = await h.call('render', { session_id: id, format: 'png' }); assert.equal(overlay.data.clipping_overlay, true);
    assert.ok(pixelDifference(decoded(before), decoded(overlay)).mean_absolute > 0.01);
    const disabled = await h.call('render', { session_id: id, format: 'png', clipping_overlay: false }); assert.equal(disabled.images[0].data, before.images[0].data);
    const exported = (await h.call('export', { session_id: id, path: 'clipping-safe.png', format: 'png', bit_depth: 8, keep_metadata: false })).data;
    const output = decodePng(await readFile(exported.path)); assert.equal(pixelDifference(output, decoded(before)).maximum, 0);
    const analyze = (await h.call('analyze', { session_id: id, histogram: false })).data; assert.ok(analyze.statistics.mean_rgb[0] > 0);
    return { preview_overlay_visible: true, export_matches_clean_pixels: true };
  }, 'pixel_assertion');
} catch (error) { failures.push({ name: 'suite', error: String(error) }); }
finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
