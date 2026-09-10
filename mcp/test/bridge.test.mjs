import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../dist/bridge.js';
const binary = fileURLToPath(new URL('./fixtures/bridge.mjs', import.meta.url));
function create(options = {}) { return new NativeBridge({ binary, workspace: '/private/tmp/rapidraw-mcp-tests', timeoutMs: 2000, log: () => {}, ...options }); }

test('serializes native requests, frames split lines, and recovers from ordinary errors', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  const results = await Promise.all([bridge.request('get_session', { session_id: 'slow' }), bridge.request('get_session', { session_id: 'next' })]);
  assert.equal(results[1].session_id, 'next');
  await assert.rejects(bridge.request('set_adjustments', { patch: { bad: true } }), { code: 'INVALID_ADJUSTMENT' });
  assert.equal((await bridge.request('get_session', { session_id: 'alive' })).session_id, 'alive');
});

test('crash rejects all queued requests without respawning', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  const results = await Promise.allSettled([bridge.request('get_session', { session_id: 'crash' }), bridge.request('get_session', { session_id: 'must-not-run' })]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  await assert.rejects(bridge.request('capabilities'), (error) => ['BRIDGE_EXIT', 'BRIDGE_EOF'].includes(error.code));
});

test('timeout stops uncertain mutation and fails future requests', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  await bridge.capabilities();
  await assert.rejects(bridge.request('set_adjustments', { session_id: 'stall' }, 50), { code: 'BRIDGE_TIMEOUT' });
  await assert.rejects(bridge.request('get_session'), { code: 'BRIDGE_TIMEOUT' });
});

test('mismatched native response ID fails closed', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  await assert.rejects(bridge.request('get_session', { session_id: 'wrong_id' }), { code: 'BRIDGE_PROTOCOL' });
});

test('native stdout EOF rejects pending request', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  await assert.rejects(bridge.request('get_session', { session_id: 'eof' }), { code: 'BRIDGE_EOF' });
});

test('missing binary gives actionable startup failure', async (t) => {
  const bridge = create({ binary: '/nonexistent/rapidraw' }); t.after(() => bridge.close());
  await assert.rejects(bridge.request('capabilities'), { code: 'BRIDGE_START' });
});

test('cancelled queued request is not applied and leaves other requests usable', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  const abort = new AbortController();
  const slow = bridge.request('get_session', { session_id: 'slow' });
  const queued = bridge.request('set_adjustments', {}, undefined, abort.signal);
  abort.abort();
  await slow;
  await assert.rejects(queued, { code: 'REQUEST_CANCELLED' });
  assert.equal((await bridge.request('get_session', { session_id: 'alive' })).session_id, 'alive');
});

test('cancelled active request stops the engine and never replays edits', async (t) => {
  const bridge = create(); t.after(() => bridge.close());
  await bridge.capabilities();
  const abort = new AbortController();
  const request = bridge.request('set_adjustments', { session_id: 'stall' }, undefined, abort.signal);
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(request, { code: 'REQUEST_CANCELLED' });
  await assert.rejects(bridge.request('get_session'), { code: 'REQUEST_CANCELLED' });
});


test('native startup error preserves actionable workspace code without unrelated stderr', async (t) => {
  const bridge = create({ env: { ...process.env, FAKE_START_ERROR: '1' } }); t.after(() => bridge.close());
  await assert.rejects(bridge.request('capabilities'), (error) => {
    assert.equal(error.code, 'WORKSPACE_BUSY');
    assert.equal(error.message, 'Workspace already owned by another connection');
    assert.ok(!error.message.includes('DO_NOT_ATTACH'));
    return true;
  });
});
