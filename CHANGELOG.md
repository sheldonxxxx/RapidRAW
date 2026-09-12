# Fork changelog

Changes added by this fork to RapidRAW. Upstream application changes remain in the [upstream history](https://github.com/CyberTimon/RapidRAW/commits/main/). Dated entries below record fork development milestones, not packaged releases. Native bridge versions are separate from the upstream application version and the MCP server package version.

## Unreleased — native bridge 1.2.0

### Added

The MCP interface grows from 47 to 62 public tools: 57 native methods and five host worker methods. Tool names below omit the `rapidraw_` prefix.

| Addition | New tools |
| --- | --- |
| Independent editing copies, portable bundles, version differences and selective synchronization | `fork_session`, `export_session_bundle`, `import_session_bundle`, `diff_versions`, `copy_adjustments` |
| Coordinate conversion, resource checks and regional color/white-balance diagnostics | `map_coordinates`, `preflight`, `sample_region` |
| Owned workspace preset and LUT libraries | `manage_presets`, `manage_luts` |
| Isolated background operations with durable status, cancellation and explicit resume | `start_operation`, `get_operation_job`, `list_operation_jobs`, `cancel_operation_job`, `resume_operation_job` |

- Matched photograph, overlay and grayscale mask previews, selection bounds/statistics, and atomic submask add/edit/remove/duplicate/reorder operations.
- Include/exclude point prompts and in-place AI-subject refinement, with retained mask IDs and edits, revision guards, saved native logits, explicit approximate legacy-mask seeds, and captured worker support.
- Dedicated clipping previews and an exact encoded-preview cache with revision/settings/source invalidation.
- Portable sessions containing their required sources, LUTs, masks, patches, history and saved versions; integrity checks and recovery from interrupted imports.
- Background export, merge, negative conversion, mask/depth generation and local retouch using captured inputs, settings and verified model assets.
- Native rendering beyond the GPU's single-texture dimension limit, with bounded processing tiles and a documented 100-megapixel limit.
- Explicit sRGB profile policy for supported exports and independent profile/codec verification.
- Native coverage inventories, photographic fixture/review runners, RAW cache timing, setup checks and portable evidence-contract CI.
- Schema-aware evidence attribution and requirement grouping, explicit derived-state evidence, focused rendering oracles, and photographic point-refinement/panorama regression runners.
- Fresh-mask native-edge and real automatic lens-profile runners, with immutable first-attempt artifacts, explicit photographic criteria and independent calibration expectations.
- Guided masking instructions for choosing an AI or manual starting selection, painting named additive/subtractive corrections, and judging the actual local adjustment at overview and native detail.
- A photographic guided-mask regression runner covering preserved AI baselines, brush corrections, an independent manual mask, selected/protected-region effects, history and exact saved-state/rendering checks.

### Fixed

- Incorrect ICC adaptation/tag layout and export profile labeling.
- Invalid JPEG XL output for affected image dimensions/alpha paths. Lossless and transparent compatibility cases use a verified encoder; a transparent fallback reports its quality/file-size tradeoff.
- Extreme-aspect export resizing that could return the wrong requested dimension or a zero-sized companion axis.
- Local-only flare and large/tall-image effect seams caused by tile coordinates or insufficient overlap.
- Mask review responses exceeding common MCP client buffers. Display color previews now consistently use 8-bit encoding; an 8 MiB response budget returns actionable recovery data without silently resizing images or replaying completed mutations. Native processing and high-precision exports retain their precision.
- Worker model/input portability and interrupted session import handling.
- A completed operation could briefly reject the next start as busy while native teardown was still running; subsequent start/resume now waits for that completed worker to close.
- Signed SAM prior conversion, retouch-aware point inference, legacy morphology preservation and stale submask-placement guards.
- Zero-strength and neutral-profile lens correction no longer resamples identity images or changes their border pixels/bit depth; zero strength also matches disabled correction alongside other geometry.
- Saved subject-refinement dimensions encoded as floating JSON values return validation errors instead of terminating the native worker.
- Panorama matching retries low-contrast detection thumbnails with normalized feature detection when the original match graph is disconnected. MCP merges require every input to connect, avoiding a partial panorama whose provenance incorrectly lists excluded inputs.
- Wide panoramas use a central frame as the reference and reject transforms that cross the projection plane before allocating a stitched canvas.
- Lens calibration uses a valid EXIF f-number before the logarithmic aperture fallback, so automatic vignette selection and explicit MCP aperture overrides use the intended aperture.
- Fresh-mask evidence capture explicitly requests full adjustment state; summary-only responses cannot silently stand in for editable-state evidence.

### Verification and limits

The earlier macOS/Metal acceptance run exercised all 62 tools through real MCP, with 1,490 calls and 202 explicit checks. Separate focused builds passed 665 rendering/refinement calls and 40 panorama calls. Lens correction passed 125 native library tests (including Metal) and 67 real lens-profile MCP calls with nine checks. Guided masking reuses that native build and passes 118 MCP calls with 12 checks; the protocol/worker/evidence suite passes 103 tests. See the verification record for each build boundary.

Fresh mask testing records three automatic selections, 53 successful native calls and 37 native-region triplets. All three fail strict full-matte criteria because of hair/claw omissions, unwanted-object spill, filled gaps or coarse sky boundaries. Those limits do not establish that the selections are unusable for restrained local edits. Point prompts improve the tested tail/twig regions; guided brush repairs and actual-grade comparisons address whether a selection is sufficient for the requested edit. The genuine panorama still needs projection/framing improvements, and the real lens photograph retains residual colour fringing; passing execution checks do not imply complete photographic quality.

On the guided bird regression, named AI review finds an AI-plus-brush whole-bird lift and an independent manual breast lift useful, while retaining painted-edge limits. Selected breast pixels change, the protected perch probe remains exact, and both edited sessions retain state and rendered pixels after history changes and restart. This does not approve a complete extraction matte or every photograph.

See the [application/MCP capability matrix](mcp/CAPABILITY-MATRIX.md), [verification record](mcp/VERIFICATION.md) and [reproducible test instructions](mcp/testing-matrix.md). Windows/Linux native acceptance, release packaging, configured remote providers and genuine HDR/focus/negative-film fixtures remain unverified.

## 2026-09-12 — comparison reviews and recoverable denoise

Native bridge 1.1.0 exposed 47 tools.

- Added temporary matched edit comparisons and exposure/adjustment diagnostics.
- Added durable named edit versions and restoration beyond the bounded undo history.
- Added background AI/BM3D denoise with captured inputs, progress, cancellation, restart recovery and explicit resume.
- Added smooth/asymmetric gradient fades in native masks and desktop mask controls.
- Extended the execution skill and file-backed MCP client for reliable image/result capture, error handling and timeout control.
- Expanded native/protocol acceptance for comparisons, masking and denoise jobs.

## 2026-09-11 — fork build configuration

- Disabled Android build jobs in this fork's CI. This does not remove Android support from upstream RapidRAW.

## 2026-09-10 — initial native MCP integration

Native bridge 1.0.0 introduced the optional MCP editing workflow.

- Added an official-SDK stdio server and optional native bridge, enabled with the `mcp` Cargo feature, while retaining the ordinary application and export CLI entry points.
- Exposed RAW development, global/local adjustments, AI masks, depth, retouch, denoise, lens correction, merging, negative conversion, metadata, presets/LUTs and exports through the existing native engine.
- Added isolated working copies, source/sidecar preservation, strict schemas, revision checks, atomic session history, recipes, undo/redo and protected export destinations.
- Added float32 processing with high-precision readback/export and preservation of RAW interpretation in derived denoise sessions.
- Added the optional photo-editing execution skill, setup/integration documentation, and protocol/native CI checks.
- Fixed the four-point panorama homography nullspace calculation and added mathematical regressions.
