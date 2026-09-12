/** Reproducible setup runner. A local clean checkout is not called a fresh machine. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.env.RAPIDRAW_SETUP_OUTPUT ?? `test-output/setup-${Date.now()}`);
await mkdir(output, { recursive: true });
const records = [];
async function run(command, args, cwd = root, env = {}) {
  const start = Date.now(); const entry = { command, args, cwd, started_at: new Date().toISOString() }; records.push(entry);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: false });
    child.once('error', reject); child.once('exit', (code, signal) => { entry.exit_code = code; entry.signal = signal; entry.elapsed_ms = Date.now() - start; code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)); });
  });
}
const args = new Set(process.argv.slice(2)); let failure;
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ required');
  await run('git', ['rev-parse', 'HEAD']); await run('cargo', ['--version']);
  if (args.has('--build')) {
    const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : null;
    const npmCommand = npmArgs ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (process.platform === 'win32') assert.ok(npmArgs, 'On Windows launch through npm run test:setup so npm_execpath is available');
    const npm = async (...args) => run(npmCommand, [...(npmArgs ?? []), ...args]);
    await npm('ci'); await npm('ci', '--prefix', 'mcp'); await npm('run', 'build'); await npm('test', '--prefix', 'mcp');
    await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'mcp', '--locked']);
    await run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']);
  }
  if (args.has('--native')) {
    assert.ok(process.env.RAPIDRAW_BINARY, 'Set RAPIDRAW_BINARY to the freshly built executable');
    for (const script of ['coverage-e2e.mjs', 'geometry-review-e2e.mjs', 'portable-sessions-e2e.mjs', 'operation-jobs-e2e.mjs', 'export-interoperability-e2e.mjs']) await run(process.execPath, [join(root, 'mcp', 'scripts', script)], root, { RAPIDRAW_WORKSPACE: join(output, script.replace('.mjs', '')) });
  }
} catch (error) { failure = error; }
finally { await writeFile(join(output, 'setup-summary.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', error: failure ? String(failure) : undefined, platform: process.platform, arch: process.arch, node: process.version, fresh_machine: process.env.RAPIDRAW_FRESH_MACHINE === '1', fresh_machine_declaration: process.env.RAPIDRAW_FRESH_MACHINE === '1' ? 'Declared by runner; requires an actually fresh host/VM and empty dependency/model caches' : 'Existing host; this run cannot establish fresh-machine installation', built: args.has('--build'), native_requested: args.has('--native'), records }, null, 2)); }
if (failure) throw failure;
