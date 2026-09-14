/** Combine versioned evidence only when its exact source/binary provenance matches. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { markdownCoverage } from './coverage-evidence.mjs';
import { loadCompletedRuns, combineRuns } from './coverage-runs.mjs';

const paths = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
assert.ok(
  paths.length,
  'Usage: node scripts/coverage-report.mjs run-dir [run-dir ...] [--require-native-tools] [--require-pixel-adjustments] [--require-direct-adjustments]',
);
const runs = await loadCompletedRuns(paths);
const report = combineRuns(runs);
if (process.argv.includes('--require-native-tools'))
  assert.equal(
    report.requirements.filter((r) => r.id.startsWith('tool:') && !r.levels.includes('native_call')).length,
    0,
    'Tools without successful real native calls remain; inspect coverage JSON',
  );
if (process.argv.includes('--require-pixel-adjustments'))
  assert.equal(
    report.requirements.filter((r) => r.id.startsWith('adjustment:') && !r.levels.includes('pixel_assertion')).length,
    0,
    'Adjustment evidence gaps remain; do not claim complete pixel coverage',
  );
if (process.argv.includes('--require-direct-adjustments'))
  assert.equal(
    report.requirements.filter((r) => r.id.startsWith('adjustment:') && !r.evidence_by_basis.direct_input.length)
      .length,
    0,
    'Direct adjustment-input evidence gaps remain; derived state does not establish the direct-input contract',
  );
const output = process.env.RAPIDRAW_COVERAGE_OUTPUT
  ? resolve(process.env.RAPIDRAW_COVERAGE_OUTPUT)
  : join(runs[0].directory, 'combined-coverage.json');
await writeFile(output, JSON.stringify(report, null, 2));
await writeFile(join(dirname(output), 'combined-coverage.md'), markdownCoverage(report, basename(output)));
console.log(JSON.stringify({ output, ...report.totals }, null, 2));
