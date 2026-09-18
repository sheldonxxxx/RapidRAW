/** Opt-in native acceptance against a real connector and caller-owned photograph. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { requireFreeSpace } from '../dist/storage.js';
import { decodePng, pixelDifference } from './png-fixtures.mjs';
import { inspectTiff16 } from './tiff-inspect.mjs';
import { sanitize, hashFile, nativeExecutableFormat } from './coverage-evidence.mjs';

const binary = process.env.RAPIDRAW_BINARY;
const source = process.env.RAPIDRAW_TEST_IMAGE;
const address = process.env.RAPIDRAW_CONNECTOR;
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/surfaces-${Date.now()}`);
assert.ok(
  binary && isAbsolute(binary) && source && isAbsolute(source) && address,
  'Set RAPIDRAW_BINARY, RAPIDRAW_TEST_IMAGE (absolute paths) and RAPIDRAW_CONNECTOR',
);
nativeExecutableFormat(await readFile(binary));
await requireFreeSpace(dirname(workspace));
await mkdir(workspace); // Refuse a previous run instead of overwriting evidence.
const originalHash = await hashFile(source);
const sidecarHash = await hashFile(source + '.rrdata').catch((e) => {
  if (e.code === 'ENOENT') return null;
  throw e;
});
const point = JSON.parse(process.env.RAPIDRAW_SURFACE_POINT ?? '[0.5,0.5]');
let client, sid, revision;
const events = [],
  checks = [];
const digest = (b) => createHash('sha256').update(b).digest('hex');
async function connect(enabled) {
  await writeFile(
    join(workspace, 'engine-settings.json'),
    JSON.stringify({
      marigoldSurfaceEnabled: enabled,
      aiConnectorAddress: enabled ? address : '127.0.0.1:1',
    }),
  );
  client = new Client({ name: 'surface-native-acceptance', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../dist/index.js', import.meta.url)),
        '--binary',
        binary,
        '--workspace',
        workspace,
        '--timeout-ms',
        '900000',
      ],
      stderr: 'inherit',
      env: { ...process.env },
    }),
  );
}
async function call(method, args = {}, error = false) {
  const start = Date.now();
  const result = await client.callTool({ name: 'rapidraw_' + method, arguments: args }, { timeout: 900000 });
  const data = result.structuredContent;
  events.push(sanitize({ method, args, ms: Date.now() - start, error: !!result.isError, data }));
  await writeFile(join(workspace, 'events.json'), JSON.stringify(events, null, 2));
  console.log(method, Date.now() - start, result.isError ? JSON.stringify(data) : 'ok');
  assert.equal(!!result.isError, error, JSON.stringify(data));
  if (data?.session_id === sid && typeof data.revision === 'number') revision = data.revision;
  return { data, result };
}
async function mutate(method, args = {}, error = false) {
  return (await call(method, { session_id: sid, expected_revision: revision, ...args }, error)).data;
}
async function render(name, extra = {}) {
  const { result } = await call('render', { session_id: sid, format: 'png', long_edge: 1024, ...extra });
  const bytes = Buffer.from(result.content.find((c) => c.type === 'image').data, 'base64');
  await writeFile(join(workspace, name + '.png'), bytes);
  return decodePng(bytes);
}
function identical(label, a, b, region) {
  const diff = pixelDifference(a, b, region);
  assert.equal(diff.maximum, 0, label);
  checks.push({ label, ...diff });
}
async function update(mask, parameters) {
  return mutate('mask_update', {
    mask_id: mask.mask_id,
    submask_operations: [{ operation: 'edit', submask_id: mask.sub_mask_id, patch: { parameters } }],
  });
}
async function region(mask, w, h) {
  return mutate('mask_update', {
    mask_id: mask.mask_id,
    submask_operations: [
      {
        operation: 'add',
        submask: {
          type: 'radial',
          mode: 'intersect',
          parameters: {
            centerX: w * 0.5,
            centerY: h * 0.5,
            radiusX: w * 0.4,
            radiusY: h * 0.48,
            rotation: 0,
            feather: 0.1,
          },
        },
      },
    ],
  });
}
try {
  await connect(false);
  const opened = (await call('open_photo', { path: source, inherit_sidecar: false })).data;
  sid = opened.session_id;
  revision = opened.revision;
  const w = opened.dimensions.width,
    h = opened.dimensions.height;
  await mutate('set_adjustments', { patch: { exposure: Number(process.env.RAPIDRAW_SURFACE_EXPOSURE ?? 0) } });
  const base = await render('baseline');
  for (const kind of ['normals', 'albedo']) await mutate('mask_generate', { kind }, true);
  identical('disabled features preserve baseline', base, await render('disabled'));
  await client.close();
  await connect(true);
  const normals = await mutate('mask_generate', {
    kind: 'normals',
    name: 'Directional light',
    parameters: { normalAmount: 0 },
  });
  identical('normal amount zero', base, await render('normal-zero'));
  await region(normals, w, h);
  await update(normals, { normalAmount: 0.65, normalAngle: 0 });
  const lit = await render('normals');
  assert.ok(pixelDifference(base, lit).maximum > 0, 'Normals change pixels');
  identical('normal protected left edge', base, lit, {
    x: 0,
    y: 0,
    width: Math.floor(base.width * 0.08),
    height: base.height,
  });
  await update(normals, { normalAngle: 90 });
  assert.ok(pixelDifference(lit, await render('normals-up')).maximum > 0, 'Direction changes native output');
  await mutate('undo');
  identical('normal undo', lit, await render('normals-undo'));
  await mutate('redo');
  await update(normals, { normalAngle: 0 });
  await mutate('mask_update', { mask_id: normals.mask_id, patch: { visible: false } });
  identical('normal hidden', base, await render('normals-hidden'));
  const albedo = await mutate('mask_generate', {
    kind: 'albedo',
    name: 'Albedo colour',
    parameters: {
      surfacePointX: point[0],
      surfacePointY: point[1],
      surfaceTolerance: 0.13,
      surfaceAmount: 0,
      surfaceColor: [90, 160, 220],
    },
  });
  identical('albedo amount zero', base, await render('albedo-zero'));
  await region(albedo, w, h);
  await update(albedo, { surfaceAmount: 0.75 });
  const recoloured = await render('albedo');
  assert.ok(pixelDifference(base, recoloured).maximum > 0, 'Choose a nonblack colour point for this fixture');
  identical('albedo protected left edge', base, recoloured, {
    x: 0,
    y: 0,
    width: Math.floor(base.width * 0.08),
    height: base.height,
  });
  await render('albedo-mask', { mask_id: albedo.mask_id, mask_mode: 'grayscale' });
  await mutate('mask_update', { mask_id: normals.mask_id, patch: { visible: true } });
  const both = await render('both');
  const state = (await call('get_session', { session_id: sid, include_adjustments: true })).data;
  const artifacts = state.adjustments.masks.map((m) => m.subMasks[0].parameters.surfaceArtifact);
  assert.deepEqual(
    artifacts.map((a) => a.kind),
    ['normals', 'albedo'],
  );
  assert.ok(!JSON.stringify(state).includes('data:image/png;base64,'), 'Map data stays opaque to models');
  await call('save_session', { session_id: sid });
  const bundle = (await call('export_session_bundle', { session_id: sid, name: 'surface-offline' })).data;
  const full = (await call('export', { session_id: sid, path: 'surface-native.png', format: 'png' })).data;
  await mutate('mask_update', { mask_id: normals.mask_id, patch: { visible: false } });
  await mutate('mask_update', { mask_id: albedo.mask_id, patch: { visible: false } });
  const baselineExport = (await call('export', { session_id: sid, path: 'surface-baseline.png', format: 'png' })).data;
  await mutate('mask_update', { mask_id: normals.mask_id, patch: { visible: true } });
  await mutate('mask_update', { mask_id: albedo.mask_id, patch: { visible: true } });
  await call('save_session', { session_id: sid });
  await client.close();
  await connect(false);
  identical('reopen offline', both, await render('reopened-offline'));
  const imported = (await call('import_session_bundle', { path: bundle.path })).data;
  const oldSid = sid;
  sid = imported.session_id;
  revision = imported.revision;
  identical('portable offline', both, await render('portable-offline'));
  await mutate('set_adjustments', {
    patch: {
      orientationSteps: 1,
      flipHorizontal: true,
      crop: { x: 20, y: 30, width: Math.floor(h * 0.8), height: Math.floor(w * 0.8), unit: 'px' },
    },
  });
  const rotated = await render('rotated-crop');
  await call('save_session', { session_id: sid });
  await client.close();
  await connect(false);
  identical('rotated crop offline', rotated, await render('rotated-offline'));
  sid = oldSid;
  revision = (await call('get_session', { session_id: sid })).data.revision;
  await mutate('set_adjustments', { patch: { transformRotate: 2 } });
  const stale = await render('stale-geometry');
  await mutate('mask_update', { mask_id: normals.mask_id, patch: { visible: false } });
  await mutate('mask_update', { mask_id: albedo.mask_id, patch: { visible: false } });
  identical('stale maps have no effect', stale, await render('stale-disabled'));
  await mutate('undo');
  await mutate('undo');
  await mutate('undo');
  identical('undo restores map alignment', both, await render('restored'));
  const tiff = (
    await call('export', {
      session_id: sid,
      path: 'surface-native.tiff',
      format: 'tiff',
      bit_depth: 16,
      long_edge: 1024,
    })
  ).data;
  const precision = inspectTiff16(await readFile(tiff.path));
  assert.equal(await hashFile(source), originalHash);
  assert.equal(
    await hashFile(source + '.rrdata').catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    }),
    sidecarHash,
  );
  checks.push({ label: 'original photo and sidecar unchanged', source_sha256: originalHash });
  await writeFile(
    join(workspace, 'success.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        sid,
        revision,
        artifacts,
        full,
        baselineExport,
        tiff,
        precision,
        bundle,
        engine_sha256: await hashFile(binary),
        source_sha256: originalHash,
        render_sha256: digest(Buffer.from(both.pixels)),
        scope: 'Native pixels and persistence; photographic quality requires separate visual review.',
      },
      null,
      2,
    ),
  );
  console.log('PASS', workspace);
} finally {
  await client?.close();
}
