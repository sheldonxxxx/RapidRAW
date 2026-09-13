# Portable sessions, candidates and reusable assets

The MCP workspace is an isolated editing authority. `fork_session` creates an independent candidate; portable bundles move complete editable sessions between workspaces. All examples below show the arguments to `rapidraw_<method>`.

## Fork a candidate from a reference

Save a named reference before exploring a different treatment:

```json
{"session_id":"<session UUID>","expected_revision":12,"label":"Accepted light"}
```

Send that to `save_version`, then use its returned `version_id`:

```json
{"session_id":"<session UUID>","expected_revision":12,"version_id":"<version UUID>","label":"Cooler candidate"}
```

Send this to `fork_session`. Omit `version_id` to use current edits. The new session has a new UUID, revision zero, its own working source and LUT copies, and one active history snapshot. Named references are copied and rebound to the new session. Source provenance, metadata, inline masks, depth maps, retouch patches and `is_raw` are preserved. A float TIFF derived from RAW therefore keeps its RAW interpretation when edited through the new MCP session.

Edits to either session are independent. Read the returned session ID and revision before continuing.

## Move a complete edit between workspaces

Export the session:

```json
{"session_id":"<session UUID>","expected_revision":12,"name":"accepted-landscape"}
```

`export_session_bundle` returns an absolute `path` under `workspace/bundles`, plus `manifest_sha256`. A bundle is a directory, not a ZIP archive. Its contents are:

- `manifest.json`: source identity, RAW interpretation, dimensions, complete bounded undo history, named references, provenance and the asset inventory.
- `source.<extension>`: an independent byte-for-byte working source.
- `assets/`: content-hashed LUT dependencies used anywhere in history or named references.

Bitmap masks, depth maps and retouch patches remain embedded in their snapshots. Originals and original sidecars are preserved. The working source must still match the SHA-256 recorded when the session was created.

Copy the entire directory to the destination machine or disk. Connect an MCP server to the destination workspace and call `import_session_bundle`:

```json
{"path":"/absolute/path/to/accepted-landscape","expected_manifest_sha256":"<SHA-256 returned by export>"}
```

Import checks every file's digest and size, all history snapshots and named references, dependency references and LUT parsing. It rejects traversal, absolute asset paths, duplicate assets, missing assets and symlinks within the bundle. The imported source and LUTs live in a new UUID directory; once import succeeds, the transport bundle and old workspace are no longer required.

Files are staged outside the scanned `sessions/` directory before a session is published. An interrupted import can leave an unpublished `.session-import-*` directory; startup ignores it and does not replay the import. Invalid bundles do not create a registered session. Bundle names cannot replace existing bundles. Keep the returned new session ID; imported history, cursor and revision are preserved. `save_session` can write a native `.rrdata` beside the new working source when required. The portable directory carries the information needed for MCP RAW-derived sessions; a standalone TIFF reopened outside that session does not carry that complete contract.

Limits: 32 history snapshots, up to 4,096 named references, 8,192 inventoried files and a 512 MiB manifest. Source images are copied and hashed in bounded streaming buffers.

## Explain what changed

`diff_versions` compares named snapshots or current edits:

```json
{"session_id":"<session UUID>","from_version_id":"<accepted version UUID>"}
```

Omitting `to_version_id` compares against current edits. Either side can be omitted. The result contains JSON Pointer paths, add/remove/replace operations and before/after values for adjustments and metadata. Large embedded strings are represented by byte length and SHA-256, so a mask change does not print megabytes of bitmap data. Comparing versions leaves history and revision unchanged; use `render_compare` for the photographic comparison.

## Copy selected controls to a series

`copy_adjustments` accepts explicit top-level adjustment names and a current revision for every destination:

```json
{
  "session_id":"<source UUID>",
  "expected_revision":12,
  "keys":["exposure","temperature","tint","hsl"],
  "geometry":"exclude",
  "mode":"replace_selected",
  "targets":[
    {"session_id":"<destination UUID>","expected_revision":3},
    {"session_id":"<another destination UUID>","expected_revision":0}
  ]
}
```

The source may additionally specify `version_id`. `replace_selected` replaces each selected top-level control, including nested objects; a selected control absent from the source is removed from the destination. `merge` merges nested selected controls. Unselected controls and destination metadata are preserved. Each destination has its own success/error result; a stale destination does not prevent other valid destinations from receiving edits. The source is never committed by copying.

`geometry:"exclude"` skips selected crop, orientation, perspective, lens, mask and retouch fields and reports `skipped_keys`. A selection containing only excluded fields is rejected. Use `geometry:"require_same_dimensions"` to explicitly copy those controls when source dimensions match. This preserves pixel coordinates; it does not register unrelated photographs or adapt a subject mask to a different subject. Copied mask/submask IDs are regenerated, and LUT files are materialized inside each destination.

## Manage reusable presets and LUTs

`manage_presets` and `manage_luts` operate on `workspace/assets`. Their IDs have the form `workspace:<UUID>`. Existing `list_presets`, `list_luts`, `apply_preset` and `apply_lut` include these managed assets.

Save a preset from current edits:

```json
{"action":"save","session_id":"<session UUID>","expected_revision":12,"name":"Evening colour","include_masks":false,"include_geometry":false}
```

`include_masks` and `include_geometry` default to false. Disabling selective content excludes both adjustment masks and retouch patches; imported native presets with `includeMasks:false` use the same behavior. Disabling geometry excludes crop, orientation, flips, perspective and depth-map geometry. Presets own any LUT dependency. Save returns the new preset `id`; send it to `apply_preset` using `preset_id`.

For a reusable look that preserves each photo's base corrections, save only its intended controls:

```json
{"action":"save","session_id":"<session UUID>","expected_revision":12,"name":"Film colour","adjustment_keys":["lutPath","lutIntensity","lutIsSceneReferred","contrast","saturation","curves"],"include_masks":false,"include_geometry":false}
```

`adjustment_keys` accepts 1–100 unique, exact top-level names from `rapidraw://adjustment-schema`, only for `action:"save"`. Unknown, missing and excluded keys are errors; selecting a nested object such as `hsl` saves that whole control. Masks and geometry still require their respective include option. Selecting any LUT field requires `lutPath`, `lutIntensity` and `lutIsSceneReferred` together. Selecting `pointCurves`, `parametricCurve` or `curveMode` also requires the authoritative rendered `curves` field. The response reports the saved `adjustment_keys`.

Omit `exposure`, `temperature`, `tint`, denoise and sharpening keys when they belong to the individual photo. Without `adjustment_keys`, save retains all current adjustment fields except the excluded masks and geometry, including neutral defaults. `apply_preset` at intensity 100 applies the saved controls and preserves omitted controls; intensity blending is separate from the saved LUT strength. To verify reuse, apply the exported and reimported preset to the same base as a direct edit and compare matching renders.

When the base has no LUT, both MCP and desktop preset application blend a newly added LUT from zero effective strength: a saved LUT strength of 60 at 50% preset intensity produces a LUT strength of 30. Replacing one LUT with another selects the new path and colour interpretation at any positive preset intensity and interpolates the scalar strength from the previous value; it does not crossfade two LUTs. MCP applies intensity relative to the session's current edit on each call, so restore the same base before comparing strengths. Intensity zero leaves that current edit unchanged.

Preset management calls:

```json
{"action":"list"}
{"action":"export","id":"workspace:<UUID>","path":"evening-colour.json"}
{"action":"import","path":"/absolute/path/to/evening-colour.json"}
{"action":"remove","id":"workspace:<UUID>"}
```

Exports are self-contained JSON, including a verified embedded LUT. Import also accepts a native single preset, a raw adjustment object, or a native `PresetFile` collection. Collection folders are flattened into independent managed presets; inspect per-item results. Safely inactive legacy negative-conversion fields use the same migration as `apply_preset`. Active legacy negative conversion is rejected.

Import self-contained MCP exports with `manage_presets`. The desktop preset dialog uses the separate `.rrpreset` collection format and does not import this embedded-LUT envelope. Saving or importing through MCP does not install presets into the desktop library.

For same-machine desktop use, a `.rrpreset` collection may wrap saved native preset definitions as `{"presets":[{"preset":{...}}]}` with their existing absolute workspace-owned LUT paths. Keep those LUT files in place; this collection is not portable like the embedded MCP export. Desktop preset strength blends selected controls from the edit captured before applying the preset. Zero strength or clicking the active preset again restores that captured edit, and 100% applies the saved values.

LUT management calls:

```json
{"action":"import","path":"/absolute/path/to/film.cube","name":"Film look"}
{"action":"list"}
{"action":"export","id":"workspace:<UUID>","path":"film-copy.cube"}
{"action":"remove","id":"workspace:<UUID>"}
```

LUT imports parse the file, verify copied bytes and allocate a new owned ID. Export preserves the source format and requires a matching extension. Preset/LUT export paths belong under `workspace/exports` and cannot overwrite existing files. Removal deletes only the identified managed entry. Sessions that applied it retain their own materialized LUT. Individual asset files and self-contained presets are limited to 128 MiB.

## Verification

`src-tauri/src/mcp_bridge/portable.rs` and `asset_library.rs` contain focused native storage, integrity, path, RAW-domain, version, copy and owned-asset tests.

`mcp/scripts/portable-sessions-e2e.mjs` uses the actual MCP SDK and native executable. It compares native rendered pixels before/after a named fork, library removal, portable preset import and a moved bundle import after the original session paths disappear. A selected-preset round trip compares against a direct edit while checking that target exposure, white balance, denoise and sharpening survive. It checks stale revisions, mixed-result copying and corrupt/missing/traversing bundles. It records source/binary provenance and separate native-call and pixel-assertion evidence.

From `mcp/`, after building the server and native executable:

```sh
RAPIDRAW_BINARY=/absolute/path/to/RapidRAW \
RAPIDRAW_RAW_FIXTURE=/absolute/path/to/photo.dng \
node scripts/portable-sessions-e2e.mjs
```

The RAW fixture is optional; without it the report explicitly skips photographic RAW portability. Set `RAPIDRAW_TEST_WORKSPACE` to choose a new empty output root. The tests preserve supplied photos. Generated fixture/library/bundle copies are deliberately moved, removed or corrupted to verify independence and recovery.
