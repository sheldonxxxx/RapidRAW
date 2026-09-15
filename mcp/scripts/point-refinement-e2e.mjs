/** Actual MCP point-refinement contracts; photographic selection quality has a separate review suite.
 * RAPIDRAW_BINARY=/absolute/RapidRAW RAPIDRAW_TEST_IMAGE=/absolute/photo \
 * RAPIDRAW_WORKSPACE=/absolute/new-run node scripts/point-refinement-e2e.mjs
 * Optional RAPIDRAW_TEST_POINT_PROMPTS: absolute path to a JSON file containing
 * {normalized_source:{include_points:[{x,y}],exclude_points:[{x,y}],region?:{x,y,width,height}}}.
 * Coordinates in that configuration are fractions of the natively exported fixture, not edited bitmaps or SAM logits.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashBytes, hashFile } from './coverage-evidence.mjs';
import { decodePng, pixelDifference } from './png-fixtures.mjs';

assert.ok(process.env.RAPIDRAW_TEST_IMAGE, 'Set RAPIDRAW_TEST_IMAGE to an inspected real photograph');
const source = resolve(process.env.RAPIDRAW_TEST_IMAGE);
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/point-refinement-${Date.now()}`);
const config = process.env.RAPIDRAW_TEST_POINT_PROMPTS
  ? JSON.parse(await readFile(resolve(process.env.RAPIDRAW_TEST_POINT_PROMPTS), 'utf8')).normalized_source
  : { include_points: [{ x: 0.5, y: 0.5 }], exclude_points: [{ x: 0.05, y: 0.05 }] };
assert.ok(
  config &&
    Array.isArray(config.include_points) &&
    config.include_points.length &&
    Array.isArray(config.exclude_points) &&
    config.exclude_points.length,
  'Provide positive subject and negative background points',
);
for (const p of [...config.include_points, ...config.exclude_points])
  assert.ok([p.x, p.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
const h = await createNativeHarness({ suite: 'point-refinement', workspace, timeout: 900000 });
let failure, fixture, sid, width, height, prompts, mainMask, mainSub;
const req = (...fields) => ['tool:mask_generate', ...fields.map((field) => `parameter:mask_generate.${field}`)];
const digest = (value) => hashBytes(JSON.stringify(value));
const state = async (id = sid) =>
  (await h.call('get_session', { session_id: id, include_adjustments: true, include_assets: true })).data;
const render = async (id = sid, options = {}) => h.call('render', { session_id: id, format: 'png', ...options });
const patch = async (id, adjustments) =>
  h.call('set_adjustments', { session_id: id, expected_revision: (await state(id)).revision, patch: adjustments });
const maskIn = (s, id) => {
  const mask = s.adjustments.masks.find((m) => m.id === id);
  assert.ok(mask, 'Mask must remain in its owning session');
  return mask;
};
const subIn = (s, maskId, subId) => {
  const sub = maskIn(s, maskId).subMasks.find((m) => m.id === subId);
  assert.ok(sub, 'Submask identity must survive');
  return sub;
};
const image = (response, index = 0) => decodePng(Buffer.from(response.images[index].data, 'base64'));
function samePixels(a, b, message) {
  assert.equal(pixelDifference(image(a), image(b)).maximum, 0, message);
}
function stableMask(mask, subjectId) {
  return {
    ...mask,
    subMasks: mask.subMasks.map((sub) => {
      if (sub.id !== subjectId) return sub;
      const { parameters, ...properties } = sub;
      return properties;
    }),
  };
}
async function artifact(response, name) {
  const path = join(workspace, 'artifacts', `${name}.png`);
  await mkdir(join(workspace, 'artifacts'), { recursive: true });
  await writeFile(path, Buffer.from(response.images[0].data, 'base64'), { flag: 'wx' });
  return { path, sha256: await hashFile(path) };
}
async function generatedState(result, id, expectedPrompts, expectedMode, expectedPrior) {
  const info = result.data.refinement;
  assert.equal(info.mode, expectedMode);
  assert.equal(info.prior_mode, expectedPrior);
  assert.equal(info.coordinate_space, 'mask');
  assert.equal(info.caller_prompts_preserved, true);
  assert.equal(info.iterations, 2);
  assert.deepEqual(info.include_points, expectedPrompts.include_points ?? []);
  assert.deepEqual(info.exclude_points, expectedPrompts.exclude_points ?? []);
  assert.deepEqual(info.region, expectedPrompts.region ?? null);
  assert.equal(info.generated_submask_statistics.empty, false);
  const s = await state(id),
    sub = subIn(s, result.data.mask_id, result.data.sub_mask_id),
    saved = sub.parameters.samRefinement;
  assert.equal(sub.type, 'ai-subject');
  assert.equal(saved.version, 1);
  assert.equal(saved.encoding, 'f32-le-base64');
  assert.equal(saved.sourceSha256, s.source_sha256);
  assert.equal(saved.sourceSha256, info.source_sha256);
  assert.equal(saved.geometrySha256, info.geometry_sha256);
  assert.match(saved.geometrySha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.maskSha256, hashBytes(sub.parameters.maskDataBase64));
  assert.equal(Buffer.from(saved.logitsBase64, 'base64').length, 256 * 256 * 4, 'Store actual full SAM mask logits');
  assert.deepEqual([saved.canvasWidth, saved.canvasHeight], info.canvas_dimensions);
  assert.deepEqual(saved.includePoints, info.include_points);
  assert.deepEqual(saved.excludePoints, info.exclude_points);
  assert.deepEqual(saved.region, info.region);
  const bitmap = decodePng(Buffer.from(sub.parameters.maskDataBase64.split(',').at(-1), 'base64'));
  assert.deepEqual([bitmap.width, bitmap.height], info.canvas_dimensions);
  assert.ok(bitmap.pixels.some((v) => v > 0));
  return { s, sub, saved, info };
}
async function rejectWithoutMutation(name, args, code, id = sid, method = 'mask_generate') {
  await h.check(
    name,
    [method === 'mask_generate' ? 'tool:mask_generate' : `tool:${method}`],
    async () => {
      const before = await state(id),
        historyBefore = (await h.call('history', { session_id: id })).data;
      const pixelsBefore = await render(id);
      const jobsBefore =
        method === 'start_operation'
          ? (await h.call('list_operation_jobs')).data.jobs.map((job) => job.job_id).sort()
          : null;
      const rejected = await h.call(method, args, { expectError: true });
      assert.match(JSON.stringify(rejected.data ?? rejected.result.content), code);
      const after = await state(id);
      assert.equal(after.revision, before.revision);
      assert.equal(digest(after.adjustments), digest(before.adjustments));
      assert.equal(digest(after.metadata), digest(before.metadata));
      assert.equal(digest((await h.call('history', { session_id: id })).data), digest(historyBefore));
      samePixels(await render(id), pixelsBefore, 'Rejected request must leave rendered pixels unchanged');
      if (jobsBefore)
        assert.deepEqual(
          (await h.call('list_operation_jobs')).data.jobs.map((job) => job.job_id).sort(),
          jobsBefore,
          'Rejected capture must not leave a durable worker job',
        );
      return { error: code.source, unchanged_revision: after.revision, state_history_and_pixels_unchanged: true };
    },
    'pixel_assertion',
  );
}
async function waitJob(id) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const job = (await h.call('get_operation_job', { job_id: id })).data;
    if (job.status !== 'running') {
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      return job;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.fail('Point-refinement worker exceeded 10 minutes');
}
try {
  await h.fixture(source, 'real photographic source; original and sidecar must remain unchanged');
  await h.check(
    'fixture_is_exported_by_native_mcp',
    ['tool:open_photo', 'tool:export'],
    async () => {
      const opened = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data;
      const output = (
        await h.call('export', {
          session_id: opened.session_id,
          path: 'point-refinement-fixture.png',
          format: 'png',
          bit_depth: 8,
          color_profile: 'none',
          long_edge: 512,
          keep_metadata: false,
        })
      ).data;
      fixture = output.path;
      const decoded = decodePng(await readFile(fixture));
      width = decoded.width;
      height = decoded.height;
      assert.ok(Math.max(width, height) <= 512 && Math.min(width, height) >= 64);
      assert.equal(decoded.bitDepth, 8);
      await h.fixture(
        fixture,
        '512px fixture generated exclusively by a native MCP export of the preserved real photo',
        { parent_source_sha256: await hashFile(source) },
      );
      sid = (await h.call('open_photo', { path: fixture, inherit_sidecar: false })).data.session_id;
      assert.equal(pixelDifference(decoded, image(await render())).maximum, 0);
      const toPoint = (p) => ({ x: Math.round(p.x * (width - 1)), y: Math.round(p.y * (height - 1)) });
      prompts = {
        include_points: config.include_points.map(toPoint),
        exclude_points: config.exclude_points.map(toPoint),
      };
      if (config.region) {
        const r = config.region;
        assert.ok(
          [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
            r.x >= 0 &&
            r.y >= 0 &&
            r.width > 0 &&
            r.height > 0 &&
            r.x + r.width <= 1 &&
            r.y + r.height <= 1,
        );
        prompts.region = {
          x: Math.floor(r.x * width),
          y: Math.floor(r.y * height),
          width: Math.max(1, Math.floor(r.width * width)),
          height: Math.max(1, Math.floor(r.height * height)),
        };
      }
      await writeFile(
        join(workspace, 'fixture-prompts.json'),
        JSON.stringify(
          {
            source,
            fixture,
            width,
            height,
            normalized_source: config,
            mask_canvas_prompts: prompts,
            photographic_quality: 'not assessed by this contract suite',
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      return {
        width,
        height,
        native_export_sha256: await hashFile(fixture),
        source_sha256: await hashFile(source),
        hand_created_bitmap: false,
      };
    },
    'pixel_assertion',
  );
  if (!(await h.call('models')).data.groups.masks.ready) await h.call('install_model', { kind: 'masks' });
  assert.equal(
    (await h.call('models')).data.groups.masks.ready,
    true,
    'Native SAM models must be ready; this acceptance suite never silently skips AI inference',
  );

  await rejectWithoutMutation(
    'new_exclude_only_without_prior_rejected',
    { session_id: sid, kind: 'subject', exclude_points: prompts.exclude_points },
    /INVALID_ARGUMENT/,
  );
  await rejectWithoutMutation(
    'empty_new_prompts_without_region_rejected',
    { session_id: sid, kind: 'subject', include_points: [], exclude_points: [] },
    /INVALID_ARGUMENT/,
  );
  await h.check(
    'new_positive_negative_points_create_native_sam_state',
    req('include_points', 'exclude_points', 'kind="subject"'),
    async () => {
      const before = await state();
      const result = await h.call('mask_generate', {
        session_id: sid,
        expected_revision: before.revision,
        kind: 'subject',
        name: 'Point-guided subject',
        ...prompts,
        parameters: { grow: 0, feather: 0 },
        adjustments: { exposure: 0.25, temperature: 5 },
      });
      mainMask = result.data.mask_id;
      mainSub = result.data.sub_mask_id;
      const checked = await generatedState(result, sid, prompts, 'new_mask', 'none');
      assert.equal(checked.s.revision, before.revision + 1);
      await artifact(await render(sid, { mask_id: mainMask }), 'initial-point-selection');
      return {
        mask_id: mainMask,
        sub_mask_id: mainSub,
        canvas: checked.info.canvas_dimensions,
        state_digest: digest(checked.saved),
        photographic_quality: 'separate review required',
      };
    },
  );

  await h.call('mask_create', {
    session_id: sid,
    expected_revision: (await state()).revision,
    type: 'radial',
    name: 'Independent mask',
    parameters: {
      centerX: width / 2,
      centerY: height / 2,
      radiusX: width / 4,
      radiusY: height / 4,
      rotation: 0,
      feather: 0.5,
    },
    adjustments: { saturation: 8 },
  });
  await h.call('mask_update', {
    session_id: sid,
    mask_id: mainMask,
    expected_revision: (await state()).revision,
    patch: { opacity: 73, name: 'Retained local grade' },
    submask_operations: [
      {
        operation: 'add',
        submask: {
          type: 'linear',
          visible: true,
          invert: false,
          opacity: 21,
          mode: 'subtractive',
          parameters: { startX: 0, startY: height * 0.75, endX: 0, endY: height - 1 },
        },
      },
    ],
  });
  await h.check(
    'refine_preserves_ids_siblings_grade_and_other_masks',
    [...req('refine', 'refine.mask_id', 'refine.sub_mask_id', 'expected_revision'), 'tool:undo', 'tool:redo'],
    async () => {
      const before = await state(),
        beforePhoto = await render(),
        beforeMask = await render(sid, { mask_id: mainMask });
      const onlyNegative = { exclude_points: prompts.exclude_points };
      const refined = await h.call('mask_generate', {
        session_id: sid,
        expected_revision: before.revision,
        kind: 'subject',
        refine: { mask_id: mainMask, sub_mask_id: mainSub },
        ...onlyNegative,
      });
      const after = await generatedState(refined, sid, onlyNegative, 'replace_submask', 'native_logits');
      assert.equal(refined.data.mask_id, mainMask);
      assert.equal(refined.data.sub_mask_id, mainSub);
      assert.equal(after.s.revision, before.revision + 1);
      assert.equal(
        digest(stableMask(maskIn(after.s, mainMask), mainSub)),
        digest(stableMask(maskIn(before, mainMask), mainSub)),
      );
      assert.equal(
        digest(after.s.adjustments.masks.filter((m) => m.id !== mainMask)),
        digest(before.adjustments.masks.filter((m) => m.id !== mainMask)),
      );
      assert.equal(after.sub.parameters.grow, 0);
      assert.equal(after.sub.parameters.feather, 0);
      const afterPhoto = await render(),
        afterMask = await render(sid, { mask_id: mainMask });
      await h.call('undo', { session_id: sid, expected_revision: after.s.revision });
      assert.equal(digest((await state()).adjustments), digest(before.adjustments));
      samePixels(await render(), beforePhoto);
      samePixels(await render(sid, { mask_id: mainMask }), beforeMask);
      await h.call('redo', { session_id: sid, expected_revision: (await state()).revision });
      assert.equal(digest((await state()).adjustments), digest(after.s.adjustments));
      samePixels(await render(), afterPhoto);
      samePixels(await render(sid, { mask_id: mainMask }), afterMask);
      await artifact(afterMask, 'refined-point-selection');
      return {
        unchanged_mask_and_submask_ids: true,
        siblings_grade_other_masks_preserved: true,
        undo_redo_state_and_pixels_exact: true,
        sam_state_digest: digest(after.saved),
      };
    },
    'pixel_assertion',
  );

  const current = await state(),
    sibling = maskIn(current, mainMask).subMasks.find((m) => m.id !== mainSub);
  const base = {
    session_id: sid,
    kind: 'subject',
    refine: { mask_id: mainMask, sub_mask_id: mainSub },
    exclude_points: prompts.exclude_points,
  };
  for (const [name, args, code] of [
    ['refine_requires_expected_revision', base, /INVALID_ARGUMENT/],
    ['stale_revision_rejected', { ...base, expected_revision: current.revision - 1 }, /REVISION_CONFLICT/],
    [
      'conflicting_positive_negative_points_rejected',
      { ...base, expected_revision: current.revision, include_points: prompts.exclude_points },
      /INVALID_ARGUMENT/,
    ],
    [
      'point_outside_full_canvas_rejected',
      { ...base, expected_revision: current.revision, include_points: [{ x: width, y: height - 1 }] },
      /INVALID_ARGUMENT/,
    ],
    [
      'point_outside_canvas_height_rejected',
      { ...base, expected_revision: current.revision, include_points: [{ x: width - 1, y: height }] },
      /INVALID_ARGUMENT/,
    ],
    [
      'wrong_mask_target_rejected',
      { ...base, expected_revision: current.revision, refine: { mask_id: 'missing-mask' } },
      /MASK_NOT_FOUND/,
    ],
    [
      'wrong_submask_target_rejected',
      { ...base, expected_revision: current.revision, refine: { mask_id: mainMask, sub_mask_id: 'missing-submask' } },
      /SUBMASK_NOT_FOUND/,
    ],
    [
      'geometric_submask_refinement_rejected',
      { ...base, expected_revision: current.revision, refine: { mask_id: mainMask, sub_mask_id: sibling.id } },
      /INVALID_ARGUMENT/,
    ],
    [
      'non_subject_kind_rejected',
      { ...base, expected_revision: current.revision, kind: 'foreground' },
      /INVALID_ARGUMENT/,
    ],
    [
      'combined_point_limit_rejected',
      {
        ...base,
        expected_revision: current.revision,
        include_points: Array.from({ length: 33 }, (_, x) => ({ x, y: 1 })),
        exclude_points: Array.from({ length: 32 }, (_, x) => ({ x, y: 2 })),
      },
      /INVALID_ARGUMENT/,
    ],
  ])
    await rejectWithoutMutation(name, args, code);

  const ambiguous = (
    await h.call('fork_session', {
      session_id: sid,
      expected_revision: (await state()).revision,
      label: 'Ambiguous refinement target',
    })
  ).data;
  await h.call('mask_update', {
    session_id: ambiguous.session_id,
    mask_id: mainMask,
    expected_revision: ambiguous.revision,
    submask_operations: [{ operation: 'duplicate', submask_id: mainSub }],
  });
  await rejectWithoutMutation(
    'multiple_subject_submasks_require_explicit_target',
    {
      session_id: ambiguous.session_id,
      expected_revision: (await state(ambiguous.session_id)).revision,
      kind: 'subject',
      refine: { mask_id: mainMask },
      exclude_points: prompts.exclude_points,
    },
    /INVALID_ARGUMENT/,
    ambiguous.session_id,
  );

  const movedTarget = (
    await h.call('fork_session', {
      session_id: sid,
      expected_revision: (await state()).revision,
      label: 'Changed native submask placement',
    })
  ).data;
  await h.call('mask_update', {
    session_id: movedTarget.session_id,
    mask_id: mainMask,
    expected_revision: movedTarget.revision,
    submask_operations: [{ operation: 'edit', submask_id: mainSub, patch: { parameters: { flipHorizontal: true } } }],
  });
  assert.equal(
    subIn(await state(movedTarget.session_id), mainMask, mainSub).parameters.flipHorizontal,
    true,
    'The actual native mask edit must precede stale-prior rejection',
  );
  await rejectWithoutMutation(
    'edited_native_submask_placement_rejects_stale_logits',
    {
      session_id: movedTarget.session_id,
      expected_revision: (await state(movedTarget.session_id)).revision,
      kind: 'subject',
      refine: { mask_id: mainMask, sub_mask_id: mainSub },
      exclude_points: prompts.exclude_points,
    },
    /STALE_REFINEMENT/,
    movedTarget.session_id,
  );

  await h.check(
    'point_state_and_pixels_survive_restart_and_moved_bundle',
    [...req('refine'), 'tool:save_session', 'tool:export_session_bundle', 'tool:import_session_bundle'],
    async () => {
      const before = await state(),
        photo = await render(),
        mask = await render(sid, { mask_id: mainMask });
      await h.call('save_session', { session_id: sid });
      await h.reconnect();
      assert.equal(digest((await state()).adjustments), digest(before.adjustments));
      samePixels(await render(), photo);
      samePixels(await render(sid, { mask_id: mainMask }), mask);
      const bundle = (
        await h.call('export_session_bundle', {
          session_id: sid,
          expected_revision: (await state()).revision,
          name: 'point-refinement-state',
        })
      ).data;
      const moved = join(workspace, 'transport', 'refined-bundle');
      await cp(bundle.path, moved, { recursive: true });
      const imported = (
        await h.call('import_session_bundle', { path: moved, expected_manifest_sha256: bundle.manifest_sha256 })
      ).data;
      assert.notEqual(imported.session_id, sid);
      await rm(moved, { recursive: true });
      const restored = await state(imported.session_id);
      assert.equal(digest(restored.adjustments), digest(before.adjustments));
      samePixels(await render(imported.session_id), photo);
      samePixels(await render(imported.session_id, { mask_id: mainMask }), mask);
      const updated = await h.call('mask_generate', {
        session_id: imported.session_id,
        expected_revision: restored.revision,
        kind: 'subject',
        refine: { mask_id: mainMask },
        ...prompts,
      });
      await generatedState(updated, imported.session_id, prompts, 'replace_submask', 'native_logits');
      assert.equal(digest((await state()).adjustments), digest(before.adjustments));
      samePixels(await render(), photo);
      return {
        imported_session_id: imported.session_id,
        restart_and_bundle_state_and_pixels_exact: true,
        imported_native_prior_remains_refinable: true,
        source_session_unchanged: true,
      };
    },
    'pixel_assertion',
  );

  await h.check(
    'legacy_refinement_preserves_morphology_grade_and_hidden_zero_opacity_target',
    req('refine', 'exclude_points'),
    async () => {
      const id = (await h.call('open_photo', { path: fixture, inherit_sidecar: false })).data.session_id;
      const legacy = (
        await h.call('mask_generate', {
          session_id: id,
          kind: 'subject',
          region: prompts.region ?? { x: 0, y: 0, width, height },
          adjustments: { exposure: 0.4 },
        })
      ).data;
      assert.equal(
        subIn(await state(id), legacy.mask_id, legacy.sub_mask_id).parameters.samRefinement,
        undefined,
        'Legacy region-only generation establishes an actual prior, not edited state',
      );
      await h.call('mask_update', {
        session_id: id,
        mask_id: legacy.mask_id,
        expected_revision: (await state(id)).revision,
        patch: { visible: false, opacity: 0 },
        submask_operations: [
          {
            operation: 'edit',
            submask_id: legacy.sub_mask_id,
            patch: { visible: false, opacity: 0, parameters: { grow: 8, feather: 4 } },
          },
        ],
      });
      const before = await state(id),
        beforePhoto = await render(id);
      const refined = await h.call('mask_generate', {
        session_id: id,
        kind: 'subject',
        expected_revision: before.revision,
        refine: { mask_id: legacy.mask_id },
        exclude_points: prompts.exclude_points,
      });
      const after = await generatedState(
        refined,
        id,
        { exclude_points: prompts.exclude_points },
        'replace_submask',
        'coverage_logit_seed',
      );
      assert.match(after.info.prior_conversion, /Approximate legacy selection/);
      assert.equal(refined.data.mask_statistics.empty, true);
      assert.equal(after.sub.parameters.grow, 8);
      assert.equal(after.sub.parameters.feather, 4); // Seed normalization is verified separately by the native CPU regression.
      assert.equal(
        digest(stableMask(maskIn(after.s, legacy.mask_id), legacy.sub_mask_id)),
        digest(stableMask(maskIn(before, legacy.mask_id), legacy.sub_mask_id)),
      );
      samePixels(await render(id), beforePhoto, 'Hidden zero-opacity refinement cannot alter the visible photo');
      const nativeAgain = await h.call('mask_generate', {
        session_id: id,
        kind: 'subject',
        expected_revision: after.s.revision,
        refine: { mask_id: legacy.mask_id },
        ...prompts,
      });
      const nativeChecked = await generatedState(nativeAgain, id, prompts, 'replace_submask', 'native_logits');
      assert.equal(nativeAgain.data.mask_statistics.empty, true);
      assert.equal(nativeChecked.sub.parameters.grow, 8);
      assert.equal(nativeChecked.sub.parameters.feather, 4);
      assert.equal(
        digest(stableMask(maskIn(nativeChecked.s, legacy.mask_id), legacy.sub_mask_id)),
        digest(stableMask(maskIn(before, legacy.mask_id), legacy.sub_mask_id)),
      );
      samePixels(await render(id), beforePhoto);
      return {
        hidden_parent_and_child_preserved: true,
        opacity_zero_preserved: true,
        generated_selection_nonempty: true,
        combined_mask_empty: true,
        preserved_grow: 8,
        preserved_feather: 4,
        prior_modes_verified: [after.info.prior_mode, nativeChecked.info.prior_mode],
      };
    },
    'pixel_assertion',
  );

  await h.check(
    'transformed_canvas_points_crop_and_grade_keep_native_prior',
    [...req('include_points', 'exclude_points', 'refine'), 'tool:map_coordinates'],
    async () => {
      const id = (await h.call('open_photo', { path: fixture, inherit_sidecar: false })).data.session_id;
      const originalPhoto = await render(id);
      await patch(id, { orientationSteps: 1, flipHorizontal: true });
      const coordinates = (
        await h.call('map_coordinates', {
          session_id: id,
          from: 'oriented_source',
          to: 'mask',
          points: [...prompts.include_points, ...prompts.exclude_points],
        })
      ).data;
      assert.deepEqual(coordinates.mask_dimensions, [height, width]);
      assert.ok(coordinates.points.every((p) => p.mapped));
      const points = coordinates.points.map(({ x, y }) => ({ x, y }));
      const transformed = {
        include_points: points.slice(0, prompts.include_points.length),
        exclude_points: points.slice(prompts.include_points.length),
      };
      const photo = image(await render(id)),
        original = image(originalPhoto);
      for (const [index, p] of [...prompts.include_points, ...prompts.exclude_points].entries()) {
        const q = points[index];
        assert.ok(Math.abs(q.x - Math.round(q.x)) < 1e-8 && Math.abs(q.y - Math.round(q.y)) < 1e-8);
        for (let c = 0; c < 3; c++)
          assert.equal(
            photo.pixels[(Math.round(q.y) * photo.width + Math.round(q.x)) * 3 + c],
            original.pixels[(p.y * original.width + p.x) * 3 + c],
            'Mapped coarse-rotation/flip prompt must target the actual same photograph pixel',
          );
      }
      const generated = await h.call('mask_generate', {
        session_id: id,
        expected_revision: (await state(id)).revision,
        kind: 'subject',
        ...transformed,
      });
      const before = await generatedState(generated, id, transformed, 'new_mask', 'none');
      const crop = { unit: 'px', x: 1, y: 1, width: height - 2, height: width - 2 };
      await patch(id, { crop, exposure: 0.15 });
      const croppedMapping = (
        await h.call('map_coordinates', {
          session_id: id,
          from: 'mask',
          to: 'rendered',
          points: transformed.include_points,
        })
      ).data;
      croppedMapping.points.forEach((p, i) => {
        assert.equal(p.mapped, true);
        assert.ok(Math.abs(p.x - transformed.include_points[i].x + crop.x) < 1e-8);
        assert.ok(Math.abs(p.y - transformed.include_points[i].y + crop.y) < 1e-8);
      });
      const refined = await h.call('mask_generate', {
        session_id: id,
        expected_revision: (await state(id)).revision,
        kind: 'subject',
        refine: { mask_id: generated.data.mask_id },
        ...transformed,
      });
      const after = await generatedState(refined, id, transformed, 'replace_submask', 'native_logits');
      assert.equal(after.saved.geometrySha256, before.saved.geometrySha256);
      assert.deepEqual([after.saved.canvasWidth, after.saved.canvasHeight], [height, width]);
      const cropped = image(await render(id));
      assert.deepEqual([cropped.width, cropped.height], [crop.width, crop.height]);
      await patch(id, { flipHorizontal: false });
      await rejectWithoutMutation(
        'changed_full_canvas_geometry_rejects_prior',
        {
          session_id: id,
          expected_revision: (await state(id)).revision,
          kind: 'subject',
          refine: { mask_id: generated.data.mask_id },
          ...transformed,
        },
        /STALE_REFINEMENT/,
        id,
      );
      return {
        mapped_pixels_exact: true,
        crop_does_not_change_mask_canvas: true,
        color_edit_keeps_prior: true,
        changed_flip_rejected: true,
      };
    },
    'pixel_assertion',
  );

  const workerBefore = await state();
  await rejectWithoutMutation(
    'worker_refinement_requires_revision_before_capture',
    {
      operation: 'mask_generate',
      arguments: {
        session_id: sid,
        kind: 'subject',
        refine: { mask_id: mainMask },
        exclude_points: prompts.exclude_points,
      },
    },
    /INVALID_ARGUMENT/,
    sid,
    'start_operation',
  );
  await rejectWithoutMutation(
    'worker_stale_revision_rejected_before_capture',
    {
      operation: 'mask_generate',
      arguments: {
        session_id: sid,
        expected_revision: workerBefore.revision - 1,
        kind: 'subject',
        refine: { mask_id: mainMask },
        exclude_points: prompts.exclude_points,
      },
    },
    /REVISION_CONFLICT/,
    sid,
    'start_operation',
  );
  await h.check(
    'worker_refines_captured_snapshot_after_parent_geometry_and_grade_edits',
    [
      'tool:start_operation',
      'tool:get_operation_job',
      'parameter:start_operation.operation="mask_generate"',
      ...req('refine'),
    ],
    async () => {
      const captured = await state(),
        capturedMask = maskIn(captured, mainMask),
        capturedOther = captured.adjustments.masks.filter((m) => m.id !== mainMask);
      assert.equal(captured.revision, workerBefore.revision);
      const started = (
        await h.call('start_operation', {
          operation: 'mask_generate',
          arguments: {
            session_id: sid,
            expected_revision: captured.revision,
            kind: 'subject',
            refine: { mask_id: mainMask, sub_mask_id: mainSub },
            ...prompts,
          },
        })
      ).data;
      await patch(sid, { exposure: 0.9, flipHorizontal: true });
      const parentEdited = await state(),
        parentPhoto = await render();
      const done = await waitJob(started.job_id);
      assert.notEqual(done.result.session_id, sid);
      assert.notEqual(done.result.worker_session_id, sid);
      const result = { data: done.result };
      const checked = await generatedState(result, done.result.session_id, prompts, 'replace_submask', 'native_logits');
      assert.equal(checked.s.adjustments.exposure, captured.adjustments.exposure);
      assert.equal(checked.s.adjustments.flipHorizontal, captured.adjustments.flipHorizontal);
      assert.equal(digest(stableMask(maskIn(checked.s, mainMask), mainSub)), digest(stableMask(capturedMask, mainSub)));
      assert.equal(digest(checked.s.adjustments.masks.filter((m) => m.id !== mainMask)), digest(capturedOther));
      assert.equal(
        checked.saved.geometrySha256,
        subIn(captured, mainMask, mainSub).parameters.samRefinement.geometrySha256,
      );
      assert.equal(digest((await state()).adjustments), digest(parentEdited.adjustments));
      assert.equal((await state()).revision, parentEdited.revision);
      samePixels(await render(), parentPhoto);
      const workerPhoto = await render(done.result.session_id),
        workerMask = await render(done.result.session_id, { mask_id: mainMask });
      await artifact(workerMask, 'worker-point-selection');
      await h.reconnect();
      assert.equal(digest((await state(done.result.session_id)).adjustments), digest(checked.s.adjustments));
      samePixels(await render(done.result.session_id), workerPhoto);
      samePixels(await render(done.result.session_id, { mask_id: mainMask }), workerMask);
      samePixels(await render(), parentPhoto);
      const persisted = (await h.call('get_operation_job', { job_id: started.job_id })).data;
      assert.equal(persisted.status, 'succeeded');
      assert.equal(digest(persisted.result), digest(done.result));
      return {
        job_id: started.job_id,
        imported_session_id: done.result.session_id,
        snapshot_geometry_and_grade_retained: true,
        parent_remains_edited: true,
        refined_state_and_pixels_persisted: true,
      };
    },
    'pixel_assertion',
  );
} catch (error) {
  failure = error;
} finally {
  await h.close(failure);
}
if (failure) throw failure;
