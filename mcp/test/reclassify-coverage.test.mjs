import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvidence, hashFile, requiredInventory } from '../scripts/coverage-evidence.mjs';
const exec = promisify(execFile), script = fileURLToPath(new URL('../scripts/reclassify-coverage.mjs', import.meta.url));
async function fixture(t, status = 'passed') {
  const root = await mkdtemp(join(tmpdir(), 'rapidraw-historical-attribution-unit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'original'), output = join(root, 'corrected'); await mkdir(input);
  const tools = [{ name: 'rapidraw_retouch', inputSchema: { properties: { mode: { enum: ['clone', 'generative'] }, enabled: { type: 'boolean', default: true }, sub_masks: { items: { properties: { id: { type: 'string' }, type: { type: 'string' }, visible: { type: 'boolean' }, mode: { enum: ['additive', 'intersect'] }, parameters: { type: 'object' } } } } } } }];
  const capabilities = { adjustment_schema: { properties: { lensBlurEnabled: { type: 'boolean' } } } };
  const provenance = { runtime_tree_sha256: 'a'.repeat(64), binary_sha256: 'b'.repeat(64) };
  const requirements = requiredInventory(tools, capabilities);
  // This is a pure CLI contract fixture, not execution of a native engine.
  const base = { evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp' };
  const records = [
    { ...base, id: 'legacy:1', type: 'call', method: 'retouch', args: { mode: 'clone', sub_masks: [{ id: 'stroke', type: 'clone', visible: true, mode: 'additive', parameters: {} }] }, requirements: ['tool:retouch', 'parameter:retouch.mode', 'parameter:retouch.mode="clone"', 'parameter:retouch.sub_masks', 'parameter:retouch.sub_masks[]<clone>.id', 'parameter:retouch.sub_masks[]<clone>.type', 'parameter:retouch.sub_masks[]<clone>.visible', 'parameter:retouch.sub_masks[]<clone>.visible=true', 'parameter:retouch.sub_masks[]<clone>.mode', 'parameter:retouch.sub_masks[]<clone>.mode="additive"', 'parameter:retouch.sub_masks[]<clone>.parameters'], status: 'passed', level: 'native_call', result: { lensBlurEnabled: true } },
    { ...base, id: 'legacy:2', type: 'call', method: 'retouch', args: { mode: 'generative' }, requirements: ['parameter:retouch.mode="generative"'], status: 'skipped', level: 'native_assertion', reason: 'Provider unavailable' },
    { ...base, id: 'legacy:3', type: 'check', requirements: ['tool:retouch'], status: 'passed', level: 'pixel_assertion' },
  ];
  const report = aggregateEvidence(requirements, records);
  for (const [name, data] of [
    ['inventory.json', { provenance, tools, capabilities, requirements }],
    ['summary.json', { provenance, status, calls: 2, ...report.totals }],
    ['coverage.json', { provenance, ...report }],
  ]) await writeFile(join(input, name), JSON.stringify(data));
  await writeFile(join(input, 'evidence.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { root, input, output, requirements };
}
const run = ({ input, output }) => exec(process.execPath, [script, '--output', output, input]);
test('historical correction repairs seven recorded generic fields without new calls, defaults or quality credit', async (t) => {
  const f = await fixture(t), filenames = await readdir(f.input);
  const before = await Promise.all(filenames.map((name) => hashFile(join(f.input, name))));
  await run(f);
  const result = JSON.parse(await readFile(join(f.output, 'corrected-coverage.json'), 'utf8'));
  assert.deepEqual(result.requirements.map((row) => row.id), f.requirements);
  assert.equal(result.reclassification.new_native_calls, 0); assert.equal(result.reclassification.reconstructed_successful_calls, 1);
  assert.equal(result.reclassification.changed_requirements.length, 7);
  assert.equal(result.totals.native_call - result.reclassification.original_totals.native_call, 7);
  assert.equal(result.totals.pixel_assertion, 1); assert.equal(result.totals.visual_review, 0);
  for (const id of ['parameter:retouch.enabled=true', 'parameter:retouch.mode="generative"', 'adjustment:lensBlurEnabled=true']) assert.deepEqual(result.requirements.find((row) => row.id === id).levels, [], id);
  assert.deepEqual(await Promise.all(filenames.map((name) => hashFile(join(f.input, name)))), before);
  await assert.rejects(readFile(join(f.output, 'evidence.jsonl')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.output, 'summary.json')), { code: 'ENOENT' });
});
test('historical correction refuses failed runs, missing schemas and changed inventory before writing output', async (t) => {
  for (const mode of ['failed', 'missing-schema', 'changed-inventory']) await t.test(mode, async (t) => {
    const f = await fixture(t, mode === 'failed' ? 'failed' : 'passed');
    if (mode !== 'failed') { const path = join(f.input, 'inventory.json'), data = JSON.parse(await readFile(path, 'utf8')); if (mode === 'missing-schema') delete data.tools; else data.requirements.push('tool:invented'); await writeFile(path, JSON.stringify(data)); }
    await assert.rejects(run(f)); await assert.rejects(readdir(f.output), { code: 'ENOENT' });
  });
});
test('historical correction never writes into a source run and never overwrites a previous correction', async (t) => {
  const f = await fixture(t);
  await assert.rejects(run({ ...f, output: join(f.input, 'correction') }), (error) => { assert.match(error.stderr, /outside original run/); return true; });
  await run(f); const hash = await hashFile(join(f.output, 'reclassification.json'));
  await assert.rejects(run(f), (error) => { assert.match(error.stderr, /EEXIST/); return true; });
  assert.equal(await hashFile(join(f.output, 'reclassification.json')), hash);
});
