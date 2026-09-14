/** Shared integrity gate for completed evidence. Reading old runs never creates new call evidence. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { aggregateEvidence, readEvidence } from './coverage-evidence.mjs';

export async function loadCompletedRuns(paths) {
  assert.ok(paths.length, 'At least one completed native run is required');
  const runs = await Promise.all(
    paths.map(async (path) => {
      const directory = resolve(path);
      const json = async (name) => {
        try {
          return JSON.parse(await readFile(join(directory, name), 'utf8'));
        } catch (error) {
          throw new Error(`${directory}: missing or invalid ${name}; incomplete suites cannot be combined`, {
            cause: error,
          });
        }
      };
      const [inventory, summary, coverage, records] = await Promise.all([
        json('inventory.json'),
        json('summary.json'),
        json('coverage.json'),
        readEvidence(join(directory, 'evidence.jsonl')),
      ]);
      assert.equal(
        summary.status,
        'passed',
        `${directory}: suite did not finish successfully (${summary.status ?? 'missing status'}); inspect summary.json and coverage.json`,
      );
      assert.equal(summary.failed, 0, `${directory}: summary contains failed requirements`);
      assert.ok(coverage.error == null, `${directory}: suite reported an error: ${coverage.error}`);
      assert.equal(coverage.totals?.failed, 0, `${directory}: coverage contains failed requirements or is incomplete`);
      assert.ok(
        !records.some((record) => record.status === 'failed'),
        `${directory}: evidence contains a failed call or assertion`,
      );
      assert.equal(
        summary.calls,
        records.filter((record) => record.type === 'call').length,
        `${directory}: summary call count differs from ledger; evidence may be incomplete`,
      );
      for (const key of ['runtime_tree_sha256', 'binary_sha256']) {
        assert.ok(typeof inventory.provenance?.[key] === 'string', `${directory}: missing ${key} provenance`);
        for (const report of [summary, coverage])
          assert.equal(
            report.provenance?.[key],
            inventory.provenance[key],
            `${directory}: completion report differs from inventory ${key}`,
          );
      }
      return { directory, inventory, summary, records };
    }),
  );
  const first = runs[0].inventory;
  for (const run of runs)
    for (const key of ['runtime_tree_sha256', 'binary_sha256'])
      assert.equal(
        run.inventory.provenance[key],
        first.provenance[key],
        `Cannot silently combine evidence from different ${key}; report each build separately`,
      );
  for (const run of runs)
    assert.deepEqual(
      run.inventory.requirements,
      first.requirements,
      'Schema inventory differs; rerun against the same binary/server',
    );
  return runs;
}

export function combineRuns(runs) {
  const first = runs[0].inventory;
  const records = runs.flatMap((run) =>
    run.records.map((record) => ({
      ...record,
      id: `${run.directory}#${record.id}`,
      ...(record.source_call_ids
        ? { source_call_ids: record.source_call_ids.map((id) => `${run.directory}#${id}`) }
        : {}),
    })),
  );
  return {
    provenance: first.provenance,
    runs: runs.map((run) => ({ directory: run.directory, provenance: run.inventory.provenance })),
    ...aggregateEvidence(first.requirements, records),
  };
}
