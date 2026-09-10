/** Real engine acceptance test. Requires a built fork, never a fake native renderer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { inspectTiff16 } from './tiff-inspect.mjs';

const binary = process.env.RAPIDRAW_BINARY;
const sources = process.env.RAPIDRAW_TEST_IMAGES ? JSON.parse(process.env.RAPIDRAW_TEST_IMAGES) : [process.env.RAPIDRAW_TEST_IMAGE, process.env.RAPIDRAW_TEST_IMAGE_2].filter(Boolean);
const workspace = process.env.RAPIDRAW_WORKSPACE ?? resolve('test-output/engine-e2e');
assert.ok(binary && isAbsolute(binary), 'Set RAPIDRAW_BINARY to the absolute built fork executable');
assert.ok(Array.isArray(sources) && sources.length > 0 && sources.every((p) => typeof p === 'string' && isAbsolute(p)), 'Set RAPIDRAW_TEST_IMAGE (+ optional RAPIDRAW_TEST_IMAGE_2), or RAPIDRAW_TEST_IMAGES as a JSON array of absolute photo paths');
assert.ok(isAbsolute(workspace), 'RAPIDRAW_WORKSPACE must be absolute');
await mkdir(workspace, { recursive: true });
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const sidecarDigest = async (source) => { try { return await digest(`${source}.rrdata`); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const originals = await Promise.all(sources.map(async (source) => ({ source, sha256: await digest(source), sidecar_sha256: await sidecarDigest(source) })));
const records = [];
const outputId = Date.now();
const evidencePath = join(workspace, `${outputId}-evidence.jsonl`);
function sanitize(value, key = '') {
  if (/token|password|secret/i.test(key)) return '[redacted]';
  if (typeof value === 'string' && (value.length > 4096 || /base64/i.test(key))) return `[omitted ${value.length} characters]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}
let client;
async function connect() {
  client = new Client({ name: 'rapidraw-real-engine-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace], stderr: 'inherit' });
  await client.connect(transport);
}
async function call(method, args = {}, expectError = false) {
  const start = performance.now();
  const sequence = records.length + 1;
  console.error(`[engine-e2e ${sequence}] ${method} started`);
  const result = await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout: 300000 });
  const record = sanitize({ sequence, method, args, elapsed_ms: Math.round(performance.now() - start), is_error: !!result.isError, result: result.structuredContent });
  records.push(record);
  await appendFile(evidencePath, `${JSON.stringify(record)}\n`);
  console.error(`[engine-e2e ${sequence}] ${method} ${result.isError ? 'ERROR' : 'OK'} ${record.elapsed_ms} ms`);
  assert.equal(!!result.isError, expectError, `${method}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result;
}
function data(result) { assert.ok(result.structuredContent); return result.structuredContent; }
async function writePreview(result, filename) {
  const block = result.content.find((item) => item.type === 'image');
  assert.ok(block, 'Renderer must return a native MCP image block');
  assert.ok(block.data.length > 100, 'Preview must contain encoded image bytes');
  assert.equal(result.structuredContent.image.data, undefined, 'Base64 must not be duplicated in structured data');
  await writeFile(join(workspace, filename), Buffer.from(block.data, 'base64'));
  return block.data;
}
const completed = [];
try {
  await connect();
  assert.ok((await client.listTools()).tools.length >= 37);
  const capabilities = data(await call('capabilities'));
  assert.equal(capabilities.protocol_version, 1);
  assert.ok(capabilities.methods.includes('mask_generate'));
  for (const [index, source] of sources.entries()) {
    const prefix = `${outputId}-${index + 1}`;
    const opened = data(await call('open_photo', { path: source }));
    const session_id = opened.session_id;
    assert.ok(typeof session_id === 'string');
    assert.notEqual(opened.working_path, source);
    const state = data(await call('get_session', { session_id, include_adjustments: true }));
    const original = await writePreview(await call('render', { session_id, original: true, long_edge: 1200 }), `${prefix}-original.jpg`);
    const changed = data(await call('set_adjustments', { session_id, expected_revision: state.revision, patch: { exposure: 0.4, highlights: -15, shadows: 10 } }));
    assert.ok(changed.revision > state.revision);
    await call('set_adjustments', { session_id, expected_revision: state.revision, patch: { exposure: 0.8 } }, true);
    await call('set_adjustments', { session_id, patch: { definitely_not_a_native_adjustment: 1 } }, true);
    const edited = await writePreview(await call('render', { session_id, long_edge: 1200 }), `${prefix}-edited.jpg`);
    assert.notEqual(edited, original, 'Real exposure edit must change rendered pixels');
    await call('analyze', { session_id, long_edge: 800, histogram: true, scopes: true });
    await writePreview(await call('render', { session_id, region: { x: 0, y: 0, width: 256, height: 256 } }), `${prefix}-detail.jpg`);
    const { width, height } = state.dimensions;
    const mask = data(await call('mask_create', { session_id, name: 'E2E local correction', type: 'radial', parameters: { centerX: width / 2, centerY: height / 2, radiusX: width / 5, radiusY: height / 5, rotation: 0, feather: 0.6 }, adjustments: { exposure: 0.25 } }));
    assert.ok(typeof mask.mask_id === 'string', 'Mask creation must identify the new mask');
    await writePreview(await call('render', { session_id, mask_id: mask.mask_id, long_edge: 800 }), `${prefix}-mask.jpg`);
    await call('mask_update', { session_id, mask_id: mask.mask_id, patch: { opacity: 80 } });
    await call('history', { session_id });
    await call('undo', { session_id });
    await call('redo', { session_id });
    await call('set_metadata', { session_id, rating: 4, tags: ['mcp-e2e'] });
    await call('get_metadata', { session_id });
    const recipePath = join(workspace, 'recipes', `${prefix}-recipe.json`);
    await call('save_recipe', { session_id, path: recipePath });
    JSON.parse(await readFile(recipePath, 'utf8'));
    await call('save_session', { session_id });
    const exportPath = join(workspace, 'exports', `${prefix}-delivery.jpg`);
    await call('export', { session_id, path: exportPath, format: 'jpeg', quality: 92, long_edge: 1600 });
    assert.ok((await stat(exportPath)).size > 1000);
    await call('export', { session_id, path: exportPath, format: 'jpeg' }, true);
    await call('export', { session_id, path: source, overwrite: true }, true);
    const masterPath = join(workspace, 'exports', `${prefix}-master.tiff`);
    await call('export', { session_id, path: masterPath, format: 'tiff', bit_depth: 16, keep_metadata: false });
    const precision = inspectTiff16(await readFile(masterPath));
    const finalState = data(await call('get_session', { session_id, include_adjustments: true }));
    const beforeRestart = await writePreview(await call('render', { session_id, long_edge: 800 }), `${prefix}-final.jpg`);
    await call('close_session', { session_id });
    await client.close();
    await connect();
    const restoredSessions = data(await call('list_sessions'));
    assert.ok(restoredSessions.sessions.some((session) => session.session_id === session_id), 'Saved session must return after process restart');
    const restored = data(await call('get_session', { session_id, include_adjustments: true }));
    assert.deepEqual(restored.adjustments, finalState.adjustments);
    assert.deepEqual(restored.metadata, finalState.metadata);
    assert.equal(restored.revision, finalState.revision);
    const afterRestart = await writePreview(await call('render', { session_id, long_edge: 800 }), `${prefix}-restored.jpg`);
    assert.equal(afterRestart, beforeRestart, 'Restored session must render identical pixels');
    const batchPath = join(workspace, 'exports', `${prefix}-batch.jpg`);
    const batch = data(await call('batch_export', { items: [{ session_id, path: batchPath }, { session_id: 'missing-session', path: join(workspace, 'exports', `${prefix}-missing.jpg`) }], options: { format: 'jpeg', long_edge: 800 } }, true));
    assert.equal(batch.succeeded, 1); assert.equal(batch.failed, 1);
    completed.push({ source, session_id, export_path: exportPath, master_path: masterPath, recipe_path: recipePath, precision });
  }
  for (const method of ['models', 'list_presets', 'list_luts', 'get_engine_settings']) await call(method);
  for (const original of originals) {
    assert.equal(await digest(original.source), original.sha256, 'Source bytes must remain unchanged');
    assert.equal(await sidecarDigest(original.source), original.sidecar_sha256, 'Original sidecar bytes/existence must remain unchanged');
  }
  await writeFile(join(workspace, `${outputId}-evidence.json`), JSON.stringify({ originals, sources_unchanged: true, completed, records }, null, 2));
  console.log(JSON.stringify({ status: 'passed', workspace, completed, calls: records.length }, null, 2));
} finally {
  await client?.close();
  for (const original of originals) {
    assert.equal(await digest(original.source), original.sha256, 'Source changed during the workflow');
    assert.equal(await sidecarDigest(original.source), original.sidecar_sha256, 'Original sidecar changed during the workflow');
  }
}
