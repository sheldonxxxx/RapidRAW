# RapidRAW MCP

A local, nondestructive interface to RapidRAW's native processing engine. It supports an agent's full editing loop: inspect a RAW photo, make reversible global and selective edits, inspect previews and native detail, manage models/presets/LUTs, save editable state and verify delivery exports. It does not contain a separate renderer or invoke the legacy export CLI.

The MCP server uses the official TypeScript SDK v2 and stdio. One connection owns each workspace at a time through an exclusive native lock; use separate workspaces for simultaneous agents. It owns one persistent native bridge process; image processing and validation remain in Rust. The `mcp/` package and `src-tauri/src/mcp_bridge/` module are isolated so normal upstream development can be merged with a small integration surface. Build the fork with the `mcp` Cargo feature; an unmodified installed RapidRAW app does not provide this bridge.

The [RapidRAW MCP skill](../skills/rapidraw-mcp/SKILL.md) provides agent guidance for editing, mask coordinates, derived sessions, recovery, and verified exports. Install it with `npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp`, or place its complete folder in your agent's skills directory. Pair it with your own brief or [Lightweft](https://github.com/sheldonxxxx/lightweft) for photographic direction, shared review and personal style exploration. RapidRAW runs independently; Lightweft and the [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit) are optional companions with separate setup. The MCP connection is configured below.

Choose [macOS setup](#macos-quick-start), [Linux over SSH](REMOTE-SSH.md), or the [tool reference](#capabilities). For a first edit, follow the [example editing loop](#example-editing-loop). All `/absolute/...` paths in this guide are placeholders.

## Connect a beta package

Fork release packages include the native bridge and install as **RapidRAW MCP**. Upstream packages do not include it. The Node host remains a separate setup step; use the same source tag as your downloaded package. Fresh-machine MCP installation of these packages has not yet been validated; the source-build workflows below retain their recorded test boundaries.

For `fork-v0.1.0-beta.1`, install Node.js 22.12+ and Git, then run:

```sh
git clone --branch fork-v0.1.0-beta.1 --depth 1 https://github.com/sheldonxxxx/RapidRAW.git
cd RapidRAW
npm ci --prefix mcp
npm run build --prefix mcp
```

Use the [host configuration below](#build-and-connect) with the absolute path to this checkout's `mcp/dist/index.js`. Set `--binary` to the installed executable. On macOS, for example, that is `/Applications/RapidRAW MCP.app/Contents/MacOS/rapidraw-mcp`; quote this path when using it in a shell. On Windows select `rapidraw-mcp.exe` inside the installation directory. On Linux use the installed `rapidraw-mcp` executable from a DEB/RPM package; the documented source build is the fallback if your package's launch environment does not support stdio.

Reconnect your client and call `rapidraw_capabilities` to confirm native startup. The host package reports `0.1.0`, while the native bridge reports `1.2.0`; these component versions are independent of the app release version. Models are installed separately. The fork's new application identifier separates preferences and model storage from upstream; it does not migrate them automatically.

## macOS quick start

This quick start covers macOS with Metal and a debug build of this fork. The [Linux GPU server guide](REMOTE-SSH.md) covers the tested Debian 13/NVIDIA/Xvfb workflow over SSH. **Windows and packaged MCP releases have not been tested for the MCP workflow.**

Use macOS 14+ on Apple Silicon or macOS 13+ on Intel, Node.js 22.12+, [Rust via rustup](https://www.rust-lang.org/tools/install), and [Apple Command Line Tools](https://v2.tauri.app/start/prerequisites/#macos). If the Apple tools are missing, run `xcode-select --install` and finish installation first.

```sh
git clone https://github.com/sheldonxxxx/RapidRAW.git
cd RapidRAW
rustup toolchain install 1.98.1 --profile minimal
npm ci
npm run build
CARGO_PROFILE_DEV_DEBUG=0 cargo +1.98.1 build \
  --manifest-path src-tauri/Cargo.toml --features mcp --locked
npm ci --prefix mcp
npm run build --prefix mcp
```

This produces `src-tauri/target/debug/RapidRAW` and `mcp/dist/index.js`. Use those absolute paths in the host configuration below, replacing its release binary path with the debug path. Use `command -v node` to find an absolute Node path if your GUI agent does not inherit the shell's PATH. Reconnect the host and call `rapidraw_capabilities` to verify native startup; a successful skill installation alone does not connect the editor.

## Build and connect

Requirements: Node.js 22.12+, Rust 1.98 or later, this RapidRAW checkout's native system dependencies, and a GPU adapter supported by the renderer. The pinned Rust toolchain below leaves the machine's default unchanged. From the repository root:

Apple Silicon builds require macOS 14 or later and bundle ONNX Runtime 1.30.0. Intel Mac builds retain 1.22.0. See the [runtime and hardware guide](../docs/local-enhancement.md#apple-silicon-runtime).

```sh
rustup toolchain install 1.98.1 --profile minimal --component rustfmt,clippy
npm ci
npm run build
cargo +1.98.1 build --release --features mcp --manifest-path src-tauri/Cargo.toml --locked
npm ci --prefix mcp
npm run build --prefix mcp
```

Configure your MCP host with absolute paths (replace the examples with your checkout and desired output folder):

```json
{
  "mcpServers": {
    "rapidraw": {
      "command": "node",
      "args": [
        "/absolute/RapidRAW/mcp/dist/index.js",
        "--binary",
        "/absolute/RapidRAW/src-tauri/target/release/RapidRAW",
        "--workspace",
        "/absolute/rapidraw-photo-jobs"
      ]
    }
  }
}
```

Use the actual Cargo output path if `CARGO_TARGET_DIR` is configured. `RAPIDRAW_BINARY` and `RAPIDRAW_WORKSPACE` are equivalent environment variables. `--timeout-ms`/`RAPIDRAW_TIMEOUT_MS` sets the default native-operation timeout (300000 ms). Model installation, merge and batch export have a 30-minute maximum; configure the host's tool timeout accordingly. Diagnostics go to stderr; stdout contains only MCP protocol traffic.

Existing masking, denoise and inpainting tools default to CPU on every platform. Linux deployments can opt into [CUDA for foreground/sky masks, depth and AI denoise](ONNX-CUDA.md) with a separate compatible runtime. Subject selection and local inpainting retain their CPU compatibility paths. The newer enhancement operations have their own [Auto provider policy](../docs/local-enhancement.md#choose-speed-and-detail).

## Process-local engine settings

Optional `workspace/engine-settings.json` overrides bridge defaults using the native **camelCase** keys returned by `rapidraw_get_engine_settings`. A partial object is merged with defaults; unknown keys are rejected. Restart the MCP connection after changing this file. The bridge does not migrate or write the installed GUI application's preferences.

For an explicitly selected generative retouch provider, for example:

```json
{
  "aiProvider": "ai-connector",
  "aiConnectorAddress": "127.0.0.1:7860"
}
```

Use the address of the connector you actually run, in `host:port` form. Alternatively set `aiProvider` to `cloud` and pass a request-scoped `token` to `rapidraw_retouch` with `mode: "generative"`. Generative requests fail with `GENERATION_NOT_CONFIGURED` if no provider is configured; local editing, masking and inpainting do not require this remote setup. Image content is sent only when generative mode is explicitly selected. Do not put provider tokens in the settings file.

With an AI Connector that advertises protocol version 2 at `GET /capabilities`, a generative `retouch` request can also include:

```json
{
  "generation_options": {
    "seed": 104729,
    "profile": "balanced",
    "megapixels": 1
  }
}
```

`balanced` is an illustrative profile ID; choose an ID and resolution listed by your connector. Seeds must be integers from 1 through 9007199254740991. Profile IDs contain up to 64 ASCII letters, digits, periods, underscores or hyphens and start with a letter or digit. Megapixels must be finite, between 0.0625 and 16, and supported by the selected profile. Without an explicit profile, resolution validation uses the connector's advertised `generation.default_profile`. Generation resolution describes the generated context crop; a full-resolution export can contain an enlarged generated patch.

Explicit options are checked before sending image data and fail when the connector cannot honor them. They require AI Connector generative mode; local inpainting and the cloud provider do not accept these options. Omitting `generation_options` retains connector defaults and compatibility with older connectors. Requested options persist in the patch's `generationOptions` field and are returned by MCP; they are configuration records, not a guarantee of identical pixels across hardware or model versions.

When the connector supplies a valid generation receipt, `retouch` also returns `generation`: the actual seed, profile, source and generated dimensions, placement context and processing duration. The same bounded record is saved in `patchData.generation`, including through undo/redo and session persistence. Provider paths, prompts, tokens and arbitrary receipt fields are not copied into that record. Older connectors may omit it. Generated dimensions describe neural output before placement and do not establish native RAW detail.

For choosing a treatment and comparing candidates, see [AI editing workflows](../docs/ai-editing-workflows.md) and the skill's [generative editing reference](../skills/rapidraw-mcp/references/generative-editing.md). MCP retouch adds a new patch; use a saved pre-edit version or independent forks for alternatives from the same source state.

## Capabilities

Every tool starts with `rapidraw_`; the table shows the suffixes. The engine's live `capabilities` response is authoritative for availability and schemas.

The [application/MCP/test matrix](CAPABILITY-MATRIX.md) maps the complete application feature areas to their MCP implementation, test boundary and remaining gaps. The generated evidence ledger distinguishes individual tool calls, parameter coverage, pixel assertions and photographic review.

| Area                        | Tools                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and state         | `capabilities`, `list_images`, `open_photo`, `list_sessions`, `get_session`, `close_session`                                                                                       |
| Editing and review          | `set_adjustments`, `render`, `render_compare`, `inspect_adjustments`, `analyze`, `auto_adjust`, `map_coordinates`, `preflight`, `sample_region`                                    |
| Selective edits             | `mask_create`, `mask_update`, `mask_remove`, `mask_generate`, `generate_depth`                                                                                                     |
| Background processing       | `start_denoise`, `get_job`, `list_jobs`, `cancel_job`, `resume_job`, `start_operation`, `get_operation_job`, `list_operation_jobs`, `cancel_operation_job`, `resume_operation_job` |
| Local masks and enhancement | `enhancement_models`, `install_enhancement_model`, `enhance`; [models, profiles and examples](../docs/local-enhancement.md)                                                        |
| Detail and corrections      | `retouch`, `denoise`, `lens_profile`, `negative_convert`                                                                                                                           |
| History and persistence     | `history`, `undo`, `redo`, `save_version`, `list_versions`, `restore_version`, `save_session`, `load_recipe`, `save_recipe`                                                        |
| Presets and assets          | `list_presets`, `apply_preset`, `list_luts`, `apply_lut`, `manage_presets`, `manage_luts`, `models`, `install_model`                                                               |
| Delivery and composition    | `export`, `batch_export`, `merge`                                                                                                                                                  |
| Portable editing            | `fork_session`, `export_session_bundle`, `import_session_bundle`, `diff_versions`, `copy_adjustments`                                                                              |
| Metadata and configuration  | `get_metadata`, `set_metadata`, `get_engine_settings`                                                                                                                              |

Resources:

- `rapidraw://workflow`: a concrete editing/review/delivery workflow.
- `rapidraw://adjustment-schema`: current native adjustment and mask schemas, units and capabilities.
- `rapidraw://sessions/{session_id}`: current complete editing state.

The `pro_photo_edit` prompt accepts `path` and optional `intent`. It gives the host's model a complete workflow; the server does not itself run or pay for a language model. Professional results require the agent to inspect the returned images and iterate appropriately.

## Example editing loop

Call `rapidraw_capabilities`, read the schema resource, then:

```json
{"tool":"rapidraw_open_photo","arguments":{"path":"/photos/example.cr3"}}
{"tool":"rapidraw_render","arguments":{"session_id":"RETURNED_ID","original":true,"long_edge":1600}}
{"tool":"rapidraw_set_adjustments","arguments":{"session_id":"RETURNED_ID","expected_revision":0,"patch":{"exposure":0.25,"highlights":-18,"shadows":12}}}
{"tool":"rapidraw_render","arguments":{"session_id":"RETURNED_ID","long_edge":1600}}
{"tool":"rapidraw_analyze","arguments":{"session_id":"RETURNED_ID","histogram":true,"scopes":true}}
```

Use the actual returned revision, not the illustrative `0` above. For native detail review, first inspect rendered dimensions, then call `render` with an integer pixel `region`; omitting `long_edge` preserves native 1:1 detail. **Render/analyze regions use full-resolution rendered coordinates after user crop and geometry. Mask geometry and AI subject regions use the corrected, user-oriented/flipped/rotated canvas before crop (`map_coordinates` space `mask`).** The separate `oriented_source` space precedes user geometry. Map measured preview pixel centers with `map_coordinates`, supplying the actual preview dimensions and region. `mask_id` renders a grayscale mask with coverage statistics for edge review.

Selective editing examples:

```json
{"tool":"rapidraw_mask_create","arguments":{"session_id":"RETURNED_ID","type":"radial","name":"Subject lift","parameters":{"centerX":2600,"centerY":1900,"radiusX":1000,"radiusY":1600,"rotation":-12,"feather":0.8},"adjustments":{"exposure":0.18,"shadows":8}}}
{"tool":"rapidraw_mask_generate","arguments":{"session_id":"RETURNED_ID","kind":"sky","name":"Sky control","adjustments":{"highlights":-12}}}
{"tool":"rapidraw_mask_update","arguments":{"session_id":"RETURNED_ID","mask_id":"RETURNED_MASK_ID","patch":{"opacity":75}}}
```

Coordinates above are illustrative and must match the actual photo. Inspect `models` before AI operations and deliberately call `install_model` for missing assets. Local masks/inpaint/denoise can need substantial model downloads. Generative retouch is an explicit remote mode using the configured provider; it sends image content and requires the caller's credentials. The server does not request or log tokens itself.

`denoise` accepts `method: "ai"` (default) or `"bm3d"` and blends its result with the pristine source at the requested intensity; intensity zero leaves the session unchanged. A nonzero result returns a new `session_id` with the existing adjustments inherited, so continue with that returned session. For RAW input, the derived linear TIFF retains its rendering interpretation in the saved MCP session. Reopening that TIFF directly in the GUI cannot recover the same interpretation from `.rrdata` alone; use MCP export for a portable display image. Original RAW working copies and their saved sidecars can be continued in the GUI.

Save and deliver after visual review:

```json
{"tool":"rapidraw_save_session","arguments":{"session_id":"RETURNED_ID"}}
{"tool":"rapidraw_save_recipe","arguments":{"session_id":"RETURNED_ID","path":"/absolute/rapidraw-photo-jobs/recipes/final.json"}}
{"tool":"rapidraw_export","arguments":{"session_id":"RETURNED_ID","path":"/absolute/rapidraw-photo-jobs/exports/master.tiff","format":"tiff","bit_depth":16}}
{"tool":"rapidraw_export","arguments":{"session_id":"RETURNED_ID","path":"/absolute/rapidraw-photo-jobs/exports/delivery.jpg","format":"jpeg","quality":92,"long_edge":2400}}
```

`long_edge` is a convenience maximum-long-edge resize. For other delivery targets use `resize: {"mode":"shortEdge","value":1080}` (or `width`, `height`, `longEdge`). Enlargement is disabled by default; `dont_enlarge: false` explicitly permits it. Supply either `long_edge` or `resize`, never both. These options also work in `batch_export.options`.

Inspect the exported image and returned output metadata. Supported formats depend on the native engine build. A successful preview or export call alone does not prove a professional-quality edit. Batch outputs need per-item review.

## Comparison and job tools

Use `save_version` to retain a named reference independently of the 32-entry undo history. `render_compare` renders 2–4 labeled temporary patches, named versions or mask-off variants without changing saved state. One crop/region and delivery size apply to every variant; incompatible geometry is rejected. `inspect_adjustments` returns matched before/after images, an amplified actual RGB difference, and a native local-exposure influence map with EV statistics and row means. Exposure influence does not account for other tonal controls. Multiple images use ordered MCP image blocks with `images[].content_index` metadata, never duplicated base64 in text.

Linear masks accept `falloff: "linear" | "smoothstep" | "smootherstep"`, plus independent source-pixel `fadeBefore` (zero edge) and `fadeAfter` (full edge). Omitted ends use `range`. Old recipes remain byte-compatible. The desktop mask panel exposes these controls and draws each transition edge at its actual distance.

Prefer `start_denoise` over the synchronous compatibility `denoise` tool. After source capture and local asset verification it returns `job_id`; computation runs on a background worker while editing/rendering remain available. Poll `get_job` for progress and the separate `result_session_id`. One worker runs per workspace. Results inherit the input snapshot, not subsequent parent edits. `cancel_job` cooperatively stops at BM3D patch/AI tile boundaries without terminating the bridge. Completed results persist even without polling. Engine exit interrupts unfinished work; after reconnect use `list_jobs` and explicitly `resume_job` to recompute from the captured input. There are no partial-tile checkpoints. Intensity zero skips filtering but still creates a separate result session in the background API.

See the skill's [review and job reference](../skills/rapidraw-mcp/references/review-and-jobs.md) for complete semantics and examples.

## Workflow expansion

Bridge 1.2 exposes 60 native methods. The stdio server adds 5 isolated-worker tools, for **65 MCP tools**. The native method list and host worker list remain separately identifiable.

Use `map_coordinates` when translating displayed points or regions into edit coordinates. `sample_region` returns rendered sRGB, linear luminance, clipping and robust color measurements from a native region of at most 4 megapixels; its optional white-balance suggestion assumes the selected region should be neutral and does not change the session. `preflight` checks current geometry, requested model-group availability, export format/bit depth and native render resource limits. It does not predict every AI/merge allocation or validate a complete export request. [Geometry and review](GEOMETRY-REVIEW.md) defines coordinate spaces, overlays, submask operations and exact preview caching.

`render(mask_id, mask_mode: "overlay")` returns aligned overlay, photograph and grayscale image blocks. `clipping_overlay: true` is a diagnostic preview; exported photographs exclude clipping indicators. Cache keys include rendered state, source/dependencies and view options; `cache: false` forces a fresh render and returned diagnostics disclose hits.

[Forks, portable bundles and workspace assets](PORTABLE-SESSIONS.md) cover independent alternatives, moving saved edits and dependencies between workspaces, version diffs, selective copying and owned preset/LUT collections.

For expensive `merge`, `export`, `negative_convert`, `mask_generate`, `generate_depth` or local `retouch`, use `start_operation` with the usual native arguments. The server captures immutable inputs/settings, starts a separate native process and returns a job ID. One such worker runs per workspace alongside the main editing bridge. `get_operation_job` reports truthful stages; it does not invent a completion percentage. `cancel_operation_job` terminates only that worker. On reconnect, `list_operation_jobs` exposes interrupted jobs; `resume_operation_job` explicitly recomputes the captured operation in a fresh attempt directory. No automatic replay or partial computation checkpoints. Successful edits import as a new independent session; worker exports stay in the returned worker-workspace export path. Generative retouch is excluded from these durable jobs so credentials and remote requests are not persisted or replayed.

Mask/depth workers capture the verified parent `masks` model group; inpaint workers capture `inpaint`. The job reports `captured_models` with group and asset count, retains owned model copies, and verifies their SHA-256 before each attempt. Later parent-model changes do not affect captured jobs. Partial/corrupt parent groups fail before start with `install_model` guidance. When every required parent model is absent, the existing native installed-app copy fallback remains available and verifies the files in the worker; job capture never requests a download.

Export `color_profile: "auto"` embeds and verifies an sRGB ICC profile in JPEG, PNG, TIFF and WebP. `"none"` omits it. Explicit `"srgb"` fails for AVIF, JXL and CUBE instead of claiming an unsupported profile. Pixels use the native display-referred sRGB pipeline; this is not arbitrary working-space conversion. EXIF/timestamp/GPS behavior is reported separately, and unsupported metadata preservation produces a warning.

Images exceeding the GPU texture dimension use bounded overlapping input/mask tiles in the high-precision MCP renderer. Global effect coordinates remain continuous. Streaming is limited to 100 megapixels and the effect halo must fit the adapter; preflight reports the same allocation limits as rendering. Very large images still require CPU memory for their source, masks and final output.

[The testing matrix](testing-matrix.md) provides per-tool, per-mode and per-adjustment evidence generation, photographic fixture validation, download/provider gates and platform setup commands. A native call, a pixel assertion and a photographic visual review are distinct coverage levels.

## Preservation and error behavior

Source images and their sidecars are read-only to the workflow. `open_photo` creates an isolated working copy under `workspace/sessions/<id>`; edits, retouch intermediates and native `.rrdata` state stay with that copy. Exports must remain under `workspace/exports`, and recipes under `workspace/recipes`; relative output paths resolve inside their respective category. Exporting over a source is prohibited, and replacing an existing export requires `overwrite: true`. Recipe saves never overwrite an existing file; choose a new recipe path or revision. GPS stripping defaults on. Metadata edits affect the isolated session and its exports.

Installed presets containing explicitly disabled legacy negative-conversion controls are migrated with a warning naming the removed obsolete fields. Active legacy negative conversion is rejected with guidance to use `negative_convert`; unrelated unknown preset keys remain errors.

Tool inputs reject unknown top-level fields. Native validation checks the actual adjustment/mask records against RapidRAW's schemas, so a misspelled adjustment cannot silently become a no-op. Mutations accept `expected_revision` to reject stale changes. Success returns `structuredContent`; previews also return native MCP image blocks without repeating their base64 in the JSON/text result. Engine failures return `isError: true` with a stable code and actionable message.

The server caps serialized MCP responses at **8 MiB**, leaving room below the SDK's default 10 MiB stdio buffer; `capabilities.transport_limits` reports the budget. Oversized images or state return `RESPONSE_TOO_LARGE` while keeping the connection usable. Requested pixels are never silently resized or transcoded. Retry a read with an explicitly smaller `long_edge`, bounded native `region`, requested JPEG encoding, or `get_session(include_adjustments:false)`. The native operation has already returned when this error is generated: inspect `recovery` session/revision, mask/job IDs and output paths before deciding what remains. Do not replay a mutation. Batch recovery includes at most 16 item summaries and explicitly reports truncation; retain the original request and reconcile omitted items separately. Large session resources raise the same named error; very long native error messages are flagged as truncated. Prompt arguments accept at most 16384 path characters and 65536 intent characters.

Native requests are serialized; denoise computation and captured operation jobs run on separate workers. The server never automatically retries a mutation. A timeout, crash, protocol mismatch or cancellation of an active MCP request terminates or invalidates the bridge; reconnect and inspect saved state before retrying. `cancel_job` is a separate cooperative operation and leaves the bridge usable. A request cancelled while queued is skipped without invalidating the engine. Closing the MCP connection closes stdin and then terminates an unresponsive native child. Save sessions at meaningful checkpoints for crash recovery.

The MCP process runs with your local account's filesystem permissions. Use it only with trusted local hosts. It is stdio-only: no network listener or authentication service is installed.

## Verification

See [the verification report](VERIFICATION.md) for the checks run on this fork, their evidence and remaining limitations. Reproduction commands follow.

```sh
npm test --prefix mcp
```

These tests use the real official MCP client and an intentionally fake native subprocess only to verify protocol transport, schemas, native image blocks, error propagation, serialization, cancellation and subprocess lifecycle. A separate compatibility test uses the official SDK v1.30 client and its MCP 2025 initialize handshake to verify discovery, tool/image results, resources and prompts against this v2 server. These tests do not claim image-processing correctness or prove a particular host configuration is installed.

For real-engine verification after building the fork:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/release/RapidRAW \
RAPIDRAW_TEST_IMAGE=/absolute/photos/example.cr3 \
RAPIDRAW_WORKSPACE=/absolute/rapidraw-photo-jobs/e2e \
npm run test:engine --prefix mcp
```

Set `RAPIDRAW_TEST_IMAGE_2` for a second sample, or `RAPIDRAW_TEST_IMAGES` to a JSON array of source paths. The real test opens each source, renders original/edited/detail/mask images, verifies an edit changes rendered bytes, checks stale/invalid mutations, exercises history, persists metadata/recipe/session, exports and checks source and overwrite protections. It restarts the process and verifies saved state and rendered pixels survive, checks partial batch failure is reported as an MCP error, decodes the actual TIFF sample data to reject expanded 8-bit output, and verifies source and original-sidecar SHA-256 before and after. It writes structured evidence plus review images to the workspace. Optional AI models, external generative services, every RAW camera, merge geometry and artistic quality require additional explicit evaluations; they are not implied by the transport suite.

SDK references: [official v2 server documentation](https://ts.sdk.modelcontextprotocol.io/v2/), [TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk).

The delivery/asset acceptance script uses a small native JPEG export (300–2048 pixels per dimension) to cover automatic adjustments and undo, oriented crop/ROI, recipe reload, an installed preset if available, local point-curve creation/update/removal with actual pixel comparisons, high-precision CUBE output, session-owned LUT files across source moves and restart, all resize modes, watermark pixels, selective-mask exports, six raster formats and independent metadata inspection:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/release/RapidRAW \
RAPIDRAW_TEST_IMAGE=/absolute/native-small-export.jpg \
RAPIDRAW_WORKSPACE=/absolute/separate-asset-workspace \
npm run test:assets --prefix mcp
```

ImageMagick (`magick`, or `RAPIDRAW_MAGICK`) supplies an independent metadata/dimension inspection and watermark pixel comparison for this acceptance test. Installed presets and the sample source are read-only. If no installed preset exists, that single case is explicitly recorded as skipped. JSONL records capture every operation and a final summary records both verified checks and any external-decoder limitations.

The comparison/job acceptance test uses a source image at least 512 pixels wide (a 2400-pixel native export is suitable). It creates a smaller test input with the native exporter and exercises temporary variants, mask diagnostics, independent gradient fades, reference persistence beyond undo history, editing during BM3D, cancellation, completed-result recovery, process interruption, and explicit restart:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
RAPIDRAW_TEST_IMAGE=/absolute/native-export.jpg \
RAPIDRAW_WORKSPACE=/absolute/separate-review-job-workspace \
npm run test:review-jobs --prefix mcp
```

The script writes JSONL evidence, review PNGs and `summary.json`. It does not imply AI model quality, star preservation, or desktop pointer interaction was tested.

Set `RAPIDRAW_TEST_AI=1` to include completion and cancellation during real AI inference on a 64-pixel test input using already installed assets; the acceptance script never downloads models.
