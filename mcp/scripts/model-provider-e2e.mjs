/** Opt-in real downloads and provider execution; never modifies installed application assets. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { decodePng, fixturePng, pixelDifference } from './png-fixtures.mjs';
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/model-provider-${Date.now()}`);
await mkdir(workspace, { recursive: true });
const source = join(workspace, 'synthetic-provider-fixture.png');
await writeFile(source, fixturePng(96, 64));
if (process.env.RAPIDRAW_TEST_PROVIDER_SETTINGS) {
  // Settings path is explicitly supplied by the runner; secrets themselves never enter evidence.
  await writeFile(
    join(workspace, 'engine-settings.json'),
    await readFile(resolve(process.env.RAPIDRAW_TEST_PROVIDER_SETTINGS)),
  );
}
const h = await createNativeHarness({ suite: 'model-provider', workspace, timeout: 1800000 });
let failure;
try {
  await h.fixture(source, 'synthetic image; authorized optional provider test sends only this generated fixture');
  const before = (await h.call('models')).data;
  const requested = (process.env.RAPIDRAW_TEST_MODEL_KINDS ?? 'inpaint').split(',');
  if (process.env.RAPIDRAW_TEST_MODEL_DOWNLOAD !== '1')
    await h.skip(
      'fresh_model_download',
      ['tool:install_model'],
      'Set RAPIDRAW_TEST_MODEL_DOWNLOAD=1 for real downloads into a new workspace; default group is inpaint',
    );
  else
    for (const kind of requested) {
      assert.ok(['inpaint', 'masks', 'denoise'].includes(kind));
      await h.check(
        `fresh_download_and_corrupt_asset_recovery_${kind}`,
        ['tool:install_model', `parameter:install_model.kind=${JSON.stringify(kind)}`],
        async () => {
          const assets = before.groups[kind].assets;
          assert.ok(assets.length);
          for (const asset of assets) {
            assert.equal(asset.present, false, 'Use a fresh workspace; never overwrite existing model assets');
            assert.ok(resolve(asset.path).startsWith(resolve(workspace, 'models') + '/'));
            await mkdir(dirname(asset.path), { recursive: true });
            // Native installed-copy shortcut runs only when the target is absent.
            // A deliberately corrupt local target forces the verified download path.
            await writeFile(asset.path, 'rapidraw disposable corrupted download fixture', { flag: 'wx' });
          }
          const corrupt = (await h.call('models')).data;
          assert.equal(corrupt.groups[kind].ready, false);
          await h.call('install_model', { kind });
          const after = (await h.call('models')).data;
          assert.equal(after.groups[kind].ready, true);
          for (const asset of assets) assert.equal(await hashFile(asset.path), asset.expected_sha256);
          await h.call('install_model', { kind });
          for (const asset of assets)
            assert.equal(
              await hashFile(asset.path),
              asset.expected_sha256,
              'Repeated install must preserve verified assets',
            );
          return {
            kind,
            assets: assets.map((a) => ({ name: a.name, sha256: a.expected_sha256 })),
            reused_installed_assets: false,
            network_download_required: true,
          };
        },
      );
    }
  await h.skip(
    'mcp_download_interruption_offline_and_transport_retry',
    ['tool:install_model'],
    'Real downloader fault/retry tests run separately as ai_processing::download_fault_tests using controlled local HTTP; those unit tests do not establish the MCP install/cancellation boundary',
  );
  if (process.env.RAPIDRAW_TEST_GENERATIVE !== '1')
    await h.skip(
      'authorized_generative_provider_success',
      ['parameter:retouch.mode="generative"'],
      'Set RAPIDRAW_TEST_GENERATIVE=1 and RAPIDRAW_TEST_PROVIDER_SETTINGS to deliberately use a configured provider with the generated fixture',
    );
  else {
    assert.ok(
      process.env.RAPIDRAW_TEST_PROVIDER_SETTINGS,
      'Supply deliberate provider settings; do not silently inherit application credentials',
    );
    await h.check(
      'authorized_generative_provider_patch_and_undo',
      ['tool:retouch', 'parameter:retouch.mode="generative"'],
      async () => {
        const session_id = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data.session_id;
        const before = (await h.call('render', { session_id, format: 'png' })).images[0].data;
        const patch = (
          await h.call('retouch', {
            session_id,
            mode: 'generative',
            prompt: 'Replace the center texture with a small blue square. Preserve the surrounding image.',
            sub_masks: [
              {
                id: 'generated-test-region',
                type: 'radial',
                visible: true,
                mode: 'additive',
                parameters: { centerX: 48, centerY: 32, radiusX: 15, radiusY: 15, rotation: 0, feather: 0.1 },
              },
            ],
            ...(process.env.RAPIDRAW_TEST_PROVIDER_TOKEN ? { token: process.env.RAPIDRAW_TEST_PROVIDER_TOKEN } : {}),
          })
        ).data;
        assert.ok(patch.patch_id);
        const changed = (await h.call('render', { session_id, format: 'png' })).images[0].data;
        const baseline = decodePng(Buffer.from(before, 'base64'));
        assert.ok(pixelDifference(decodePng(Buffer.from(changed, 'base64')), baseline).mean_absolute > 0.0001);
        await h.call('undo', { session_id });
        assert.equal(
          pixelDifference(
            decodePng(Buffer.from((await h.call('render', { session_id, format: 'png' })).images[0].data, 'base64')),
            baseline,
          ).maximum,
          0,
        );
        return {
          source_kind: 'generated_fixture',
          patch_id: patch.patch_id,
          restored_identically: true,
          photographic_quality_reviewed: false,
        };
      },
      'pixel_assertion',
    );
  }
} catch (error) {
  failure = error;
} finally {
  await h.close(failure);
}
if (failure) throw failure;
