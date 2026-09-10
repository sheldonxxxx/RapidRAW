/** Native advanced-feature acceptance test through a real MCP stdio client.
 * Uses a small engine-produced sample for bounded inference/merge tests.
 * This verifies operation behavior, not whether a scene is suitable for HDR
 * or panorama or whether an automatic edit deserves a professional rating.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const binary = process.env.RAPIDRAW_BINARY;
const source = process.env.RAPIDRAW_TEST_IMAGE;
const workspace = process.env.RAPIDRAW_WORKSPACE ?? resolve('test-output/advanced-e2e');
assert.ok(binary && isAbsolute(binary), 'Set RAPIDRAW_BINARY to the built fork executable');
assert.ok(source && isAbsolute(source), 'Set RAPIDRAW_TEST_IMAGE to a real source photo');
await mkdir(workspace, { recursive: true });
const stamp = String(Date.now());
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const sourceDigest = await digest(source);
const sourceSidecar = `${source}.rrdata`;
let sidecarBefore;
try { sidecarBefore = await readFile(sourceSidecar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const modelDirectory = process.env.RAPIDRAW_INSTALLED_MODELS;
const originalModels = {};
if (modelDirectory) {
  for (const name of await readdir(modelDirectory)) {
    if (name.endsWith('.onnx')) originalModels[name] = await digest(join(modelDirectory, name));
  }
}
const client = new Client({ name: 'rapidraw-advanced-engine-e2e', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace, '--timeout-ms', '900000'],
  stderr: 'pipe',
});
let diagnostics = '';
transport.stderr.on('data', (chunk) => { diagnostics += chunk; process.stderr.write(chunk); });
const records = [];
async function call(method, args = {}, allowedError) {
  const started = performance.now();
  process.stdout.write(`Running ${method}${args.kind ? ` ${args.kind}` : ''}${args.mode ? ` ${args.mode}` : ''}\n`);
  const result = await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout: 900000 });
  const data = result.structuredContent;
  assert.ok(data, `${method} must return structured content`);
  const record = { method, args, elapsed_ms: Math.round(performance.now() - started), is_error: !!result.isError, result: data };
  // Avoid duplicating large embedded native recipes in evidence.
  if (record.result.adjustments) record.result = { ...record.result, adjustments: '[captured in saved session]' };
  records.push(record);
  await writeEvidence('running');
  if (result.isError) {
    assert.ok(allowedError && allowedError.test(JSON.stringify(data)), `${method}: ${JSON.stringify(data)}`);
  } else if (allowedError === 'required') {
    assert.fail(`${method} should reject the invalid request`);
  }
  return { result, data, failed: !!result.isError };
}
async function writeEvidence(status, error) {
  await writeFile(join(workspace, `${stamp}-advanced-evidence.json`), JSON.stringify({ status, error, source, source_sha256: sourceDigest, installed_model_sha256: originalModels, records }, null, 2));
  await writeFile(join(workspace, `${stamp}-diagnostics.log`), diagnostics);
}
async function preview(result, label) {
  const image = result.content.find((block) => block.type === 'image');
  assert.ok(image && image.data.length > 100, `${label}: expected actual image bytes`);
  await writeFile(join(workspace, `${stamp}-${label}.png`), Buffer.from(image.data, 'base64'));
}
try {
  await client.connect(transport);
  const opened = (await call('open_photo', { path: source, inherit_sidecar: false })).data;
  const rawSession = opened.session_id;
  const seedPath = join(workspace, 'exports', `${stamp}-advanced-seed.jpg`);
  await call('export', { session_id: rawSession, path: seedPath, format: 'jpeg', quality: 98, long_edge: 512, keep_metadata: true });
  const base = (await call('open_photo', { path: seedPath, inherit_sidecar: false })).data;
  const session_id = base.session_id;
  const { width, height } = base.dimensions;
  await preview((await call('render', { session_id, long_edge: 512, format: 'png' })).result, 'baseline');

  await call('models');
  for (const kind of ['masks', 'inpaint', 'denoise']) await call('install_model', { kind });
  const ready = (await call('models')).data;
  for (const kind of ['masks', 'inpaint', 'denoise']) assert.equal(ready.groups[kind].ready, true);

  for (const kind of ['subject', 'foreground', 'sky', 'depth']) {
    const generated = await call('mask_generate', {
      session_id, kind,
      ...(kind === 'subject' ? { region: { x: width * 0.1, y: height * 0.05, width: width * 0.8, height: height * 0.9 } } : {}),
      ...(kind === 'depth' ? { parameters: { minDepth: 20, maxDepth: 80, minFade: 10, maxFade: 10, feather: 5 } } : {}),
      adjustments: { exposure: 0.2 },
    }, kind === 'sky' ? /EMPTY_MASK/ : undefined);
    if (!generated.failed) {
      assert.ok(generated.data.mask_statistics.mean_opacity > 0);
      await preview(generated.result, `${kind}-mask`);
      await preview((await call('render', { session_id, format: 'png', long_edge: 512 })).result, `${kind}-edited`);
      await call('mask_remove', { session_id, mask_id: generated.data.mask_id });
    }
  }
  const depth = await call('generate_depth', { session_id, enable_blur: true });
  await preview(depth.result, 'depth-map');
  await preview((await call('render', { session_id, format: 'png', long_edge: 512 })).result, 'lens-blur');
  await call('set_adjustments', { session_id, patch: { lensBlurEnabled: false } });

  for (const mode of ['clone', 'heal', 'retouch', 'liquify', 'inpaint']) {
    const kind = mode === 'inpaint' ? 'brush' : mode;
    const parameters = {
      lines: [{ tool: 'brush', brushSize: Math.max(18, width * 0.05), feather: 0.6, points: [{ x: width * 0.45, y: height * 0.45 }, { x: width * 0.5, y: height * 0.5 }] }],
      ...(mode === 'retouch' ? { intensity: 50 } : {}),
      ...(mode === 'liquify' ? { pressure: 40, liquifyMode: 'push' } : {}),
    };
    const retouched = await call('retouch', { session_id, mode,
      sub_masks: [{ id: `${stamp}-${mode}-stroke`, type: kind, visible: true, mode: 'additive', parameters }],
      ...(['clone', 'heal'].includes(mode) ? { source_point: { x: width * 0.2, y: height * 0.25 } } : {}),
    });
    assert.ok(retouched.data.patch_id);
    assert.ok(retouched.data.mask_statistics.nonzero_fraction > 0);
    await preview(retouched.result, `${mode}-mask`);
    await preview((await call('render', { session_id, format: 'png', long_edge: 512 })).result, `${mode}-result`);
    await call('undo', { session_id });
  }
  await call('retouch', { session_id, mode: 'generative', sub_masks: [{ id: `${stamp}-invalid-remote`, type: 'all', visible: true, mode: 'additive', parameters: {} }] }, /INVALID_ARGUMENT|GENERATION_NOT_CONFIGURED/);

  const parentBefore = (await call('get_session', { session_id, include_adjustments: true })).data;
  for (const method of ['ai', 'bm3d']) {
    const denoised = (await call('denoise', { session_id, method, intensity: 25 })).data;
    assert.notEqual(denoised.session_id, session_id);
    assert.equal(denoised.parent_session_id, session_id);
    assert.equal(denoised.inherited_adjustments, true);
    await preview((await call('render', { session_id: denoised.session_id, format: 'png', long_edge: 512 })).result, `denoise-${method}`);
  }
  assert.equal((await call('get_session', { session_id })).data.revision, parentBefore.revision);
  const negative = (await call('negative_convert', { session_id, parameters: { red_weight: 1, green_weight: 1, blue_weight: 1, exposure: 0, contrast: 1 } })).data;
  assert.notEqual(negative.session_id, session_id);
  await preview((await call('render', { session_id: negative.session_id, format: 'png', long_edge: 512 })).result, 'negative-conversion');
  await call('lens_profile', { session_id: rawSession, mode: 'lookup' });
  await call('lens_profile', { session_id: rawSession, mode: 'auto' }, /LENS_PROFILE_NOT_FOUND/);

  for (const kind of ['hdr', 'focus', 'panorama']) {
    // Preserve detailed native feature descriptors for the panorama fixture.
    let mergePath = seedPath;
    if (kind === 'panorama') {
      mergePath = join(workspace, 'exports', `${stamp}-panorama-seed.jpg`);
      await call('export', { session_id: rawSession, path: mergePath, format: 'jpeg', quality: 98, long_edge: 2048, keep_metadata: true });
    }
    const merged = (await call('merge', { kind, paths: [mergePath, mergePath] })).data;
    assert.equal(merged.parent_session_ids.length, 2);
    assert.equal(merged.merge_kind, kind);
    await preview((await call('render', { session_id: merged.session_id, format: 'png', long_edge: 512 })).result, `merge-${kind}`);
  }
  await call('save_session', { session_id });
  assert.equal(await digest(source), sourceDigest, 'Original source changed');
  let sidecarAfter;
  try { sidecarAfter = await readFile(sourceSidecar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.deepEqual(sidecarAfter, sidecarBefore, 'Original sidecar changed');
  for (const [name, before] of Object.entries(originalModels)) assert.equal(await digest(join(modelDirectory, name)), before, `Installed model ${name} changed`);
  await writeEvidence('passed');
  console.log(JSON.stringify({ status: 'passed', workspace, calls: records.length, evidence: join(workspace, `${stamp}-advanced-evidence.json`) }, null, 2));
} catch (error) {
  await writeEvidence('failed', error.message);
  throw error;
} finally {
  await client.close();
  assert.equal(await digest(source), sourceDigest, 'Original source changed');
  let finalSidecar;
  try { finalSidecar = await readFile(sourceSidecar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.deepEqual(finalSidecar, sidecarBefore, 'Original sidecar changed');
  for (const [name, before] of Object.entries(originalModels)) assert.equal(await digest(join(modelDirectory, name)), before, `Installed model ${name} changed`);
}
