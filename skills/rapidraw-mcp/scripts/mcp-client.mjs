#!/usr/bin/env node
// Persistent stdio MCP client; rendering and validation stay in RapidRAW.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const help = `Usage: node mcp-client.mjs --server /repo/mcp/dist/index.js --binary /repo/src-tauri/target/debug/RapidRAW --workspace /job [--timeout-ms 900000]
Remote: node mcp-client.mjs --server /local/repo/mcp/dist/index.js --connection /local/ssh.json --workspace /local/evidence
--connection reads a stdio launcher object with command, args, and optional cwd. In this mode --server only locates the local SDK, and --workspace only stores local responses. Configure native paths and timeouts in the launcher arguments.
--timeout-ms sets the server's native-processing timeout; per-request timeout_ms separately sets the client wait.
Keep this process open. Submit one JSON line at a time and inspect its result:
  {"tool":"capabilities","arguments":{"detail":"overview"},"timeout_ms":30000}
  {"tool":"get_session","arguments":{"session_id":"...","include_adjustments":true}}
  {"file":"/absolute/request.json"}
  {"file":"/absolute/operations.json","index":0,"arguments":{"session_id":"...","expected_revision":0}}
  {"resource":"rapidraw://adjustment-schema"}
  {"list_tools":["render","mask_create"]}
  {"close":true}
Optional pick: ["adjustment_schema.properties.temperature"] selects fields for stdout.
Structured response records (opaque assets redacted) and native image blocks are saved under workspace/client-output.
Large requests belong in files, not terminal input. No requests are retried automatically.`;
const options = {};
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}
for (let i = 0; i < argv.length; i += 2) {
  if (!['--server', '--binary', '--workspace', '--timeout-ms', '--connection'].includes(argv[i]) || !argv[i + 1]) {
    console.error(help);
    process.exit(2);
  }
  options[argv[i].slice(2)] = argv[i + 1];
}
for (const key of ['server', 'workspace', options.connection ? 'connection' : 'binary']) {
  if (!options[key] || !isAbsolute(options[key])) {
    console.error(`${key} must be an absolute path.\n${help}`);
    process.exit(2);
  }
}
if (
  options['timeout-ms'] !== undefined &&
  (!Number.isSafeInteger(Number(options['timeout-ms'])) || Number(options['timeout-ms']) < 1)
) {
  console.error('--timeout-ms must be a positive safe integer in milliseconds.');
  process.exit(2);
}
await access(options.server);
let launcher;
if (options.connection) {
  if (options.binary || options['timeout-ms'])
    throw new Error(
      '--connection cannot be combined with --binary or --timeout-ms; configure these in the launcher arguments',
    );
  launcher = JSON.parse(await readFile(options.connection, 'utf8'));
  if (
    !launcher ||
    typeof launcher !== 'object' ||
    Array.isArray(launcher) ||
    Object.keys(launcher).some((key) => !['command', 'args', 'cwd'].includes(key)) ||
    typeof launcher.command !== 'string' ||
    !launcher.command.trim() ||
    launcher.command.includes('\0') ||
    !Array.isArray(launcher.args) ||
    !launcher.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    (launcher.cwd !== undefined &&
      (typeof launcher.cwd !== 'string' || !isAbsolute(launcher.cwd) || launcher.cwd.includes('\0')))
  ) {
    throw new Error('Connection must contain command, string-array args, and optional absolute cwd');
  }
} else {
  await access(options.binary);
  launcher = {
    command: process.execPath,
    args: [
      options.server,
      '--binary',
      options.binary,
      '--workspace',
      options.workspace,
      ...(options['timeout-ms'] === undefined ? [] : ['--timeout-ms', options['timeout-ms']]),
    ],
  };
}
// Resolve the official SDK from the installed server dependencies, not the skill folder.
const requireFromServer = createRequire(options.server);
const { Client } = await import(pathToFileURL(requireFromServer.resolve('@modelcontextprotocol/client')).href);
const { StdioClientTransport } = await import(
  pathToFileURL(requireFromServer.resolve('@modelcontextprotocol/client/stdio')).href
);
const outputDir = join(options.workspace, 'client-output', `${Date.now()}-${process.pid}`);
await mkdir(outputDir, { recursive: true });
const client = new Client({ name: 'rapidraw-skill-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  ...launcher,
  stderr: 'inherit',
});
let sequence = 0;
const { redactClientData, summarizeOutput } = await import(
  new URL('./model-output.js', pathToFileURL(options.server)).href
);
const select = (data, paths) => Object.fromEntries(paths.map((p) => [p, p.split('.').reduce((v, k) => v?.[k], data)]));
let input;
try {
  await client.connect(transport);
  console.log(
    JSON.stringify({
      ready: true,
      output_dir: outputDir,
      note: 'MCP connected; call capabilities to check native engine startup.',
    }),
  );
  input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.file) {
        const saved = JSON.parse(await readFile(resolve(request.file), 'utf8'));
        if (
          request.index !== undefined &&
          (!Array.isArray(saved) ||
            !Number.isInteger(request.index) ||
            request.index < 0 ||
            request.index >= saved.length)
        )
          throw new Error('index must select an existing request in the file array');
        const selected = request.index === undefined ? saved : saved[request.index];
        if (!selected || typeof selected !== 'object' || Array.isArray(selected))
          throw new Error('File must contain a request object, or supply index for an array');
        request = { ...selected, arguments: { ...selected.arguments, ...request.arguments } };
      }
      if (request.close === true) break;
      if (
        request.pick !== undefined &&
        (!Array.isArray(request.pick) || !request.pick.every((p) => typeof p === 'string'))
      )
        throw new Error('pick must be an array of field paths');
      const kinds = [
        typeof request.tool === 'string',
        typeof request.resource === 'string',
        Array.isArray(request.list_tools),
      ];
      if (kinds.filter(Boolean).length !== 1) throw new Error('Specify exactly one of tool, resource, list_tools');
      const timeout = request.timeout_ms ?? 300000;
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > 1800000)
        throw new Error('timeout_ms must be 100..1800000');
    } catch (error) {
      console.log(JSON.stringify({ isError: true, phase: 'input', message: String(error) }));
      continue;
    }
    const started = Date.now();
    try {
      let result;
      if (request.tool)
        result = await client.callTool(
          {
            name: request.tool.startsWith('rapidraw_') ? request.tool : `rapidraw_${request.tool}`,
            arguments: request.arguments ?? {},
          },
          { timeout: request.timeout_ms ?? 300000 },
        );
      else if (request.resource) result = await client.readResource({ uri: request.resource });
      else {
        const listing = await client.listTools();
        result = {
          structuredContent: {
            tools: listing.tools.filter(
              (t) =>
                request.list_tools.length === 0 ||
                request.list_tools.includes(t.name) ||
                request.list_tools.includes(t.name.replace(/^rapidraw_/, '')),
            ),
          },
        };
      }
      const prefix = join(outputDir, String(++sequence).padStart(4, '0'));
      const images = [];
      for (const block of result.content ?? []) {
        if (block.type === 'image') {
          const ext = block.mimeType === 'image/png' ? 'png' : 'jpg';
          const imagePath = `${prefix}-${images.length + 1}.${ext}`;
          await writeFile(imagePath, Buffer.from(block.data, 'base64'));
          images.push(imagePath);
        }
      }
      let data = result.structuredContent;
      if (data === undefined && result.contents) {
        data = result.contents.map((entry) => {
          if (entry.mimeType === 'application/json' && typeof entry.text === 'string') {
            try {
              return { ...entry, data: JSON.parse(entry.text), text: undefined };
            } catch {
              /* Preserve invalid JSON for diagnosis. */
            }
          }
          return entry;
        });
        if (data.length === 1 && data[0].data !== undefined) data = data[0].data;
      }
      if (data === undefined) {
        const blocks = (result.content ?? []).filter((b) => b.type !== 'image');
        if (blocks.length === 1 && blocks[0].type === 'text') {
          try {
            data = JSON.parse(blocks[0].text);
          } catch {
            data = blocks;
          }
        } else data = blocks;
      }
      const envelope = {
        operation: request.tool ?? request.resource ?? 'list_tools',
        isError: !!result.isError,
        elapsed_ms: Date.now() - started,
        data: redactClientData(data),
        images,
      };
      const responsePath = `${prefix}.json`;
      await writeFile(responsePath, JSON.stringify(envelope, null, 2));
      const brief = result.isError
        ? envelope.data
        : request.pick
          ? select(envelope.data, request.pick)
          : request.list_tools || !envelope.data || Array.isArray(envelope.data)
            ? envelope.data
            : summarizeOutput(envelope.operation, envelope.data);
      console.log(JSON.stringify({ ...envelope, data: brief, response_path: responsePath }));
      if (result.isError) {
        // Avoid executing queued mutations after a failure whose state needs review.
        console.error('Stopping after MCP error. Inspect saved response/state before reconnecting; no replay.');
        process.exitCode = 1;
        break;
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          isError: true,
          phase: 'transport-or-output',
          message: String(error),
          elapsed_ms: Date.now() - started,
          next: 'Reconnect and inspect persisted state before retrying; the operation may have completed.',
        }),
      );
      process.exitCode = 1;
      break;
    }
  }
} finally {
  input?.close();
  await client.close();
}
