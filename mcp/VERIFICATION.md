# MCP verification record

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

The server exposes 37 tools and the `pro_photo_edit` workflow prompt. A vision-capable host model must still inspect images and make artistic decisions; the MCP server does not run its own language model. Previews currently render at full resolution before resizing, so large RAW files can take several seconds per review.

Original RAW working copies and ordinary sidecars support GUI continuation. Linear denoised TIFF intermediates require their saved MCP session to preserve RAW interpretation; opening one directly in the GUI can change its appearance. Use MCP export for a portable display image.

See [setup and reproducible acceptance commands](README.md#verification) and [native build/integration checks](../MCP.md#build-and-verify). Local evidence is written under `.mcp-workspace/engine-e2e`, `.mcp-workspace/wildlife-proof`, and `mcp/test-output/{advanced-live,asset-live,denoise-domain}`.
