import * as z from 'zod/v4';

const path = z.string().min(1).max(32768).describe('Absolute local filesystem path. Exports must be inside workspace/exports; saved recipes must be inside workspace/recipes.');
const record = z.record(z.string(), z.unknown());
const sessionId = z.string().min(1).max(128).describe('Session ID returned by rapidraw_open_photo or rapidraw_merge.');
const session = { session_id: sessionId };
const mutation = { ...session, expected_revision: z.number().int().nonnegative().optional().describe('Reject the mutation if the session revision changed since inspection.') };
const percent = z.number().min(0).max(100);
const region = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }).strict().describe('Rectangle in oriented full-resolution image pixels, before user crop.');
const renderRegion = region.extend({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).describe('Rectangle in full-resolution rendered image pixels AFTER user crop and geometry. Extracted before long_edge resizing; read rendered dimensions first.');
const point = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).strict();
const longEdge = z.number().int().min(1).max(32768).describe('Maximum output long edge in pixels. Preview default 1600; use a region for native detail review.');
const adjustments = record.describe('Native RapidRAW adjustment object. Read rapidraw://adjustment-schema first; unknown keys and invalid values are rejected by the engine.');
const subMask = z.object({
  id: z.string().min(1), type: z.string().min(1), visible: z.boolean(), invert: z.boolean().optional(),
  opacity: percent.optional(), mode: z.enum(['additive', 'subtractive', 'intersect']), parameters: record,
}).strict();
const watermark = z.object({
  path, anchor: z.enum(['topLeft', 'topCenter', 'topRight', 'centerLeft', 'center', 'centerRight', 'bottomLeft', 'bottomCenter', 'bottomRight']),
  scale: z.number().positive(), spacing: z.number().nonnegative(), opacity: percent,
}).strict();
const exportOptions = {
  format: z.enum(['jpeg', 'png', 'tiff', 'webp', 'avif', 'jxl', 'cube']).optional(),
  quality: z.number().int().min(1).max(100).optional(), long_edge: longEdge.optional().describe('Convenience maximum long-edge resize. Cannot be combined with resize.'),
  resize: z.object({ mode: z.enum(['longEdge', 'shortEdge', 'width', 'height']), value: z.number().int().min(1).max(32768), dont_enlarge: z.boolean().default(true) }).strict().optional().describe('Resize by long edge, short edge, width or height. Cannot be combined with long_edge; enlargement is disabled by default.'),
  bit_depth: z.union([z.literal(8), z.literal(16)]).optional(), keep_metadata: z.boolean().optional(),
  strip_gps: z.boolean().optional(), overwrite: z.boolean().optional(), preserve_timestamps: z.boolean().optional(),
  watermark: watermark.optional(), export_masks: z.boolean().optional(),
};
export interface ToolDefinition {
  method: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  idempotent?: boolean;
  network?: boolean;
  timeoutMs?: number;
}
function tool(method: string, description: string, shape: z.ZodRawShape, readOnly = false, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return { method, description, schema: z.object(shape).strict(), readOnly, ...extra };
}
export const toolDefinitions: ToolDefinition[] = [
  tool('capabilities', 'Inspect engine version, available methods, edit schemas, coordinate rules, and feature limitations. Call before editing.', {}, true),
  tool('list_images', 'Discover supported local images with pagination. Reads source folders without changing images.', { path, recursive: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }, true),
  tool('open_photo', 'Create an isolated nondestructive editing session from a source image and optional existing sidecar. Returns session_id, revision and dimensions; source files remain unchanged.', { path, inherit_sidecar: z.boolean().optional() }),
  tool('list_sessions', 'List editing sessions in the workspace, including saved sessions available after restart.', {}, true),
  tool('get_session', 'Inspect source/working paths, revision, dimensions and optional full adjustment state.', { ...session, include_adjustments: z.boolean().optional() }, true),
  tool('close_session', 'Release a session from memory while preserving its saved manifest. It becomes available on the next bridge startup; save_session also writes a native .rrdata sidecar.', session),
  tool('set_adjustments', 'Validate and apply a native adjustment patch. Merge preserves unrelated edits; replace supplies a complete new recipe. Returns the new revision.', { ...mutation, patch: adjustments, mode: z.enum(['merge', 'replace']).optional() }),
  tool('render', 'Render a visual preview, original comparison, native detail region, or mask. Returns an MCP image block plus dimensions and revision. Inspect pixels before accepting an edit.', { ...session, long_edge: longEdge.optional(), region: renderRegion.optional(), format: z.enum(['jpeg', 'png']).optional(), quality: z.number().int().min(1).max(100).optional(), original: z.boolean().optional(), mask_id: z.string().optional().describe('Render this mask as grayscale with numerical coverage, for edge inspection.') }, true),
  tool('analyze', 'Measure rendered exposure, clipping, histogram and optional scopes for the whole image or a detail region. Statistics complement visual review; they do not score artistic quality.', { ...session, long_edge: longEdge.optional(), region: renderRegion.optional(), histogram: z.boolean().optional(), scopes: z.boolean().optional() }, true),
  tool('auto_adjust', 'Compute RapidRAW automatic tonal/color adjustments; apply only when apply=true. Review the suggested or applied result visually.', { ...mutation, apply: z.boolean().optional() }),
  tool('mask_create', 'Create a selective adjustment mask using native geometric, brush, color or luminance parameters. Read parameter schemas from capabilities, then render mask_id to inspect edges.', { ...mutation, name: z.string().max(200).optional(), type: z.enum(['radial', 'linear', 'brush', 'flow', 'color', 'luminance', 'all']), parameters: record, adjustments: adjustments.optional(), invert: z.boolean().optional(), opacity: percent.optional() }),
  tool('mask_update', 'Patch an existing mask, including adjustments or complete subMasks composition. Native validation rejects malformed masks.', { ...mutation, mask_id: z.string().min(1), patch: record }),
  tool('mask_remove', 'Remove a mask from the session, with undo support; original photo is unchanged.', { ...mutation, mask_id: z.string().min(1) }),
  tool('mask_generate', 'Generate a local AI subject, foreground, sky or depth mask. Models must be installed. Inspect the returned mask before selective edits; region identifies a subject rectangle.', { ...mutation, kind: z.enum(['subject', 'foreground', 'sky', 'depth']), name: z.string().max(200).optional(), region: region.optional(), parameters: record.optional(), adjustments: adjustments.optional() }),
  tool('generate_depth', 'Generate an image depth map; optionally enable depth blur. Requires local mask models.', { ...mutation, enable_blur: z.boolean().optional() }),
  tool('retouch', 'Apply a reversible clone, heal, retouch, liquify, local inpaint or remote generative patch defined by native submasks. Generative mode sends image content to the configured provider only when explicitly selected; token is used only for that request.', { ...mutation, mode: z.enum(['clone', 'heal', 'retouch', 'liquify', 'inpaint', 'generative']), name: z.string().max(200).optional(), sub_masks: z.array(subMask).min(1).max(64), source_point: point.optional(), prompt: z.string().max(10000).optional(), token: z.string().max(4096).optional() }, false, { network: true }),
  tool('denoise', 'Apply native AI or BM3D denoise with a source-preserving intensity blend; intensity 0 is a no-op. The original remains intact. Inspect native detail for lost texture and save the MCP session to preserve linear RAW interpretation after AI denoise.', { ...mutation, intensity: percent.optional(), method: z.enum(['ai', 'bm3d']).optional() }),
  tool('lens_profile', 'Find or automatically apply native lens correction data. Lookup mode inspects profiles; auto mode applies corrections with revision tracking.', { ...mutation, mode: z.enum(['auto', 'lookup']).optional(), maker: z.string().max(200).optional(), model: z.string().max(200).optional(), focal_length: z.number().positive().optional(), aperture: z.number().positive().optional(), distance: z.number().positive().optional() }),
  tool('history', 'Read edit history and current undo/redo position.', session, true),
  tool('undo', 'Undo one session edit and return the restored state/revision.', mutation),
  tool('redo', 'Reapply one undone session edit and return the restored state/revision.', mutation),
  tool('save_session', 'Persist current session and native .rrdata sidecar inside the workspace for recovery and continued editing.', session, false, { idempotent: true }),
  tool('load_recipe', 'Load and validate a saved adjustment JSON recipe, then merge or replace session edits.', { ...mutation, path, mode: z.enum(['merge', 'replace']).optional() }),
  tool('save_recipe', 'Save a reproducible adjustment JSON recipe under workspace/recipes; returns its path.', { ...session, path: path.optional() }),
  tool('list_presets', 'List installed RapidRAW edit presets and their identifiers.', {}, true),
  tool('apply_preset', 'Apply an installed native edit preset with an optional intensity.', { ...mutation, preset_id: z.string().min(1), intensity: percent.optional() }),
  tool('list_luts', 'List installed color LUTs and their local paths.', {}, true),
  tool('apply_lut', 'Apply a local LUT at the given intensity using the native renderer.', { ...mutation, path, intensity: percent.optional() }),
  tool('models', 'Inspect local model installation and availability before AI mask, inpaint or denoise operations.', {}, true),
  tool('install_model', 'Download and install RapidRAW local model assets for masks, inpainting or denoise. This makes network requests and may download large files.', { kind: z.enum(['masks', 'inpaint', 'denoise']) }, false, { network: true, idempotent: true, timeoutMs: 1_800_000 }),
  tool('export', 'Export a verified image or LUT under workspace/exports. Source overwrite is forbidden; overwrite defaults false, GPS stripping defaults true. Returns path, dimensions, size and output details.', { ...session, path, ...exportOptions }),
  tool('batch_export', 'Export multiple existing sessions with shared settings. Inspect per-item outcomes; a partial failure is not a successful whole batch.', { items: z.array(z.object({ ...session, path }).strict()).min(1).max(100), options: z.object(exportOptions).strict().optional() }, false, { timeoutMs: 1_800_000 }),
  tool('merge', 'Merge multiple source exposures into HDR, focus stack or panorama in a new isolated session. Original images are preserved.', { kind: z.enum(['hdr', 'focus', 'panorama']), paths: z.array(path).min(2).max(100) }, false, { timeoutMs: 1_800_000 }),
  tool('negative_convert', 'Apply native film-negative conversion to the isolated session using validated conversion parameters.', { ...mutation, parameters: record }),
  tool('get_metadata', 'Read session rating, tags and available EXIF metadata.', session, true),
  tool('set_metadata', 'Update rating, tags or EXIF metadata in the isolated session only. Save/export to persist the changes.', { ...mutation, rating: z.number().int().min(0).max(5).optional(), tags: z.array(z.string().max(200)).max(200).optional(), exif: z.record(z.string(), z.string()).optional() }),
  tool('get_engine_settings', 'Inspect effective native color management, processing and AI settings without changing application preferences.', {}, true),
];
