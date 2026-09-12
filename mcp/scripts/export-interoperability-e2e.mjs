/** Native delivery matrix; independent decoding/metadata assertions are separately evidenced. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { decodePng, fixturePng, gpsExifFixture } from './png-fixtures.mjs';
import { inspectTiff16 } from './tiff-inspect.mjs';
import { assertNoIccWarnings, inspectDisplaySrgbProfile, pngProfile } from './icc-inspect.mjs';
const exec = promisify(execFile);
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/exports-${Date.now()}`);
await mkdir(workspace, { recursive: true });
const source = join(workspace, 'source.png'); await writeFile(source, fixturePng(256, 192, undefined, [{ type: 'eXIf', data: gpsExifFixture() }]));
const sourceTime = new Date('2020-02-03T04:05:06.000Z'); await utimes(source, sourceTime, sourceTime);
const h = await createNativeHarness({ suite: 'export-interoperability', workspace }); const failures = [];
async function test(name, requirements, fn, level = 'native_assertion') { try { return await h.check(name, requirements, fn, level); } catch (error) { failures.push({ name, error: String(error) }); return undefined; } }
const magick = process.env.RAPIDRAW_MAGICK ?? 'magick';
let external;
try { external = (await exec(magick, ['-version'])).stdout.split('\n')[0]; } catch { /* Recorded per format, not silently called independent verification. */ }
async function imageioJxl(path, requirements, name, baselinePath) {
  if (process.platform !== 'darwin') { await h.skip(name, requirements, 'ImageMagick JXL delegate is unavailable and the macOS ImageIO fallback is unavailable on this platform'); return; }
  return test(name, requirements, async () => {
    const output = join(workspace, `${name}.png`);
    const result = await exec('xcrun', ['swift', '-module-cache-path', join(workspace, 'swift-module-cache'), fileURLToPath(new URL('./imageio-decode.swift', import.meta.url)), path, output], { maxBuffer: 4 * 1024 * 1024 });
    const decoder = JSON.parse(result.stdout); assert.equal(decoder.png_finalized, true); assert.ok(decoder.raster_bytes > 0); assert.equal(decoder.gps_present, false);
    assert.deepEqual([decoder.width, decoder.height], [160, 120]);
    const decoded = decodePng(await readFile(output)); assert.deepEqual([decoded.width, decoded.height], [160, 120]);
    assert.ok(new Set(decoded.pixels).size > 16, 'Independent decoder must materialize varied fixture pixels');
    if (baselinePath) {
      const baseline = decodePng(await readFile(baselinePath)); assert.equal(baseline.bitDepth, 8); assert.equal(decoder.bits_per_component, 8);
      assert.deepEqual(Buffer.from(Array.from(decoded.pixels, (value) => Math.round(value * 255))), Buffer.from(Array.from(baseline.pixels, (value) => Math.round(value * 255))), 'Independent ImageIO JXL quality100 decoding must match every baseline RGB8 sample');
    }
    return { ...decoder, independent_png: output, png_bit_depth: decoded.bitDepth, ...(baselinePath ? { quality: 100, exact_rgb_samples: decoded.pixels.length } : {}) };
  }, 'pixel_assertion');
}
try {
  await h.fixture(source, 'generated delivery fixture', { original_mtime: sourceTime.toISOString() });
  const sid = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
  await h.call('set_adjustments', { session_id: sid, patch: { exposure: 0.13, temperature: 7 } });
  if (external) await test('gps_positive_control_source_and_unstripped_export', ['parameter:export.strip_gps=false', 'parameter:export.keep_metadata=true'], async () => {
    const sourceTags = (await exec(magick, ['identify', '-format', '%[EXIF:GPSLatitude]\n%[EXIF:GPSLongitude]', source])).stdout;
    assert.equal(sourceTags.split('\n').length, 2); assert.ok(sourceTags.split('\n').every((tag) => tag.length), 'Source must contain actual GPS tags before testing removal');
    const retainedPath = join(workspace, 'exports', 'gps-retained.jpg'); await h.call('export', { session_id: sid, path: retainedPath, format: 'jpeg', keep_metadata: true, strip_gps: false });
    const retainedTags = (await exec(magick, ['identify', '-format', '%[EXIF:GPSLatitude]\n%[EXIF:GPSLongitude]', retainedPath])).stdout;
    assert.equal(retainedTags.split('\n').length, 2); assert.ok(retainedTags.split('\n').every((tag) => tag.length), 'Unstripped export must retain actual GPS metadata');
    return { source_has_gps: true, retained_export_has_gps: true };
  });
  if (external) await test('current_metadata_edits_export_without_stale_saved_sidecar', ['tool:set_metadata', 'tool:export', 'parameter:export.keep_metadata=true'], async () => {
    await h.call('set_metadata', { session_id: sid, exif: { Artist: 'Original saved artist' } });
    await h.call('save_session', { session_id: sid });
    await h.call('set_metadata', { session_id: sid, exif: { Artist: 'Current unsaved artist' } });
    const path = join(workspace, 'exports', 'current-metadata.jpg'); await h.call('export', { session_id: sid, path, format: 'jpeg', keep_metadata: true });
    const artist = (await exec(magick, ['identify', '-format', '%[EXIF:Artist]', path])).stdout;
    assert.equal(artist, 'Current unsaved artist', 'Export must use current session metadata, not an earlier saved sidecar');
    return { exported_artist: artist, separately_saved_after_edit: false };
  });
  const hasProfile = h.tools.find((t) => t.name === 'rapidraw_export').inputSchema.properties.color_profile !== undefined;
  for (const format of ['jpeg', 'png', 'tiff', 'webp', 'avif', 'jxl']) {
    const path = join(workspace, 'exports', `format-${format}.${format}`);
    const requirements = [`parameter:export.format=${JSON.stringify(format)}`];
    const result = await test(`native_export_${format}`, ['tool:export', ...requirements], async () => {
      const result = (await h.call('export', { session_id: sid, path, format, bit_depth: ['png', 'tiff'].includes(format) ? 16 : 8, resize: { mode: 'width', value: 160 }, keep_metadata: true, strip_gps: true, preserve_timestamps: true, ...(hasProfile ? { color_profile: 'auto' } : {}) })).data;
      assert.equal(result.width, 160); assert.equal(result.height, 120); assert.equal((await stat(path)).size, result.bytes);
      assert.ok(Math.abs((await stat(path)).mtimeMs - sourceTime.getTime()) < 2000, 'Requested source timestamp must survive export');
      return result;
    });
    if (!result) continue;
    if (format === 'png') await test('independent_png_16bit_samples_and_profile', [...requirements, 'parameter:export.bit_depth=16', 'parameter:export.color_profile="auto"'], async () => {
      const decoded = decodePng(await readFile(path)); assert.equal(decoded.bitDepth, 16); assert.equal(decoded.width, 160); assert.equal(decoded.height, 120);
      const offGrid = decoded.pixels.filter((v) => Math.abs(v * 255 - Math.round(v * 255)) > 0.0001).length; assert.ok(offGrid > 1000, '16-bit output must contain actual intermediate values');
      if (hasProfile) assert.ok(decoded.chunks.some((c) => c.type === 'iCCP'), 'An embedded ICC profile, not just sRGB declaration, is required');
      return { non_8bit_grid_samples: offGrid, chunk_types: decoded.chunks.map((c) => c.type), ...(hasProfile ? { icc: inspectDisplaySrgbProfile(pngProfile(decoded)) } : {}) };
    }, 'pixel_assertion');
    if (format === 'tiff') await test('independent_tiff_16bit_samples', [...requirements, 'parameter:export.bit_depth=16'], async () => inspectTiff16(await readFile(path)), 'pixel_assertion');
    if (!external) {
      if (format === 'jxl') await imageioJxl(path, requirements, 'independent_imageio_jxl');
      else await h.skip(`independent_decode_${format}`, requirements, `${magick} is unavailable; native verification is not an independent decoder`);
      continue;
    }
    let decoded;
    try { decoded = await exec(magick, ['identify', '-format', '%w\n%h\n%z\n%[profiles]\n%[EXIF:GPSLatitude]\n%[EXIF:GPSLongitude]\n%[EXIF:Software]\n', path], { maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) {
      const detail = `${error.stderr ?? ''}\n${String(error)}`;
      if (/no decode delegate|delegate[^\n]*not (?:available|installed)|no loader for this file format/i.test(detail)) {
        if (format === 'jxl') await imageioJxl(path, requirements, 'independent_imageio_jxl');
        else await h.skip(`independent_decode_${format}`, requirements, `${external}: independent decoder unavailable: ${detail.slice(0, 1000)}`);
      }
      else await test(`independent_decode_${format}`, requirements, async () => { throw error; });
      continue;
    }
    await test(`independent_decode_metadata_${format}`, [...requirements, 'parameter:export.strip_gps=true', 'parameter:export.keep_metadata=true', 'parameter:export.preserve_timestamps=true'], async () => {
      assertNoIccWarnings(decoded.stderr);
      const [width, height, depth, profiles, latitude, longitude, software] = decoded.stdout.split('\n'); assert.equal(Number(width), 160); assert.equal(Number(height), 120);
      assert.equal(latitude, ''); assert.equal(longitude, '');
      if (result.metadata_applied) assert.match(software, /RapidRAW/);
      if (hasProfile && ['jpeg', 'png', 'tiff', 'webp'].includes(format)) assert.match(profiles, /icc/i);
      return { decoder: external, depth, profiles, gps_absent: true, metadata_applied: result.metadata_applied, software };
    }, 'pixel_assertion');
    if (hasProfile && ['jpeg', 'tiff', 'webp'].includes(format)) await test(`independent_icc_colorimetry_${format}`, [...requirements, 'parameter:export.color_profile="auto"'], async () => {
      const extracted = await exec(magick, [path, 'icc:-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }); assertNoIccWarnings(extracted.stderr);
      await writeFile(join(workspace, `embedded-${format}.icc`), extracted.stdout);
      return { independent_extractor: external, ...inspectDisplaySrgbProfile(extracted.stdout) };
    });
    if (hasProfile && ['jpeg', 'png', 'tiff', 'webp'].includes(format)) await test(`explicit_profile_none_${format}`, ['parameter:export.color_profile="none"'], async () => {
      const nonePath = join(workspace, 'exports', `no-profile.${format}`); await h.call('export', { session_id: sid, path: nonePath, format, color_profile: 'none', keep_metadata: false });
      const profiles = (await exec(magick, ['identify', '-format', '%[profiles]', nonePath])).stdout; assert.ok(!/icc/i.test(profiles)); return { profiles };
    });
  }
  const lossless = await test('native_jxl_quality_100_lossless', ['parameter:export.format="jxl"', 'parameter:export.quality', 'parameter:export.bit_depth=8'], async () => {
    const baselinePath = join(workspace, 'exports', 'lossless-baseline.png'), jxlPath = join(workspace, 'exports', 'lossless-quality-100.jxl');
    const common = { session_id: sid, bit_depth: 8, keep_metadata: false, resize: { mode: 'width', value: 160 }, ...(hasProfile ? { color_profile: 'none' } : {}) };
    await h.call('export', { ...common, path: baselinePath, format: 'png' });
    const result = (await h.call('export', { ...common, path: jxlPath, format: 'jxl', quality: 100 })).data;
    assert.equal(result.width, 160); assert.equal(result.height, 120); assert.ok((await stat(jxlPath)).size > 0);
    return { quality: 100, baselinePath, jxlPath, width: result.width, height: result.height };
  });
  if (lossless) {
    if (!external) await imageioJxl(lossless.jxlPath, ['parameter:export.format="jxl"', 'parameter:export.quality'], 'independent_imageio_jxl_quality_100_exact_pixels', lossless.baselinePath);
    else {
      let decoded;
      try { decoded = await exec(magick, [lossless.jxlPath, '-depth', '8', 'rgb:-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }); }
      catch (error) {
        const detail = `${error.stderr ?? ''}\n${String(error)}`;
        if (/no decode delegate|delegate[^\n]*not (?:available|installed)|no loader for this file format/i.test(detail)) await imageioJxl(lossless.jxlPath, ['parameter:export.format="jxl"', 'parameter:export.quality', 'parameter:export.bit_depth=8'], 'independent_imageio_jxl_quality_100_exact_pixels', lossless.baselinePath);
        else await test('independent_jxl_quality_100_exact_pixels', ['parameter:export.format="jxl"', 'parameter:export.quality'], async () => { throw error; });
      }
      if (decoded) await test('independent_jxl_quality_100_exact_pixels', ['parameter:export.format="jxl"', 'parameter:export.quality', 'parameter:export.bit_depth=8'], async () => {
        assertNoIccWarnings(decoded.stderr); const baseline = decodePng(await readFile(lossless.baselinePath));
        const expected = Buffer.from(Array.from(baseline.pixels, (value) => Math.round(value * 255)));
        assert.equal(decoded.stdout.length, baseline.width * baseline.height * 3);
        assert.deepEqual(decoded.stdout, expected, 'Lossless JXL quality 100 must preserve every independently decoded 8-bit RGB sample');
        return { quality: 100, decoder: external, exact_rgb_samples: expected.length, dimensions: [baseline.width, baseline.height] };
      }, 'pixel_assertion');
    }
  }
  if (hasProfile) {
    const reference = process.env.RAPIDRAW_REFERENCE_SRGB_ICC ?? (process.platform === 'darwin' ? '/System/Library/ColorSync/Profiles/sRGB Profile.icc' : undefined);
    const referenceAvailable = reference && await stat(reference).then((info) => info.isFile()).catch(() => false);
    if (!external || !referenceAvailable) await h.skip('independent_srgb_reference_identity', ['parameter:export.color_profile="srgb"'], 'ImageMagick with LittleCMS and an independent reference sRGB ICC profile are required; set RAPIDRAW_REFERENCE_SRGB_ICC on other platforms');
    else await test('independent_srgb_reference_identity', ['parameter:export.color_profile="srgb"', 'parameter:export.format="png"'], async () => {
      await h.fixture(reference, 'independent system/reference sRGB ICC profile for LittleCMS identity conversion');
      const path = join(workspace, 'exports', 'explicit-srgb-reference.png');
      await h.call('export', { session_id: sid, path, format: 'png', bit_depth: 16, color_profile: 'srgb', resize: { mode: 'width', value: 160 }, keep_metadata: false });
      const original = decodePng(await readFile(path)); inspectDisplaySrgbProfile(pngProfile(original));
      const converted = await exec(magick, [path, '-profile', reference, '-depth', '16', '-endian', 'MSB', 'rgb:-'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }); assertNoIccWarnings(converted.stderr);
      assert.equal(converted.stdout.length, original.width * original.height * 6);
      let sum = 0, maximum = 0;
      for (let i = 0; i < original.pixels.length; i++) { const error = Math.abs(original.pixels[i] - converted.stdout.readUInt16BE(i * 2) / 65535); sum += error; maximum = Math.max(maximum, error); }
      const mean = sum / original.pixels.length;
      assert.ok(mean <= 4 / 65535 && maximum <= 32 / 65535, `sRGB-to-independent-sRGB must preserve color within fixed-point/TRC quantization: mean=${mean}, maximum=${maximum}`);
      await writeFile(join(workspace, 'reference-srgb-transform.rgb'), converted.stdout);
      return { decoder: external, reference_profile: reference, reference_sha256: await hashFile(reference), mean_absolute: mean, maximum, mean_tolerance: 4 / 65535, maximum_tolerance: 32 / 65535, conversion: 'embedded RapidRAW sRGB to independent reference sRGB through ImageMagick/LittleCMS' };
    }, 'pixel_assertion');
  }
  if (hasProfile) for (const format of ['avif', 'jxl', 'cube']) await test(`unsupported_explicit_srgb_${format}`, ['parameter:export.color_profile="srgb"'], async () => h.call('export', { session_id: sid, path: `explicit-srgb.${format}`, format, color_profile: 'srgb' }, { expectError: true }));
  for (const [mode, value, expected] of [['height', 60, [80, 60]], ['longEdge', 128, [128, 96]], ['shortEdge', 48, [64, 48]], ['width', 512, [256, 192]]]) await test(`resize_${mode}`, [`parameter:export.resize.mode=${JSON.stringify(mode)}`, 'parameter:export.resize.dont_enlarge=true'], async () => {
    const path = join(workspace, 'exports', `resize-${mode}.png`); await h.call('export', { session_id: sid, path, format: 'png', resize: { mode, value, dont_enlarge: true } }); const decoded = decodePng(await readFile(path)); assert.deepEqual([decoded.width, decoded.height], expected);
  }, 'pixel_assertion');
} catch (error) { failures.push({ name: 'suite', error: String(error) }); }
finally { await h.close(failures.length ? JSON.stringify(failures) : undefined); }
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
