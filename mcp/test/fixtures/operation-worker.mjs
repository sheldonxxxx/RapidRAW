#!/usr/bin/env node
// Fake process for worker-lifecycle tests only. It grants no native/pixel coverage.
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const workspace = process.argv[process.argv.indexOf('--workspace') + 1];
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'worker.pid'), String(process.pid));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  let result = { session_id: 'worker-session', method, params };
  if (method === 'import_session_bundle') result.revision = 11;
  if (method === 'export_session_bundle') {
    const path = join(workspace, 'bundles', 'result'); await mkdir(path, { recursive: true });
    result = { path, manifest_sha256: '0'.repeat(64) };
  }
  if (['merge', 'export', 'negative_convert', 'mask_generate', 'generate_depth', 'retouch', 'enhance'].includes(method)) {
    if (process.env.FAKE_OPERATION_STALL === '1') { await new Promise(() => {}); }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settings = await readFile(join(workspace, 'engine-settings.json'), 'utf8').then(JSON.parse).catch(() => null);
    const models = {};
    for (const name of await readdir(join(workspace, 'models')).catch(() => [])) models[name] = await readFile(join(workspace, 'models', name), 'utf8');
    result = { ...result, settings, models, path: join(workspace, 'exports', 'delivery.png') };
  }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

// Keep teardown pending after stdin EOF to exercise terminal-status handoff.
if (process.env.FAKE_CLOSE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLOSE_DELAY_MS)));
