import { McpServer, ResourceTemplate, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { BridgeError, NativeBridge, isObject, type JsonObject } from './bridge.js';
import { toolDefinitions } from './tools.js';
import { workflow } from './workflow.js';

export function toolResult(result: JsonObject): CallToolResult {
  const structuredContent = { ...result };
  const content: ContentBlock[] = [];
  if (isObject(result.image) && typeof result.image.data === 'string' && typeof result.image.mimeType === 'string') {
    const { data, ...imageMetadata } = result.image;
    structuredContent.image = imageMetadata;
    content.push({ type: 'image', data, mimeType: result.image.mimeType });
  }
  content.unshift({ type: 'text', text: JSON.stringify(structuredContent) });
  const failed = result.ok === false || (typeof result.failed === 'number' && result.failed > 0);
  return { content, structuredContent, ...(failed ? { isError: true } : {}) };
}

function toolError(error: unknown): CallToolResult {
  const code = error instanceof BridgeError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Unexpected native engine error.';
  const output = { error: { code, message } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
}

export function createServer(bridge: NativeBridge): McpServer {
  const server = new McpServer({ name: 'rapidraw-mcp-server', version: '0.1.0' }, {
    instructions: 'Nondestructive local photo editing through RapidRAW. Read rapidraw://workflow and rapidraw_capabilities, inspect preview images and detail crops, then save and verify exports. Source files remain unchanged. Every tool returns structured data; preview tools also return native image blocks.',
  });
  const capabilities = async (): Promise<JsonObject> => {
    const result = await bridge.capabilities();
    if (result.protocol_version !== 1 || !Array.isArray(result.methods)) {
      throw new BridgeError('INCOMPATIBLE_ENGINE', 'The selected binary does not expose RapidRAW MCP bridge protocol 1. Build the fork and point --binary at the resulting executable.');
    }
    return result;
  };
  for (const definition of toolDefinitions) {
    server.registerTool(`rapidraw_${definition.method}`, {
      title: definition.method.split('_').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' '),
      description: definition.description,
      inputSchema: definition.schema,
      outputSchema: z.record(z.string(), z.unknown()),
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: false,
        idempotentHint: definition.idempotent ?? definition.readOnly,
        openWorldHint: definition.network ?? false,
      },
    }, async (params, context): Promise<CallToolResult> => {
      try {
        const available = await capabilities();
        if (definition.method === 'capabilities') return toolResult(available);
        if (!(available.methods as unknown[]).includes(definition.method)) {
          throw new BridgeError('UNSUPPORTED_METHOD', `This engine does not support ${definition.method}. Check rapidraw_capabilities and build a matching fork revision.`);
        }
        return toolResult(await bridge.request(definition.method, params, definition.timeoutMs, context.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    });
  }
  server.registerResource('workflow', 'rapidraw://workflow', {
    title: 'Professional editing workflow', description: 'Visual review, nondestructive editing, masking, delivery and recovery workflow.', mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: workflow }] }));
  server.registerResource('adjustment-schema', 'rapidraw://adjustment-schema', {
    title: 'Native edit and mask schemas', description: 'Current engine schema and coordinates for validated adjustment recipes and mask definitions.', mimeType: 'application/json',
  }, async (uri) => {
    const data = await capabilities();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }] };
  });
  server.registerResource('session', new ResourceTemplate('rapidraw://sessions/{session_id}', { list: undefined }), {
    title: 'Editing session state', description: 'Current source, working image, revision and full adjustments for a session.', mimeType: 'application/json',
  }, async (uri, variables) => {
    const sessionId = variables.session_id;
    if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) throw new Error('Invalid session ID.');
    await capabilities();
    const result = await bridge.request('get_session', { session_id: sessionId, include_adjustments: true });
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] };
  });
  server.registerPrompt('pro_photo_edit', {
    title: 'Edit a photo to professional quality', description: 'Run a complete visually reviewed and nondestructive editing workflow.',
    argsSchema: z.object({ path: z.string().min(1).describe('Absolute source photo path.'), intent: z.string().optional().describe('Desired treatment and delivery format; default natural professional edit.') }).strict(),
  }, ({ path, intent }) => ({ messages: [
    { role: 'user', content: { type: 'resource', resource: { uri: 'rapidraw://workflow', mimeType: 'text/markdown', text: workflow } } },
    { role: 'user', content: { type: 'text', text: `Edit ${JSON.stringify(path)}. Intent: ${intent ?? 'Natural professional treatment that suits the subject and lighting.'} Complete the workflow and return the verified export and saved recipe paths.` } },
  ] }));
  return server;
}
