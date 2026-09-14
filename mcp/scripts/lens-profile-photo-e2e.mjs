/** Real-photograph automatic Lensfun matching. Supply a private manifest; photographs are never bundled. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createNativeHarness, hashBytes, hashFile } from './coverage-evidence.mjs';
import { decodePng, mean, pixelDifference } from './png-fixtures.mjs';

const manifestPath = process.env.RAPIDRAW_LENS_MANIFEST;
assert.ok(
  manifestPath,
  'Set RAPIDRAW_LENS_MANIFEST to a manifest containing an original RAW and independently sourced expected profile coefficients',
);
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const manifestSha256 = hashBytes(manifestBytes);
assert.equal(manifest.schema_version, 1);
assert.ok(manifest.source?.path && /^[a-f0-9]{64}$/.test(manifest.source.sha256));
assert.ok(manifest.expected_metadata?.lens_model && manifest.expected_metadata.focal_length > 0);
assert.ok(manifest.expected_profile?.xml_path && manifest.expected_profile.xml_sha256);
assert.ok(
  Array.isArray(manifest.review_regions) && manifest.review_regions.length > 0,
  'Provide a native edge review region',
);
for (const region of manifest.review_regions) {
  assert.ok(region.width <= 512 && region.height <= 512, 'Use explicit native review tiles of at most512 pixels');
}
for (const region of manifest.review_regions)
  for (const key of ['x', 'y', 'width', 'height'])
    assert.ok(
      Number.isInteger(region[key]) && region[key] >= (key === 'x' || key === 'y' ? 0 : 1),
      `Invalid native region ${key}`,
    );
const coefficients = manifest.expected_profile.coefficients;
const apertureOverride = manifest.aperture_override;
assert.ok(
  Number.isFinite(apertureOverride?.aperture) && apertureOverride.aperture > 0,
  'Provide an independent aperture-override calibration expectation',
);
for (const key of ['vig_k1', 'vig_k2', 'vig_k3'])
  assert.ok(Number.isFinite(apertureOverride.vignetting?.[key]), `Missing override ${key} expectation`);
assert.ok(
  Object.entries(apertureOverride.vignetting).some(([key, value]) => Math.abs(value - coefficients[key]) > 1e-6),
  'Aperture override must select a different calibrated vignette row',
);
for (const key of ['model', 'k1', 'k2', 'k3', 'tca_vr', 'tca_vb', 'vig_k1', 'vig_k2', 'vig_k3'])
  assert.ok(Number.isFinite(coefficients[key]), `Missing independent ${key} expectation`);
assert.ok(
  Math.abs(coefficients.k1) + Math.abs(coefficients.k2) + Math.abs(coefficients.k3) > 0,
  'Fixture requires calibrated distortion',
);
assert.ok(Math.abs(coefficients.tca_vr - 1) + Math.abs(coefficients.tca_vb - 1) > 0, 'Fixture requires calibrated TCA');
assert.ok(
  Math.abs(coefficients.vig_k1) + Math.abs(coefficients.vig_k2) + Math.abs(coefficients.vig_k3) > 0,
  'Fixture requires calibrated vignetting',
);
assert.equal(await hashFile(manifest.source.path), manifest.source.sha256);
assert.equal(await hashFile(manifest.expected_profile.xml_path), manifest.expected_profile.xml_sha256);
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/lens-profile-photo-${Date.now()}`);
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'fixture-manifest.json'), manifestBytes, { flag: 'wx' });
const h = await createNativeHarness({ suite: 'lens-profile-photo', workspace });
const provenance = JSON.parse(await readFile(join(workspace, 'inventory.json'), 'utf8')).provenance;
let failure, sid, baseline, corrected, originalState, autoCall, autoState;
const artifacts = [];
const cleanText = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^"|"$/g, '');
const canonicalName = (value, maker) => {
  const text = cleanText(value),
    prefix = `${cleanText(maker)} `;
  return text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length) : text;
};
const numericExif = (value) =>
  Number(
    cleanText(value)
      .replace(/^f\//i, '')
      .replace(/\s*mm$/i, ''),
  );
const state = async () => (await h.call('get_session', { session_id: sid, include_adjustments: true })).data;
const mutate = async (patch) =>
  h.call('set_adjustments', { session_id: sid, expected_revision: (await state()).revision, mode: 'merge', patch });
const controls = (distortion, tca, vignette) => ({
  lensDistortionEnabled: distortion,
  lensTcaEnabled: tca,
  lensVignetteEnabled: vignette,
});
async function render(name, options = { long_edge: 1024 }) {
  const result = await h.call('render', { session_id: sid, format: 'png', ...options });
  assert.equal(result.images.length, 1);
  const bytes = Buffer.from(result.images[0].data, 'base64');
  const image = decodePng(bytes);
  if (options.region)
    assert.deepEqual(
      [image.width, image.height],
      [options.region.width, options.region.height],
      'Native detail must not resize',
    );
  if (name) {
    const path = join(workspace, `${name}.png`);
    await writeFile(path, bytes, { flag: 'wx' });
    artifacts.push({
      name,
      path,
      sha256: hashBytes(bytes),
      bytes: bytes.length,
      dimensions: [image.width, image.height],
      options,
      metadata: result.data,
    });
  }
  return image;
}
function changed(a, b, label, minimum = 0.00001) {
  const difference = pixelDifference(a, b);
  assert.ok(difference.mean_absolute > minimum, `${label}: ${JSON.stringify(difference)}`);
  return difference;
}
function identical(a, b, label) {
  const difference = pixelDifference(a, b);
  assert.equal(difference.maximum, 0, label);
}
function equivalentProfile(actual, expected, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), label);
  let maximum = 0;
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(Number.isFinite(actual[key]), label);
    maximum = Math.max(maximum, Math.abs(actual[key] - value));
  }
  assert.equal(actual.model, expected.model, label);
  // JSON decimal conversion may move the last f64 bit; processing coefficients
  // are f32. Rendered pixels still require exact equality after persistence.
  assert.ok(maximum <= 1e-12, `${label}: coefficient error ${maximum}`);
  return maximum;
}

async function check(name, requirements, fn, level = 'pixel_assertion') {
  await h.check(name, requirements, fn, level);
  console.log(`PASS ${name}`);
}

try {
  await h.fixture(manifestPath, 'Immutable photographic acceptance manifest', { expected_sha256: manifestSha256 });
  if (manifest.provenance?.runtime_freeze) {
    const freeze = manifest.provenance.runtime_freeze;
    assert.equal(provenance.runtime_tree_sha256, freeze.runtime_tree_sha256, 'Acceptance must use the frozen runtime');
    assert.equal(provenance.binary_sha256, freeze.binary_sha256, 'Acceptance must use the frozen native executable');
    assert.equal(await hashFile(freeze.path), freeze.sha256, 'Freeze declaration must remain unchanged');
    await h.fixture(freeze.path, 'Runtime and skill freeze declaration');
  }
  await h.fixture(manifest.source.path, 'Unmodified original RAW with genuine camera/lens EXIF', {
    expected_sha256: manifest.source.sha256,
  });
  await h.fixture(manifest.expected_profile.xml_path, 'Independently parsed Lensfun calibration XML');
  const resourceXml =
    process.env.RAPIDRAW_LENS_RESOURCE_XML ??
    join(dirname(process.env.RAPIDRAW_BINARY), 'lensfun_db', basename(manifest.expected_profile.xml_path));
  assert.equal(
    await hashFile(resourceXml),
    manifest.expected_profile.xml_sha256,
    'Native resource calibration must match the independently inspected XML',
  );
  await h.fixture(resourceXml, 'Actual native Lensfun resource XML');
  const opened = (await h.call('open_photo', { path: manifest.source.path, inherit_sidecar: false })).data;
  sid = opened.session_id;
  await check(
    'original_raw_exif_is_used_without_metadata_or_profile_overrides',
    ['tool:open_photo', 'tool:get_session'],
    async () => {
      assert.equal(opened.is_raw, true);
      assert.notEqual(opened.working_path, manifest.source.path);
      assert.equal(await hashFile(opened.working_path), manifest.source.sha256);
      await h.call('set_adjustments', {
        session_id: sid,
        expected_revision: opened.revision,
        mode: 'replace',
        patch: h.capabilities.adjustment_schema.default,
      });
      originalState = await state();
      const dimensions = (await h.call('preflight', { session_id: sid, operation: 'render' })).data.rendered_dimensions;
      for (const region of manifest.review_regions)
        assert.ok(
          region.x + region.width <= dimensions[0] && region.y + region.height <= dimensions[1],
          'Review region must fit native dimensions',
        );
      const exif = originalState.metadata.exif,
        expected = manifest.expected_metadata;
      assert.equal(cleanText(exif.Make), expected.make);
      assert.equal(canonicalName(exif.Model, expected.make), canonicalName(expected.camera_model, expected.make));
      assert.equal(canonicalName(exif.LensModel, expected.make), canonicalName(expected.lens_model, expected.make));
      assert.equal(numericExif(exif.FocalLength), expected.focal_length);
      assert.equal(numericExif(exif.FNumber), expected.f_number);
      assert.ok(!originalState.adjustments.lensDistortionParams, 'Baseline must have no resolved lens correction');
      return {
        native_exif: Object.fromEntries(
          ['Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ApertureValue'].map((key) => [key, exif[key]]),
        ),
        maker_prefix_normalized: true,
        original_sha256: manifest.source.sha256,
        camera: expected.camera_model,
        lens: expected.lens_model,
        focal_length: expected.focal_length,
        f_number: expected.f_number,
      };
    },
    'native_assertion',
  );
  baseline = await render('baseline-overview');
  for (const [index, region] of (manifest.review_regions ?? []).entries())
    await render(`baseline-native-detail-${index + 1}`, { region });

  await check(
    'automatic_exif_match_applies_calibrated_profile_and_changes_photo_pixels',
    ['tool:lens_profile', 'parameter:lens_profile.mode="auto"'],
    async () => {
      autoCall = await h.call('lens_profile', {
        session_id: sid,
        expected_revision: originalState.revision,
        mode: 'auto',
      });
      autoState = await state();
      assert.equal(autoState.revision, originalState.revision + 1);
      assert.equal(autoState.adjustments.lensCorrectionMode, 'auto');
      assert.equal(autoState.adjustments.lensMaker, manifest.expected_profile.maker);
      assert.equal(autoState.adjustments.lensModel, manifest.expected_profile.model);
      for (const [key, value] of Object.entries(coefficients))
        assert.ok(
          Math.abs(autoCall.data.profile[key] - value) <= 1e-6,
          `Automatic ${key} differs from independent Lensfun expectation`,
        );
      corrected = await render('corrected-overview');
      for (const [index, region] of (manifest.review_regions ?? []).entries())
        await render(`corrected-native-detail-${index + 1}`, { region });
      return {
        resolved_maker: autoState.adjustments.lensMaker,
        resolved_model: autoState.adjustments.lensModel,
        calibrated_profile: autoCall.data.profile,
        difference: changed(baseline, corrected, 'Automatic correction must affect actual RAW rendering'),
        visual_quality: 'requires separate named review',
      };
    },
  );
  await h.checkDerived(
    'automatic_profile_coefficients_are_native_derived_state',
    [
      'adjustment:lensCorrectionMode="auto"',
      'adjustment:lensMaker',
      'adjustment:lensModel',
      ...Object.keys(coefficients).map((key) => `adjustment:lensDistortionParams.${key}`),
    ],
    [autoCall.call_id],
    async () => {
      equivalentProfile(autoState.adjustments.lensDistortionParams, autoCall.data.profile, 'Stored automatic profile');
      return { independent_calibration_sha256: manifest.expected_profile.xml_sha256, profile: autoCall.data.profile };
    },
  );
  await check(
    'auto_profile_undo_redo_and_stale_revision_are_atomic',
    ['tool:undo', 'tool:redo', 'parameter:lens_profile.expected_revision'],
    async () => {
      await h.call('undo', { session_id: sid, expected_revision: autoState.revision });
      identical(baseline, await render(), 'Undo must reproduce baseline');
      await h.call('redo', { session_id: sid, expected_revision: (await state()).revision });
      identical(corrected, await render(), 'Redo must reproduce correction');
      const before = await state();
      const rejected = await h.call(
        'lens_profile',
        { session_id: sid, expected_revision: originalState.revision, mode: 'auto' },
        { expectError: true },
      );
      assert.match(JSON.stringify(rejected.result), /REVISION_CONFLICT/);
      assert.equal((await state()).revision, before.revision);
      identical(corrected, await render(), 'Stale profile must not change pixels');
      return { undo_redo_exact: true, stale_revision_preserved: true };
    },
  );
  await check(
    'distortion_only_moves_coordinates_and_disable_restores_raw_pixels',
    [
      'tool:map_coordinates',
      'adjustment:lensDistortionEnabled=true',
      'adjustment:lensDistortionEnabled=false',
      'adjustment:lensTcaEnabled=false',
      'adjustment:lensVignetteEnabled=false',
    ],
    async () => {
      await mutate(controls(false, false, false));
      identical(
        baseline,
        await render('all-corrections-disabled'),
        'Resolved but disabled corrections must equal original baseline',
      );
      const dimensions = (await h.call('preflight', { session_id: sid, operation: 'render' })).data.rendered_dimensions;
      const [width, height] = dimensions;
      const points = [
        [0.1, 0.15],
        [0.9, 0.2],
        [0.85, 0.8],
        [0.5, 0.5],
      ].map(([x, y]) => ({ x: Math.round(width * x), y: Math.round(height * y) }));
      const before = (
        await h.call('map_coordinates', { session_id: sid, from: 'rendered', to: 'oriented_source', points })
      ).data;
      await mutate(controls(true, false, false));
      const distortionOnly = await render('distortion-only-overview');
      const after = (
        await h.call('map_coordinates', { session_id: sid, from: 'rendered', to: 'oriented_source', points })
      ).data;
      const back = (
        await h.call('map_coordinates', {
          session_id: sid,
          from: 'oriented_source',
          to: 'rendered',
          points: after.points.map(({ x, y }) => ({ x, y })),
        })
      ).data;
      let movement = 0,
        roundtrip = 0;
      after.points.forEach((point, index) => {
        assert.equal(point.mapped, true);
        movement = Math.max(movement, Math.hypot(point.x - before.points[index].x, point.y - before.points[index].y));
        roundtrip = Math.max(
          roundtrip,
          Math.hypot(back.points[index].x - points[index].x, back.points[index].y - points[index].y),
        );
      });
      assert.ok(movement > 1, 'Calibrated distortion must move off-axis source coordinates');
      assert.ok(roundtrip < 0.1, `Lens mapping roundtrip error ${roundtrip}px`);
      return {
        dimensions,
        maximum_coordinate_movement_px: movement,
        maximum_roundtrip_error_px: roundtrip,
        pixel_difference: changed(baseline, distortionOnly, 'Distortion-only correction'),
      };
    },
  );
  await check(
    'tca_only_changes_color_registration_and_preserves_green_channel',
    ['adjustment:lensTcaEnabled=true', 'adjustment:lensTcaEnabled=false'],
    async () => {
      const region = manifest.review_regions[0];
      await mutate(controls(false, false, false));
      const reference = await render(null, { region });
      await mutate(controls(false, true, false));
      const tca = await render('tca-only-native-detail', { region });
      const sums = [0, 0, 0],
        maxima = [0, 0, 0];
      for (let i = 0; i < reference.pixels.length; i++) {
        const difference = Math.abs(reference.pixels[i] - tca.pixels[i]);
        sums[i % 3] += difference;
        maxima[i % 3] = Math.max(maxima[i % 3], difference);
      }
      assert.ok(sums[0] + sums[2] > 0.1, 'Actual lens TCA must shift red or blue edge pixels');
      assert.ok(maxima[1] <= 1 / 255, `TCA altered the unaffected green channel: ${maxima[1]}`);
      return { channel_absolute_sums: sums, channel_maxima: maxima };
    },
  );
  await check(
    'vignetting_only_lifts_corners_more_than_center_without_geometry_change',
    ['adjustment:lensVignetteEnabled=true', 'adjustment:lensVignetteEnabled=false'],
    async () => {
      await mutate(controls(false, false, true));
      const vignette = await render('vignette-only-overview');
      const corner = { x: 10, y: baseline.height - 60, width: 40, height: 40 };
      const center = {
        x: Math.floor(baseline.width / 2) - 20,
        y: Math.floor(baseline.height / 2) - 20,
        width: 40,
        height: 40,
      };
      const cornerLift = mean(vignette, corner) - mean(baseline, corner),
        centerChange = Math.abs(mean(vignette, center) - mean(baseline, center));
      assert.ok(cornerLift > 0.003, `Calibrated vignette must lift this dark corner: ${cornerLift}`);
      assert.ok(cornerLift > centerChange * 2, 'Vignette correction must have radial effect');
      const dimensions = (await h.call('preflight', { session_id: sid, operation: 'render' })).data.rendered_dimensions;
      const points = [{ x: Math.round(dimensions[0] * 0.15), y: Math.round(dimensions[1] * 0.2) }];
      const mapped = (
        await h.call('map_coordinates', { session_id: sid, from: 'rendered', to: 'oriented_source', points })
      ).data;
      assert.equal(mapped.points[0].mapped, true);
      assert.ok(
        Math.hypot(mapped.points[0].x - points[0].x, mapped.points[0].y - points[0].y) < 0.01,
        'Vignetting alone must not move coordinates',
      );
      return {
        corner_luminance_lift: cornerLift,
        center_luminance_change: centerChange,
        coordinate_identity: true,
        full_pixel_difference: changed(baseline, vignette, 'Vignette-only correction'),
      };
    },
  );
  await check(
    'explicit_aperture_overrides_apex_and_undo_restores_original_profile',
    ['tool:lens_profile', 'parameter:lens_profile.aperture', 'tool:undo'],
    async () => {
      await mutate(controls(true, true, true));
      identical(corrected, await render(), 'Restore original automatic profile before aperture override');
      const before = await state();
      assert.ok(
        before.metadata.exif.ApertureValue,
        'This regression requires original APEX metadata alongside FNumber',
      );
      const overridden = await h.call('lens_profile', {
        session_id: sid,
        expected_revision: before.revision,
        mode: 'auto',
        aperture: apertureOverride.aperture,
      });
      const expected = { ...coefficients, ...apertureOverride.vignetting };
      for (const [key, value] of Object.entries(expected))
        assert.ok(
          Math.abs(overridden.data.profile[key] - value) <= 1e-6,
          `Explicit aperture failed to select independent ${key} calibration`,
        );
      const after = await state();
      assert.deepEqual(after.metadata, before.metadata, 'Applying profile aperture must preserve original EXIF');
      const overridePixels = await render('aperture-override-overview');
      const difference = changed(
        corrected,
        overridePixels,
        'Aperture override must change actual calibrated vignette pixels',
      );
      await h.call('undo', { session_id: sid, expected_revision: after.revision });
      identical(corrected, await render(), 'Undo override must exactly restore original automatic correction');
      const detected = await h.call('lens_profile', {
        session_id: sid,
        expected_revision: (await state()).revision,
        mode: 'auto',
      });
      equivalentProfile(detected.data.profile, autoCall.data.profile, 'Original automatic profile restored');
      identical(corrected, await render(), 'Omitted override must resolve the original EXIF aperture again');
      return {
        requested_f_number: apertureOverride.aperture,
        original_f_number: before.metadata.exif.FNumber,
        original_apex: before.metadata.exif.ApertureValue,
        selected_vignetting: apertureOverride.vignetting,
        original_metadata_preserved: true,
        pixel_difference: difference,
        undo_and_original_auto_exact: true,
      };
    },
  );
  await check(
    'automatic_profile_saves_restarts_and_transfers_with_exact_pixels',
    ['tool:save_session', 'tool:export_session_bundle', 'tool:import_session_bundle'],
    async () => {
      await mutate(controls(true, true, true));
      identical(corrected, await render(), 'All correction components restored');
      await h.call('save_session', { session_id: sid });
      const bundle = (await h.call('export_session_bundle', { session_id: sid, name: 'automatic-lens-profile' })).data;
      const expected = await state();
      await h.reconnect();
      const coefficientError = equivalentProfile(
        (await state()).adjustments.lensDistortionParams,
        expected.adjustments.lensDistortionParams,
        'Restarted profile',
      );
      identical(corrected, await render(), 'Restart correction must be exact');
      const imported = (
        await h.call('import_session_bundle', { path: bundle.path, expected_manifest_sha256: bundle.manifest_sha256 })
      ).data;
      const parent = sid;
      sid = imported.session_id;
      assert.notEqual(sid, parent);
      assert.equal(imported.is_raw, true);
      assert.equal(await hashFile(imported.working_path), manifest.source.sha256);
      assert.equal((await state()).adjustments.lensCorrectionMode, 'auto');
      identical(corrected, await render(), 'Imported correction must be exact');
      sid = parent;
      return {
        maximum_profile_coefficient_roundtrip_error: coefficientError,
        persisted_profile: expected.adjustments.lensDistortionParams,
        imported_session_id: imported.session_id,
        raw_preserved: true,
        restart_and_bundle_pixels_exact: true,
      };
    },
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  await writeFile(
    join(workspace, 'review-required.json'),
    JSON.stringify(
      {
        fixture_id: manifest.id,
        fixture_manifest_sha256: manifestSha256,
        source_sha256: manifest.source.sha256,
        provenance,
        inspection_timing: manifest.provenance?.inspection_timing ?? {
          classification: 'Not declared; no blind-holdout claim',
        },
        session_id: sid,
        visual_review: 'not_reviewed',
        criteria: [
          'Compare door, handrail and ceiling edges before/after for natural geometry and interpolation artifacts',
          'Check native color fringes and detail retention',
          'Check corner brightness for overcorrection and altered shadow intent',
        ],
        limitations:
          'An exact database match and nonzero correction do not establish optical calibration accuracy or photographic improvement.',
        artifacts,
      },
      null,
      2,
    ),
  );
  const mediaRoot = resolve(process.env.RAPIDRAW_REVIEW_MEDIA_ROOT ?? workspace);
  const cases = [];
  for (const [suffix, title] of [
    ['overview', 'Automatic lens correction'],
    ...manifest.review_regions.map((_, index) => [`native-detail-${index + 1}`, `Native lens detail ${index + 1}`]),
  ]) {
    const before = artifacts.find((item) => item.name === `baseline-${suffix}`),
      after = artifacts.find((item) => item.name === `corrected-${suffix}`);
    if (!before || !after) continue;
    cases.push({
      id: `${manifest.id}-${suffix}`,
      title,
      category: 'lens-correction',
      intent: 'Inspect automatic lens-profile correction on genuine RAW pixels.',
      aligned: false,
      limits:
        'Correction changes geometry. Matching output crops may contain shifted scene features. No calibrated optical target or visual pass is implied.',
      variants: [
        { id: 'baseline', label: 'Lens correction off', role: 'baseline', image: relative(mediaRoot, before.path) },
        { id: 'automatic', label: 'Automatic lens profile', role: 'candidate', image: relative(mediaRoot, after.path) },
      ],
      regions: [],
    });
  }
  if (cases.length)
    await writeFile(
      join(workspace, 'shared-review-manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: `automatic-lens-${manifest.id}`,
          title: 'Automatic lens-profile review',
          description:
            'Native RAW correction with a matching calibration profile; visual assessment remains separate from automated acceptance.',
          cases,
        },
        null,
        2,
      ),
    );
  await h.close(failure);
}
