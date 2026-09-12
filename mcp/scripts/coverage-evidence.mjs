/** Coverage is evidence, not schema acceptance. No native/pixel credit is inferred from mocks. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { classifyRequirement, summarizeGroups } from './coverage-classification.mjs';

const exec = promisify(execFile);
export const evidenceLevels = ['native_call', 'native_assertion', 'pixel_assertion', 'visual_review'];
export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function isRuntimeSource(path) {
  return path.startsWith('src/') || path.startsWith('src-tauri/src/') || path.startsWith('mcp/src/') ||
    ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'package.json', 'package-lock.json', 'mcp/package.json', 'mcp/package-lock.json'].includes(path);
}
export function nativeExecutableFormat(header) {
  const magic = header.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') return 'ELF';
  if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) return 'Mach-O';
  if (header.subarray(0, 2).toString('ascii') === 'MZ') return 'PE';
  throw new Error('Native evidence requires an actual Mach-O/ELF/PE executable, not a script or mock subprocess');
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
export function sanitize(value, key = '') {
  if (/token|password|secret|authorization|api.?key/i.test(key)) return '[redacted]';
  if (typeof value === 'string' && (/base64/i.test(key) || value.length > 4096)) return `[omitted ${value.length} characters]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}
function leaves(schema, prefix, output) {
  if (!schema || typeof schema !== 'object') return;
  // A discriminator is part of the path, so brush.flow and liquify.flow cannot share credit.
  for (const variant of schema.oneOf ?? schema.anyOf ?? []) {
    const kind = variant.properties?.type?.const;
    leaves(variant, kind === undefined ? prefix : `${prefix}<${kind}>`, output);
  }
  for (const [name, value] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    output.add(path);
    leaves(value, path, output);
  }
  if (schema.items) leaves(schema.items, `${prefix}[]`, output);
  for (const value of schema.enum ?? (schema.const === undefined ? [] : [schema.const])) output.add(`${prefix}=${JSON.stringify(value)}`);
  if (schema.type === 'boolean') for (const value of [true, false]) output.add(`${prefix}=${value}`);
}
export function requiredInventory(tools, capabilities) {
  const required = new Set();
  for (const tool of tools) {
    const name = tool.name.replace(/^rapidraw_/, '');
    required.add(`tool:${name}`);
    const paths = new Set(); leaves(tool.inputSchema, '', paths);
    for (const path of paths) required.add(`parameter:${name}.${path}`);
  }
  const paths = new Set(); leaves(capabilities.adjustment_schema, '', paths);
  for (const path of paths) required.add(`adjustment:${path}`);
  return [...required].sort();
}
export function observedRequirements(method, args, { tools = [], capabilities = {} } = {}) {
  const output = new Set([`tool:${method}`]);
  function visit(value, prefix, schema = {}) {
    output.add(prefix);
    if (value === null || typeof value !== 'object') { output.add(`${prefix}=${JSON.stringify(value)}`); return; }
    if (Array.isArray(value)) {
      const alternatives = (schema.oneOf ?? schema.anyOf ?? []).filter((branch) => branch.items).map((branch) => branch.items);
      const itemSchema = schema.items ?? (alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives });
      for (const item of value) visit(item, `${prefix}[]`, itemSchema); return;
    }
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    const discriminated = variants.find((variant) => variant.properties?.type?.const !== undefined && variant.properties.type.const === value.type);
    // Only a discriminator present in this actual schema qualifies a path.
    // Generic retouch sub_masks and native discriminated recipe masks differ.
    const branches = discriminated ? [discriminated] : variants.filter((variant) => variant.properties?.type?.const === undefined && (!variant.type || variant.type === 'object'));
    const properties = Object.assign({}, schema.properties, ...branches.map((branch) => branch.properties));
    const base = discriminated ? `${prefix}<${value.type}>` : prefix;
    for (const [key, item] of Object.entries(value)) visit(item, `${base}.${key}`, properties[key]);
  }
  const input = tools.find((tool) => tool.name === `rapidraw_${method}`)?.inputSchema;
  for (const [key, value] of Object.entries(args)) visit(value, `parameter:${method}.${key}`, input?.properties?.[key]);
  const adjustment = capabilities.adjustment_schema;
  if (method === 'set_adjustments' && args.patch) for (const [key, value] of Object.entries(args.patch)) visit(value, `adjustment:${key}`, adjustment?.properties?.[key]);
  const local = adjustment?.properties?.masks?.items?.properties?.adjustments;
  if (method === 'mask_create' && args.adjustments) for (const [key, value] of Object.entries(args.adjustments)) visit(value, `adjustment:masks[].adjustments.${key}`, local?.properties?.[key]);
  return [...output];
}
export function aggregateEvidence(inventory, records) {
  const rows = new Map(inventory.map((id) => [id, { id, classification: classifyRequirement(id), levels: [], evidence: [], evidence_by_basis: { direct_input: [], explicit_assertion: [], derived_state: [], legacy_unspecified: [] }, failures: [], skips: [] }]));
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    // Only the real native SDK harness format grants coverage. Legacy/protocol logs stay separate.
    if (record.evidence_format !== 'rapidraw-native-evidence-v1' || record.execution !== 'real_native_mcp') continue;
    if (record.status === 'passed' && record.basis === 'derived_state') {
      if (record.type !== 'check' || !['native_assertion', 'pixel_assertion'].includes(record.level) || !Array.isArray(record.source_call_ids) || !record.source_call_ids.length || !record.source_call_ids.every((id) => { const source = byId.get(id); return source?.evidence_format === 'rapidraw-native-evidence-v1' && source.execution === 'real_native_mcp' && source.type === 'call' && source.status === 'passed' && source.level === 'native_call' && !source.expected_error; })) throw new Error(`Derived-state evidence ${record.id} needs an explicit assertion and successful native source calls`);
    }
    for (const id of record.requirements ?? []) {
      const row = rows.get(id); if (!row) continue;
      if (record.status === 'passed' && evidenceLevels.includes(record.level)) {
        if (!row.levels.includes(record.level)) row.levels.push(record.level);
        row.evidence.push(record.id);
        const basis = record.basis === 'direct_input' && record.direct_input_requirements && !record.direct_input_requirements.includes(id) ? 'explicit_assertion' : record.basis ?? 'legacy_unspecified';
        if (!Object.hasOwn(row.evidence_by_basis, basis)) throw new Error(`Unknown evidence basis ${basis}`);
        row.evidence_by_basis[basis].push(record.id);
      } else if (record.status === 'failed') row.failures.push({ id: record.id, error: record.error });
      else if (record.status === 'skipped') row.skips.push({ id: record.id, reason: record.reason });
    }
  }
  const requirements = [...rows.values()];
  return { schema_version: 2, requirements, groups: summarizeGroups(requirements), grouping_note: 'Families group shared schema and workflow contexts for planning only. Every original requirement retains independent evidence; group membership grants no credit.', totals: {
    required: requirements.length,
    untested: requirements.filter((r) => !r.levels.length).length,
    ...Object.fromEntries(evidenceLevels.map((level) => [level, requirements.filter((r) => r.levels.includes(level)).length])),
    ...Object.fromEntries(['direct_input', 'derived_state'].map((basis) => [basis, requirements.filter((r) => r.evidence_by_basis[basis].length).length])),
    failed: requirements.filter((r) => r.failures.length).length,
    skipped: requirements.filter((r) => r.skips.length).length,
  } };
}
export function markdownCoverage(report, detailFile = 'coverage.json') {
  const rows = report.requirements.filter((r) => r.id.startsWith('tool:'));
  return `# RapidRAW native MCP coverage\n\nGenerated from actual calls and explicit assertions. Empty cells are evidence gaps. Visual review is never inferred from image generation. Direct input and explicitly asserted derived state are separate evidence bases; neither grants pixel credit automatically.\n\n| Tool | Native call | Assertion | Pixel assertion | Visual review | Failures |\n|---|---|---|---|---|---|\n${rows.map((row) => `| ${row.id.slice(5)} | ${evidenceLevels.map((level) => row.levels.includes(level) ? 'passed' : '—').join(' | ')} | ${row.failures.length} |`).join('\n')}\n\nComplete per-parameter and per-adjustment coverage is in ${detailFile} (${report.totals.required} requirements; ${report.totals.untested} without evidence).\n\n## Requirement families\n\n${report.grouping_note}\n\n| Family | Requirements | Without evidence | Direct input | Derived state | Pixel assertion |\n|---|---:|---:|---:|---:|---:|\n${report.groups.map((group) => `| ${group.family} | ${group.required} | ${group.without_evidence} | ${group.direct_input} | ${group.derived_state} | ${group.pixel_assertion} |`).join('\n')}\n`;
}
export async function createNativeHarness({ suite, workspace, binary = process.env.RAPIDRAW_BINARY, env = {}, timeout = 300000 }) {
  if (!binary || !binary.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(binary)) throw new Error('RAPIDRAW_BINARY must be an absolute real RapidRAW executable path');
  const executable = await open(binary, 'r'); const header = Buffer.alloc(4);
  try { await executable.read(header, 0, 4, 0); } finally { await executable.close(); }
  const executableFormat = nativeExecutableFormat(header);
  workspace = resolve(workspace); await mkdir(workspace, { recursive: true });
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const git = async (...args) => (await exec('git', args, { cwd: repository })).stdout.trim();
  async function runtimeSnapshot() {
    const sourcePaths = (await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repository })).stdout.split('\0').filter(Boolean).filter(isRuntimeSource).sort();
    const files = await Promise.all([...new Set(sourcePaths)].map(async (path) => ({ path, sha256: await hashFile(join(repository, path)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) })));
    return { sha256: hashBytes(JSON.stringify(files)), files };
  }
  const diff = await exec('git', ['diff', 'HEAD', '--binary'], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
  const untrackedPaths = (await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repository })).stdout.split('\0').filter(Boolean).sort();
  const untracked = await Promise.all(untrackedPaths.map(async (path) => ({ path, sha256: await hashFile(join(repository, path)) })));
  const runtime = await runtimeSnapshot();
  const suitePath = process.argv[1] ? resolve(process.argv[1]) : null;
  const provenance = { source_revision: await git('rev-parse', 'HEAD'), source_dirty: Boolean(await git('status', '--porcelain')), source_diff_sha256: hashBytes(diff.stdout), source_tree_sha256: hashBytes(JSON.stringify({ diff: hashBytes(diff.stdout), untracked })), untracked_source_files: untracked, runtime_tree_sha256: runtime.sha256, runtime_source_files: runtime.files, suite_script: suitePath ? relative(repository, suitePath) : null, suite_script_sha256: suitePath ? await hashFile(suitePath) : null, binary_sha256: await hashFile(binary), binary, executable_format: executableFormat, platform: process.platform, arch: process.arch, node: process.version, suite, started_at: new Date().toISOString() };
  const records = [], fixtures = [];
  const evidencePath = join(workspace, 'evidence.jsonl');
  // An acceptance retry must use a new workspace so its first failure survives.
  await writeFile(evidencePath, '', { flag: 'wx' });
  let client;
  async function connect() {
    client = new Client({ name: `rapidraw-${suite}`, version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace, '--timeout-ms', String(timeout)], stderr: 'inherit', env: { ...process.env, ...env } }));
  }
  await connect();
  const tools = (await client.listTools()).tools;
  let capabilities = {};
  async function record(details) {
    const value = sanitize({ evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', id: `${suite}:${records.length + 1}`, ...details });
    records.push(value); await appendFile(evidencePath, `${JSON.stringify(value)}\n`); return value;
  }
  async function call(method, args = {}, options = {}) {
    const started = performance.now(); let response;
    try {
      response = await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout });
      const optionalError = !!response.isError && options.allowError instanceof RegExp && options.allowError.test(JSON.stringify(response.structuredContent ?? response.content));
      if (!!response.isError !== !!options.expectError && !optionalError) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
      const observed = observedRequirements(method, args, { tools, capabilities });
      const entry = await record({ type: 'call', method, args, status: optionalError ? 'skipped' : 'passed', level: response.isError ? 'native_assertion' : 'native_call', basis: response.isError ? 'explicit_assertion' : 'direct_input', direct_input_requirements: response.isError ? [] : observed, requirements: options.expectError ? [`tool:${method}`, ...(options.requirements ?? [])] : [...observed, ...(options.requirements ?? [])], elapsed_ms: Math.round(performance.now() - started), expected_error: !!options.expectError, ...(optionalError ? { reason: `Allowed runtime condition; processing did not succeed: ${JSON.stringify(response.structuredContent ?? response.content)}` } : {}), result: response.structuredContent });
      return { data: response.structuredContent, result: response, images: response.content.filter((c) => c.type === 'image'), call_id: entry.id };
    } catch (error) {
      await record({ type: 'call', method, args, status: 'failed', level: 'native_call', requirements: [`tool:${method}`, ...(options.requirements ?? [])], elapsed_ms: Math.round(performance.now() - started), error: String(error) }); throw error;
    }
  }
  capabilities = (await call('capabilities')).data;
  if (capabilities.engine !== 'RapidRAW' || capabilities.protocol_version !== 1) throw new Error('A real compatible RapidRAW native binary is required');
  const inventory = requiredInventory(tools, capabilities);
  await writeFile(join(workspace, 'inventory.json'), JSON.stringify({ provenance, attribution_version: 'actual-schema-v2', tools, capabilities, requirements: inventory }, null, 2));
  async function check(name, requirements, fn, level = 'native_assertion', basis = 'explicit_assertion', source_call_ids) {
    if (!evidenceLevels.includes(level) || level === 'native_call' || level === 'visual_review') throw new Error('Use explicit native/pixel assertions; visual review requires a named reviewer and artifacts');
    try {
      if (basis === 'derived_state') {
        if (!requirements.length || !requirements.every((id) => inventory.includes(id))) throw new Error('Derived-state checks must name existing schema requirements');
        // Validate before evaluating a check so callers cannot mistake an error
        // or a skipped operation for a successful derived-state source.
        aggregateEvidence(inventory, [...records, { evidence_format: 'rapidraw-native-evidence-v1', execution: 'real_native_mcp', id: 'validate-derived-source', type: 'check', status: 'passed', level, basis, source_call_ids, requirements: [] }]);
      }
      const details = await fn(); await record({ type: 'check', name, status: 'passed', level, basis, ...(source_call_ids ? { source_call_ids } : {}), requirements, details }); return details;
    } catch (error) { await record({ type: 'check', name, status: 'failed', level, basis, ...(source_call_ids ? { source_call_ids } : {}), requirements, error: String(error) }); throw error; }
  }
  return { workspace, get client() { return client; }, tools, capabilities, call, records, inventory,
    async reconnect() { await client.close(); await connect(); return call('capabilities'); },
    has: (method) => tools.some((t) => t.name === `rapidraw_${method}`),
    async fixture(path, role, extra = {}) {
      const sidecar = `${path}.rrdata`; const sidecar_sha256 = await hashFile(sidecar).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      const entry = { path, sha256: await hashFile(path), sidecar, sidecar_sha256, role, ...extra }; fixtures.push(entry); return entry;
    },
    check,
    checkDerived: (name, requirements, sourceCallIds, fn, level = 'native_assertion') => check(name, requirements, fn, level, 'derived_state', sourceCallIds),
    async skip(name, requirements, reason) { await record({ type: 'check', name, status: 'skipped', requirements, reason }); },
    async close(error) {
      await client.close();
      if (await hashFile(binary) !== provenance.binary_sha256) await record({ type: 'check', name: 'binary_preservation', requirements: ['tool:capabilities'], status: 'failed', error: 'Native binary changed during this run; do not combine evidence across builds' });
      if ((await runtimeSnapshot()).sha256 !== provenance.runtime_tree_sha256) await record({ type: 'check', name: 'runtime_source_preservation', requirements: ['tool:capabilities'], status: 'failed', error: 'Runtime source changed during this run; rerun against a stable build' });
      for (const fixture of fixtures) {
        const current = await hashFile(fixture.path).catch(() => null);
        const sidecar = await hashFile(fixture.sidecar).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (current !== fixture.sha256 || sidecar !== fixture.sidecar_sha256) await record({ type: 'check', name: 'source_preservation', requirements: ['tool:open_photo'], status: 'failed', error: `Fixture or original sidecar changed: ${fixture.path}` });
      }
      const report = aggregateEvidence(inventory, records);
      await writeFile(join(workspace, 'coverage.json'), JSON.stringify({ provenance, fixtures, error: error ? String(error) : undefined, ...report }, null, 2));
      await writeFile(join(workspace, 'coverage.md'), markdownCoverage(report));
      await writeFile(join(workspace, 'summary.json'), JSON.stringify({ provenance, fixtures, status: error || report.totals.failed ? 'failed' : 'passed', calls: records.filter((r) => r.type === 'call').length, ...report.totals }, null, 2));
      if (!error && report.totals.failed) throw new Error('Native evidence contains failed checks or changed runtime/binary provenance; inspect summary.json and evidence.jsonl');
      return report;
    },
  };
}
export async function readEvidence(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
