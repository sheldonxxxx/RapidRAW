/** Real native MCP regression for portable sessions and workspace-owned assets. */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { fixturePng, decodePng, pixelDifference } from './png-fixtures.mjs';

const root = resolve(
  process.env.RAPIDRAW_TEST_WORKSPACE ?? process.env.RAPIDRAW_WORKSPACE ?? `test-output/portable-live/${Date.now()}`,
);
await mkdir(join(root, 'fixtures'), { recursive: true });
const fixture = join(root, 'fixtures', 'colour-texture.png');
await writeFile(fixture, fixturePng(192, 128));
const lutSource = join(root, 'fixtures', 'identity.cube');
await writeFile(lutSource, 'TITLE "Identity"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const requirements = (method, ...fields) => [
  `tool:${method}`,
  ...fields.map((field) => `parameter:${method}.${field}`),
];
const imageOf = (result) => {
  assert.equal(result.images.length, 1, 'Expected exactly one native PNG preview');
  return decodePng(Buffer.from(result.images[0].data, 'base64'));
};
const render = async (h, id) => imageOf(await h.call('render', { session_id: id, format: 'png', long_edge: 192 }));
const session = async (h, id) => (await h.call('get_session', { session_id: id, include_adjustments: true })).data;
let first,
  second,
  failure,
  accepted,
  source,
  reference,
  bundle,
  presetExport,
  lutExport,
  portableImage,
  rawBundle,
  rawImage;
try {
  first = await createNativeHarness({ suite: 'portable-source', workspace: join(root, 'source-workspace') });
  await first.fixture(fixture, 'synthetic-colour-texture');
  source = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
  await first.call('set_adjustments', {
    session_id: source.session_id,
    expected_revision: source.revision,
    patch: { exposure: 0.35, temperature: -6 },
  });
  await first.call('mask_create', {
    session_id: source.session_id,
    type: 'radial',
    name: 'Warm centre',
    parameters: { centerX: 96, centerY: 64, radiusX: 40, radiusY: 32, rotation: 0, feather: 0.6 },
    adjustments: { exposure: 0.3 },
  });
  let ownedLut, ownedPreset;
  await first.check(
    'workspace_lut_import_list_export_and_apply',
    requirements('manage_luts', 'action="import"', 'action="list"', 'action="export"'),
    async () => {
      ownedLut = (await first.call('manage_luts', { action: 'import', path: lutSource, name: 'Portable identity' }))
        .data;
      assert.ok(ownedLut.id.startsWith('workspace:'));
      assert.ok(ownedLut.path.startsWith(join(first.workspace, 'assets')));
      assert.equal(await hashFile(ownedLut.path), await hashFile(lutSource));
      assert.ok((await first.call('manage_luts', { action: 'list' })).data.luts.some((lut) => lut.id === ownedLut.id));
      assert.ok((await first.call('list_luts')).data.luts.some((lut) => lut.path === ownedLut.path));
      lutExport = (
        await first.call('manage_luts', { action: 'export', id: ownedLut.id, path: 'portable-identity.cube' })
      ).data;
      assert.equal(await hashFile(lutExport.path), ownedLut.sha256);
      await first.call('apply_lut', { session_id: source.session_id, path: ownedLut.path, intensity: 70 });
      return { id: ownedLut.id, digest: ownedLut.sha256 };
    },
  );
  accepted = await session(first, source.session_id);
  reference = (
    await first.call('save_version', {
      session_id: source.session_id,
      expected_revision: accepted.revision,
      label: 'Accepted portable edit',
    })
  ).data;
  portableImage = await render(first, source.session_id);
  await first.check(
    'named_fork_matches_pixels_then_edits_independently',
    requirements('fork_session', 'version_id', 'expected_revision', 'label'),
    async () => {
      await first.call('set_adjustments', {
        session_id: source.session_id,
        expected_revision: accepted.revision,
        patch: { exposure: -0.8 },
      });
      const fork = (
        await first.call('fork_session', {
          session_id: source.session_id,
          version_id: reference.version_id,
          label: 'Independent candidate',
        })
      ).data;
      assert.notEqual(fork.session_id, source.session_id);
      assert.equal(fork.revision, 0);
      assert.equal(fork.adjustments.exposure, accepted.adjustments.exposure);
      assert.equal(fork.is_raw, accepted.is_raw);
      assert.equal(await hashFile(fork.working_path), accepted.source_sha256);
      assert.equal(pixelDifference(await render(first, fork.session_id), portableImage).maximum, 0);
      await first.call('set_adjustments', {
        session_id: fork.session_id,
        expected_revision: 0,
        patch: { exposure: 1.2 },
      });
      assert.equal((await session(first, source.session_id)).adjustments.exposure, -0.8);
      const invalid = await first.call(
        'fork_session',
        { session_id: source.session_id, expected_revision: 0 },
        { expectError: true },
      );
      assert.match(JSON.stringify(invalid.result), /REVISION_CONFLICT/);
      return { candidate: fork.session_id, source_unchanged: true, max_pixel_difference: 0 };
    },
    'pixel_assertion',
  );
  await first.check(
    'version_diff_reports_controls_without_mutation',
    requirements('diff_versions', 'from_version_id'),
    async () => {
      const before = await session(first, source.session_id);
      const diff = (
        await first.call('diff_versions', { session_id: source.session_id, from_version_id: reference.version_id })
      ).data;
      assert.ok(
        diff.changes.some(
          (change) => change.path === '/adjustments/exposure' && change.before === 0.35 && change.after === -0.8,
        ),
      );
      assert.equal((await session(first, source.session_id)).revision, before.revision);
      return { changes: diff.changes, revision: before.revision };
    },
  );
  await first.call('restore_version', { session_id: source.session_id, version_id: reference.version_id });
  await first.check(
    'selective_copy_has_individual_revision_results_and_explicit_geometry',
    requirements('copy_adjustments', 'geometry="exclude"', 'targets', 'mode="replace_selected"'),
    async () => {
      const target = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      const stale = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      await first.call('set_adjustments', { session_id: stale.session_id, patch: { exposure: 0.1 } });
      const result = (
        await first.call(
          'copy_adjustments',
          {
            session_id: source.session_id,
            version_id: reference.version_id,
            keys: ['exposure', 'temperature', 'masks'],
            geometry: 'exclude',
            mode: 'replace_selected',
            targets: [
              { session_id: target.session_id, expected_revision: 0 },
              { session_id: stale.session_id, expected_revision: 0 },
            ],
          },
          { expectError: true },
        )
      ).data;
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);
      assert.deepEqual(result.results[0].skipped_keys, ['masks']);
      assert.match(result.results[1].error, /REVISION_CONFLICT/);
      assert.equal((await session(first, target.session_id)).adjustments.exposure, accepted.adjustments.exposure);
      assert.equal((await session(first, stale.session_id)).adjustments.exposure, 0.1);
      const compatible = await session(first, target.session_id);
      const complete = (
        await first.call('copy_adjustments', {
          session_id: source.session_id,
          keys: ['temperature'],
          geometry: 'exclude',
          targets: [{ session_id: target.session_id, expected_revision: compatible.revision }],
        })
      ).data;
      assert.equal(complete.succeeded, 1);
      assert.equal(complete.failed, 0);
      assert.equal(complete.results[0].session_id, target.session_id);
      assert.equal((await session(first, target.session_id)).adjustments.temperature, accepted.adjustments.temperature);
      return { mixed: result, all_compatible: complete };
    },
  );
  await first.check(
    'owned_preset_saves_and_exports_dependencies',
    requirements('manage_presets', 'action="save"', 'action="list"', 'action="export"'),
    async () => {
      ownedPreset = (
        await first.call('manage_presets', {
          action: 'save',
          session_id: source.session_id,
          name: 'Portable grade',
          include_masks: true,
          include_geometry: true,
        })
      ).data;
      assert.ok(
        (await first.call('manage_presets', { action: 'list' })).data.presets.some(
          (preset) => preset.id === ownedPreset.id,
        ),
      );
      assert.ok((await first.call('list_presets')).data.presets.some((preset) => preset.id === ownedPreset.id));
      presetExport = (
        await first.call('manage_presets', { action: 'export', id: ownedPreset.id, path: 'portable-preset.json' })
      ).data;
      const exported = JSON.parse(await readFile(presetExport.path, 'utf8'));
      assert.ok(exported.lut.data_base64.length > 0);
      assert.ok(exported.lut.sha256.length === 64);
      const fresh = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      await first.call('apply_preset', { session_id: fresh.session_id, preset_id: ownedPreset.id });
      assert.equal(pixelDifference(await render(first, fresh.session_id), portableImage).maximum, 0);
      return { preset_id: ownedPreset.id, self_contained: true, matched_render: true };
    },
    'pixel_assertion',
  );
  await first.check(
    'selected_preset_round_trip_matches_direct_edit_and_preserves_base',
    requirements('manage_presets', 'action="save"', 'adjustment_keys', 'action="export"', 'action="import"'),
    async () => {
      const keys = ['lutPath', 'lutIntensity', 'lutIsSceneReferred', 'contrast', 'curves'];
      const lookSource = (
        await first.call('fork_session', { session_id: source.session_id, label: 'Selective preset source' })
      ).data;
      await first.call('set_adjustments', {
        session_id: lookSource.session_id,
        patch: {
          contrast: 18,
          curves: {
            luma: [
              { x: 0, y: 3 },
              { x: 128, y: 146 },
              { x: 255, y: 250 },
            ],
          },
        },
      });
      const look = await session(first, lookSource.session_id);
      const saved = (
        await first.call('manage_presets', {
          action: 'save',
          session_id: lookSource.session_id,
          expected_revision: look.revision,
          name: 'Selective portable grade',
          adjustment_keys: keys,
        })
      ).data;
      assert.deepEqual([...saved.adjustment_keys].sort(), [...keys].sort());
      const exported = (
        await first.call('manage_presets', { action: 'export', id: saved.id, path: 'selective-preset.json' })
      ).data;
      const envelope = JSON.parse(await readFile(exported.path, 'utf8'));
      assert.deepEqual(Object.keys(envelope.preset.adjustments).sort(), [...keys].sort());
      assert.ok(envelope.preset.adjustments.lutPath.startsWith('embedded:'));
      await first.call('manage_presets', { action: 'remove', id: saved.id });
      const imported = (await first.call('manage_presets', { action: 'import', path: exported.path })).data;
      const target = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      const base = {
        exposure: -0.3,
        temperature: 12,
        tint: 4,
        colorNoiseReduction: 17,
        lumaNoiseReduction: 9,
        sharpness: 23,
      };
      await first.call('set_adjustments', { session_id: target.session_id, mode: 'replace', patch: base });
      const basePixels = await render(first, target.session_id);
      await first.call('set_adjustments', {
        session_id: target.session_id,
        patch: Object.fromEntries(keys.map((key) => [key, look.adjustments[key]])),
      });
      const direct = await render(first, target.session_id);
      assert.ok(pixelDifference(direct, basePixels).maximum > 0, 'The selected look must visibly change the fixture');
      await first.call('set_adjustments', { session_id: target.session_id, mode: 'replace', patch: base });
      await first.call('apply_preset', { session_id: target.session_id, preset_id: imported.id, intensity: 100 });
      const reapplied = await session(first, target.session_id);
      for (const [key, value] of Object.entries(base)) assert.equal(reapplied.adjustments[key], value, key);
      assert.equal(pixelDifference(await render(first, target.session_id), direct).maximum, 0);
      return { adjustment_keys: saved.adjustment_keys, base_preserved: true, max_pixel_difference: 0 };
    },
    'pixel_assertion',
  );
  await first.check(
    'native_imported_preset_excludes_valid_retouch_patches_when_masks_disabled',
    requirements('manage_presets', 'action="import"'),
    async () => {
      const bitmap = (await readFile(fixture)).toString('base64');
      const aiPatch = {
        id: 'valid-imported-patch',
        name: 'Full canvas patch',
        visible: true,
        invert: false,
        prompt: 'Fixture replacement',
        subMasks: [{ id: 'valid-patch-submask', type: 'all', visible: true, mode: 'additive', parameters: {} }],
        patchData: {
          color: bitmap,
          mask: bitmap,
          offsetX: 0,
          offsetY: 0,
          width: 192,
          height: 128,
          isSrgbEncoded: true,
        },
      };
      const presetPath = join(root, 'fixtures', 'native-selective-preset.json');
      await writeFile(
        presetPath,
        JSON.stringify({
          id: 'native-source-id',
          name: 'Exclude selective content',
          includeMasks: false,
          includeCropTransform: false,
          adjustments: { exposure: 0.1, aiPatches: [aiPatch], crop: { x: 0, y: 0, width: 32, height: 32 } },
        }),
      );
      const imported = (await first.call('manage_presets', { action: 'import', path: presetPath })).data;
      const fresh = (await first.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      // A successful explicit set first proves this patch is structurally valid;
      // the preset flag must exclude it for semantics, not because validation failed.
      await first.call('set_adjustments', { session_id: fresh.session_id, patch: { aiPatches: [aiPatch] } });
      await first.call('undo', { session_id: fresh.session_id });
      await first.call('apply_preset', { session_id: fresh.session_id, preset_id: imported.id });
      const edited = await session(first, fresh.session_id);
      assert.equal((edited.adjustments.aiPatches ?? []).length, 0);
      assert.equal(edited.adjustments.crop ?? null, null);
      assert.equal(edited.adjustments.exposure, 0.1);
      return { valid_patch_explicitly_accepted: true, imported_preset_omits_ai_patches_and_crop: true };
    },
  );
  await first.check(
    'removing_library_entries_preserves_materialized_sessions',
    [...requirements('manage_luts', 'action="remove"'), ...requirements('manage_presets', 'action="remove"')],
    async () => {
      await first.call('manage_luts', { action: 'remove', id: ownedLut.id });
      await first.call('manage_presets', { action: 'remove', id: ownedPreset.id });
      assert.equal(pixelDifference(await render(first, source.session_id), portableImage).maximum, 0);
      const outside = await first.call(
        'manage_luts',
        { action: 'remove', id: 'workspace:../../outside' },
        { expectError: true },
      );
      assert.ok(outside.result.isError);
      return { rendered_after_removal: true };
    },
    'pixel_assertion',
  );
  await first.check(
    'bundle_export_records_complete_assets_and_no_overwrite',
    requirements('export_session_bundle', 'name', 'expected_revision'),
    async () => {
      const current = await session(first, source.session_id);
      bundle = (
        await first.call('export_session_bundle', {
          session_id: source.session_id,
          expected_revision: current.revision,
          name: 'portable-edit',
        })
      ).data;
      const manifest = JSON.parse(await readFile(join(bundle.path, 'manifest.json'), 'utf8'));
      assert.equal(manifest.session.is_raw, current.is_raw);
      assert.ok(manifest.versions.some((version) => version.version_id === reference.version_id));
      assert.ok(manifest.files.some((file) => file.kind === 'lut'));
      assert.equal(await hashFile(join(bundle.path, 'manifest.json')), bundle.manifest_sha256);
      for (const file of manifest.files) assert.equal(await hashFile(join(bundle.path, file.path)), file.sha256);
      const duplicate = await first.call(
        'export_session_bundle',
        { session_id: source.session_id, name: 'portable-edit' },
        { expectError: true },
      );
      assert.match(JSON.stringify(duplicate.result), /OUTPUT_EXISTS/);
      return {
        manifest_sha256: bundle.manifest_sha256,
        assets: manifest.files.length,
        versions: manifest.versions.length,
      };
    },
  );
  if (process.env.RAPIDRAW_RAW_FIXTURE) {
    const rawPath = resolve(process.env.RAPIDRAW_RAW_FIXTURE);
    await first.fixture(rawPath, 'photographic-raw-portability');
    const raw = (await first.call('open_photo', { path: rawPath, inherit_sidecar: false })).data;
    assert.equal(raw.is_raw, true);
    rawImage = await render(first, raw.session_id);
    rawBundle = (await first.call('export_session_bundle', { session_id: raw.session_id, name: 'raw-portability' }))
      .data;
  } else {
    await first.skip(
      'photographic_raw_bundle',
      ['tool:export_session_bundle', 'tool:import_session_bundle'],
      'Set RAPIDRAW_RAW_FIXTURE to run native photographic RAW portability in addition to TIFF RAW-domain unit tests.',
    );
  }
  const transport = join(root, 'transport');
  await mkdir(transport);
  await cp(bundle.path, join(transport, 'edit'), { recursive: true });
  await cp(presetExport.path, join(transport, 'preset.json'));
  await cp(lutExport.path, join(transport, 'identity.cube'));
  if (rawBundle) await cp(rawBundle.path, join(transport, 'raw'), { recursive: true });
  await first.close();
  first = null;
  // Removing the original session paths before import catches accidental absolute
  // LUT/source references that otherwise pass a same-machine roundtrip.
  await rename(
    join(root, 'source-workspace', 'sessions'),
    join(root, 'source-workspace', 'detached-original-sessions'),
  );
  const abandonedStage = join(root, 'destination-workspace', '.session-import-interrupted');
  await mkdir(abandonedStage, { recursive: true });
  await writeFile(join(abandonedStage, 'session.json'), '{"incomplete":true}');
  second = await createNativeHarness({ suite: 'portable-destination', workspace: join(root, 'destination-workspace') });
  await second.fixture(fixture, 'synthetic-colour-texture');
  await second.check(
    'restart_ignores_unpublished_import_staging_manifests',
    requirements('import_session_bundle'),
    async () => {
      assert.equal((await second.call('list_sessions')).data.count, 0);
      assert.equal(await readFile(join(abandonedStage, 'session.json'), 'utf8'), '{"incomplete":true}');
      return { abandoned_staging_did_not_poison_startup: true, published_sessions: 0 };
    },
  );
  await second.check(
    'moved_bundle_import_matches_pixels_without_original_session_paths',
    requirements('import_session_bundle', 'path', 'expected_manifest_sha256'),
    async () => {
      const imported = (
        await second.call('import_session_bundle', {
          path: join(transport, 'edit'),
          expected_manifest_sha256: bundle.manifest_sha256,
        })
      ).data;
      assert.notEqual(imported.session_id, source.session_id);
      assert.equal(imported.source_sha256, accepted.source_sha256);
      assert.equal(imported.is_raw, accepted.is_raw);
      assert.equal(await hashFile(imported.working_path), accepted.source_sha256);
      assert.ok(imported.adjustments.lutPath.startsWith(join(second.workspace, 'sessions', imported.session_id)));
      assert.equal(pixelDifference(await render(second, imported.session_id), portableImage).maximum, 0);
      const versions = (await second.call('list_versions', { session_id: imported.session_id })).data.versions;
      assert.ok(versions.some((version) => version.version_id === reference.version_id));
      await rm(join(transport, 'edit'), { recursive: true });
      await second.call('set_adjustments', { session_id: imported.session_id, patch: { exposure: 1 } });
      await second.call('restore_version', { session_id: imported.session_id, version_id: reference.version_id });
      assert.equal(pixelDifference(await render(second, imported.session_id), portableImage).maximum, 0);
      return {
        imported_session_id: imported.session_id,
        max_pixel_difference: 0,
        named_version_restored_after_bundle_deletion: true,
      };
    },
    'pixel_assertion',
  );
  await second.check(
    'self_contained_preset_import_matches_render_after_library_removal',
    requirements('manage_presets', 'action="import"'),
    async () => {
      const imported = (
        await second.call('manage_presets', {
          action: 'import',
          path: join(transport, 'preset.json'),
          name: 'Relocated grade',
        })
      ).data;
      const fresh = (await second.call('open_photo', { path: fixture, inherit_sidecar: false })).data;
      await second.call('apply_preset', { session_id: fresh.session_id, preset_id: imported.id });
      assert.equal(pixelDifference(await render(second, fresh.session_id), portableImage).maximum, 0);
      const badPath = join(transport, 'corrupt-preset.json');
      const corrupt = JSON.parse(await readFile(join(transport, 'preset.json'), 'utf8'));
      corrupt.lut.sha256 = '0'.repeat(64);
      await writeFile(badPath, JSON.stringify(corrupt));
      const result = await second.call('manage_presets', { action: 'import', path: badPath }, { expectError: true });
      assert.match(JSON.stringify(result.result), /SHA-256/);
      return { preset_id: imported.id, max_pixel_difference: 0, corrupt_dependency_rejected: true };
    },
    'pixel_assertion',
  );
  await second.check(
    'corrupt_missing_traversal_and_symlink_bundle_rejection_is_atomic',
    requirements('import_session_bundle', 'expected_manifest_sha256'),
    async () => {
      const baseline = (await second.call('list_sessions')).data.count;
      const exported = bundle.path; // The source bundle remains self-contained even after source session directories move.
      const cases = ['corrupt', 'missing', 'traversal', 'digest', ...(process.platform === 'win32' ? [] : ['symlink'])];
      for (const kind of cases) {
        const directory = join(transport, kind);
        await cp(exported, directory, { recursive: true });
        const manifestPath = join(directory, 'manifest.json'),
          manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (kind === 'corrupt') await writeFile(join(directory, manifest.session.working_path), 'corrupted source');
        if (kind === 'missing') await rm(join(directory, manifest.session.working_path));
        if (kind === 'symlink') {
          await rm(join(directory, manifest.session.working_path));
          await symlink(fixture, join(directory, manifest.session.working_path));
        }
        if (kind === 'traversal') {
          manifest.files[0].path = '../outside';
          await writeFile(manifestPath, JSON.stringify(manifest));
        }
        const result = await second.call(
          'import_session_bundle',
          { path: directory, ...(kind === 'digest' ? { expected_manifest_sha256: '0'.repeat(64) } : {}) },
          { expectError: true },
        );
        assert.ok(result.result.isError);
        assert.equal((await second.call('list_sessions')).data.count, baseline);
      }
      return { invalid_bundles: cases.length, no_partial_sessions: true };
    },
  );
  if (rawBundle)
    await second.check(
      'photographic_raw_domain_and_pixels_survive_workspace_move',
      requirements('import_session_bundle'),
      async () => {
        const imported = (
          await second.call('import_session_bundle', {
            path: join(transport, 'raw'),
            expected_manifest_sha256: rawBundle.manifest_sha256,
          })
        ).data;
        assert.equal(imported.is_raw, true);
        assert.equal(pixelDifference(await render(second, imported.session_id), rawImage).maximum, 0);
        return { is_raw: true, max_pixel_difference: 0 };
      },
      'pixel_assertion',
    );
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (first) await first.close(failure);
  if (second) await second.close(failure);
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', workspace: root }));
if (failure) process.exitCode = 1;
