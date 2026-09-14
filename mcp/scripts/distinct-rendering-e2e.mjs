/** Focused real-native behavior gaps. Generated fixtures establish semantics, not photo quality. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { decodePng, fixturePng, gpsExifFixture, mean, pixelDifference } from './png-fixtures.mjs';

const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/distinct-rendering-${Date.now()}`);
const fixtures = join(workspace, 'fixtures');
await mkdir(fixtures, { recursive: true });
const width = 512,
  height = 384;
const definitions = {
  texture: fixturePng(width, height, undefined, [{ type: 'eXIf', data: gpsExifFixture() }]),
  ramp: fixturePng(width, height, (x, y) => [25 + x * 0.39, 30 + y * 0.49, 55 + x * 0.15 + y * 0.2]),
  gray: fixturePng(width, height, () => [110, 110, 110]),
  stripes: fixturePng(width, height, (x, y) => {
    const value = (Math.floor(x / 9) + Math.floor(y / 11)) % 2 ? 190 : 55;
    return [value, value, value];
  }),
  bokeh: fixturePng(width, height, (x, y) => {
    const lit = x % 37 < 2 && y % 41 < 2;
    const value = lit ? 245 : 12;
    return [value, value, value];
  }),
  depth: fixturePng(width, height, (x) => {
    const value = x < 170 ? 0 : x > 340 ? 255 : 128;
    return [value, value, value];
  }),
  watermark: fixturePng(32, 20, (x, y) => [x < 16 ? 245 : 20, y < 10 ? 55 : 220, 70]),
};
const paths = {};
for (const [name, bytes] of Object.entries(definitions)) {
  paths[name] = join(fixtures, `${name}.png`);
  await writeFile(paths[name], bytes, { flag: 'wx' });
}
const lut = join(fixtures, 'identity.cube');
const cube = ['TITLE "Distinct rendering identity fixture"', 'LUT_3D_SIZE 2'];
for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.push(`${r} ${g} ${b}`);
await writeFile(lut, cube.join('\n') + '\n', { flag: 'wx' });
const h = await createNativeHarness({ suite: 'distinct-rendering', workspace });
let failure;
const sessions = new Map();
async function open(name) {
  if (!sessions.has(name))
    sessions.set(name, (await h.call('open_photo', { path: paths[name], inherit_sidecar: false })).data.session_id);
  return sessions.get(name);
}
const defaults = h.capabilities.adjustment_schema.default;
const state = async (sid) => (await h.call('get_session', { session_id: sid, include_adjustments: true })).data;
async function mutate(sid, patch, mode = 'merge') {
  return h.call('set_adjustments', { session_id: sid, expected_revision: (await state(sid)).revision, mode, patch });
}
async function reset(sid) {
  await mutate(sid, defaults, 'replace');
}
async function render(sid, options = {}, artifact) {
  const response = await h.call('render', { session_id: sid, format: 'png', ...options });
  assert.equal(response.images.length, 1);
  const bytes = Buffer.from(response.images[0].data, 'base64');
  if (artifact) await writeFile(join(workspace, `${artifact}.png`), bytes, { flag: 'wx' });
  return decodePng(bytes);
}
function changed(before, after, message, threshold = 0.00001) {
  const difference = pixelDifference(before, after);
  assert.ok(difference.mean_absolute > threshold, `${message}: ${JSON.stringify(difference)}`);
  return difference;
}
function identical(before, after, message) {
  const difference = pixelDifference(before, after);
  assert.equal(difference.maximum, 0, `${message}: ${JSON.stringify(difference)}`);
}
async function check(name, requirements, fn, level = 'pixel_assertion') {
  await h.check(name, requirements, fn, level);
  console.log(`PASS ${name}`);
}

try {
  for (const path of [...Object.values(paths), lut])
    await h.fixture(path, 'generated distinct-rendering oracle fixture');
  const sid = await open('texture');
  await reset(sid);
  const baseline = await render(sid);
  const sectionCases = [
    ['basic', { exposure: 0.8 }],
    [
      'curves',
      {
        curves: {
          luma: [
            { x: 0, y: 0 },
            { x: 255, y: 180 },
          ],
        },
      },
    ],
    ['color', { saturation: -80 }],
    ['details', { clarity: 80, sharpness: 85 }],
    ['effects', { glowAmount: 85 }],
  ];
  for (const [section, patch] of sectionCases) {
    await check(
      `global_section_${section}_disables_and_restores_pixels`,
      [`adjustment:sectionVisibility.${section}=false`, `adjustment:sectionVisibility.${section}=true`],
      async () => {
        await reset(sid);
        await mutate(sid, patch);
        const active = await render(sid);
        changed(baseline, active, `${section} positive control`);
        await mutate(sid, { sectionVisibility: { [section]: false } });
        identical(baseline, await render(sid), `${section} disabled must equal baseline`);
        await mutate(sid, { sectionVisibility: { [section]: true } });
        identical(active, await render(sid), `${section} restored must equal active pixels`);
        return {
          active_difference: pixelDifference(baseline, active),
          disabled_matches_baseline: true,
          restored_matches_active: true,
        };
      },
    );
    await check(
      `local_section_${section}_disables_and_restores_pixels`,
      [
        `adjustment:masks[].adjustments.sectionVisibility.${section}=false`,
        `adjustment:masks[].adjustments.sectionVisibility.${section}=true`,
      ],
      async () => {
        await reset(sid);
        const mask = (
          await h.call('mask_create', {
            session_id: sid,
            expected_revision: (await state(sid)).revision,
            type: 'all',
            parameters: {},
            adjustments: patch,
          })
        ).data;
        const active = await render(sid);
        changed(baseline, active, `Local ${section} positive control`);
        const update = async (visible) =>
          h.call('mask_update', {
            session_id: sid,
            mask_id: mask.mask_id,
            expected_revision: (await state(sid)).revision,
            patch: { adjustments: { sectionVisibility: { [section]: visible } } },
          });
        await update(false);
        identical(baseline, await render(sid), `Local ${section} disabled must equal baseline`);
        await update(true);
        identical(active, await render(sid), `Local ${section} restored must equal active pixels`);
        await h.call('mask_remove', {
          session_id: sid,
          mask_id: mask.mask_id,
          expected_revision: (await state(sid)).revision,
        });
        identical(baseline, await render(sid), 'Removing local control must restore baseline');
        return { active_difference: pixelDifference(baseline, active), disabled_matches_baseline: true };
      },
    );
  }

  await check(
    'parametric_mode_matches_compiled_curve_and_survives_history_restart',
    [
      'adjustment:curveMode="parametric"',
      'adjustment:masks[].adjustments.curveMode="parametric"',
      'adjustment:parametricCurve.luma.shadows',
      'adjustment:parametricCurve.luma.highlights',
      'parameter:undo.expected_revision',
      'parameter:redo.expected_revision',
    ],
    async () => {
      await reset(sid);
      const applied = await mutate(sid, {
        curveMode: 'parametric',
        parametricCurve: { luma: { shadows: 50, darks: 20, lights: -10, highlights: -40 } },
      });
      const current = await state(sid);
      assert.equal(current.adjustments.curveMode, 'parametric');
      assert.ok(current.adjustments.curves.luma.length > 2);
      const curve = current.adjustments.curves;
      const parametrized = await render(sid, {}, 'parametric-mode');
      changed(baseline, parametrized, 'Parametric curve must affect pixels');
      await h.checkDerived(
        'parametric_controls_compile_native_curve_state',
        ['adjustment:curves.luma'],
        [applied.call_id],
        async () => {
          assert.ok(curve.luma.some((point) => Math.abs(point.x - point.y) > 1));
          return { point_count: curve.luma.length, nonidentity: true };
        },
      );
      await h.call('undo', { session_id: sid, expected_revision: current.revision });
      identical(baseline, await render(sid), 'Undo parametric controls');
      await h.call('redo', { session_id: sid, expected_revision: (await state(sid)).revision });
      identical(parametrized, await render(sid), 'Redo parametric controls');
      await h.reconnect();
      identical(parametrized, await render(sid), 'Parametric recipe must survive restart');
      await reset(sid);
      await mutate(sid, { curveMode: 'point', curves: curve });
      identical(parametrized, await render(sid), 'Compiled native curve and parametric input must render identically');
      await reset(sid);
      const local = (
        await h.call('mask_create', {
          session_id: sid,
          type: 'all',
          parameters: {},
          adjustments: { curveMode: 'parametric', parametricCurve: { luma: { shadows: 40, highlights: -30 } } },
        })
      ).data;
      const localPixels = await render(sid);
      changed(baseline, localPixels, 'Local parametric positive control');
      await h.checkDerived(
        'local_parametric_mask_compiles_curve',
        ['adjustment:masks[].adjustments.curveMode="parametric"', 'adjustment:masks[].adjustments.curves.luma'],
        [h.records.findLast((r) => r.type === 'call' && r.method === 'mask_create').id],
        async () => {
          const mask = (await state(sid)).adjustments.masks.find((mask) => mask.id === local.mask_id);
          assert.equal(mask.adjustments.curveMode, 'parametric');
          assert.ok(mask.adjustments.curves.luma.length > 2);
          return { point_count: mask.adjustments.curves.luma.length, mode: mask.adjustments.curveMode };
        },
      );
      return { compiled_curve_pixel_identity: true, undo_redo_restart_identity: true };
    },
  );

  const bokeh = await open('bokeh');
  await reset(bokeh);
  const sharp = await render(bokeh);
  const depthMap = `data:image/png;base64,${definitions.depth.toString('base64')}`;
  const blurControls = {
    lensBlurEnabled: true,
    lensBlurDepthMap: depthMap,
    lensBlurAmount: 100,
    lensBlurMinDepth: 45,
    lensBlurMaxDepth: 55,
    lensBlurMinFade: 0,
    lensBlurMaxFade: 0,
    lensBlurDiffusion: 0,
  };
  const shapePixels = new Map();
  for (const shape of ['circle', 'hexagon', 'octagon', 'ring'])
    await check(
      `lens_blur_${shape}_changes_defocus_and_preserves_focus`,
      [
        `adjustment:lensBlurShape=${JSON.stringify(shape)}`,
        'adjustment:lensBlurEnabled=true',
        'adjustment:lensBlurDepthMap',
      ],
      async () => {
        await reset(bokeh);
        await mutate(bokeh, { ...blurControls, lensBlurShape: shape });
        const image = await render(bokeh, {}, `bokeh-${shape}`);
        changed(sharp, image, `${shape} must blur defocused points`);
        const focus = { x: 215, y: 20, width: 80, height: height - 40 };
        const focusError = pixelDifference(sharp, image, focus);
        assert.ok(focusError.maximum <= 1 / 255, 'Interior focus plane must stay sharp');
        for (const [previous, pixels] of shapePixels)
          changed(pixels, image, `${previous}/${shape} must have distinct point-spread pixels`, 1e-7);
        shapePixels.set(shape, image);
        await mutate(bokeh, { lensBlurEnabled: false });
        identical(sharp, await render(bokeh), 'Disabled blur must be exact identity');
        return { focus_maximum_error: focusError.maximum, unique_shape: true };
      },
    );
  await check(
    'blur_focus_range_and_zero_amount_are_identity',
    [
      'adjustment:lensBlurAmount',
      'adjustment:lensBlurMinDepth',
      'adjustment:lensBlurMaxDepth',
      'adjustment:lensBlurEnabled=false',
    ],
    async () => {
      await mutate(bokeh, { ...blurControls, lensBlurAmount: 0 });
      identical(sharp, await render(bokeh), 'Zero amount');
      await mutate(bokeh, { ...blurControls, lensBlurMinDepth: 0, lensBlurMaxDepth: 100 });
      identical(sharp, await render(bokeh), 'Full depth interval in focus');
      return { zero_strength_identity: true, full_depth_focus_identity: true };
    },
  );

  await check(
    'horizontal_guides_level_lines_and_match_native_coordinate_pixels',
    ['adjustment:guidedPerspective.lines[].type="horizontal"', 'tool:map_coordinates'],
    async () => {
      const ramp = await open('ramp');
      await reset(ramp);
      const original = await render(ramp);
      const lines = [
        { id: 'upper', type: 'horizontal', p1: { x: 0.1, y: 0.2 }, p2: { x: 0.9, y: 0.3 } },
        { id: 'lower', type: 'horizontal', p1: { x: 0.1, y: 0.8 }, p2: { x: 0.9, y: 0.7 } },
      ];
      await mutate(ramp, { guidedPerspective: { enabled: true, autoCrop: false, lines } });
      const corrected = await render(ramp, {}, 'horizontal-guides');
      // Strong projective correction can move guide endpoints outside the canvas.
      // Test visible interior points on each unchanged guide instead.
      const points = lines.flatMap((line) =>
        [0.25, 0.6].map((t) => ({
          x: (line.p1.x + (line.p2.x - line.p1.x) * t) * width,
          y: (line.p1.y + (line.p2.y - line.p1.y) * t) * height,
        })),
      );
      const result = (
        await h.call('map_coordinates', { session_id: ramp, from: 'oriented_source', to: 'rendered', points })
      ).data;
      assert.ok(result.points.every((p) => p.mapped));
      const residuals = [
        Math.abs(result.points[0].y - result.points[1].y),
        Math.abs(result.points[2].y - result.points[3].y),
      ];
      assert.ok(
        residuals.every((value) => value < 1),
        `Guides were not leveled: ${residuals}`,
      );
      const probes = [
        { x: 210, y: 145 },
        { x: 270, y: 205 },
        { x: 310, y: 240 },
      ];
      const mapping = (
        await h.call('map_coordinates', { session_id: ramp, from: 'rendered', to: 'oriented_source', points: probes })
      ).data;
      let maximum = 0;
      mapping.points.forEach((p, i) => {
        assert.equal(p.mapped, true);
        for (let c = 0; c < 3; c++)
          maximum = Math.max(
            maximum,
            Math.abs(
              corrected.pixels[(probes[i].y * corrected.width + probes[i].x) * 3 + c] -
                original.pixels[(Math.round(p.y) * original.width + Math.round(p.x)) * 3 + c],
            ),
          );
      });
      assert.ok(maximum < 0.012, `Native warp and mapped ramp disagree: ${maximum}`);
      return { guide_y_residuals: residuals, maximum_sample_error: maximum };
    },
  );

  await check(
    'scene_referred_lut_mode_is_distinct_and_owned_state_survives_restart',
    [
      'adjustment:lutIsSceneReferred=true',
      'adjustment:lutIsSceneReferred=false',
      'adjustment:lutIntensity',
      'parameter:apply_lut.expected_revision',
    ],
    async () => {
      await reset(sid);
      const applied = await h.call('apply_lut', {
        session_id: sid,
        expected_revision: (await state(sid)).revision,
        path: lut,
        intensity: 100,
      });
      await mutate(sid, { lutIsSceneReferred: false });
      const display = await render(sid);
      assert.ok(pixelDifference(baseline, display).maximum <= 2 / 255, 'Display identity LUT must preserve pixels');
      await mutate(sid, { lutIsSceneReferred: true });
      const scene = await render(sid, {}, 'scene-referred-lut');
      changed(display, scene, 'Scene encoding must differ from display identity', 0.01);
      await mutate(sid, { lutIntensity: 0 });
      identical(baseline, await render(sid), 'Zero scene LUT intensity must be identity');
      await mutate(sid, { lutIntensity: 100 });
      identical(scene, await render(sid), 'Restoring LUT intensity');
      await h.checkDerived(
        'applied_lut_has_owned_verified_recipe_assets',
        ['adjustment:lutPath', 'adjustment:lutName', 'adjustment:lutSize'],
        [applied.call_id],
        async () => {
          const a = (await state(sid)).adjustments;
          assert.notEqual(a.lutPath, lut);
          assert.equal(await hashFile(a.lutPath), await hashFile(lut));
          assert.equal(a.lutSize, 2);
          assert.ok(a.lutName);
          return { owned_asset_verified: true, size: a.lutSize };
        },
      );
      await h.reconnect();
      identical(scene, await render(sid), 'Scene-referred LUT restart pixels');
      return {
        scene_display_difference: pixelDifference(display, scene),
        zero_intensity_identity: true,
        restart_identity: true,
      };
    },
  );

  const stripes = await open('stripes');
  await reset(stripes);
  const aligned = await render(stripes);
  for (const [coefficient, value, channel] of [
    ['tca_vr', 1.018, 0],
    ['tca_vb', 0.982, 2],
  ])
    await check(
      `lens_${coefficient}_changes_only_its_color_channel`,
      [`adjustment:lensDistortionParams.${coefficient}`, 'adjustment:lensTcaEnabled=false', 'adjustment:lensTcaAmount'],
      async () => {
        await reset(stripes);
        await mutate(stripes, {
          lensDistortionParams: { model: 0, k1: 0, k2: 0, k3: 0, tca_vr: 1, tca_vb: 1, [coefficient]: value },
          lensTcaEnabled: true,
          lensTcaAmount: 100,
        });
        const shifted = await render(stripes);
        const errors = [0, 0, 0];
        for (let y = 20; y < height - 20; y++)
          for (let x = 20; x < width - 20; x++)
            for (let c = 0; c < 3; c++)
              errors[c] += Math.abs(shifted.pixels[(y * width + x) * 3 + c] - aligned.pixels[(y * width + x) * 3 + c]);
        assert.ok(errors[channel] > 10, 'Named TCA channel must actually shift');
        errors.forEach((error, c) => {
          if (c !== channel) assert.ok(error < 0.001, 'TCA must preserve the other channels');
        });
        await mutate(stripes, { lensTcaEnabled: false });
        identical(aligned, await render(stripes), 'Disabled TCA');
        await mutate(stripes, { lensTcaEnabled: true, lensTcaAmount: 0 });
        identical(aligned, await render(stripes), 'Zero TCA amount');
        return { channel_absolute_sums: errors, named_channel: channel, disable_and_zero_identity: true };
      },
    );
  const gray = await open('gray');
  await reset(gray);
  const flat = await render(gray);
  for (const coefficient of ['vig_k1', 'vig_k2', 'vig_k3'])
    await check(
      `lens_${coefficient}_has_radial_effect_and_disable_identity`,
      [
        `adjustment:lensDistortionParams.${coefficient}`,
        'adjustment:lensVignetteEnabled=false',
        'adjustment:lensVignetteAmount',
      ],
      async () => {
        await reset(gray);
        await mutate(gray, {
          lensDistortionParams: { model: 0, k1: 0, k2: 0, k3: 0, [coefficient]: 0.7 },
          lensVignetteEnabled: true,
          lensVignetteAmount: 100,
        });
        const corrected = await render(gray);
        const corner = { x: 15, y: 15, width: 35, height: 35 },
          center = { x: width / 2 - 10, y: height / 2 - 10, width: 20, height: 20 };
        const cornerDrop = mean(flat, corner) - mean(corrected, corner),
          centerError = Math.abs(mean(flat, center) - mean(corrected, center));
        assert.ok(cornerDrop > 0.008, `${coefficient} must change the corners`);
        assert.ok(centerError < 0.005, `${coefficient} must leave the optical center effectively unchanged`);
        await mutate(gray, { lensVignetteEnabled: false });
        identical(flat, await render(gray), 'Disabled profile vignette');
        await mutate(gray, { lensVignetteEnabled: true, lensVignetteAmount: 0 });
        identical(flat, await render(gray), 'Zero profile vignette amount');
        return { corner_luminance_drop: cornerDrop, center_luminance_error: centerError };
      },
    );

  await check(
    'zero_lens_controls_and_neutral_profiles_preserve_other_geometry',
    [
      'adjustment:lensDistortionAmount',
      'adjustment:lensTcaAmount',
      'adjustment:lensVignetteAmount',
      'adjustment:lensDistortionEnabled=false',
    ],
    async () => {
      const neutral = { model: 0, k1: 0, k2: 0, k3: 0, tca_vr: 1, tca_vb: 1, vig_k1: 0, vig_k2: 0, vig_k3: 0 };
      const controls = [
        ['lensDistortionAmount', 'lensDistortionEnabled', { k1: 0.17, k2: 0.03 }],
        ['lensTcaAmount', 'lensTcaEnabled', { tca_vr: 1.045, tca_vb: 0.97 }],
        ['lensVignetteAmount', 'lensVignetteEnabled', { vig_k1: 0.4, vig_k2: 0.1 }],
      ];
      for (const [amount, enabled, coefficients] of controls) {
        await reset(stripes);
        await mutate(stripes, {
          lensDistortionParams: { ...neutral, ...coefficients },
          [amount]: 100,
          [enabled]: true,
        });
        changed(aligned, await render(stripes), `${amount} positive control`);
        await mutate(stripes, { [amount]: 0 });
        identical(aligned, await render(stripes), `${amount} zero must preserve every border pixel`);
        await mutate(stripes, { transformRotate: 3.75, transformHorizontal: 12 });
        const withGeometry = await render(stripes);
        changed(aligned, withGeometry, 'Other geometry positive control');
        await mutate(stripes, { [amount]: 100, [enabled]: false });
        identical(withGeometry, await render(stripes), `${amount} zero and disabled must match during other geometry`);
        await mutate(stripes, {
          lensDistortionParams: neutral,
          [enabled]: true,
          lensDistortionAmount: 37,
          lensTcaAmount: 37,
          lensVignetteAmount: 37,
        });
        identical(
          withGeometry,
          await render(stripes),
          'Neutral coefficients at non-default strengths must preserve the other geometry',
        );
      }
      return {
        controls: controls.map(([amount]) => amount),
        exact_borders: true,
        zero_disabled_and_neutral_match_with_other_geometry: true,
      };
    },
  );

  await check(
    'batch_forwards_delivery_options_and_reports_collisions_per_item',
    [
      'tool:batch_export',
      'parameter:batch_export.options.bit_depth=16',
      'parameter:batch_export.options.color_profile="none"',
      'parameter:batch_export.options.resize.dont_enlarge=false',
      'parameter:batch_export.options.watermark.anchor="center"',
      'parameter:batch_export.options.keep_metadata=false',
      'parameter:batch_export.options.overwrite=false',
      'parameter:batch_export.options.overwrite=true',
    ],
    async () => {
      await reset(sid);
      const exports = join(workspace, 'exports');
      const options = {
        format: 'png',
        bit_depth: 16,
        color_profile: 'none',
        resize: { mode: 'width', value: 640, dont_enlarge: false },
        keep_metadata: false,
        strip_gps: true,
        preserve_timestamps: false,
        export_masks: false,
        overwrite: false,
        watermark: { path: paths.watermark, anchor: 'center', opacity: 55, scale: 15, spacing: 0 },
      };
      const singlePath = join(exports, 'single-reference.png');
      await h.call('export', { session_id: sid, path: singlePath, ...options });
      const unmarkedPath = join(exports, 'single-unmarked.png');
      const { watermark: _watermark, ...unmarkedOptions } = options;
      await h.call('export', { session_id: sid, path: unmarkedPath, ...unmarkedOptions });
      const guardedPath = join(exports, 'single-dont-enlarge.png');
      await h.call('export', {
        session_id: sid,
        path: guardedPath,
        ...unmarkedOptions,
        resize: { ...options.resize, dont_enlarge: true },
      });
      const guarded = decodePng(await readFile(guardedPath));
      assert.deepEqual(
        [guarded.width, guarded.height],
        [width, height],
        'dont_enlarge=true must retain source dimensions',
      );
      const batchPath = join(exports, 'batch-first.png');
      const freshPath = join(exports, 'batch-partial-success.png');
      const complete = (await h.call('batch_export', { items: [{ session_id: sid, path: batchPath }], options })).data;
      assert.equal(complete.succeeded, 1);
      assert.equal(complete.failed, 0);
      const single = decodePng(await readFile(singlePath)),
        batched = decodePng(await readFile(batchPath));
      assert.deepEqual([batched.width, batched.height, batched.bitDepth], [640, 480, 16]);
      identical(single, batched, 'Shared options must reach batch export unchanged');
      const unmarked = decodePng(await readFile(unmarkedPath));
      changed(unmarked, single, 'Watermark positive control must affect delivered pixels');
      assert.equal(
        pixelDifference(unmarked, single, { x: 0, y: 0, width: 100, height: 100 }).maximum,
        0,
        'Centered watermark must preserve the distant corner',
      );
      assert.ok(
        pixelDifference(unmarked, single, { x: 250, y: 180, width: 140, height: 120 }).mean_absolute > 0.001,
        'Centered watermark must alter its expected region',
      );
      assert.ok(
        !batched.chunks.some((chunk) => ['eXIf', 'iCCP'].includes(chunk.type)),
        'Explicit metadata/profile removal must survive batch forwarding',
      );
      const protectedHash = await hashFile(batchPath);
      const partial = (
        await h.call(
          'batch_export',
          {
            items: [
              { session_id: sid, path: batchPath },
              { session_id: sid, path: freshPath },
            ],
            options,
          },
          { expectError: true },
        )
      ).data;
      assert.equal(partial.failed, 1);
      assert.equal(partial.succeeded, 1);
      assert.equal(partial.results[0].ok, false);
      assert.equal(partial.results[1].ok, true);
      assert.equal(await hashFile(batchPath), protectedHash);
      identical(
        single,
        decodePng(await readFile(freshPath)),
        'Later successful item must be correct after an earlier collision',
      );
      await mutate(sid, { exposure: 0.5 });
      const overwritten = (
        await h.call('batch_export', {
          items: [{ session_id: sid, path: batchPath }],
          options: { ...options, overwrite: true },
        })
      ).data;
      assert.equal(overwritten.succeeded, 1);
      assert.notEqual(await hashFile(batchPath), protectedHash);
      changed(batched, decodePng(await readFile(batchPath)), 'Explicit overwrite must deliver current edited pixels');
      return {
        single_batch_pixels_identical: true,
        watermark_locality_verified: true,
        enlargement_guard_dimensions: [guarded.width, guarded.height],
        output_shape: [640, 480, 16],
        collision_preserved: true,
        partial_success_verified: true,
        explicit_overwrite_changed_pixels: true,
      };
    },
  );

  await check(
    'stale_metadata_and_mask_mutations_preserve_state_and_pixels',
    [
      'parameter:set_metadata.expected_revision',
      'parameter:mask_create.expected_revision',
      'tool:set_metadata',
      'tool:mask_create',
    ],
    async () => {
      const before = await state(sid),
        pixels = await render(sid);
      assert.ok(before.revision > 0);
      const staleMetadata = await h.call(
        'set_metadata',
        { session_id: sid, expected_revision: before.revision - 1, rating: 5 },
        { expectError: true },
      );
      assert.match(JSON.stringify(staleMetadata.data), /REVISION_CONFLICT/);
      const staleMask = await h.call(
        'mask_create',
        {
          session_id: sid,
          expected_revision: before.revision - 1,
          type: 'all',
          parameters: {},
          adjustments: { exposure: 2 },
        },
        { expectError: true },
      );
      assert.match(JSON.stringify(staleMask.data), /REVISION_CONFLICT/);
      const after = await state(sid);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.adjustments, before.adjustments);
      assert.deepEqual(after.metadata, before.metadata);
      identical(pixels, await render(sid), 'Rejected mutations must preserve pixels');
      return { revision_preserved: true, metadata_adjustments_preserved: true, pixel_identity: true };
    },
  );
} catch (error) {
  failure = error;
} finally {
  await h.close(failure);
}
if (failure) throw failure;
