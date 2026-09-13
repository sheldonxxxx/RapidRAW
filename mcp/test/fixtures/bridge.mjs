#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { toolDefinitions } from '../../dist/tools.js';
const args = process.argv.slice(2);
if (args[0] !== '--mcp-bridge' || args[1] !== '--workspace' || !args[2]?.startsWith('/')) process.exit(22);
if (process.env.FAKE_START_ERROR) { process.stderr.write('unrelated provider token=DO_NOT_ATTACH\nRapidRAW bridge: WORKSPACE_BUSY: Workspace already owned by another connection\n'); process.exit(1); }
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
process.stdout.write('Native startup diagnostic that must not corrupt MCP\n');
process.stdout.write('{"event":"initializing"}\n');
let busy = false;
let mutationCount = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (busy) { process.stdout.write(`${JSON.stringify({ id, error: { code: 'CONCURRENT', message: 'Concurrent native request' } })}\n`); return; }
  busy = true;
  if (params.session_id === 'crash') process.exit(9);
  if (params.session_id === 'stall') return;
  if (params.session_id === 'wrong_id') { process.stdout.write(`${JSON.stringify({ id: id + 1, result: {} })}\n`); return; }
  if (params.session_id === 'eof') { process.stdout.end(); return; }
  if (params.session_id === 'slow') await new Promise((resolve) => setTimeout(resolve, 30));
  let result = { method, params, revision: 2, session_id: params.session_id ?? 'test-session' };
  if (method === 'capabilities') result = { protocol_version: 1, workspace: args[2], methods: toolDefinitions.map((d) => d.method), adjustment_schema: { type: 'object' } };
  if (method === 'batch_export') result = { ok: false, total: 2, succeeded: 1, failed: 1, results: [{ ok: true, result: { path: '/tmp/ok.jpg' } }, { ok: false, error: 'SESSION_NOT_FOUND', path: '/tmp/bad.jpg' }] };
  if (method === 'render') result = { ...result, width: 1, height: 1, image: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' } };
  if (params.session_id === 'oversized-images' && method === 'render' || params.session_id === 'oversized-mutation' && method === 'mask_generate') {
    const data = 'A'.repeat(4 * 1024 * 1024);
    result = { ...result, image: { data, mimeType: 'image/png' }, images: [{ label: 'Photograph', data, mimeType: 'image/png' }, { label: 'Selection', data, mimeType: 'image/png' }] };
    if (method === 'mask_generate') { mutationCount++; result.mask_id = 'mask-created'; result.revision = 3; }
  }
  if (params.session_id === 'oversized-state' && method === 'get_session' && params.include_adjustments) result.adjustments = { description: 'é'.repeat(3 * 1024 * 1024) };
  if (params.session_id === 'oversized-resource' && method === 'get_session' && params.include_adjustments) result.adjustments = { description: 'é'.repeat(5 * 1024 * 1024) };
  if (method === 'get_session') { result.mutation_count = mutationCount; if (mutationCount) result.revision = 3; }
  if (params.session_id === 'oversized-error' && method === 'render') {
    process.stdout.write(`${JSON.stringify({ id, error: { code: 'NATIVE_FAILURE', message: 'x'.repeat(12 * 1024 * 1024) } })}\n`);
  } else if (method === 'set_adjustments' && params.patch?.bad) {
    process.stdout.write(`${JSON.stringify({ id, error: { code: 'INVALID_ADJUSTMENT', message: 'Unknown adjustment bad; read the edit schema.' } })}\n`);
  } else {
    // Split lines to exercise stream framing.
    const response = `${JSON.stringify({ id, result })}\n`;
    process.stdout.write(response.slice(0, 7));
    process.stdout.write(response.slice(7));
  }
  busy = false;
});
