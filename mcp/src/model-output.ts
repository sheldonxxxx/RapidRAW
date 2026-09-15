import { createHash } from 'node:crypto';
import { BridgeError, isObject, type JsonObject } from './bridge.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaqueKeys = new Set(['maskDataBase64', 'logitsBase64', 'lensBlurDepthMap', 'lutData']);

/** Project native state without modifying it. Descriptors are never replacement recipes. */
export function modelOutput(data: JsonObject): JsonObject {
  let count = 0;
  const walk = (value: unknown, path: string[] = []): unknown => {
    const key = path.at(-1);
    const opaque = opaqueKeys.has(key ?? '') || (path.at(-2) === 'patchData' && (key === 'color' || key === 'mask'));
    if (typeof value === 'string' && value.length > 0 && opaque) {
      count++;
      return {
        _rapidraw_asset: true,
        sha256: digest(value),
        encoded_chars: value.length,
        state_path: '/' + path.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/'),
      };
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, [...path, String(i)]));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, [...path, k])]));
    return value;
  };
  const output = walk(data) as JsonObject;
  if (count)
    output.state_representation = {
      kind: 'model-summary-v1',
      omitted_assets: count,
      note: 'Asset descriptors identify native state; they are not editable pixels or a replacement recipe. Use targeted merge/mask tools; use save_session or portable bundles to preserve complete state.',
    };
  return output;
}

export function rejectAssetDescriptors(value: unknown): void {
  if (Array.isArray(value)) value.forEach(rejectAssetDescriptors);
  else if (isObject(value)) {
    if (value._rapidraw_asset === true || value.kind === 'model-summary-v1')
      throw new BridgeError(
        'INVALID_ARGUMENT',
        'A model-facing asset summary cannot be used as an edit or replacement recipe. Apply a targeted merge or use native saved state. No mutation was requested.',
      );
    Object.values(value).forEach(rejectAssetDescriptors);
  }
}

export function capabilityOutput(available: JsonObject, params: JsonObject = {}): JsonObject {
  const schema = available.adjustment_schema;
  const schemaId = digest(JSON.stringify(schema ?? null));
  // No-argument calls retain the legacy full contract for programmatic clients.
  if (params.detail !== 'overview' && !Array.isArray(params.schema_paths)) return { ...available, schema_id: schemaId };
  const { adjustment_schema: _, ...overview } = available;
  const output: JsonObject = {
    ...overview,
    schema_id: schemaId,
    schema_discovery: {
      tool: 'rapidraw_capabilities',
      schema_paths:
        'Paths inside adjustment_schema, e.g. properties.temperature; detail:full returns the complete schema.',
    },
  };
  if (isObject(schema)) {
    output.schema_description = schema.description;
    output.adjustment_keys = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  }
  if (Array.isArray(params.schema_paths)) {
    const selected: JsonObject = {};
    for (const path of params.schema_paths as string[]) {
      let value: unknown = schema;
      for (const part of path.split('.')) {
        if ((!isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, part))
          throw new BridgeError('INVALID_ARGUMENT', `Unknown adjustment schema path: ${path}`);
        value = (value as JsonObject)[part];
      }
      selected[path] = value;
    }
    output.schemas = selected;
  }
  return output;
}

/** Also protects clients connected to older servers that still return opaque assets. */
export function redactClientData(data: unknown): unknown {
  const scrub = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string' && /token|password|secret|api.?key/i.test(key)) return '[redacted]';
    if (typeof value === 'string' && /base64/i.test(key)) return '[large payload omitted]';
    if (Array.isArray(value)) return value.map((item) => scrub(item));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    return value;
  };
  return scrub(
    isObject(data)
      ? modelOutput(data)
      : Array.isArray(data)
        ? data.map((v) => (isObject(v) ? modelOutput(v) : v))
        : data,
  );
}

const common = [
  'id',
  'session_id',
  'result_session_id',
  'parent_session_id',
  'revision',
  'mask_id',
  'mask_ids',
  'submask_id',
  'submask_ids',
  'patch_id',
  'patch_ids',
  'job_id',
  'version_id',
  'status',
  'stage',
  'progress',
  'ok',
  'error',
  'code',
  'message',
  'warnings',
  'recovery',
  'state_representation',
];
const fields = (data: JsonObject, keys: string[]): JsonObject =>
  Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));

/** Preserve structured results for unknown methods; silently empty success is unsafe. */
export function summarizeOutput(operation: string, data: JsonObject): JsonObject {
  const method = operation.replace(/^rapidraw_/, '');
  if (data.error || data.recovery || data.ok === false || (typeof data.failed === 'number' && data.failed > 0))
    return data;
  if (method === 'capabilities')
    return fields(data, [
      ...common,
      'engine',
      'bridge_version',
      'protocol_version',
      'methods',
      'workspace',
      'coordinate_space',
      'precision',
      'limits',
      'transport_limits',
      'model_policy',
      'persistence',
      'originals',
      'schema_id',
      'schema_discovery',
      'schema_description',
      'adjustment_keys',
      'schemas',
      'background_operations',
    ]);
  if (method === 'get_session') return data;
  if (/^(start_|get_|cancel_|resume_).*(job|denoise|operation)/.test(method) || method === 'save_version') return data;
  if (/^(render|inspect_adjustments)/.test(method)) return data;
  if (/export|bundle/.test(method)) return data;
  if (
    [
      'open_photo',
      'set_adjustments',
      'mask_create',
      'mask_update',
      'mask_delete',
      'mask_generate',
      'mask_refine',
      'retouch',
      'undo',
      'redo',
      'save_session',
      'restore_version',
      'apply_lut',
      'apply_preset',
    ].includes(method)
  ) {
    const output = { ...data };
    // Session metadata is repeated on commits; preserve provenance for open/save and
    // every unrecognized result field (including future refinement/retouch receipts).
    if (!['open_photo', 'save_session'].includes(method)) {
      for (const key of ['source_path', 'working_path', 'metadata', 'is_raw']) delete output[key];
    }
    return output;
  }
  return data;
}
