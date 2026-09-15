import { McpServer, ResourceTemplate, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { BridgeError, NativeBridge, isObject, type JsonObject } from './bridge.js';
import { toolDefinitions } from './tools.js';
import { workflow } from './workflow.js';
import { OperationJobs } from './operation-jobs.js';
import { modelOutput, capabilityOutput, rejectAssetDescriptors } from './model-output.js';

// SDK v2 stdio peers default to a 10 MiB read buffer. Keep room for SDK
// envelopes and framing without changing requested image encoding or geometry.
export const MCP_RESPONSE_BUDGET_BYTES = 8 * 1024 * 1024;
interface ResponseContext {
  method?: string;
  params?: JsonObject;
  readOnly?: boolean;
  requestId?: string | number;
}
const responseBytes = (result: unknown, requestId: string | number = 0): number =>
  Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }), 'utf8') + 1;
const textResult = (output: JsonObject): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output,
});

function recoveryMetadata(result: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const key of [
    'id',
    'session_id',
    'result_session_id',
    'parent_session_id',
    'revision',
    'mask_id',
    'patch_id',
    'version_id',
    'job_id',
    'path',
    'bundle_path',
    'working_path',
    'status',
    'ok',
    'failed',
    'succeeded',
    'total',
  ]) {
    const value = result[key];
    if (
      (typeof value === 'string' && value.length <= 2048) ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    )
      output[key] = value;
  }
  for (const key of ['mask_ids', 'submask_ids', 'patch_ids'])
    if (Array.isArray(result[key])) {
      const ids = result[key] as unknown[];
      output[key] = ids.slice(0, 32).filter((value) => typeof value === 'string' && value.length <= 256);
      output[`${key}_count`] = ids.length;
      output[`${key}_truncated`] = (output[key] as unknown[]).length !== ids.length;
    }
  return output;
}

function oversizedResult(result: JsonObject, bytes: number, context: ResponseContext): CallToolResult {
  const mutation = context.readOnly !== true;
  const inputSession = context.params?.session_id;
  const recovery: JsonObject = {
    method: context.method?.slice(0, 128) ?? 'unknown',
    request_completed: true,
    mutation_may_have_completed: mutation,
    retry_mutation: false,
    ...(typeof inputSession === 'string' && inputSession.length <= 2048 ? { input_session_id: inputSession } : {}),
    ...recoveryMetadata(result),
    next_step: mutation
      ? 'The operation already returned. Do not repeat the mutation. Inspect the returned session/revision with get_session(include_adjustments:false), or inspect the returned job ID/output path. Request any preview separately with a smaller long_edge, bounded native region, or explicit JPEG format.'
      : 'Retry this read with a smaller long_edge, a bounded native region, or explicit JPEG format. For session state, request get_session(include_adjustments:false). Images were not resized or transcoded automatically.',
  };
  for (const key of ['results', 'items'])
    if (Array.isArray(result[key])) {
      const entries = result[key] as unknown[];
      recovery[key] = entries.slice(0, 16).map((entry) =>
        isObject(entry)
          ? {
              ...recoveryMetadata(entry),
              ...(isObject(entry.result) ? { result: recoveryMetadata(entry.result) } : {}),
            }
          : {},
      );
      recovery[`${key}_count`] = entries.length;
      recovery[`${key}_truncated`] = entries.length > 16;
    }
  return textResult({
    error: {
      code: 'RESPONSE_TOO_LARGE',
      message: `The completed response requires ${bytes} UTF-8 JSON-RPC bytes, exceeding the ${MCP_RESPONSE_BUDGET_BYTES}-byte MCP response budget. The connection remains usable; follow recovery guidance before retrying.`,
      response_bytes: bytes,
      max_response_bytes: MCP_RESPONSE_BUDGET_BYTES,
    },
    recovery,
  });
}

export function toolResult(result: JsonObject, context: ResponseContext = {}): CallToolResult {
  const structuredContent =
    context.method === 'get_session' && context.params?.include_assets === true ? { ...result } : modelOutput(result);
  const content: ContentBlock[] = [];
  if (isObject(result.image) && typeof result.image.data === 'string' && typeof result.image.mimeType === 'string') {
    const { data, ...imageMetadata } = result.image;
    structuredContent.image = imageMetadata;
    content.push({ type: 'image', data, mimeType: result.image.mimeType });
  }
  if (Array.isArray(result.images)) {
    structuredContent.images = result.images.map((entry) => {
      if (!isObject(entry) || typeof entry.data !== 'string' || typeof entry.mimeType !== 'string') return entry;
      const { data, ...metadata } = entry;
      // content[0] will be the text summary; indexes identify the corresponding native image blocks.
      const contentIndex = content.length + 1;
      content.push({ type: 'image', data, mimeType: entry.mimeType });
      return { ...metadata, content_index: contentIndex };
    });
  }
  content.unshift({ type: 'text', text: JSON.stringify(structuredContent) });
  const failed = result.ok === false || (typeof result.failed === 'number' && result.failed > 0);
  const response: CallToolResult = { content, structuredContent, ...(failed ? { isError: true } : {}) };
  const bytes = responseBytes(response, context.requestId);
  return bytes <= MCP_RESPONSE_BUDGET_BYTES ? response : oversizedResult(result, bytes, context);
}

function toolError(error: unknown): CallToolResult {
  const code = error instanceof BridgeError ? error.code.slice(0, 128) : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Unexpected native engine error.';
  return textResult({
    error: { code, message: message.slice(0, 4096), ...(message.length > 4096 ? { message_truncated: true } : {}) },
  });
}

function jsonResource(uri: URL, data: JsonObject, requestId: string | number) {
  const response = {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(modelOutput(data)) }],
  };
  const bytes = responseBytes(response, requestId);
  if (bytes > MCP_RESPONSE_BUDGET_BYTES)
    throw new BridgeError(
      'RESPONSE_TOO_LARGE',
      `RESPONSE_TOO_LARGE: Resource requires ${bytes} bytes; MCP budget is ${MCP_RESPONSE_BUDGET_BYTES}. Read session metadata using get_session(include_adjustments:false) and bounded preview regions. No mutation was requested; the connection remains usable.`,
    );
  return response;
}

export function createServer(bridge: NativeBridge, jobs?: OperationJobs): McpServer {
  const server = new McpServer(
    { name: 'rapidraw-mcp-server', version: '0.1.0' },
    {
      instructions:
        'Nondestructive local photo editing through RapidRAW. Read rapidraw://workflow and rapidraw_capabilities(detail:"overview"), then request needed schema_paths. Inspect preview images and detail crops, then save and verify exports. Source files remain unchanged. State asset descriptors are not replacement recipes. Every tool returns structured data; preview tools also return native image blocks.',
    },
  );
  const capabilities = async (): Promise<JsonObject> => {
    const result = await bridge.capabilities();
    if (result.protocol_version !== 1 || !Array.isArray(result.methods)) {
      throw new BridgeError(
        'INCOMPATIBLE_ENGINE',
        'The selected binary does not expose RapidRAW MCP bridge protocol 1. Build the fork and point --binary at the resulting executable.',
      );
    }
    const limits = {
      max_response_bytes: MCP_RESPONSE_BUDGET_BYTES,
      oversized_response: 'RESPONSE_TOO_LARGE',
      automatic_image_resizing: false,
    };
    return jobs
      ? {
          ...result,
          methods: [...result.methods, ...OperationJobs.methods],
          background_operations: {
            isolation: 'separate native worker and captured bundle',
            progress: 'stage',
            cancellation: 'worker process only',
          },
          transport_limits: limits,
        }
      : { ...result, transport_limits: limits };
  };
  for (const definition of toolDefinitions) {
    server.registerTool(
      `rapidraw_${definition.method}`,
      {
        title: definition.method
          .split('_')
          .map((word) => word[0]!.toUpperCase() + word.slice(1))
          .join(' '),
        description: definition.description,
        inputSchema: definition.schema,
        outputSchema: z.record(z.string(), z.unknown()),
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: false,
          idempotentHint: definition.idempotent ?? definition.readOnly,
          openWorldHint: definition.network ?? false,
        },
      },
      async (params, context): Promise<CallToolResult> => {
        const respond = (result: JsonObject) =>
          toolResult(result, {
            method: definition.method,
            params,
            readOnly: definition.readOnly,
            requestId: context.mcpReq.id,
          });
        try {
          const available = await capabilities();
          if (definition.method === 'capabilities') return respond(capabilityOutput(available, params));
          rejectAssetDescriptors(params);
          if (definition.host) {
            if (!jobs)
              throw new BridgeError(
                'UNSUPPORTED_METHOD',
                'Operation workers require the configured server entry point.',
              );
            if (definition.method === 'start_operation') {
              const operation = toolDefinitions.find((tool) => tool.method === params.operation && !tool.host);
              if (!operation) throw new BridgeError('INVALID_ARGUMENT', 'Unknown native operation');
              const valid = operation.schema.safeParse(params.arguments);
              if (!valid.success) throw new BridgeError('INVALID_ARGUMENT', valid.error.message);
              return respond(await jobs.dispatch(definition.method, { ...params, arguments: valid.data }));
            }
            return respond(await jobs.dispatch(definition.method, params));
          }
          if (!(available.methods as unknown[]).includes(definition.method)) {
            throw new BridgeError(
              'UNSUPPORTED_METHOD',
              `This engine does not support ${definition.method}. Check rapidraw_capabilities and build a matching fork revision.`,
            );
          }
          const nativeParams = { ...params };
          if (definition.method === 'get_session') delete nativeParams.include_assets;
          return respond(
            await bridge.request(definition.method, nativeParams, definition.timeoutMs, context.mcpReq.signal),
          );
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
  server.registerResource(
    'workflow',
    'rapidraw://workflow',
    {
      title: 'Professional editing workflow',
      description: 'Visual review, nondestructive editing, masking, delivery and recovery workflow.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: workflow }] }),
  );
  server.registerResource(
    'adjustment-schema',
    'rapidraw://adjustment-schema',
    {
      title: 'Native edit and mask schemas',
      description: 'Current engine schema and coordinates for validated adjustment recipes and mask definitions.',
      mimeType: 'application/json',
    },
    async (uri, context) => {
      const available = await capabilities();
      const data = {
        protocol_version: available.protocol_version,
        engine: available.engine,
        bridge_version: available.bridge_version,
        schema_id: capabilityOutput(available, { detail: 'overview' }).schema_id,
        coordinate_space: available.coordinate_space,
        adjustment_schema: available.adjustment_schema,
      };
      return jsonResource(uri, data, context.mcpReq.id);
    },
  );
  server.registerResource(
    'session',
    new ResourceTemplate('rapidraw://sessions/{session_id}', { list: undefined }),
    {
      title: 'Editing session state',
      description:
        'Current source, working image, revision and adjustments with opaque asset descriptors. Use native saved state for complete recipes.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) => {
      const sessionId = variables.session_id;
      if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) throw new Error('Invalid session ID.');
      await capabilities();
      const result = await bridge.request('get_session', { session_id: sessionId, include_adjustments: true });
      return jsonResource(uri, result, context.mcpReq.id);
    },
  );
  server.registerPrompt(
    'pro_photo_edit',
    {
      title: 'Edit a photo to professional quality',
      description: 'Run a complete visually reviewed and nondestructive editing workflow.',
      argsSchema: z
        .object({
          path: z.string().min(1).max(16384).describe('Absolute source photo path.'),
          intent: z
            .string()
            .max(65536)
            .optional()
            .describe('Desired treatment and delivery format; default natural professional edit.'),
        })
        .strict(),
    },
    ({ path, intent }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: { uri: 'rapidraw://workflow', mimeType: 'text/markdown', text: workflow },
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Edit ${JSON.stringify(path)}. Intent: ${intent ?? 'Natural professional treatment that suits the subject and lighting.'} Complete the workflow and return the verified export and saved recipe paths.`,
          },
        },
      ],
    }),
  );
  return server;
}
