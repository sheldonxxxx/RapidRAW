/** Real RAW preview latency, exact cache bytes and revision invalidation. Timings are measurements, not an SLA. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness } from './coverage-evidence.mjs';
const source = process.env.RAPIDRAW_TEST_IMAGE;
assert.ok(source, 'Set RAPIDRAW_TEST_IMAGE to an actual photographic RAW original');
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/photo-performance-${Date.now()}`);
await mkdir(workspace, { recursive: true });
const h = await createNativeHarness({ suite: 'photo-preview-performance', workspace });
let failure;
try {
  await h.fixture(source, 'photographic RAW preview performance regression; no quality approval inferred');
  const session = (await h.call('open_photo', { path: resolve(source), inherit_sidecar: false })).data;
  const session_id = session.session_id;
  await h.check(
    'raw_exact_preview_cache_and_revision_invalidation',
    ['tool:render', 'parameter:render.cache=true', 'parameter:render.cache=false', 'tool:set_adjustments'],
    async () => {
      async function timed(args) {
        const start = performance.now();
        const result = await h.call('render', { session_id, format: 'png', long_edge: 1600, ...args });
        return { ...result, elapsed_ms: performance.now() - start };
      }
      const cold = await timed({ cache: true });
      const warm = await timed({ cache: true });
      const forced = await timed({ cache: false });
      assert.equal(cold.data.cache.hit, false);
      assert.equal(warm.data.cache.hit, true);
      assert.equal(forced.data.cache.hit, false);
      assert.equal(warm.images[0].data, cold.images[0].data);
      assert.equal(forced.images[0].data, cold.images[0].data);
      await writeFile(join(workspace, 'native-original-preview.png'), Buffer.from(cold.images[0].data, 'base64'));
      await h.call('set_adjustments', { session_id, expected_revision: session.revision, patch: { exposure: 0.25 } });
      const edited = await timed({ cache: true });
      assert.equal(edited.data.cache.hit, false);
      assert.notEqual(edited.images[0].data, cold.images[0].data);
      await h.call('undo', { session_id });
      assert.equal((await timed({ cache: true })).images[0].data, cold.images[0].data);
      return {
        dimensions: session.dimensions,
        preview: { width: cold.data.width, height: cold.data.height },
        cold_ms: cold.elapsed_ms,
        cached_ms: warm.elapsed_ms,
        uncached_ms: forced.elapsed_ms,
        changed_revision_ms: edited.elapsed_ms,
        cache_speedup_observed: forced.elapsed_ms / warm.elapsed_ms,
        exact_bytes: true,
        notes:
          'Single local sample; no minimum speedup asserted. Input remains at native resolution until preview resizing.',
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
