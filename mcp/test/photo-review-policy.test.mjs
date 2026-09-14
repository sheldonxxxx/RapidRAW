import assert from 'node:assert/strict';
import test from 'node:test';
import { isDisconnected, nativeReviewTiles, recoverCompletedResponse } from '../scripts/photo-review-policy.mjs';

test('native detail tiling preserves the exact requested area, offsets and all boundary pixels', () => {
  const region = { x: 137, y: 91, width: 1025, height: 769 },
    tiles = nativeReviewTiles(region);
  assert.equal(tiles.length, 6);
  assert.equal(
    tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0),
    region.width * region.height,
  );
  for (const tile of tiles) {
    assert.ok(tile.width <= 512 && tile.height <= 512);
    assert.ok(
      tile.x >= region.x &&
        tile.y >= region.y &&
        tile.x + tile.width <= region.x + region.width &&
        tile.y + tile.height <= region.y + region.height,
    );
  }
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i],
        b = tiles[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  assert.deepEqual(
    nativeReviewTiles({ x: 20, y: 30, width: 1024, height: 1024 }).map((tile) => [tile.width, tile.height]),
    [
      [512, 512],
      [512, 512],
      [512, 512],
      [512, 512],
    ],
  );
});

test('transport shutdown stops future photographic attempts while actionable image-size errors do not', () => {
  for (const error of [
    'MCP error -32000: Connection closed',
    'ReadBuffer exceeded maximum size',
    '{"code":"BRIDGE_TIMEOUT"}',
  ])
    assert.equal(isDisconnected(error), true);
  for (const error of [
    'RESPONSE_TOO_LARGE: use a smaller overview',
    'EMPTY_MASK: selection is empty',
    'INVALID_ARGUMENT',
  ])
    assert.equal(isDisconnected(error), false);
});

test('oversized completed mutations recover identifiers without permission to replay', () => {
  const response = {
    error: { code: 'RESPONSE_TOO_LARGE' },
    recovery: {
      request_completed: true,
      retry_mutation: false,
      input_session_id: 'parent',
      result_session_id: 'derived',
      mask_id: 'mask',
    },
  };
  assert.equal(recoverCompletedResponse(response, ['session_id', 'mask_id']).session_id, 'derived');
  assert.throws(
    () => recoverCompletedResponse({ ...response, recovery: { ...response.recovery, request_completed: false } }),
    /completed work/,
  );
  assert.throws(() => recoverCompletedResponse(response, ['job_id']), /do not replay/);
});
