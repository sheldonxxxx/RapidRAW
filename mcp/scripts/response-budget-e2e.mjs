/** Real SDK/native wire-budget acceptance: oversized pixels must not kill the connection. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness } from './coverage-evidence.mjs';
import { decodePng, fixturePng } from './png-fixtures.mjs';

const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/response-budget-${Date.now()}`);
await mkdir(workspace, { recursive: true });
let random = 0x1a2b3c4d;
const byte = () => {
  random ^= random << 13;
  random ^= random >>> 17;
  random ^= random << 5;
  return random >>> 24;
};
const source = join(workspace, 'high-entropy-2000x1200.png');
await writeFile(
  source,
  fixturePng(2000, 1200, () => [byte(), byte(), byte()]),
  { flag: 'wx' },
);
const h = await createNativeHarness({ suite: 'response-budget', workspace, timeout: 300000 });
let failure;
try {
  await h.fixture(source, 'deterministic high-entropy synthetic source that exceeds the MCP image budget');
  const opened = (await h.call('open_photo', { path: source, inherit_sidecar: false })).data;
  const mask = (
    await h.call('mask_create', {
      session_id: opened.session_id,
      name: 'budget-mask',
      type: 'all',
      parameters: {},
      adjustments: {},
    })
  ).data;
  const state = (await h.call('get_session', { session_id: opened.session_id })).data;
  const args = { session_id: opened.session_id, format: 'png', mask_id: mask.mask_id, mask_mode: 'overlay' };
  await h.check(
    'oversized_png_returns_actionable_error_and_same_connection_survives',
    ['tool:render', 'parameter:render.mask_mode="overlay"', 'parameter:render.format="png"', 'tool:get_session'],
    async () => {
      const oversized = await h.call('render', { ...args, long_edge: 2000 }, { expectError: true });
      assert.equal(oversized.data.error.code, 'RESPONSE_TOO_LARGE');
      assert.equal(oversized.data.error.max_response_bytes, 8 * 1024 * 1024);
      assert.ok(oversized.data.error.response_bytes > oversized.data.error.max_response_bytes);
      assert.equal(oversized.images.length, 0, 'Oversized images must not escape into SDK stdio');
      assert.equal(oversized.data.recovery.method, 'render');
      assert.equal(oversized.data.recovery.request_completed, true);
      assert.equal(oversized.data.recovery.mutation_may_have_completed, false);
      assert.equal(oversized.data.recovery.retry_mutation, false);
      assert.equal(oversized.data.recovery.input_session_id ?? oversized.data.recovery.session_id, opened.session_id);
      await writeFile(join(workspace, 'oversized-response-error.json'), JSON.stringify(oversized.data, null, 2));
      const after = (await h.call('get_session', { session_id: opened.session_id })).data;
      assert.equal(after.revision, state.revision, 'A read-only overflow must not change edits');
      return {
        response_bytes: oversized.data.error.response_bytes,
        budget_bytes: oversized.data.error.max_response_bytes,
        connection_preserved: true,
        revision_unchanged: true,
      };
    },
  );
  await h.check(
    'explicit_bounded_overview_and_native_detail_after_overflow',
    ['tool:render', 'parameter:render.long_edge', 'parameter:render.region', 'parameter:render.mask_mode="overlay"'],
    async () => {
      const overview = await h.call('render', { ...args, long_edge: 512 });
      assert.equal(overview.images.length, 3);
      const overviewShapes = overview.images.map((image) => {
        const decoded = decodePng(Buffer.from(image.data, 'base64'));
        assert.equal(decoded.bitDepth, 8);
        assert.ok(decoded.width <= 512 && decoded.height <= 512);
        return [decoded.width, decoded.height];
      });
      assert.deepEqual(overviewShapes[0], overviewShapes[1]);
      assert.deepEqual(overviewShapes[0], overviewShapes[2]);
      const region = { x: 851, y: 333, width: 512, height: 512 };
      const detail = await h.call('render', { ...args, region });
      assert.equal(detail.images.length, 3);
      for (const [index, image] of detail.images.entries()) {
        const bytes = Buffer.from(image.data, 'base64'),
          decoded = decodePng(bytes);
        assert.equal(decoded.bitDepth, 8);
        assert.deepEqual([decoded.width, decoded.height], [512, 512]);
        await writeFile(join(workspace, `native-detail-${index + 1}.png`), bytes);
      }
      await h.call('set_adjustments', {
        session_id: opened.session_id,
        expected_revision: state.revision,
        patch: { exposure: 0.25 },
      });
      assert.equal(
        (await h.call('get_session', { session_id: opened.session_id })).data.revision,
        state.revision + 1,
        'The same connection must remain able to edit after recovery',
      );
      return {
        matched_overview_shapes: overviewShapes,
        native_region: region,
        native_detail_not_resized: true,
        subsequent_edit_succeeded: true,
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
