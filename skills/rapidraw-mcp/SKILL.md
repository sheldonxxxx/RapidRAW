---
name: rapidraw-mcp
description: Edit, mask, retouch, and export photos through RapidRAW's native MCP server, including saved sessions, recipes, and batch delivery. Use when the user requests RapidRAW MCP or photo work with connected rapidraw_* tools. For explicit desktop UI control, use the separate rapidraw skill.
---

# RapidRAW MCP

Use the native photo engine to achieve the user's requested look and deliverable. Inspect the actual images; successful tool calls and good histograms do not establish visual quality.

## Connect and inspect

- Discover the connected tools whose names end in `rapidraw_*`; the host may prepend a namespace. Use their actual exposed names. If unavailable, read [connection and recovery](references/connection.md).
- Call `rapidraw_capabilities`. Read `rapidraw://adjustment-schema` before constructing adjustments or masks; the same schema is in the capabilities result if resource access is unavailable. Live tool inputs and native schemas take precedence over these examples.
- Resume a known session with `rapidraw_list_sessions` and `rapidraw_get_session` (`include_adjustments: true`). Otherwise use `rapidraw_list_images` when the source is unclear, then `rapidraw_open_photo` with its absolute path. Existing sidecar edits are inherited by default; use `inherit_sidecar: false` only for an intended fresh treatment.
- Keep the returned `session_id`, `revision`, working path, and dimensions. `open_photo` creates an isolated copy; source files and adjacent `.rrdata` stay unchanged.

## Edit and review

1. Render the current overview, plus `original: true` when a baseline helps. Start around `long_edge: 1600`. Inspect composition, light, color, subject detail, and distractions before choosing changes. An original render bypasses edits; it does not represent the inherited edited starting state.
2. Apply targeted `rapidraw_set_adjustments` patches with `mode: "merge"` and the last observed `expected_revision`. Use exact native names and units. `temperature` is a relative control, not Kelvin. Replace mode resets the adjustment recipe and is appropriate only when a replacement is intended.
3. Render after each meaningful group of edits. `rapidraw_analyze` can show clipping, histogram, and scopes; these measure rendered pixels, not sensor RAW headroom. `rapidraw_auto_adjust` with `apply: false` provides suggestions. Review auto adjustments, presets, and LUTs against the photo before accepting them.
4. Use selective edits when they help the requested result. Read [selective and advanced editing](references/advanced-editing.md) for masks, coordinates, retouching, denoise, negatives, or merges. Inspect the grayscale mask and the edited image to catch empty coverage, spill, and halos.
5. Inspect important detail with a bounded integer `region` and omit `long_edge` for native 1:1 review. Check texture, sharpening, noise, crop edges, and mask transitions. Use history/undo for an unsuccessful edit; keep the revision returned by undo/redo.
6. Stop when the requested result is achieved. Do not impose one aesthetic, automatically remove scene content, or create extra deliverables the user did not request.

Example tone patch; replace `SESSION_ID` and the illustrative revision with actual returned values. Numeric adjustments are examples, not a universal preset.

```json
{"tool":"rapidraw_set_adjustments","arguments":{"session_id":"SESSION_ID","expected_revision":0,"mode":"merge","patch":{"exposure":0.25,"highlights":-18,"shadows":12}}}
```

## Save and deliver

- Call `rapidraw_save_session` at useful checkpoints and before finishing. It writes native `.rrdata` beside the isolated working copy. Save a recipe with `rapidraw_save_recipe` when reuse or a reproducible recipe is part of the task; its default filename includes the session and revision.
- Export the requested format and size with `rapidraw_export`. Absolute paths must be under the workspace's `exports` directory; relative names resolve there. Recipes belong under `recipes`. Read the returned path instead of assuming the caller's current directory is the destination.
- For a typical web JPEG, quality 92 and a 2400-pixel long edge are reasonable starting values if the user gives no specification. Choose dimensions from the actual delivery need. Supply either `long_edge` or `resize`, never both. Enlargement is disabled by default; permit it with `resize.dont_enlarge: false` only when intended. Confirm supported format and bit depth from the live engine.

```json
{"tool":"rapidraw_export","arguments":{"session_id":"SESSION_ID","path":"delivery.jpg","format":"jpeg","quality":92,"long_edge":2400,"strip_gps":true}}
```

- Inspect the exported file visually and verify returned dimensions, format, size, and relevant metadata/bit depth. Return a clickable output path and a short description of the treatment. If pixel inspection is unavailable, state that visual quality is unverified.
- For batches, inspect each source, adapt shared styling to the lighting, and read every `rapidraw_batch_export` item result. Partial failure sets `isError: true` even when some files were written. Continue from the failed items after inspecting successes; do not blindly replay the full batch.

## State and boundaries

- Use `structuredContent` for state and inspect `isError` before treating a result as successful. Rendered pixels are separate MCP `image` blocks; forward or view those blocks rather than looking for base64 in the JSON. If the host cannot display them, save the returned bytes as a temporary image and inspect that file.
- Operations can return a new session. Nonzero denoise, film-negative conversion, and merges require continuing with the returned `session_id`; inspect the new adjustments and revision before proceeding.
- On `REVISION_CONFLICT`, reread the session and reconcile the intended change. On timeout, crash, or active cancellation, reconnect and inspect persisted state before retrying any mutation. See [connection and recovery](references/connection.md).
- Keep source images, source sidecars, and generated mask/retouch data intact. Use MCP operations instead of hand-editing `.rrdata`, `patchData`, or `maskDataBase64`.
- Inspect `rapidraw_models` before AI work. Model installation is a separate, potentially large download. Remote generative retouch sends image content to the configured provider; use it only when that remote operation is authorized. Never silently switch a local edit to remote generation.
- Existing export replacement requires `overwrite: true`; recipe saves never overwrite. Use new names unless replacement is intended. GPS stripping defaults on; metadata changes affect the session and its exports.
- For long or multi-photo work, keep short task-local notes with source/session IDs, latest revisions, checkpoint paths, outstanding defects, and verified outputs.
