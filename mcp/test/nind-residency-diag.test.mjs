import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/nind-residency-diag.mjs', import.meta.url));

test('diag runner documents the four sequences and checkpoint contract', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  for (const sequence of ['NIND_ONLY', 'MASK_GROUP_THEN_NIND', 'MASK_GROUP_LAMA_THEN_NIND', 'NIND_THEN_MASK_GROUP']) {
    assert.ok(source.includes(sequence), sequence);
  }
  for (const marker of ['requireFreshDir', 'snapshotCudaMaps', 'before-nind', 'library_context', 'vramSnapshot']) {
    assert.ok(source.includes(marker), marker);
  }
  assert.ok(source.includes('Refusing to reuse existing run directory'));
});

test('diag runner rejects an unknown sequence before connecting', () => {
  const existing = mkdtempSync(join(tmpdir(), 'nlx-diag-seq-'));
  let failed = null;
  try {
    execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NLX_DIAG_SERVER: '/tmp/nope-index.js',
        NLX_DIAG_BINARY: '/tmp/nope-binary',
        NLX_DIAG_RUN_DIR: join(existing, 'fresh-subdir'),
        NLX_DIAG_RAW: '/tmp/nope.cr2',
        NLX_DIAG_SEQUENCE: 'BOGUS_SEQUENCE',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'unknown sequence must fail');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Unknown sequence/);
});

test('diag runner documents the models-seed exception', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(source.includes('onlyModelsSeed'), 'models-seed carve-out must be explicit');
});

test('diag runner fails closed on an existing run directory', () => {
  const existing = mkdtempSync(join(tmpdir(), 'nlx-diag-fresh-'));
  let failed = null;
  try {
    execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NLX_DIAG_SERVER: '/tmp/nope-index.js',
        NLX_DIAG_BINARY: '/tmp/nope-binary',
        NLX_DIAG_RUN_DIR: existing,
        NLX_DIAG_RAW: '/tmp/nope.cr2',
        NLX_DIAG_SEQUENCE: 'NIND_ONLY',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'existing run directory must fail');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Refusing to reuse existing run directory/);
});
