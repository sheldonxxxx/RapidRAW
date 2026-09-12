/** Real native MCP streaming beyond the actual GPU texture limit; synthetic pixels only. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createNativeHarness } from './coverage-evidence.mjs';
import { decodePng, fixturePng, pixelDifference } from './png-fixtures.mjs';

// Independent RGB16 PNG fixture writer. The native engine never creates its own oracle.
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4); return out; }
function rgb16Png(width, height, pixel) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 16; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 6 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (const [c, value] of pixel(x, y).entries()) rows.writeUInt16BE(value, y * (width * 6 + 1) + 1 + x * 6 + c * 2);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function regionDifference(full, small, region) {
  assert.equal(small.width, region.width); assert.equal(small.height, region.height);
  let sum = 0, maximum = 0;
  for (let y = 0; y < small.height; y++) for (let x = 0; x < small.width; x++) for (let c = 0; c < 3; c++) {
    const difference = Math.abs(full.pixels[((region.y + y) * full.width + region.x + x) * 3 + c] - small.pixels[(y * small.width + x) * 3 + c]);
    maximum = Math.max(maximum, difference); sum += difference;
  }
  return { maximum, mean_absolute: sum / (small.width * small.height * 3) };
}
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/large-image-${Date.now()}`);
await mkdir(join(workspace, 'fixtures'), { recursive: true });
const probe = join(workspace, 'fixtures', 'probe.png'); await writeFile(probe, fixturePng(64, 48));
const h = await createNativeHarness({ suite: 'large-image-streaming', workspace });
const failures = [];
async function test(name, requirements, fn, level = 'pixel_assertion') { try { const details = await h.check(name, requirements, fn, level); console.log(`PASS ${name}`); return details; } catch (error) { failures.push({ name, error: String(error) }); console.error(`FAIL ${name}: ${error}`); } }
let sid, width, height = 256, baseline, candidate;
async function render(options) { return h.call('render', { session_id: sid, format: 'png', cache: false, ...options }); }
const decode = (response, index = 0) => decodePng(Buffer.from(response.images[index].data, 'base64'));
try {
  await h.fixture(probe, 'tiny probe used only to discover actual native GPU limits');
  const probeId = (await h.call('open_photo', { path: probe, inherit_sidecar: false })).data.session_id;
  const gpu = (await h.call('preflight', { session_id: probeId })).data.gpu;
  assert.ok(gpu.max_texture_dimension_2d > 0);
  width = Math.max(25184, gpu.max_texture_dimension_2d + 17);
  assert.ok(width <= 100000 && width * height <= 100_000_000, 'Fixture must stay within current native pixel/schema bounds');
  const expectedPixel = (x, y) => x >= 1800 && x < 2800 && y >= 32 && y < 96 ? [65000, 63000, 61000] : [10000 + Math.round(x / (width - 1) * 40000), 16000 + y * 101, 18000 + (Math.floor(x / 128) % 2) * 16000 + (y % 7) * 35];
  const source = join(workspace, 'fixtures', `wide-${width}x${height}-rgb16.png`);
  await writeFile(source, rgb16Png(width, height, expectedPixel));
  await h.fixture(source, 'independent RGB16 gradient and high-frequency spatial texture beyond GPU texture limit', { dimensions: [width, height], bit_depth: 16, gpu_texture_limit: gpu.max_texture_dimension_2d });
  sid = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
  await test('actual_gpu_limit_requires_streaming_not_resizing', ['tool:preflight', 'tool:open_photo', 'parameter:preflight.operation="export"'], async () => {
    const result = (await h.call('preflight', { session_id: sid, operation: 'export', format: 'png', bit_depth: 16 })).data;
    assert.equal(result.ready, true); assert.equal(result.gpu.requires_streaming, true); assert.ok(result.gpu.streaming_plan.halo_pixels >= 128); assert.ok(result.gpu.streaming_plan.core_pixels >= 2048);
    assert.deepEqual(result.source_dimensions, [width, height]); assert.deepEqual(result.rendered_dimensions, [width, height]); assert.ok(width > result.gpu.max_texture_dimension_2d);
    return { dimensions: [width, height], gpu: result.gpu, blockers: result.blockers };
  }, 'native_assertion');
  await test('full_original_size_png16_retains_actual_source_precision', ['tool:export', 'parameter:export.bit_depth=16', 'parameter:export.format="png"'], async () => {
    const result = (await h.call('export', { session_id: sid, path: 'wide-baseline.png', format: 'png', bit_depth: 16, keep_metadata: false })).data;
    baseline = decodePng(await readFile(result.path)); assert.equal(baseline.width, width); assert.equal(baseline.height, height); assert.equal(baseline.bitDepth, 16);
    const levels = new Set(); let maximumSourceError = 0;
    for (let x = 0; x < width; x++) levels.add(Math.round(baseline.pixels[(height / 2 * width + x) * 3] * 65535));
    for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 11) for (const [c, expected] of expectedPixel(x, y).entries()) maximumSourceError = Math.max(maximumSourceError, Math.abs(baseline.pixels[(y * width + x) * 3 + c] * 65535 - expected));
    assert.ok(levels.size > 10000, `Only ${levels.size} distinct channel levels survived`); assert.ok(maximumSourceError <= 16, `Native fullsize source mismatch ${maximumSourceError}/65535`);
    return { output: result.path, dimensions: [baseline.width, baseline.height], red_levels: levels.size, maximum_source_error_16bit: maximumSourceError };
  });
  await test('native_regions_cross_every_4096px_window_without_seams', ['tool:render', 'parameter:render.region', 'parameter:render.cache=false'], async () => {
    assert.ok(baseline); const comparisons = [];
    for (let boundary = 4096; boundary < width - 96; boundary += 4096) {
      const region = { x: boundary - 65, y: 65, width: 131, height: 127 };
      const result = await render({ region }); assert.equal(result.data.rendered_width, width); assert.equal(result.data.source_width, width); assert.equal(result.data.width, region.width); assert.equal(result.data.coordinates.preview_to_rendered_scale.x, 1);
      const difference = regionDifference(baseline, decode(result), region); assert.ok(difference.maximum <= 1 / 255 + 2 / 65535);
      comparisons.push({ boundary, ...difference });
    }
    assert.ok(comparisons.length >= 4); return comparisons;
  });
  await test('wide_global_masks_keep_native_coordinates_across_windows', ['tool:mask_create', 'tool:render', 'tool:export', 'parameter:mask_create.type="linear"', 'parameter:mask_create.type="radial"'], async () => {
    await h.call('mask_create', { session_id: sid, type: 'linear', parameters: { startX: 8192, startY: 0, endX: 8192, endY: height, range: 1024 }, adjustments: { exposure: 0.65 } });
    const radial = (await h.call('mask_create', { session_id: sid, type: 'radial', parameters: { centerX: 12288, centerY: 128, radiusX: 950, radiusY: 95, rotation: 0, feather: 0.35 }, adjustments: { saturation: -70, temperature: 20 } })).data;
    const result = (await h.call('export', { session_id: sid, path: 'wide-masks.png', format: 'png', bit_depth: 16, keep_metadata: false })).data;
    candidate = decodePng(await readFile(result.path)); assert.equal(candidate.width, width); assert.ok(pixelDifference(baseline, candidate).mean_absolute > 0.01);
    const comparisons = [];
    for (const boundary of [4096, 8192, 12288, 16384, 20480]) {
      if (boundary + 64 >= width) continue;
      const region = { x: boundary - 64, y: 64, width: 129, height: 129 };
      const result = await render({ region }); const difference = regionDifference(candidate, decode(result), region); assert.ok(difference.maximum <= 1 / 255 + 2 / 65535); comparisons.push({ boundary, ...difference });
    }
    const detail = { x: 12288 - 128, y: 16, width: 256, height: 224 };
    const overlay = await render({ region: detail, mask_id: radial.mask_id, mask_mode: 'overlay', overlay_opacity: 0.5 }); assert.equal(overlay.images.length, 3); assert.ok(overlay.data.mask_coverage.bounds_rendered.x > 10000);
    const matchedPhotograph = decode(overlay, 1);
    for (const index of [0, 1, 2]) assert.equal(decode(overlay, index).bitDepth, 8, 'All review blocks use the 8-bit preview contract');
    const ordinaryDetail = decode(await render({ region: detail }));
    const matchedPreviewDifference = pixelDifference(matchedPhotograph, ordinaryDetail);
    assert.equal(matchedPreviewDifference.maximum, 0, 'Matched photograph must equal an ordinary same-ROI preview exactly');
    const exportDetailDifference = regionDifference(candidate, matchedPhotograph, detail);
    assert.ok(exportDetailDifference.maximum <= 1 / 255 + 2 / 65535, `Matched photograph differs beyond 8-bit preview quantization: ${JSON.stringify(exportDetailDifference)}`);
    for (const [i, label] of ['overlay', 'photograph', 'selection'].entries()) await writeFile(join(workspace, `wide-mask-detail-${label}.png`), Buffer.from(overlay.images[i].data, 'base64'));
    return { output: result.path, seam_comparisons: comparisons, matched_detail_bounds: overlay.data.mask_coverage.bounds_rendered, matched_preview_difference: matchedPreviewDifference, export_detail_difference: exportDetailDifference };
  });
  await test('resize_occurs_after_native_streaming_and_matches_preview', ['tool:export', 'parameter:export.resize', 'parameter:render.long_edge'], async () => {
    const result = (await h.call('export', { session_id: sid, path: 'wide-resized.png', format: 'png', bit_depth: 16, resize: { mode: 'width', value: 1024 }, keep_metadata: false })).data;
    const resized = decodePng(await readFile(result.path)); assert.equal(resized.width, 1024); assert.equal(resized.height, Math.round(height * 1024 / width));
    const preview = await render({ long_edge: 1024 }); assert.equal(preview.data.rendered_width, width); assert.equal(preview.data.rendered_height, height); assert.equal(preview.data.source_width, width);
    const difference = pixelDifference(resized, decode(preview)); assert.ok(difference.maximum <= 1 / 255 + 2 / 65535);
    return { native_dimensions: [width, height], delivery_dimensions: [resized.width, resized.height], preview_export_difference: difference };
  });
  await test('wide_mask_only_flare_produces_pixels_in_native_stream', ['tool:mask_create', 'tool:render', 'adjustment:masks[].adjustments.flareAmount'], async () => {
    await h.call('set_adjustments', { session_id: sid, patch: { masks: [], flareAmount: 0 } });
    const without = await render({ long_edge: 1600 });
    await h.call('mask_create', { session_id: sid, type: 'all', parameters: {}, adjustments: { flareAmount: 100 } });
    const withFlare = await render({ long_edge: 1600 });
    const difference = pixelDifference(decode(without), decode(withFlare)); assert.ok(difference.mean_absolute > 0.00001, `Mask-only native streaming flare had no pixel effect: ${JSON.stringify(difference)}`);
    return difference;
  });
} catch (error) { failures.push({ name: 'suite', error: String(error) }); }
finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
