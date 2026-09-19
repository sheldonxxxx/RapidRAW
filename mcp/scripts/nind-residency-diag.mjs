/** Narrow NIND residency diagnostic (one sequence per fresh process).
 *
 * Determines whether a native NIND (denoise-ai) failure is intrinsic or
 * caused by retained CUDA sessions from earlier AI operations. Each run uses
 * a fresh engine, workspace and the bounded 1024px fixture policy from
 * onnx-provider-e2e.mjs. Production source is untouched.
 *
 * Sequences (NLX_DIAG_SEQUENCE):
 *   NIND_ONLY            denoise-ai is the first CUDA AI operation.
 *   MASK_GROUP_THEN_NIND one foreground mask (initializes AiState.models),
 *                        then NIND.
 *   MASK_GROUP_LAMA_THEN_NIND foreground mask, then 448px LaMa inpaint
 *                        (fleet-like retained state incl. CPU LaMa), then NIND.
 *   NIND_THEN_MASK_GROUP NIND first, then foreground mask (coexistence when
 *                        NIND established its arena first).
 *
 * Env (required unless noted):
 *   NLX_DIAG_SERVER  MCP server entry (dist/index.js)
 *   NLX_DIAG_BINARY  native RapidRAW engine binary
 *   NLX_DIAG_RUN_DIR fresh isolated workspace (must not exist; fail-closed)
 *   NLX_DIAG_RAW    absolute test RAW path
 *   NLX_DIAG_SEQUENCE one of the four sequences above
 *   NLX_DIAG_TIMEOUT_MS optional (default 900000)
 *
 * The caller owns the display, ORT_DYLIB_PATH, provider policy env and any
 * process-local LD_LIBRARY_PATH override; all are inherited and recorded.
 * Checkpoints capture global/engine VRAM (nvidia-smi observations, not
 * arena-internal bytes), model/session diagnostics and process maps.
 * Output: report.json under the run dir. Exit nonzero on unexpected failure;
 * an expected NIND OOM is recorded (not thrown) with the complete error.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { snapshotCudaMaps } from './cuda-lib-maps.mjs';

const server = process.env.NLX_DIAG_SERVER;
const binary = process.env.NLX_DIAG_BINARY;
const runDir = process.env.NLX_DIAG_RUN_DIR;
const raw = process.env.NLX_DIAG_RAW;
const sequence = process.env.NLX_DIAG_SEQUENCE;
const timeoutMs = Number(process.env.NLX_DIAG_TIMEOUT_MS ?? '900000');
assert.ok(server && binary && runDir && raw, 'Set NLX_DIAG_SERVER/BINARY/RUN_DIR/RAW');
assert.ok(
  ['NIND_ONLY', 'MASK_GROUP_THEN_NIND', 'MASK_GROUP_LAMA_THEN_NIND', 'NIND_THEN_MASK_GROUP'].includes(sequence),
  `Unknown sequence: ${sequence}`,
);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const binName = binary.split('/').pop();

async function requireFreshDir(path) {
  assert.ok(isAbsolute(path), 'NLX_DIAG_RUN_DIR must be absolute');
  let existing = null;
  try {
    existing = await stat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing) {
    // Narrow exception: a directory containing ONLY a pre-seeded models/
    // subtree (verified model bytes installed before the timed run) carries
    // no evidence/cache state and is safe to use. Anything else refuses.
    const entries = await readdir(path);
    const onlyModelsSeed =
      entries.length === 1 && entries[0] === 'models' && (await stat(join(path, 'models'))).isDirectory();
    assert.equal(onlyModelsSeed, true, `Refusing to reuse existing run directory: ${path}`);
  } else {
    await mkdir(path, { recursive: true });
  }
}

function enginePids() {
  try {
    return new Set(
      execSync(`pgrep -x '${binName}' || true`, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function vramSnapshot(enginePid) {
  const snapshot = { global: null, engine_MiB: null };
  try {
    snapshot.global = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', {
      encoding: 'utf8',
    }).trim();
  } catch {}
  if (enginePid) {
    try {
      const out = execSync(`nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`, {
        encoding: 'utf8',
      });
      for (const line of out.split('\n')) {
        const [pid, mem] = line.split(',').map((s) => s.trim());
        if (pid === String(enginePid)) snapshot.engine_MiB = Number(mem);
      }
    } catch {}
  }
  return snapshot;
}

const pidsBefore = enginePids();
await requireFreshDir(runDir);
const sourceHash = hash(await readFile(raw));
const report = {
  sequence,
  run_dir: runDir,
  raw,
  source_sha256: sourceHash,
  ld_library_path: process.env.LD_LIBRARY_PATH ?? null,
  library_context: 'native-torch-free',
  onnx_provider: process.env.RAPIDRAW_ONNX_PROVIDER ?? null,
  ort_dylib_path: process.env.ORT_DYLIB_PATH ?? null,
  checkpoints: [],
  operations: [],
};
let client;
let enginePid = null;
let failure = null;
try {
  client = new Client({ name: 'nind-residency-diag', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(server), '--binary', binary, '--workspace', resolve(runDir), '--timeout-ms', String(timeoutMs)],
      stderr: 'inherit',
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    }),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name: `rapidraw_${name}`, arguments: args }, { timeout: timeoutMs });
    return response;
  };
  const data = async (name, args) => {
    const response = await call(name, args);
    assert.equal(!!response.isError, false, JSON.stringify(response.structuredContent ?? response.content));
    return response.structuredContent;
  };
  async function checkpoint(label) {
    const models = (await call('models', {})).structuredContent;
    const entry = {
      label,
      vram: vramSnapshot(enginePid),
      models: Object.fromEntries(
        Object.entries(models?.onnx_execution?.models ?? {}).map(([name, status]) => [
          name,
          {
            session_provider: status.session_provider,
            error: status.error,
            gpu_arena_limit_mb: status.gpu_arena_limit_mb ?? null,
          },
        ]),
      ),
    };
    if (enginePid) entry.maps = snapshotCudaMaps(enginePid);
    report.checkpoints.push(entry);
    return entry;
  }
  function trackEngine() {
    const after = enginePids();
    for (const pid of after) {
      if (!pidsBefore.has(pid)) {
        try {
          const cmdline = execSync(`tr '\\0' ' ' < /proc/${pid}/cmdline`, { encoding: 'utf8' });
          if (cmdline.includes(binary) && cmdline.includes(runDir)) {
            enginePid = pid;
            return;
          }
        } catch {}
      }
    }
  }

  // Bounded 1024px fixture, same policy as onnx-provider-e2e.mjs.
  const opened = await data('open_photo', { path: resolve(raw), inherit_sidecar: false });
  assert.equal(opened.is_raw, true);
  const exported = await data('export', {
    session_id: opened.session_id,
    path: 'diag-fixture.png',
    format: 'png',
    bit_depth: 8,
    long_edge: 1024,
    color_profile: 'none',
    keep_metadata: false,
  });
  await data('close_session', { session_id: opened.session_id });
  const seed = exported.path;
  trackEngine();
  await checkpoint('after-fixture-before-any-cuda');

  async function freshSeed() {
    const session = await data('open_photo', { path: seed, inherit_sidecar: false });
    return session;
  }
  async function runMask(session) {
    const start = performance.now();
    const generated = await data('mask_generate', {
      session_id: session.session_id,
      expected_revision: session.revision,
      kind: 'foreground',
      parameters: { grow: 0, feather: 0 },
    });
    assert.equal(generated.mask_statistics.empty, false);
    return { wall_s: (performance.now() - start) / 1000 };
  }
  async function runInpaint448(session, dimensions) {
    const generated = await data('retouch', {
      session_id: session.session_id,
      expected_revision: session.revision,
      mode: 'inpaint',
      sub_masks: [
        {
          id: 'diag-inpaint',
          type: 'radial',
          visible: true,
          mode: 'additive',
          parameters: {
            centerX: Math.floor(dimensions.width / 2),
            centerY: Math.floor(dimensions.height / 2),
            radiusX: 54,
            radiusY: 54,
            rotation: 0,
            feather: 0,
          },
        },
      ],
    });
    assert.equal(generated.remote_generation, false);
    assert.equal(generated.mask_statistics.empty, false);
  }
  async function runNind(session) {
    const start = performance.now();
    const response = await call('denoise', {
      session_id: session.session_id,
      expected_revision: session.revision,
      method: 'ai',
      intensity: 50,
    });
    const wall_s = (performance.now() - start) / 1000;
    if (response.isError) {
      return { ok: false, wall_s, error: JSON.stringify(response.structuredContent ?? response.content) };
    }
    const result = response.structuredContent;
    assert.notEqual(result.session_id, session.session_id);
    assert.equal(result.source_domain_preserved, true);
    const rendered = await call('render', { session_id: result.session_id, format: 'png' });
    const block = rendered.content.find((c) => c.type === 'image');
    assert.ok(block, 'render must return pixels');
    return { ok: true, wall_s, render_sha256: hash(Buffer.from(block.data, 'base64')) };
  }

  const seedDims = { width: 1024, height: 683 };
  if (sequence === 'NIND_ONLY') {
    const session = await freshSeed();
    await checkpoint('before-nind');
    const nind = await runNind(session);
    report.operations.push({ op: 'denoise-ai', ...nind });
    await checkpoint('after-nind');
    await data('close_session', { session_id: session.session_id });
  } else if (sequence === 'MASK_GROUP_THEN_NIND' || sequence === 'MASK_GROUP_LAMA_THEN_NIND') {
    let session = await freshSeed();
    report.operations.push({ op: 'mask-foreground', ...(await runMask(session)) });
    await data('close_session', { session_id: session.session_id });
    await checkpoint('after-mask-group');
    if (sequence === 'MASK_GROUP_LAMA_THEN_NIND') {
      session = await freshSeed();
      await runInpaint448(session, seedDims);
      report.operations.push({ op: 'inpaint-448', wall_s: null });
      await data('close_session', { session_id: session.session_id });
      await checkpoint('after-lama');
    }
    session = await freshSeed();
    await checkpoint('before-nind');
    const nind = await runNind(session);
    report.operations.push({ op: 'denoise-ai', ...nind });
    await checkpoint('after-nind');
    await data('close_session', { session_id: session.session_id });
  } else if (sequence === 'NIND_THEN_MASK_GROUP') {
    let session = await freshSeed();
    const nind = await runNind(session);
    report.operations.push({ op: 'denoise-ai', ...nind });
    await checkpoint('after-nind');
    await data('close_session', { session_id: session.session_id });
    session = await freshSeed();
    const mask = await runMask(session).catch((error) => ({ ok: false, error: String(error) }));
    report.operations.push({ op: 'mask-foreground', ...mask });
    await checkpoint('after-mask-group');
    await data('close_session', { session_id: session.session_id });
  }
  report.source_sha256_after = hash(await readFile(raw));
  assert.equal(report.source_sha256_after, sourceHash);
  await client.close();
  client = null;
  await writeFile(`${runDir}/report.json`, JSON.stringify(report, null, 2));
  console.log(`wrote ${runDir}/report.json`);
} catch (error) {
  failure = String(error?.stack ?? error);
  console.error(failure);
  try {
    await writeFile(`${runDir}/failure.txt`, failure);
  } catch {}
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
