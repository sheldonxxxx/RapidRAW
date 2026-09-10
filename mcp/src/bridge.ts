import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type JsonObject = Record<string, unknown>;
export interface BridgeOptions {
  binary: string;
  workspace: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
interface Pending {
  id: number;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Owns exactly one native process. Never retries or silently replays a mutation. */
export class NativeBridge {
  private child?: ChildProcessWithoutNullStreams;
  private pending: Pending | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private buffer = '';
  private stderrBuffer = '';
  private nativeFatalError: BridgeError | undefined;
  private terminalError: BridgeError | undefined;
  private closePromise: Promise<void> | undefined;
  private capabilitiesPromise: Promise<JsonObject> | undefined;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: BridgeOptions) {
    if (!isAbsolute(options.binary) || !isAbsolute(options.workspace)) {
      throw new BridgeError('CONFIGURATION', 'RapidRAW binary and workspace must be absolute paths.');
    }
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new BridgeError('CONFIGURATION', 'Timeout must be a positive integer in milliseconds.');
    }
    this.log = options.log ?? ((message) => process.stderr.write(`[rapidraw] ${message}\n`));
  }

  private start(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.child) return;
    const child = spawn(this.options.binary, ['--mcp-bridge', '--workspace', this.options.workspace], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.options.env ? { env: this.options.env } : {}),
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.log(chunk.trimEnd());
      this.captureFatalError(chunk);
    });
    child.stdin.on('error', (error: Error) => this.fail(new BridgeError('BRIDGE_IO', error.message)));
    child.on('error', (error: Error) => this.fail(new BridgeError('BRIDGE_START', `Cannot run ${this.options.binary}: ${error.message}. Build the fork with MCP bridge support and check --binary.`)));
    child.on('exit', (code, signal) => this.fail(new BridgeError('BRIDGE_EXIT', `Native engine exited (${signal ?? code ?? 'unknown'}). Reconnect the MCP server and load the saved session; edits are never automatically replayed.`)));
    child.stdout.on('end', () => this.fail(new BridgeError('BRIDGE_EOF', 'Native engine closed its output. Reconnect and load the last saved session.')));
  }

  private captureFatalError(chunk: string): void {
    // Only the explicit native fatal prefix is eligible for client error details.
    // Other stderr can contain provider diagnostics and is never attached to results.
    this.stderrBuffer = (this.stderrBuffer + chunk).slice(-16384);
    let newline: number;
    while ((newline = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      const fatal = /^RapidRAW bridge: ([A-Z][A-Z_]+): (.{1,2048})$/.exec(line);
      if (fatal) this.nativeFatalError = new BridgeError(fatal[1]!, fatal[2]!);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > 64 * 1024 * 1024) {
      this.fail(new BridgeError('BRIDGE_PROTOCOL', 'Native response exceeded the 64 MiB limit. Use a smaller preview.'));
      this.child?.kill('SIGTERM');
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch {
        this.log(line.slice(0, 4096));
        continue;
      }
      if (!isObject(message) || !Number.isSafeInteger(message.id)) {
        this.log(line.slice(0, 4096));
        continue;
      }
      if (!this.pending || message.id !== this.pending.id) {
        this.fail(new BridgeError('BRIDGE_PROTOCOL', 'Native response ID did not match the active request. Reconnect before continuing.'));
        this.child?.kill('SIGTERM');
        return;
      }
      const active = this.pending;
      this.pending = undefined;
      clearTimeout(active.timer);
      active.cleanup();
      if (isObject(message.error) && typeof message.error.message === 'string') {
        active.reject(new BridgeError(typeof message.error.code === 'string' ? message.error.code : 'ENGINE_ERROR', message.error.message));
      } else if (isObject(message.result)) {
        active.resolve(message.result);
      } else {
        active.reject(new BridgeError('BRIDGE_PROTOCOL', 'Native response needs an object result or an error with a message.'));
      }
    }
  }

  private fail(error: BridgeError): void {
    this.terminalError ??= ['BRIDGE_EXIT', 'BRIDGE_EOF'].includes(error.code) ? this.nativeFatalError ?? error : error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.cleanup();
      this.pending.reject(this.terminalError);
      this.pending = undefined;
    }
  }

  request(method: string, params: JsonObject = {}, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<JsonObject> {
    const next = this.serial.then(() => {
      if (signal?.aborted) throw new BridgeError('REQUEST_CANCELLED', 'Request was cancelled before dispatch; no native edit was applied.');
      return this.dispatch(method, params, timeoutMs, signal);
    });
    // Rejections belong to each caller; the queue still drains after ordinary engine errors.
    this.serial = next.catch(() => undefined);
    return next;
  }

  capabilities(): Promise<JsonObject> {
    this.capabilitiesPromise ??= this.request('capabilities');
    return this.capabilitiesPromise;
  }

  private dispatch(method: string, params: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject> {
    this.start();
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new BridgeError('BRIDGE_TIMEOUT', `${method} exceeded ${timeoutMs} ms. The engine is being stopped because completion is uncertain. Reconnect and inspect saved state before retrying.`));
        this.child?.kill('SIGTERM');
        const killer = setTimeout(() => this.child?.kill('SIGKILL'), 1000);
        killer.unref();
      }, timeoutMs);
      const abort = (): void => {
        this.fail(new BridgeError('REQUEST_CANCELLED', 'Active native request was cancelled. The engine is being stopped; reconnect and inspect saved state before retrying.'));
        void this.close();
      };
      const cleanup = (): void => signal?.removeEventListener('abort', abort);
      this.pending = { id, resolve, reject, timer, cleanup };
      signal?.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.fail(new BridgeError('BRIDGE_IO', `Cannot send native request: ${error.message}`));
      });
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.stop();
    return this.closePromise;
  }

  private async stop(): Promise<void> {
    this.fail(new BridgeError('BRIDGE_CLOSED', 'MCP connection closed.'));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      const finish = (): void => { clearTimeout(terminate); clearTimeout(kill); resolve(); };
      child.once('close', finish);
      child.stdin.end();
    });
  }
}
