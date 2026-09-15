# Portable editing and isolated workers

## Alternatives and transfer

`fork_session` copies the current or named version into an independent session with independent assets and history. Use the returned revision; later edits to the parent do not alter the fork.

`export_session_bundle` writes a manifest plus owned source, LUT and other dependencies. Move the entire directory, retain `manifest_sha256`, and use `import_session_bundle(path, expected_manifest_sha256)` in the destination workspace. A bundle is stronger transfer evidence than a bare recipe or session JSON. The import verifies hashes and paths before publishing a new session, including RAW source-domain semantics for derived images.

`diff_versions` compares saved/current state without mutation. `copy_adjustments` requires explicit keys, a `geometry` policy and per-target revisions; inspect every result in a mixed-success batch. Set `geometry: "exclude"` to omit geometry-dependent controls, or `geometry: "require_same_dimensions"` for dimension-sensitive copying. Copied masks receive new identities. Metadata and source pixels are not copied as adjustments.

`manage_presets` and `manage_luts` act on workspace-owned assets. Import/export uses returned paths and `workspace:` IDs. Saving a preset excludes masks and geometry unless deliberately requested. Keep asset bundles intact; linked LUT data belongs with a reusable preset.

Background mask/depth operations capture the parent's verified `masks` group; inpaint captures `inpaint`. Keep the owned job model copies intact for resume. `captured_models` reports group/count. Repair a partial/corrupt parent group with `install_model` before starting; changed captured hashes require a fresh job. Capture does not download models, and an empty parent model directory can still use the native installed-app copy fallback.

## Expensive operations

Prefer `start_operation(operation, arguments)` for long merge, export, negative conversion, mask/depth generation or local retouch. It captures inputs and settings before returning a job ID; later parent edits do not affect the captured result. One operation worker runs per workspace. Continue using the main session while it works.

Read `get_operation_job` for stages and result. A successful edit returns a new main-workspace session; an export returns its actual worker-workspace path. Cancellation terminates the worker only. After a crash or reconnect, inspect `list_operation_jobs` and explicitly resume only intended work; each attempt starts again from captured inputs, with no partial computation checkpoint.

Denoise keeps its specialized `start_denoise`/`get_job` API, including cooperative cancellation and numeric native progress. Generative retouch uses a synchronous direct call and cannot use captured operation jobs.
