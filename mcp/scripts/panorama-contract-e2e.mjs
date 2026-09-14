/** Real MCP panorama contracts on procedural fixtures; photographic quality is tested separately. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness } from './coverage-evidence.mjs';
import { fixturePng, decodePng } from './png-fixtures.mjs';
import { validatePhotoManifest } from './photo-quality-manifest.mjs';

const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/panorama-contract-${Date.now()}`);
const h = await createNativeHarness({ suite: 'panorama-contract', workspace, timeout: 600000 });
let failure;
const requirements = ['tool:merge', 'parameter:merge.kind="panorama"'];
try {
  if (process.env.RAPIDRAW_PANORAMA_LIMIT_MANIFEST) {
    const manifest = await validatePhotoManifest(
      JSON.parse(await readFile(resolve(process.env.RAPIDRAW_PANORAMA_LIMIT_MANIFEST), 'utf8')),
    );
    assert.equal(manifest.groups.length, 1);
    const group = manifest.groups[0];
    assert.equal(group.kind, 'panorama');
    for (const source of group.sources)
      await h.fixture(source.path, 'genuine capture group whose projected canvas exceeds 100MP', {
        capture_group: group.capture_group,
        partition: group.partition,
      });
    await h.check('panorama_rejects_over_limit_projected_capture_before_allocation', requirements, async () => {
      const result = await h.call(
        'merge',
        { kind: 'panorama', paths: group.sources.map((source) => source.path) },
        { expectError: true },
      );
      assert.match(JSON.stringify(result.data), /PANORAMA_CANVAS_TOO_LARGE/);
      assert.equal(result.data?.session_id, undefined);
      return {
        source_count: group.sources.length,
        maximum_canvas_megapixels: 100,
        projected_canvas_rejected: true,
        photographic_quality: 'no stitched output; limit assertion only',
      };
    });
  }
  const directory = join(workspace, 'fixtures');
  await mkdir(directory, { recursive: true });
  function scene(x, y) {
    let hash = Math.imul(Math.floor(x / 16) + 1, 374761393) ^ Math.imul(Math.floor(y / 16) + 1, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    hash ^= hash >>> 16;
    const value = 112 + ((hash >>> 0) % 32);
    return [value, value, value];
  }
  const panels = [];
  for (const [i, offset] of [0, 150, 300].entries()) {
    const path = join(directory, `low-contrast-panel-${i + 1}.png`);
    await writeFile(
      path,
      fixturePng(600, 420, (x, y) => scene(x + offset, y)),
      { flag: 'wx' },
    );
    await h.fixture(path, 'procedural overlapping panel; not a photographic capture');
    panels.push(path);
  }
  const blank = join(directory, 'blank.png');
  await writeFile(
    blank,
    fixturePng(600, 420, () => [128, 128, 128]),
    { flag: 'wx' },
  );
  await h.fixture(blank, 'featureless disconnected negative control');
  await h.check('panorama_rejects_disconnected_source_instead_of_silent_partial_result', requirements, async () => {
    const result = await h.call(
      'merge',
      { kind: 'panorama', paths: [panels[0], panels[2], blank] },
      { expectError: true },
    );
    assert.match(JSON.stringify(result.data), /connect|match|excluded/i);
    assert.equal(result.data?.session_id, undefined);
    return { supplied_sources: 3, disconnected_sources: 1, partial_success_forbidden: true };
  });
  await h.check('panorama_rejects_featureless_pair', requirements, async () => {
    const result = await h.call('merge', { kind: 'panorama', paths: [blank, blank] }, { expectError: true });
    assert.match(JSON.stringify(result.data), /connect|match/i);
    assert.equal(result.data?.session_id, undefined);
    return { featureless_pair_rejected: true };
  });
  await h.check(
    'low_contrast_panorama_preserves_all_sources_and_restart_pixels',
    [...requirements, 'tool:save_session', 'tool:render'],
    async () => {
      const merged = (await h.call('merge', { kind: 'panorama', paths: panels })).data;
      const session_id = merged.session_id;
      assert.ok(session_id);
      const state = (await h.call('get_session', { session_id })).data;
      assert.equal(state.metadata.derivedFrom.operation, 'panorama');
      assert.equal(new Set(state.metadata.derivedFrom.session_ids).size, 3);
      const before = await h.call('render', { session_id, format: 'png' });
      assert.equal(before.images.length, 1);
      const png = decodePng(Buffer.from(before.images[0].data, 'base64'));
      assert.ok(png.width >= 880 && png.width <= 925, `Expected full 900px scene, got ${png.width}`);
      assert.ok(png.height >= 400 && png.height <= 445, `Unexpected vertical drift: ${png.height}`);
      assert.ok(
        png.pixels.some((v) => v > 0.4),
        'Expected actual nonempty image samples',
      );
      await writeFile(join(workspace, 'panorama.png'), Buffer.from(before.images[0].data, 'base64'), { flag: 'wx' });
      await h.call('save_session', { session_id });
      await h.reconnect();
      const after = await h.call('render', { session_id, format: 'png' });
      assert.deepEqual(after.images, before.images);
      return {
        width: png.width,
        height: png.height,
        sources: 3,
        restart_pixels_equal: true,
        photographic_quality: 'procedural fixture; not assessed',
      };
    },
    'pixel_assertion',
  );
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  await h.close(failure);
}
