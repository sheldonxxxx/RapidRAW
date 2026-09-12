import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateEvidence, requiredInventory, observedRequirements, nativeExecutableFormat, isRuntimeSource, sanitize, createNativeHarness } from '../scripts/coverage-evidence.mjs';
import { decodePng, fixturePng, mean, pixelDifference } from '../scripts/png-fixtures.mjs';
import { classifyRequirement } from '../scripts/coverage-classification.mjs';

test('schema inventory includes tools, boolean modes, nested adjustments and discriminated mask parameters', () => {
  const tools = [{ name: 'rapidraw_example', inputSchema: { properties: { mode: { enum: ['one', 'two'] }, enabled: { type: 'boolean' } } } }];
  const capabilities = { adjustment_schema: { properties: { exposure: { type: 'number' }, masks: { items: { oneOf: [{ properties: { type: { const: 'flow' }, flow: { type: 'number' } } }, { properties: { type: { const: 'brush' }, feather: { type: 'number' } } }] } } } } };
  const inventory = requiredInventory(tools, capabilities);
  for (const id of ['tool:example', 'parameter:example.mode="two"', 'parameter:example.enabled=false', 'adjustment:exposure', 'adjustment:masks[]<flow>.flow', 'adjustment:masks[]<brush>.feather']) assert.ok(inventory.includes(id), id);
  assert.ok(!inventory.includes('adjustment:masks[]<brush>.flow'));
});
test('native evidence refuses script/mock executables before connecting', () => {
  assert.equal(nativeExecutableFormat(Buffer.from('7f454c46', 'hex')), 'ELF');
  assert.equal(nativeExecutableFormat(Buffer.from('cffaedfe', 'hex')), 'Mach-O');
  assert.equal(nativeExecutableFormat(Buffer.from('MZ00')), 'PE');
  assert.throws(() => nativeExecutableFormat(Buffer.from('#!/usr/bin/env node')), /not a script or mock/);
});
test('acceptance retries cannot overwrite prior evidence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rapidraw-evidence-preservation-'));
  try {
    const binary = join(workspace, 'never-executed-header-fixture');
    await writeFile(binary, Buffer.from('7f454c46', 'hex'));
    const prior = '{"status":"failed","error":"first attempt"}\n';
    await writeFile(join(workspace, 'evidence.jsonl'), prior);
    await assert.rejects(createNativeHarness({ suite: 'unit-no-native-execution', workspace, binary }), { code: 'EEXIST' });
    assert.equal(await readFile(join(workspace, 'evidence.jsonl'), 'utf8'), prior);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
test('runtime provenance includes actual engine/server code but separates suite and documentation edits', () => {
  for (const path of ['src-tauri/src/mcp_bridge/portable.rs', 'src-tauri/Cargo.lock', 'src/utils/adjustments.ts', 'mcp/src/tools.ts', 'mcp/package-lock.json']) assert.equal(isRuntimeSource(path), true, path);
  for (const path of ['mcp/VERIFICATION.md', 'mcp/scripts/coverage-e2e.mjs', 'mcp/test/coverage-evidence.test.mjs', 'test-output/evidence.jsonl']) assert.equal(isRuntimeSource(path), false, path);
});
test('mock calls, skipped tests and native errors never earn native or pixel credit', () => {
  const base = { evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', requirements: ['tool:render'], id: '1' };
  const result = aggregateEvidence(['tool:render', 'adjustment:exposure'], [
    { ...base, execution: 'fake_native', level: 'pixel_assertion', status: 'passed' },
    { ...base, level: 'pixel_assertion', status: 'skipped', reason: 'No decoder' },
    { ...base, level: 'native_call', status: 'failed', error: 'GPU error' },
    { ...base, level: 'native_call', status: 'passed' },
  ]);
  assert.deepEqual(result.requirements[0].levels, ['native_call']); assert.equal(result.requirements[0].failures.length, 1); assert.equal(result.totals.pixel_assertion, 0); assert.equal(result.totals.untested, 1);
});
test('pixel assertions credit only explicit requirements and never infer visual review', () => {
  const result = aggregateEvidence(['tool:render', 'adjustment:exposure', 'adjustment:sharpness'], [{ evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', requirements: ['adjustment:exposure'], id: '1', level: 'pixel_assertion', status: 'passed' }]);
  assert.equal(result.totals.pixel_assertion, 1); assert.equal(result.totals.visual_review, 0); assert.deepEqual(result.requirements[2].levels, []);
});
test('actual arguments grant observed-parameter call credit without inferring defaults', () => {
  const capabilities = { adjustment_schema: { properties: { masks: { items: { properties: { subMasks: { items: { oneOf: [{ properties: { type: { const: 'flow' }, mode: { enum: ['intersect'] }, parameters: { properties: { lines: { type: 'array' } } } } }, { properties: { type: { const: 'brush' } } }] } } } } } } } };
  const observed = observedRequirements('set_adjustments', { session_id: 'fixture', patch: { exposure: 1, masks: [{ subMasks: [{ type: 'flow', mode: 'intersect', parameters: { lines: [] } }] }] } }, { capabilities });
  for (const id of ['tool:set_adjustments', 'parameter:set_adjustments.session_id', 'adjustment:exposure', 'adjustment:masks[].subMasks[]<flow>.mode="intersect"']) assert.ok(observed.includes(id), id);
  assert.ok(!observed.includes('adjustment:sharpness'));
});
test('generic retouch schema records real submask fields without inventing native discriminators', () => {
  const tools = [{ name: 'rapidraw_retouch', inputSchema: { properties: { sub_masks: { items: { properties: { id: { type: 'string' }, type: { type: 'string' }, visible: { type: 'boolean' }, mode: { enum: ['additive', 'intersect'] }, parameters: { type: 'object' } } } } } } }];
  const actual = observedRequirements('retouch', { sub_masks: [{ id: 'clone-stroke', type: 'clone', visible: true, mode: 'additive', parameters: { sourceX: 3 } }] }, { tools });
  for (const suffix of ['id', 'type', 'visible', 'visible=true', 'mode', 'mode="additive"', 'parameters']) assert.ok(actual.includes(`parameter:retouch.sub_masks[].${suffix}`), suffix);
  assert.ok(!actual.some((id) => id.includes('<clone>')));
  assert.ok(!actual.includes('parameter:retouch.sub_masks[].visible=false'));
  assert.ok(!actual.includes('parameter:retouch.sub_masks[].mode="intersect"'));
});
test('discriminated array variants never share credit and generic records remain generic', () => {
  const properties = { items: { oneOf: ['flow', 'brush'].map((kind) => ({ properties: { type: { const: kind }, amount: { type: 'number' } } })) } };
  const tools = [{ name: 'rapidraw_example', inputSchema: { properties: { components: properties, arbitrary: { type: 'object' } } } }];
  const actual = observedRequirements('example', { components: [{ type: 'flow', amount: 50 }], arbitrary: { type: 'brush', mode: 'intersect', parameters: { amount: 20 } } }, { tools });
  assert.ok(actual.includes('parameter:example.components[]<flow>.amount'));
  assert.ok(!actual.some((id) => id.includes('components[]<brush>')));
  assert.ok(actual.includes('parameter:example.arbitrary.parameters.amount'));
  assert.ok(!actual.some((id) => id.includes('arbitrary<brush>')));
});
test('nullable arrays preserve their recorded item discriminators without granting the other branch', () => {
  const tools = [{ name: 'rapidraw_example', inputSchema: { properties: { components: { anyOf: [{ type: 'null' }, { type: 'array', items: { oneOf: ['flow', 'brush'].map((kind) => ({ properties: { type: { const: kind }, amount: { type: 'number' } } })) } }] } } } }];
  const actual = observedRequirements('example', { components: [{ type: 'brush', amount: 20 }] }, { tools });
  assert.ok(actual.includes('parameter:example.components[]<brush>.amount'));
  assert.ok(!actual.some((id) => id.includes('<flow>')));
  const empty = observedRequirements('example', { components: null }, { tools });
  assert.ok(!empty.some((id) => id.includes('<brush>')));
});
test('derived state requires explicit successful-call assertions and stays separate from direct input', () => {
  const base = { evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', status: 'passed' };
  const call = { ...base, id: 'depth:1', type: 'call', method: 'generate_depth', basis: 'direct_input', level: 'native_call', requirements: ['tool:generate_depth'], result: { lensBlurEnabled: true } };
  const ids = ['tool:generate_depth', 'adjustment:lensBlurEnabled=true', 'adjustment:lensBlurShape="ring"'];
  assert.deepEqual(aggregateEvidence(ids, [call]).requirements[1].levels, [], 'Returned state alone must grant no evidence');
  const check = { ...base, id: 'depth:2', type: 'check', basis: 'derived_state', level: 'native_assertion', requirements: [ids[1]], source_call_ids: [call.id] };
  const report = aggregateEvidence(ids, [call, check]);
  assert.deepEqual(report.requirements[1].evidence_by_basis.derived_state, [check.id]);
  assert.deepEqual(report.requirements[1].evidence_by_basis.direct_input, []);
  assert.equal(report.totals.pixel_assertion, 0); assert.equal(report.totals.derived_state, 1);
  assert.deepEqual(report.requirements[2].levels, []);
  for (const invalid of [[], ['missing']]) assert.throws(() => aggregateEvidence(ids, [call, { ...check, source_call_ids: invalid }]), /successful native source calls/);
  assert.throws(() => aggregateEvidence(ids, [{ ...call, status: 'skipped' }, check]), /successful native source calls/);
  assert.throws(() => aggregateEvidence(ids, [call, { ...check, level: 'native_call' }]), /explicit assertion/);
});
test('report grouping preserves every original requirement and never transfers shared-schema evidence', () => {
  const ids = ['adjustment:exposure', 'adjustment:masks[].adjustments.exposure', 'adjustment:masks[].subMasks[]<flow>.opacity', 'adjustment:aiPatches[].subMasks[]<flow>.opacity', 'parameter:export.quality', 'parameter:batch_export.options.quality'];
  const report = aggregateEvidence(ids, [{ id: '1', type: 'call', evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', status: 'passed', level: 'native_call', basis: 'direct_input', requirements: [ids[0], ids[2], ids[4]] }]);
  assert.deepEqual(report.requirements.map((r) => r.id), ids);
  assert.equal(report.totals.required, ids.length); assert.equal(report.totals.untested, 3);
  assert.deepEqual(report.requirements[3].levels, []);
  assert.deepEqual(report.groups.find((g) => g.family === 'submask:flow').contexts, ['local mask component', 'retouch patch component']);
  assert.equal(report.groups.find((g) => g.family === 'delivery-options').without_evidence, 1);
  assert.equal(classifyRequirement('adjustment:sectionVisibility.effects=false').purpose, 'rendering enable/disable');
  assert.equal(classifyRequirement('adjustment:lutName').purpose, 'recipe metadata and editing intent');
});
test('evidence recursively redacts credentials and large encoded assets', () => {
  assert.deepEqual(sanitize({ token: 'private', child: { apiKey: 'private', authorization: 'Bearer private', dataBase64: 'image' }, path: 'fixture.png' }), { token: '[redacted]', child: { apiKey: '[redacted]', authorization: '[redacted]', dataBase64: '[omitted 5 characters]' }, path: 'fixture.png' });
});
test('independent PNG decoder preserves exact synthetic pixels and detects corrupt bytes', () => {
  const bytes = fixturePng(20, 12, (x, y) => [x * 10, y * 10, 100]); const decoded = decodePng(bytes);
  assert.equal(decoded.width, 20); assert.equal(decoded.height, 12); assert.equal(decoded.pixels[(3 * 20 + 2) * 3], 20 / 255); assert.equal(decoded.pixels[(3 * 20 + 2) * 3 + 1], 30 / 255);
  assert.equal(pixelDifference(decoded, decodePng(bytes)).maximum, 0); assert.ok(mean(decoded) > 0);
  const corrupt = Buffer.from(bytes); corrupt[50] ^= 1; assert.throws(() => decodePng(corrupt));
});
