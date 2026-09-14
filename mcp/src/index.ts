#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NativeBridge } from './bridge.js';
import { createServer } from './server.js';
import { OperationJobs } from './operation-jobs.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      workspace: { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      `RapidRAW MCP server\n\nUsage: node dist/index.js --binary /absolute/path/to/rapidraw --workspace /absolute/output/folder\n\nOptions:\n  --binary       Fork binary with --mcp-bridge support (or RAPIDRAW_BINARY)\n  --workspace    Isolated session and output folder (or RAPIDRAW_WORKSPACE)\n  --timeout-ms   Native request timeout; default 300000 (or RAPIDRAW_TIMEOUT_MS)\n  --help         Show this message\n\nThe MCP transport is stdio. Diagnostic output goes to stderr.\n`,
    );
    return;
  }
  const binary = values.binary ?? process.env.RAPIDRAW_BINARY;
  const workspace = values.workspace ?? process.env.RAPIDRAW_WORKSPACE;
  if (!binary || !workspace || !isAbsolute(binary) || !isAbsolute(workspace)) {
    throw new Error(
      'Provide absolute --binary and --workspace paths, or RAPIDRAW_BINARY and RAPIDRAW_WORKSPACE. See --help.',
    );
  }
  const timeoutMs = Number(values['timeout-ms'] ?? process.env.RAPIDRAW_TIMEOUT_MS ?? 300000);
  const bridge = new NativeBridge({ binary, workspace, timeoutMs });
  const jobs = new OperationJobs(bridge, { binary, workspace, timeoutMs });
  const server = createServer(bridge, jobs);
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await jobs.close();
    await bridge.close();
    await server.close();
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.stdin.once('end', () => {
    void shutdown();
  });
  server.server.onclose = () => {
    void shutdown();
  };
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  process.stderr.write(`[rapidraw-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
