import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/bridge.mjs', import.meta.url));

async function connect(t) {
  const folder = await mkdtemp(join(tmpdir(), 'rapidraw-mcp-'));
  const pidFile = join(folder, 'pid');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--binary', binary, '--workspace', folder], env: { ...process.env, FAKE_PID_FILE: pidFile }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', (chunk) => { diagnostics += chunk; });
  const client = new Client({ name: 'rapidraw-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, pidFile, diagnostics: () => diagnostics };
}

test('real SDK stdio handshake exposes comprehensive strict tools, resources and workflow prompt', async (t) => {
  const { client, diagnostics } = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 37);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith('rapidraw_'));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const resources = await client.listResources();
  assert.ok(resources.resources.some((r) => r.uri === 'rapidraw://workflow'));
  const workflow = await client.readResource({ uri: 'rapidraw://workflow' });
  assert.match(workflow.contents[0].text, /native-detail/);
  const schema = await client.readResource({ uri: 'rapidraw://adjustment-schema' });
  assert.equal(JSON.parse(schema.contents[0].text).protocol_version, 1);
  const session = await client.readResource({ uri: 'rapidraw://sessions/test-session' });
  assert.equal(JSON.parse(session.contents[0].text).params.include_adjustments, true);
  const prompt = await client.getPrompt({ name: 'pro_photo_edit', arguments: { path: '/photos/test.cr3' } });
  assert.equal(prompt.messages.length, 2);
  assert.match(prompt.messages[1].content.text, /test.cr3/);
  assert.match(diagnostics(), /Native startup diagnostic/);
});

test('image bytes use MCP content without duplicating base64 in structured data', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({ name: 'rapidraw_render', arguments: { session_id: 'test-session', long_edge: 1600 } });
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.image.mimeType, 'image/png');
  assert.equal(result.structuredContent.image.data, undefined);
  assert.ok(result.content.some((block) => block.type === 'image' && block.data.startsWith('iVBOR')));
  assert.ok(!result.content[0].text.includes('iVBOR'));
});

test('invalid tool arguments and engine errors remain actionable errors', async (t) => {
  const { client } = await connect(t);
  const invalid = await client.callTool({ name: 'rapidraw_export', arguments: { session_id: 'test-session', path: '/tmp/a.jpg', quality: 101 } });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({ name: 'rapidraw_render', arguments: { session_id: 'test-session', typo: true } });
  assert.equal(unknown.isError, true);
  const error = await client.callTool({ name: 'rapidraw_set_adjustments', arguments: { session_id: 'test-session', patch: { bad: 1 } } });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent.error.code, 'INVALID_ADJUSTMENT');
  const followup = await client.callTool({ name: 'rapidraw_get_session', arguments: { session_id: 'test-session' } });
  assert.ok(!followup.isError);
});

test('client disconnect terminates the owned native process', async (t) => {
  const { client, pidFile } = await connect(t);
  await client.callTool({ name: 'rapidraw_capabilities', arguments: {} });
  const pid = Number(await readFile(pidFile, 'utf8'));
  process.kill(pid, 0);
  await client.close();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Native process ${pid} remained alive after client disconnect`);
});


test('batch partial failure is an MCP tool error with successful item evidence preserved', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({ name: 'rapidraw_batch_export', arguments: { items: [{ session_id: 'good', path: '/tmp/ok.jpg' }, { session_id: 'missing', path: '/tmp/bad.jpg' }] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.failed, 1);
  assert.equal(result.structuredContent.succeeded, 1);
  assert.equal(result.structuredContent.results[0].ok, true);
});

test('official legacy SDK v1 client interoperates through the MCP 2025 initialize flow', async (t) => {
  const { Client: LegacyClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport: LegacyTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const folder = await mkdtemp(join(tmpdir(), 'rapidraw-mcp-legacy-'));
  const transport = new LegacyTransport({ command: process.execPath, args: [serverPath, '--binary', binary, '--workspace', folder], stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  let offeredVersion;
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (message.method === 'initialize') offeredVersion = message.params.protocolVersion;
    return send(message, options);
  };
  const client = new LegacyClient({ name: 'rapidraw-legacy-compatibility', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.match(offeredVersion, /^2025-/);
  assert.equal((await client.listTools()).tools.length, 37);
  const preview = await client.callTool({ name: 'rapidraw_render', arguments: { session_id: 'legacy-test', long_edge: 1600 } });
  assert.ok(preview.content.some((item) => item.type === 'image'));
  assert.equal(preview.structuredContent.width, 1);
  const workflow = await client.readResource({ uri: 'rapidraw://workflow' });
  assert.match(workflow.contents[0].text, /professional/);
  const prompt = await client.getPrompt({ name: 'pro_photo_edit', arguments: { path: '/photos/legacy.cr3' } });
  assert.equal(prompt.messages.length, 2);
});


test('export resize options validate dimensions and default to no enlargement', async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({ name: 'rapidraw_export', arguments: { session_id: 'test-session', path: '/tmp/resize.jpg', resize: { mode: 'width', value: 1200 } } });
  assert.ok(!result.isError);
  assert.deepEqual(result.structuredContent.params.resize, { mode: 'width', value: 1200, dont_enlarge: true });
  const invalid = await client.callTool({ name: 'rapidraw_export', arguments: { session_id: 'test-session', path: '/tmp/resize.jpg', resize: { mode: 'height', value: 0 } } });
  assert.equal(invalid.isError, true);
});
