# MCP verification record

## 2026-09-12 publication checks

Rebuilt the source checkout on macOS after reinstalling both Node dependency sets with `npm ci`. The native debug executable, frontend production build, and native check with the MCP feature disabled passed. The MCP TypeScript build and all 25 protocol/client tests passed; native library tests passed 70 cases with the existing GPU-specific test left ignored.

The real `test:review-jobs` acceptance script passed through the rebuilt binary on a local CR3 original in an isolated workspace. It checked native comparison output, exposure diagnostics, named-version restoration, asymmetric gradients, BM3D completion/cancellation, editing during a worker job, captured-edit inheritance, restart/resume, result persistence, and unchanged original SHA-256. The optional AI-model branch was not rerun; its earlier evidence remains below. This run verifies execution and persistence, not a new aesthetic evaluation.

Targeted MCP/client ESLint passed. Frontend typecheck still reports 76 diagnostics, and ESLint on the two changed frontend files still reports 120 diagnostics. A fresh archive of the unchanged base revision produces the same normalized diagnostic sets; this update adds none. The frontend checks are not globally clean.

The public setup documentation now includes Skills CLI installation, a macOS debug-build quick start, and explicit Windows/other-platform limits. Installing a skill does not configure a host connection. Windows, Linux, packaged releases, and a fresh machine installation were not tested in this run. Local acceptance evidence remains ignored under `.mcp-workspace/public-release-check/`.

## 2026-09-11 comparison and background-job update

Native bridge 1.1.0 now advertises 47 tools. Implemented combined local exposure diagnostics and actual RGB differences, temporary matched comparisons, durable named references, smooth/asymmetric gradient fades (native engine, schema and desktop controls), and recoverable AI/BM3D jobs. The maintained and installed execution skills were updated and validated.

| Check | Result |
| --- | --- |
| Native MCP library tests | 70 passed; 1 existing GPU test remains intentionally ignored |
| MCP TypeScript build and protocol/schema tests | 25 passed |
| Native debug executable and frontend production build | Passed |
| ESLint on changed MCP source, protocol tests and new acceptance script | Passed |
| Real MCP comparison/job acceptance, including AI | Passed |
| Saved night-photo review regression | Both sessions retained identical state, source and sidecar hashes |
| Execution skill validation and installed-file matching | Passed |
| Frontend TypeScript diagnostics | 76, identical to unchanged HEAD after normalizing line positions and generated translation-key union counts |
| Translation runtime diagnostics | 88, identical to unchanged HEAD |

The real acceptance script tests four distinct native comparison images with matched geometry and unchanged manifests/sidecars, geometry rejection, native gradient output, version restoration after the 32-entry undo history is exceeded, stale-revision rejection, AI/BM3D completion and cancellation, editing/rendering while a worker runs, captured-edit inheritance, result persistence without polling, interruption detection, explicit restart, and preservation of explicitly closed result sessions. AI tests use a 64-pixel native export and verified already-installed assets. They validate worker behavior, not full-resolution denoise quality or star preservation. BM3D tests use a 512-pixel native export for completion and a 2400-pixel source for interruption/cancellation.

Read-only inspection and temperature comparisons also ran on the two prior night-photo sessions: photo 1 revision 11 (2400×1600) and photo 2 revision 59 (6960×4640, retained RAW interpretation). Their unchanged edits rendered successfully at 1000 pixels; diagnostic and comparison outputs were visually inspected. These are compatibility checks, not newly accepted photo edits. Desktop controls passed the production build; pointer interactions were not automated.

Local evidence is under `battle-test/2026-09-11/rapidraw-features/` in the parent photo-edit workspace, including `final-acceptance/{summary.json,evidence.jsonl}` and `saved-sessions/verification.json`. Reproduce with `npm run test:review-jobs --prefix mcp`; add `RAPIDRAW_TEST_AI=1` for installed-model AI coverage. The version-2 read-only contract fixture has ten checked reference answers; no autonomous language-model benchmark was run.

A workspace permits one denoise worker. Cancellation waits for native work boundaries; process interruption requires explicit restart from the captured input, with recomputation. Windows, Linux and a packaged release were not tested in this update.

## Earlier validation record

Verified on 2026-09-10 on macOS with Metal, Rust 1.98.1 and the optional `mcp` feature. The tested native executable was a debug build. Evidence and private photos remain in ignored local workspaces; no source photos, generated images, model binaries or credentials are included in the repository.

## Build and protocol

| Check | Result |
| --- | --- |
| Frontend production build | Passed |
| Native MCP build | Passed |
| Native library tests with MCP | 59 passed, 1 GPU integration test intentionally ignored |
| Explicit Metal precision suite, including ignored test | 5 passed |
| Native check with MCP feature disabled | Passed |
| MCP TypeScript build and official-client protocol tests | 18 passed |
| ESLint for MCP source and acceptance scripts | Passed |
| Read-only evaluation answer/reference consistency | 10 answers verified |

The protocol tests exercise real SDK v2 and SDK v1.30 clients, including the MCP 2025 initialize handshake, against a fake native subprocess. They verify tool schemas, resources, prompts, native image blocks, actionable errors, serialization, cancellation, timeouts and shutdown. They are not image-processing tests. The ten evaluation questions test understanding of the recorded contract; they are not an autonomous model or artistic-quality benchmark.

The separate frontend typecheck still reports errors in unchanged upstream TS/TSX files. No frontend implementation files were changed. Windows, Linux, a packaged release build and installation into a particular MCP host were not tested in this run.

## Real native engine acceptance

All calls below used an official MCP client, the TypeScript stdio server, and the compiled native bridge.

| Suite | Evidence and result |
| --- | --- |
| Core RAW workflow | 65 calls on `0F6A8842.cr3` and `0F6A8916.cr3`: open, original/edited/detail/mask renders, actual pixel changes, validation and stale revisions, history, metadata, recipe/session persistence, restart, exports, partial batch errors and overwrite protections |
| Local AI and composition | 58 calls: subject/foreground/sky/depth masks, depth-driven blur, clone/heal/retouch/liquify/local inpaint, AI and BM3D denoise, negative conversion, lens lookup/error handling, HDR/focus/panorama and persistence |
| Assets and delivery | 62 calls, 17 checks, zero skipped cases: auto-adjust/undo, orientation/crop/ROI, recipe roundtrip, installed preset migration, local curve create/update/remove pixel changes, CUBE precision, owned LUT portability/restart, resize modes, watermark, mask exports, six raster formats and source protection |
| Linear denoise regression | 21 calls: zero-strength exact no-op, retained recipe and RAW interpretation, highlight headroom, actual noise reduction, reconnect render identity and AI-generated local curve rendering |

Original RAW files and their existing sidecars retained identical hashes and existence. Advanced tests also verified that all seven installed ONNX model files were unchanged. Model installation reused verified local assets; a fresh network download was not exercised. External generative retouch was not configured or called; only its invalid/unconfigured request handling was checked.

The broad AI/merge tests used small exports from the RAW sample to keep inference bounded. HDR/focus used repeated source fixtures to validate operation and preservation, not genuine exposure-bracket or focus-bracket photographic quality. A separate panorama test used overlapping crops offset by 448 pixels, found 71 inliers and produced a visually continuous stitched result. The four-point native homography repair has four mathematical regressions and is isolated in its own commit.

The denoise regression uses a synthetic 96×64 float TIFF, with only its isolated test manifest marked as linear RAW. It tests the same source-domain state without claiming full-resolution CR3 inference quality. At strength 25, both filters retained values above 1.0; measured noise standard deviation fell about 18–25%, with mean linear drift below 0.0006 on the fixture. This is a regression measurement, not a general denoising-quality claim.

## Precision and export

Both full-resolution masters decoded as 6960×4640 RGB16 TIFFs. Their rasters contained 65,536 and 65,313 distinct values, respectively; sample inspection rejects merely expanded 8-bit output. The 33³ CUBE test found 91,343 channel values off the 8-bit grid. The Metal suite additionally covers a narrow high-precision ramp, tile boundaries and cropped regions.

JPEG, PNG and WebP metadata were independently inspected with ImageMagick, including the repaired WebP extended header. TIFF, AVIF and JXL report unsupported metadata retention honestly with `metadata_applied: false` and warnings. The native AVIF verifier checks the container; the acceptance script additionally used ImageMagick to decode it. JXL was decoded by the native decoder because the installed ImageMagick lacks its delegate. A zero-skipped acceptance summary does not imply an independent decoder exists for every format.

## Visual proof and remaining limits

A restrained wildlife edit of `0F6A8842.cr3` was reviewed at overview and native head-detail scale, with the local mask inspected separately. It was refined and exported as a 2700×1800 JPEG at quality 95 and a full-resolution RGB16 TIFF. The editable recipe and working `.rrdata` were retained. This demonstrates one completed host-agent workflow, not guaranteed professional results for arbitrary photographs.

The earlier server exposed 37 tools and the `pro_photo_edit` workflow prompt. A vision-capable host model must still inspect images and make artistic decisions; the MCP server does not run its own language model. Previews currently render at full resolution before resizing, so large RAW files can take several seconds per review.

Original RAW working copies and ordinary sidecars support GUI continuation. Linear denoised TIFF intermediates require their saved MCP session to preserve RAW interpretation; opening one directly in the GUI can change its appearance. Use MCP export for a portable display image.

See [setup and reproducible acceptance commands](README.md#verification) and [native build/integration checks](../MCP.md#build-and-verify). Local evidence is written under `.mcp-workspace/engine-e2e`, `.mcp-workspace/wildlife-proof`, and `mcp/test-output/{advanced-live,asset-live,denoise-domain}`.
