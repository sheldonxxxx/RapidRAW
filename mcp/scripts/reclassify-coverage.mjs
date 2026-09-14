/** Historical attribution repair from recorded schemas/arguments; never executes native tools. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, markdownCoverage, observedRequirements, requiredInventory } from './coverage-evidence.mjs';
import { loadCompletedRuns, combineRuns } from './coverage-runs.mjs';

const args = process.argv.slice(2),
  option = args.indexOf('--output');
assert.ok(
  option >= 0 && args[option + 1],
  'Usage: node scripts/reclassify-coverage.mjs --output /absolute/new-report-dir completed-run-dir [...]',
);
const output = resolve(args[option + 1]);
args.splice(option, 2);
assert.ok(args.length && args.every((arg) => !arg.startsWith('--')), 'Supply completed run directories only');
const runs = await loadCompletedRuns(args);
for (const run of runs) {
  assert.ok(
    output !== run.directory && !output.startsWith(run.directory + sep),
    'Write reclassification outside original run directories',
  );
  assert.ok(
    Array.isArray(run.inventory.tools) && run.inventory.capabilities?.adjustment_schema,
    'Historical remapping requires the original recorded tool and adjustment schemas',
  );
  assert.deepEqual(
    requiredInventory(run.inventory.tools, run.inventory.capabilities),
    run.inventory.requirements,
    'Recorded schemas must reproduce the original requirement inventory exactly',
  );
}
const original = combineRuns(runs);
let reconstructedCalls = 0;
const correctedRuns = runs.map((run) => ({
  ...run,
  records: run.records.map((record) => {
    if (
      record.evidence_format !== 'rapidraw-native-evidence-v1' ||
      record.execution !== 'real_native_mcp' ||
      record.type !== 'call' ||
      record.status !== 'passed' ||
      record.level !== 'native_call' ||
      record.expected_error
    )
      return record;
    assert.ok(
      typeof record.method === 'string' &&
        record.args &&
        typeof record.args === 'object' &&
        !Array.isArray(record.args),
      `Successful call ${record.id} lacks recorded input arguments`,
    );
    const requirements = observedRequirements(record.method, record.args, {
      tools: run.inventory.tools,
      capabilities: run.inventory.capabilities,
    });
    reconstructedCalls++;
    return {
      ...record,
      requirements,
      basis: 'direct_input',
      direct_input_requirements: requirements,
      attribution_reconstructed_from_recorded_input: true,
    };
  }),
}));
const corrected = combineRuns(correctedRuns);
assert.deepEqual(
  corrected.requirements.map((row) => row.id),
  original.requirements.map((row) => row.id),
  'Historical inventory must remain intact',
);
for (const level of ['native_assertion', 'pixel_assertion', 'visual_review'])
  assert.equal(corrected.totals[level], original.totals[level], `Re-attribution must not invent ${level} evidence`);
const changed = corrected.requirements.flatMap((row, index) => {
  const before = original.requirements[index];
  return JSON.stringify([...before.levels].sort()) === JSON.stringify([...row.levels].sort())
    ? []
    : [
        {
          id: row.id,
          before_levels: before.levels,
          corrected_levels: row.levels,
          added_evidence_ids: row.evidence.filter((id) => !before.evidence.includes(id)),
          removed_evidence_ids: before.evidence.filter((id) => !row.evidence.includes(id)),
        },
      ];
});
const sources = await Promise.all(
  runs.map(async (run) => ({
    directory: run.directory,
    provenance: run.inventory.provenance,
    inventory_sha256: await hashFile(join(run.directory, 'inventory.json')),
    ledger_sha256: await hashFile(join(run.directory, 'evidence.jsonl')),
    summary_sha256: await hashFile(join(run.directory, 'summary.json')),
    coverage_sha256: await hashFile(join(run.directory, 'coverage.json')),
  })),
);
const metadata = {
  report_kind: 'historical_recorded_input_reattribution',
  generated_at: new Date().toISOString(),
  new_native_calls: 0,
  reconstructed_successful_calls: reconstructedCalls,
  original_totals: original.totals,
  corrected_totals: corrected.totals,
  changed_requirements: changed,
  original_inventory_preserved: true,
  original_files_unchanged: true,
  rules:
    'Only recorded successful real-native call arguments are mapped against their recorded schemas. No defaults, results, skipped/error calls, derived state, pixel assertions or visual evidence are inferred. Redacted values retain field presence but cannot establish an unrecorded enum value. Output is a report, not a new executable acceptance ledger.',
  implementation_sha256: await hashFile(fileURLToPath(import.meta.url)),
  attribution_helper_sha256: await hashFile(fileURLToPath(new URL('./coverage-evidence.mjs', import.meta.url))),
  sources,
};
// Output is deliberately not a harness run: no evidence.jsonl/inventory.json/summary.json
// are created, so it cannot be combined as another source of executed calls.
await mkdir(output, { recursive: false });
for (const [name, value] of [
  ['original-coverage.json', original],
  ['corrected-coverage.json', { reclassification: metadata, ...corrected }],
  ['reclassification.json', metadata],
])
  await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(
  join(output, 'corrected-coverage.md'),
  '# Historical input attribution correction\n\nNo new native calls were executed. Original ledgers and their build provenance remain unchanged. The original requirement inventory is preserved.\n\n' +
    markdownCoverage(corrected, 'corrected-coverage.json'),
  { flag: 'wx' },
);
console.log(
  JSON.stringify(
    {
      output,
      new_native_calls: 0,
      reconstructed_successful_calls: reconstructedCalls,
      changed_requirement_count: changed.length,
      original_totals: original.totals,
      corrected_totals: corrected.totals,
    },
    null,
    2,
  ),
);
