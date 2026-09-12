import assert from 'node:assert/strict';

/** Cover the requested native-pixel rectangle exactly without resizing its detail. */
export function nativeReviewTiles(region, edge = 512) {
  assert.ok(Number.isInteger(edge) && edge > 0);
  const { x, y, width, height } = region;
  assert.ok([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0);
  const tiles = [];
  for (let top = y; top < y + height; top += edge) for (let left = x; left < x + width; left += edge) tiles.push({ x: left, y: top, width: Math.min(edge, x + width - left), height: Math.min(edge, y + height - top) });
  return tiles;
}

export function isDisconnected(error) {
  return /connection (?:is )?closed|not connected|transport[^\n]*closed|read ?buffer[^\n]*(?:limit|maximum|size)|BRIDGE_(?:EXIT|EOF|PROTOCOL|TIMEOUT|IO|CLOSED|START)/i.test(String(error));
}

/** A completed mutation may be inspected, but must never be replayed after output overflow. */
export function recoverCompletedResponse(data, requiredFields = []) {
  assert.equal(data?.error?.code, 'RESPONSE_TOO_LARGE');
  const recovery = data.recovery;
  assert.equal(recovery?.request_completed, true, 'Oversized response did not establish completed work; inspect saved state manually');
  assert.equal(recovery.retry_mutation, false, 'Mutation recovery must explicitly prohibit replay');
  const result = { ...recovery, session_id: recovery.result_session_id ?? recovery.session_id ?? recovery.input_session_id, response_recovery: data };
  for (const field of requiredFields) assert.ok(result[field], `Completed oversized result lacks ${field}; do not replay the mutation`);
  return result;
}
