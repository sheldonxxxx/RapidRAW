import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvidence } from '../scripts/coverage-evidence.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/coverage-report.mjs', import.meta.url));
async function fixture(t, change = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rapidraw-aggregate-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provenance = { runtime_tree_sha256: 'a'.repeat(64), binary_sha256: 'b'.repeat(64) };
  const requirements = change.requirements ?? ['tool:render'];
  const records = change.records ?? [
    {
      id: 'fixture:1',
      evidence_format: 'rapidraw-native-evidence-v1',
      execution: 'real_native_mcp',
      type: 'call',
      method: 'render',
      requirements,
      status: 'passed',
      level: 'native_call',
    },
  ];
  const report = aggregateEvidence(requirements, records);
  const summary = {
    provenance,
    status: 'passed',
    calls: records.filter((r) => r.type === 'call').length,
    ...report.totals,
    ...change.summary,
  };
  const coverage = { provenance, ...report, ...change.coverage };
  await writeFile(join(directory, 'inventory.json'), JSON.stringify({ provenance, requirements }));
  await writeFile(join(directory, 'evidence.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(directory, 'coverage.json'), JSON.stringify(coverage));
  if (!change.missingSummary) await writeFile(join(directory, 'summary.json'), JSON.stringify(summary));
  return directory;
}
const run = (directory) =>
  execute(process.execPath, [script, directory], {
    env: { ...process.env, RAPIDRAW_COVERAGE_OUTPUT: join(directory, 'combined-coverage.json') },
  });
async function rejectedWithoutOutput(directory, pattern) {
  await assert.rejects(run(directory), (error) => {
    assert.match(error.stderr, pattern);
    return true;
  });
  await assert.rejects(readFile(join(directory, 'combined-coverage.json')), { code: 'ENOENT' });
}

test('aggregator refuses untagged legacy assertion failure even when every ledger call passed', async (t) => {
  // Legacy adapters can throw outside h.check(), so h.close(error) is the only
  // evidence of failure: no failed call/check and zero failed requirements.
  const directory = await fixture(t, {
    summary: { status: 'failed', failed: 0 },
    coverage: { error: 'AssertionError: persisted pixels changed after reconnect' },
  });
  await rejectedWithoutOutput(directory, /suite did not finish successfully/);
});

test('aggregator requires a complete passed summary and rejects contradictory completion reports', async (t) => {
  for (const [name, change, pattern] of [
    ['missing summary', { missingSummary: true }, /missing or invalid summary.json/],
    ['unfinished summary', { summary: { status: 'running' } }, /suite did not finish successfully/],
    ['failed summary count', { summary: { failed: 1 } }, /summary contains failed requirements/],
    ['coverage error', { coverage: { error: 'Legacy assertion failed' } }, /suite reported an error/],
    ['incomplete call ledger', { summary: { calls: 2 } }, /summary call count differs/],
    [
      'stale completion provenance',
      { summary: { provenance: { runtime_tree_sha256: 'c'.repeat(64), binary_sha256: 'b'.repeat(64) } } },
      /completion report differs/,
    ],
  ])
    await t.test(name, async (t) => rejectedWithoutOutput(await fixture(t, change), pattern));
});

test('aggregator still combines completed matching runs and retains call evidence', async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  await execute(process.execPath, [script, first, second, '--require-native-tools'], {
    env: { ...process.env, RAPIDRAW_COVERAGE_OUTPUT: join(first, 'combined-coverage.json') },
  });
  const result = JSON.parse(await readFile(join(first, 'combined-coverage.json'), 'utf8'));
  assert.equal(result.runs.length, 2);
  assert.equal(result.totals.failed, 0);
  assert.equal(result.totals.native_call, 1);
  assert.deepEqual(result.requirements[0].levels, ['native_call']);
});

test('aggregator namespaces explicit derived source references and cannot treat them as direct inputs', async (t) => {
  const base = { evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', status: 'passed' };
  const requirements = ['tool:generate_depth', 'adjustment:lensBlurEnabled=true'];
  const records = [
    {
      ...base,
      id: 'depth:1',
      type: 'call',
      method: 'generate_depth',
      level: 'native_call',
      basis: 'direct_input',
      requirements: [requirements[0]],
    },
    {
      ...base,
      id: 'depth:2',
      type: 'check',
      level: 'native_assertion',
      basis: 'derived_state',
      source_call_ids: ['depth:1'],
      requirements: [requirements[1]],
    },
  ];
  const directory = await fixture(t, { requirements, records });
  await run(directory);
  const report = JSON.parse(await readFile(join(directory, 'combined-coverage.json'), 'utf8'));
  assert.deepEqual(report.requirements[1].evidence_by_basis.derived_state, [`${directory}#depth:2`]);
  assert.equal(report.totals.direct_input, 1);
  assert.equal(report.totals.pixel_assertion, 0);
  const second = await fixture(t, { requirements, records });
  await assert.rejects(
    execute(process.execPath, [script, second, '--require-direct-adjustments'], {
      env: { ...process.env, RAPIDRAW_COVERAGE_OUTPUT: join(second, 'combined-coverage.json') },
    }),
    (error) => {
      assert.match(error.stderr, /derived state does not establish/);
      return true;
    },
  );
  await assert.rejects(readFile(join(second, 'combined-coverage.json')), { code: 'ENOENT' });
});

test('strict native tool gate fails before writing an apparently successful aggregate', async (t) => {
  const directory = await fixture(t, {
    requirements: ['tool:render', 'tool:export'],
    records: [
      {
        id: '1',
        evidence_format: 'rapidraw-native-evidence-v1',
        execution: 'real_native_mcp',
        type: 'call',
        method: 'render',
        status: 'passed',
        level: 'native_call',
        requirements: ['tool:render'],
      },
    ],
  });
  await assert.rejects(
    execute(process.execPath, [script, directory, '--require-native-tools'], {
      env: { ...process.env, RAPIDRAW_COVERAGE_OUTPUT: join(directory, 'combined-coverage.json') },
    }),
    (error) => {
      assert.match(error.stderr, /without successful real native calls/);
      return true;
    },
  );
  await assert.rejects(readFile(join(directory, 'combined-coverage.json')), { code: 'ENOENT' });
});
