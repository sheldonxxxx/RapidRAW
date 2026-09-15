import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../skills/rapidraw-mcp/scripts/mcp-client.mjs', import.meta.url));
const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/bridge.mjs', import.meta.url));
async function run(workspace, requests, extraArgs = []) {
  const child = spawn(process.execPath, [
    script,
    '--server',
    server,
    ...(extraArgs.includes('--connection') ? [] : ['--binary', binary]),
    '--workspace',
    workspace,
    ...extraArgs,
  ]);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const code = await new Promise((res, rej) => {
    child.once('exit', res);
    child.once('error', rej);
  });
  clearTimeout(timer);
  const records = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  return { code, records, stderr };
}

test('connection launcher keeps remote engine workspace separate from local response files', async () => {
  const local = await mkdtemp(join(tmpdir(), 'rr-client-local-'));
  const remote = await mkdtemp(join(tmpdir(), 'rr-client-remote-'));
  const connection = join(local, 'connection.json');
  await writeFile(
    connection,
    JSON.stringify({ command: process.execPath, args: [server, '--binary', binary, '--workspace', remote] }),
  );
  const { code, records } = await run(
    local,
    [
      { tool: 'capabilities' },
      { tool: 'render', arguments: { session_id: 'example', long_edge: 100 } },
      { close: true },
    ],
    ['--connection', connection],
  );
  assert.equal(code, 0);
  assert.ok(records[0].output_dir.startsWith(local + '/'));
  const response = JSON.parse(await readFile(records[1].response_path, 'utf8'));
  assert.equal(response.data.workspace, remote);
  assert.equal((await readFile(records[2].images[0])).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('connection launcher rejects unsupported shell and environment fields before starting a child', async () => {
  const local = await mkdtemp(join(tmpdir(), 'rr-client-invalid-'));
  const connection = join(local, 'connection.json');
  await writeFile(connection, JSON.stringify({ command: process.execPath, args: [], shell: true }));
  const { code, records, stderr } = await run(local, [{ close: true }], ['--connection', connection]);
  assert.equal(code, 1);
  assert.deepEqual(records, []);
  assert.match(stderr, /Connection must contain/);
});

test('skill client reads file-backed long masks, preserves image bytes, and saves full responses while printing selected fields', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-skill-success-'));
  const requestPath = join(workspace, 'mask-request.json');
  const points = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 10 }));
  await writeFile(
    requestPath,
    JSON.stringify([
      {
        tool: 'mask_create',
        arguments: { type: 'brush', parameters: { lines: [{ tool: 'brush', brushSize: 5, feather: 0.2, points }] } },
      },
    ]),
  );
  const { code, records } = await run(workspace, [
    { tool: 'capabilities', pick: ['protocol_version'] },
    { file: requestPath, index: 0, arguments: { session_id: 'live-session', expected_revision: 7 } },
    { tool: 'render', arguments: { session_id: 'example', long_edge: 100 } },
    { list_tools: ['retouch'] },
    { close: true },
  ]);
  assert.equal(code, 0);
  assert.deepEqual(records[1].data, { protocol_version: 1 });
  const mask = JSON.parse(await readFile(records[2].response_path, 'utf8'));
  assert.equal(mask.data.params.parameters.lines[0].points.length, 1000);
  assert.equal(mask.data.params.session_id, 'live-session');
  assert.equal(mask.data.params.expected_revision, 7);
  const bytes = await readFile(records[3].images[0]);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(records[3].data.revision, 2);
  assert.equal(records[4].data.tools[0].inputSchema.properties.token.type, 'string');
});

test('skill client stops on native error instead of executing queued edits', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-skill-error-'));
  const { code, records } = await run(workspace, [
    { tool: 'set_adjustments', arguments: { session_id: 'example', patch: { bad: 1 } } },
    { tool: 'set_adjustments', arguments: { session_id: 'must-not-run', patch: { exposure: 1 } } },
  ]);
  assert.equal(code, 1);
  assert.equal(records.length, 2);
  assert.equal(records[1].data.error.code, 'INVALID_ADJUSTMENT');
  assert.equal((await readdir(records[0].output_dir)).filter((p) => p.endsWith('.json')).length, 1);
});

test('client reads JSON resources selectively and never hides errors behind pick', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-client-resource-'));
  const { code, records } = await run(workspace, [
    { resource: 'rapidraw://sessions/asset-state', pick: ['revision', 'adjustments.masks'] },
    { tool: 'get_session', arguments: { session_id: 'asset-state', include_adjustments: true } },
    { tool: 'set_adjustments', arguments: { session_id: 'example', patch: { bad: 1 } }, pick: ['revision'] },
    { tool: 'set_adjustments', arguments: { session_id: 'must-not-run', patch: { exposure: 1 } } },
  ]);
  assert.equal(code, 1);
  assert.equal(records.length, 4);
  assert.equal(records[1].data['adjustments.masks'][0].id, 'subject');
  assert.equal(records[2].data.adjustments.masks[0].subMasks[0].parameters.samRefinement.canvasWidth, 100);
  assert.equal(records[3].data.error.code, 'INVALID_ADJUSTMENT');
  const resource = JSON.parse(await readFile(records[1].response_path, 'utf8'));
  assert.ok(JSON.stringify(resource).length < 3500);
  assert.equal(resource.data.adjustments.aiPatches[0].patchData.color._rapidraw_asset, true);
});

test('skill client reports uncertain timeout without replaying a queued mutation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-skill-timeout-'));
  const { code, records } = await run(workspace, [
    { tool: 'get_session', arguments: { session_id: 'stall' }, timeout_ms: 1000 },
    { tool: 'set_adjustments', arguments: { session_id: 'must-not-run', patch: { exposure: 1 } } },
  ]);
  assert.equal(code, 1);
  assert.equal(records.length, 2);
  assert.equal(records[1].phase, 'transport-or-output');
  assert.match(records[1].next, /operation may have completed/);
});

test('skill client forwards --timeout-ms to the server native timeout independently of the request wait', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-skill-native-timeout-'));
  const { code, records } = await run(
    workspace,
    [
      { tool: 'get_session', arguments: { session_id: 'stall' }, timeout_ms: 5000 },
      { tool: 'set_adjustments', arguments: { session_id: 'must-not-run', patch: { exposure: 1 } } },
    ],
    ['--timeout-ms', '100'],
  );
  assert.equal(code, 1);
  assert.equal(records.length, 2);
  assert.equal(records[1].isError, true);
  assert.equal(records[1].data.error.code, 'BRIDGE_TIMEOUT');
  assert.match(records[1].data.error.message, /exceeded 100 ms/);
});

test('skill client rejects invalid native timeout values before connecting', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rr-skill-invalid-timeout-'));
  for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
    const { code, records, stderr } = await run(workspace, [], ['--timeout-ms', value]);
    assert.equal(code, 2, value);
    assert.deepEqual(records, [], value);
    assert.match(stderr, /positive safe integer/, value);
  }
});
