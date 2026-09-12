---
name: rapidraw-mcp
description: Edit, mask, retouch, and export photos through RapidRAW's native MCP engine, including saved sessions, recipes, and verified delivery. Use for RapidRAW MCP requests or photo work with connected rapidraw_* tools. For explicit desktop UI control, use the separate rapidraw skill.
---

# RapidRAW MCP

Use native RAW processing. Follow a supplied edit plan, or choose edits from the inspected photo and the user's requested result. Judge the pixels, not just successful calls or histograms.

## Edit and review

1. **Connect once.** Discover exposed `rapidraw_*` tools. Otherwise follow [connection and recovery](references/connection.md), using the bundled persistent client. Keep one owner of the workspace.
2. **Inspect the starting image.** Call `capabilities` and read only the needed adjustment/mask schema fields. Resume a known session with `get_session(include_adjustments: true)`, or open the source if no session exists. Sidecar edits are inherited unless a fresh treatment is intended. Record session, revision, dimensions and working path. Render an overview around 1600 px and relevant native detail before choosing changes. Render inherited edits as the starting state; `original: true` bypasses them.
3. **Apply targeted changes.** Use native names, `mode: "merge"`, and the latest returned `expected_revision`. Execute sequentially; inspect each result before the next mutation. With the fallback client, put large patches and masks in request files and submit by **file** or **file/index**, attaching live session/revision; do not paste large payloads into terminal input. Keep returned mask IDs. `temperature` is relative, not Kelvin. Measure geometry from the image and check uncertain fields against the live schema.
4. **Build and correct selections.** Follow [guided masking](references/guided-masking.md) when creating or repairing a mask: choose an AI or manual starting selection for the intended edit, inspect it, correct named misses or spill with points or brushes, and judge the actual local adjustment. A useful tonal mask does not need cutout-level precision; stronger recoloring or extraction needs closer boundaries.
5. **Check the affected pixels.** After each meaningful edit group, render an overview. For selective edits, use `render(mask_id, mask_mode: "overlay")` for aligned photograph/overlay/grayscale views, then inspect a bounded native detail region without `long_edge`. Read [selective editing](references/advanced-editing.md) for coordinates and geometry. Check intended selection and exclusion areas; nonzero coverage alone is not a pass. Judge remaining edge errors by their visible effect at the requested adjustment strength and delivery size. For example, clothing recoloring needs careful exclusion of skin and scenery. Check for spill, halos, untouched strips and lost texture. Soft edges alone do not establish success: compare the subject’s apparent extent and continuity with the unmasked source, and reject a spotlight or closed shape imposed by the combined masks.
6. **Compare and refine.** Check that the requested look or accent is visible at overview/delivery size and still believable at native detail. Use `save_version` to retain a user-valued reference and `render_compare` for temporary temperature or mask-off variants when these methods are available. Use `inspect_adjustments` to diagnose combined masks without changing history. Keep the source reference and the version/qualities the user valued; the latest candidate is not automatically the best baseline. Fix the named defect and compare both the affected area and the whole frame against that reference. For a suspected edit artefact, compare equivalent renders with the relevant adjustment isolated before asserting its cause. Reuse the session and review only changed views. If an operation remains blocked, report the exact issue and current state rather than calling an incomplete edit finished.
7. **Save and deliver.** `save_session` at useful checkpoints and before export. Keep session/revision, mask IDs, review images and known defects available for continuation. Complete only the requested scope; an inspection-only request does not require edits or exports.

Keep bulky schemas and tool responses in files and read only relevant branches. A supplied plan can use exact native requests in an `operations.json` array, but a separate plan file is not required for ordinary edits.

For revisions after user review, follow [feedback comparisons](references/review-and-jobs.md#revise-from-user-feedback) to isolate the requested change and retain decisions against the version actually reviewed.

For a collection, inspect each source at overview and relevant native detail before assigning its adjustments. A successful export is not a visual review. Keep per-image source, session, revision, baseline and selected-export provenance; a resumable runner should stop on an uncertain result and require reconciliation before another mutation. In a held-out evaluation, freeze skill and engine revisions before inspecting the held-out photographs, and retain first attempts separately from repairs.

When noise blocks the intended detail or tonal separation, read [dedicated denoising](references/advanced-editing.md#dedicated-denoising). Ordinary noise-reduction sliders do not exercise the AI/BM3D operation; an unsuccessful slider treatment does not establish the engine's limit.

## Save and deliver

- `save_session` writes editable `.rrdata` beside the isolated working copy. For transfer or independent alternatives, use portable bundles or `fork_session`; see [portable editing and workers](references/portable-and-workers.md). Save a recipe only when reuse is requested.
- `export` paths belong under workspace `exports`; relative names resolve there. Use returned paths. Never overwrite an existing export unless replacement is intended.
- Export profiles default to verified sRGB ICC for JPEG/PNG/TIFF/WebP. Read returned profile and metadata results; never infer color management from a filename.
- Original size: **omit both `long_edge` and `resize`**. Typical web delivery: JPEG quality 92, long edge 2400, unless the user specifies otherwise. Supply at most one resize option; enlargement requires explicit intent. Confirm supported format/bit depth from capabilities.
- Make comparisons easy to judge: use side-by-side or an aligned slider when useful, with matching geometry, dimensions and crop regions. Verify the delivered image links or embedded bytes; file decoding does not verify browser interaction. Label a tested candidate separately from a user-approved result.
- Inspect the actual exported file against the brief, verify dimensions/format/size, and deliver a clickable path. An export is not finished merely because it decodes. If image inspection is unavailable, label visual quality unverified.
- Batch failures can include completed exports. Inspect each result; retry only failed items after reconciliation.

## State and boundaries

- Read `structuredContent` and `isError`. Images are separate MCP image blocks: display them or save the bytes and view the saved file.
- On `RESPONSE_TOO_LARGE`, keep the connection and returned recovery IDs. A mutation may already have completed; inspect it before further edits. Request smaller overviews or adjacent native-detail tiles explicitly; see [response recovery](references/connection.md#results-and-recovery).
- A derived operation (denoise, negative conversion, merge) may return a **new session**. Continue with it; recheck dimensions and geometry before applying remaining masks.
- Prefer `start_denoise` for long filtering, then `get_job`; keep the job ID. `cancel_job` stops its worker without ending the editing engine. After reconnect, inspect `list_jobs`; explicitly `resume_job` only when restarting captured work is intended. See [review and background jobs](references/review-and-jobs.md).
- On stale revisions, reread state. On timeout/crash/cancellation, reconnect and inspect persisted sessions/output before retrying; never blindly replay a mutation.
- Source photos and sidecars stay intact. Do not hand-edit `.rrdata`, `patchData`, or `maskDataBase64`, or substitute another renderer.
- Inspect `models` before AI work. A configured remote provider is not permission to upload; generative retouch requires authorization. Ordinary grading and geometric masks need no remote generation.
