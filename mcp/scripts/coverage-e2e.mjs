/** Native adjustment/geometry/mask regressions. Generated fixtures are intentionally small. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { decodePng, fixturePng, mean, pixelDifference } from './png-fixtures.mjs';

const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/coverage-${Date.now()}`);
const fixtures = join(workspace, 'fixtures'); await mkdir(join(fixtures, 'nested'), { recursive: true });
const source = join(fixtures, 'texture.png'); await writeFile(source, fixturePng());
await writeFile(join(fixtures, 'nested', 'range.png'), fixturePng(128, 96, (x) => x < 64 ? [45, 45, 45] : [205, 205, 205]));
await writeFile(join(fixtures, 'ignore.txt'), 'not an image');
const h = await createNativeHarness({ suite: 'coverage-matrix', workspace });
const failures = []; let sid, defaults;
async function render(options = {}) {
  const response = await h.call('render', { session_id: sid, format: 'png', ...options });
  assert.equal(response.images.length, 1); return decodePng(Buffer.from(response.images[0].data, 'base64'));
}
async function reset() { await h.call('set_adjustments', { session_id: sid, mode: 'replace', patch: defaults }); }
async function test(name, requirements, fn, level = 'pixel_assertion') {
  try { await h.check(name, requirements, fn, level); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}
try {
  await h.fixture(source, 'synthetic color, luminance, fine texture and geometry fixture');
  const sourceHash = await hashFile(source);
  await test('list_images_pagination_recursive_and_filter', ['tool:list_images', 'parameter:list_images.recursive=true', 'parameter:list_images.recursive=false', 'parameter:list_images.offset', 'parameter:list_images.limit'], async () => {
    const shallow = (await h.call('list_images', { path: fixtures, recursive: false, limit: 1, offset: 0 })).data;
    const recursive = (await h.call('list_images', { path: fixtures, recursive: true, limit: 1, offset: 0 })).data;
    const second = (await h.call('list_images', { path: fixtures, recursive: true, limit: 1, offset: 1 })).data;
    const empty = (await h.call('list_images', { path: fixtures, recursive: true, limit: 1, offset: 100 })).data;
    assert.equal(shallow.images.length, 1); assert.equal(recursive.images.length, 1); assert.equal(second.images.length, 1); assert.equal(empty.images.length, 0);
    assert.notEqual(recursive.images[0].path, second.images[0].path); assert.equal(recursive.total_count, 2);
    await h.call('list_images', { path: join(fixtures, 'missing') }, { expectError: true });
    return { total: recursive.total_count, source_sha256: sourceHash };
  }, 'native_assertion');
  await test('list_jobs_empty_workspace', ['tool:list_jobs'], async () => { const result = (await h.call('list_jobs')).data; assert.ok(Array.isArray(result.jobs)); assert.equal(result.jobs.length, 0); }, 'native_assertion');
  sid = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
  defaults = (await h.call('get_session', { session_id: sid, include_adjustments: true })).data.adjustments;
  const baseline = await render();
  // Companion controls are held fixed so the named parameter, not its prerequisite, gets pixel credit.
  const cases = [
    ...['exposure', 'brightness'].map((key) => ({ key, value: 0.8, direction: 'brighter' })),
    ...['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'temperature', 'tint', 'vibrance', 'clarity', 'dehaze', 'structure', 'centré'].map((key) => ({ key, value: 65 })),
    { key: 'hue', value: 70 }, { key: 'sharpness', value: 90 },
    { key: 'sharpnessThreshold', value: 75, before: { sharpness: 90, sharpnessThreshold: 0 } },
    ...['lumaNoiseReduction', 'colorNoiseReduction', 'glowAmount', 'halationAmount', 'flareAmount', 'grainAmount'].map((key) => ({ key, value: 85 })),
    ...['grainSize', 'grainRoughness'].map((key) => ({ key, value: 90, before: { grainAmount: 75 } })),
    ...['chromaticAberrationRedCyan', 'chromaticAberrationBlueYellow'].map((key) => ({ key, value: 80 })),
    { key: 'vignetteAmount', value: -80 },
    ...['vignetteMidpoint', 'vignetteFeather', 'vignetteRoundness'].map((key) => ({ key, value: 90, before: { vignetteAmount: -80 } })),
    ...['transformVertical', 'transformHorizontal', 'transformDistortion', 'transformAspect', 'transformXOffset', 'transformYOffset'].map((key) => ({ key, value: 20, dimensionsMayChange: true })),
    { key: 'transformScale', value: 125, dimensionsMayChange: true }, { key: 'transformRotate', value: 7, dimensionsMayChange: true },
    ...['shadowsTint', 'redHue', 'redSaturation', 'greenHue', 'greenSaturation', 'blueHue', 'blueSaturation'].map((key) => ({ key: `colorCalibration.${key}`, patch: { colorCalibration: { [key]: 70 } } })),
    ...['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'].flatMap((color) => ['hue', 'saturation', 'luminance'].map((key) => ({ key: `hsl.${color}.${key}`, patch: { hsl: { [color]: { [key]: 80 } } } }))),
    ...['shadows', 'midtones', 'highlights', 'global'].map((wheel) => ({ key: `colorGrading.${wheel}.saturation`, patch: { colorGrading: { [wheel]: { hue: 190, saturation: 75 } } } })),
  ];
  const filter = process.env.RAPIDRAW_TEST_ADJUSTMENTS?.split(',');
  for (const entry of cases.filter((item) => !filter || filter.includes(item.key))) {
    if (!Object.hasOwn(h.capabilities.adjustment_schema.properties, entry.key.split('.')[0])) { await h.skip(entry.key, [`adjustment:${entry.key}`], 'Field is not in this native schema'); continue; }
    await test(`adjustment_${entry.key}`, [`adjustment:${entry.key}`, 'tool:set_adjustments', 'tool:render'], async () => {
      await reset(); if (entry.before) await h.call('set_adjustments', { session_id: sid, patch: entry.before });
      const before = entry.before ? await render() : baseline;
      await h.call('set_adjustments', { session_id: sid, patch: entry.patch ?? { [entry.key]: entry.value } });
      const after = await render();
      let metrics;
      if (entry.dimensionsMayChange && (before.width !== after.width || before.height !== after.height)) metrics = { changed_dimensions: [after.width, after.height] };
      else { metrics = pixelDifference(before, after); assert.ok(metrics.mean_absolute > 0.00001, `${entry.key} had no measurable pixel effect`); }
      if (entry.direction === 'brighter') assert.ok(mean(after) > mean(before) + 0.005);
      await reset(); assert.equal(pixelDifference(baseline, await render()).maximum, 0, 'Reset must exactly restore baseline pixels');
      return metrics;
    });
  }
  for (const [field, transform] of [
    ['flipHorizontal', (x, y, image) => [image.width - 1 - x, y]],
    ['flipVertical', (x, y, image) => [x, image.height - 1 - y]],
  ]) await test(`geometry_${field}`, [`adjustment:${field}=true`], async () => {
    await reset(); await h.call('set_adjustments', { session_id: sid, patch: { [field]: true } }); const after = await render();
    let error = 0; for (let y = 4; y < baseline.height - 4; y++) for (let x = 4; x < baseline.width - 4; x++) { const [sx, sy] = transform(x, y, baseline); for (let c = 0; c < 3; c++) error += Math.abs(after.pixels[(y * after.width + x) * 3 + c] - baseline.pixels[(sy * baseline.width + sx) * 3 + c]); }
    const mae = error / ((baseline.width - 8) * (baseline.height - 8) * 3); assert.ok(mae < 0.01, `Mirrored pixels misplaced (${mae})`); return { mean_absolute_error: mae };
  });
  await test('geometry_crop_region_resize', ['adjustment:crop', 'parameter:render.region', 'parameter:render.long_edge'], async () => {
    await reset(); await h.call('set_adjustments', { session_id: sid, patch: { crop: { unit: 'px', x: 20, y: 30, width: 120, height: 100 } } });
    const cropped = await render(); assert.equal(cropped.width, 120); assert.equal(cropped.height, 100);
    const region = await render({ region: { x: 10, y: 20, width: 40, height: 30 } }); assert.equal(region.width, 40); assert.equal(region.height, 30);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(region.pixels[(y * 40 + x) * 3 + c] - cropped.pixels[((y + 20) * 120 + x + 10) * 3 + c]) < 0.01);
    const reduced = await render({ long_edge: 60 }); assert.equal(reduced.width, 60); assert.equal(reduced.height, 50);
  });
  for (const type of ['brush', 'flow']) await test(`mask_${type}_locality`, [`parameter:mask_create.type=${JSON.stringify(type)}`], async () => {
    await reset(); const mask = (await h.call('mask_create', { session_id: sid, type, parameters: { lines: [{ tool: 'brush', brushSize: 35, feather: 0.1, ...(type === 'flow' ? { flow: 60 } : {}), points: [{ x: 50, y: 70 }, { x: 50, y: 120 }] }] }, adjustments: { exposure: 1 } })).data;
    const map = await render({ mask_id: mask.mask_id }); assert.ok(mean(map, { x: 45, y: 80, width: 10, height: 20 }) > 0.1); assert.ok(mean(map, { x: 190, y: 100, width: 30, height: 30 }) < 0.01);
    const after = await render(); assert.ok(pixelDifference(baseline, after, { x: 40, y: 80, width: 20, height: 20 }).mean_absolute > 0.01); assert.ok(pixelDifference(baseline, after, { x: 190, y: 100, width: 30, height: 30 }).mean_absolute < 0.002);
  });
  await test('mask_composition_add_subtract_intersect_invert_opacity', ['tool:mask_update', 'parameter:mask_update.patch', 'adjustment:masks[].subMasks[]<radial>.mode="intersect"', 'adjustment:masks[].subMasks[]<radial>.mode="subtractive"'], async () => {
    await reset(); const mask = (await h.call('mask_create', { session_id: sid, type: 'all', parameters: {}, adjustments: { exposure: 0.5 } })).data;
    const radial = { id: 'intersection', type: 'radial', visible: true, opacity: 100, mode: 'intersect', parameters: { centerX: 80, centerY: 90, radiusX: 35, radiusY: 35, rotation: 0, feather: 0 } };
    const all = { id: 'base', type: 'all', visible: true, mode: 'additive', parameters: {} };
    await h.call('mask_update', { session_id: sid, mask_id: mask.mask_id, patch: { subMasks: [all, radial] } }); const intersection = await render({ mask_id: mask.mask_id });
    assert.ok(mean(intersection, { x: 75, y: 85, width: 10, height: 10 }) > 0.95); assert.ok(mean(intersection, { x: 180, y: 100, width: 20, height: 20 }) < 0.01);
    await h.call('mask_update', { session_id: sid, mask_id: mask.mask_id, patch: { subMasks: [all, { ...radial, mode: 'subtractive' }] } }); const subtract = await render({ mask_id: mask.mask_id });
    assert.ok(mean(subtract, { x: 75, y: 85, width: 10, height: 10 }) < 0.01); assert.ok(mean(subtract, { x: 180, y: 100, width: 20, height: 20 }) > 0.95);
    await h.call('mask_update', { session_id: sid, mask_id: mask.mask_id, patch: { invert: true, opacity: 50 } }); const inverted = await render({ mask_id: mask.mask_id });
    assert.ok(Math.abs(mean(inverted, { x: 75, y: 85, width: 10, height: 10 }) - 0.5) < 0.03); assert.ok(mean(inverted, { x: 180, y: 100, width: 20, height: 20 }) < 0.01);
  });
  await test('mask_luminance_and_color_target_selection', ['parameter:mask_create.type="luminance"', 'parameter:mask_create.type="color"'], async () => {
    const rangePath = join(fixtures, 'nested', 'range.png'); await h.fixture(rangePath, 'synthetic distinct luminance regions');
    const previous = sid; sid = (await h.call('open_photo', { path: rangePath, inherit_sidecar: false })).data.session_id;
    try { for (const type of ['luminance', 'color']) { const mask = (await h.call('mask_create', { session_id: sid, type, parameters: { targetX: 25, targetY: 40, tolerance: 10 }, adjustments: { exposure: 0.4 } })).data;
      const image = await render({ mask_id: mask.mask_id }); assert.ok(mean(image, { x: 10, y: 10, width: 30, height: 30 }) > 0.8); assert.ok(mean(image, { x: 90, y: 10, width: 30, height: 30 }) < 0.1);
    } } finally { sid = previous; }
  });
  await test('source_original_unchanged', ['tool:open_photo', 'tool:set_adjustments', 'tool:mask_create'], async () => assert.equal(await hashFile(source), sourceHash), 'native_assertion');
} catch (error) { failures.push({ name: 'suite', error: String(error) }); }
finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
