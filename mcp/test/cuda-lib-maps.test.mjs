import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPS_KEYWORDS, findEnginePids, snapshotCudaMaps } from '../scripts/cuda-lib-maps.mjs';

test('maps keywords cover the audited CUDA families', () => {
  for (const keyword of ['libcudnn', 'libcublas', 'libcublasLt', 'libcudart', 'libcurand', 'libnvrtc', 'libnvJitLink']) {
    assert.ok(MAPS_KEYWORDS.includes(keyword), keyword);
  }
});

test('snapshot is a libraries map or an explicit note, never a throw', () => {
  const snapshot = snapshotCudaMaps(process.pid);
  assert.ok(snapshot && typeof snapshot === 'object');
  assert.ok('libraries' in snapshot || 'note' in snapshot);
  if ('libraries' in snapshot) {
    for (const name of Object.keys(snapshot.libraries)) {
      assert.ok(
        MAPS_KEYWORDS.some((keyword) => name.startsWith(keyword)),
        `unfiltered mapping leaked: ${name}`,
      );
    }
  }
});

test('engine PID search finds nothing for an impossible binary path', () => {
  assert.deepEqual(findEnginePids('/definitely/not/a/rapidraw-binary-xyz'), []);
});

test('provider regression wires maps, LD path and library context', () => {
  const source = readFileSync(new URL('../scripts/onnx-provider-e2e.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('snapshotCudaMaps'), 'e2e must capture process maps');
  assert.ok(source.includes('ld_library_path'), 'e2e must record LD_LIBRARY_PATH');
  assert.ok(source.includes('library_context'), 'e2e must label the library context');
  assert.ok(source.includes('native_cuda_libraries'), 'e2e must persist the maps snapshot');
});

test('lib-bench fails closed on an existing run directory', () => {
  const source = readFileSync(new URL('../scripts/nonlocal-lib-bench.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('requireFreshDir'), 'runner must enforce fresh directories');
  assert.ok(
    source.includes('Refusing to reuse existing run directory'),
    'runner must name the contamination risk',
  );
  const existing = mkdtempSync(join(tmpdir(), 'nlx-fresh-check-'));
  let failed = null;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/nonlocal-lib-bench.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NLX_SERVER: '/tmp/nope-index.js',
        NLX_BINARY: '/tmp/nope-binary',
        NLX_RUN_DIR: existing,
        NLX_RAW: '/tmp/nope.cr2',
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
