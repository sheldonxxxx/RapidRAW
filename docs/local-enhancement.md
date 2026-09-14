# Local masks and detail enhancement

Build finer selections, select scene and portrait regions, recover mild motion blur, and enlarge a finished photograph inside RapidRAW. These optional operations run local ONNX models through the same native implementation in the desktop editor and MCP. They require a current source build of this fork and separately installed model assets.

| Operation                              | Best use                                                                                               | What to inspect                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Refine mask — ViTMatte Small           | Improve an existing selection around hair, feathers and soft edges                                     | Fine strands, holes and protected background at native detail. The starting selection still matters.                                       |
| Semantic mask — UperNet / Face Parsing | Select vegetation, water, sky and other scene categories, or skin, hair, eyes and other portrait parts | Semantic labels are approximate. Isolate a face region when several people appear or the face occupies little of the frame.                |
| Deblur — NAFNet GoPro 32, experimental | Recover mild motion blur on a clean, rendered image                                                    | Noise, invented texture, ringing and tile boundaries. Denoise noisy photographs first; this model failed severely on a noisy feather test. |
| Upscale — SwinIR Lightweight 2×        | Make a conservative enlargement of a finished image                                                    | Compare with ordinary interpolation at the same display size. Enlarged noise is still noise; missing detail is not reliably recovered.     |

Mask operations create or refine ordinary editable masks. Refinement replaces one selected component while retaining its mask grade, siblings, opacity, inversion and combination mode. Deblur and upscale produce a separate 16-bit TIFF or MCP session with the current adjustments baked into rendered sRGB pixels. Keep the original RAW session for further development.

These are reconstruction and segmentation models, without prompts or a generative image service. Photographs are not uploaded by these operations. Installing models downloads assets and, for local export, upstream implementation code.

## Desktop

Open a photograph, expand **Photo enhancement** in the AI panel, and choose an operation. Download a supported ready-made model or import its prepared ONNX file using the model control. Choose the mask component for refinement, or select categories for a semantic mask. Run the operation and inspect the before/after preview and elapsed time. Restoration results are saved as separate files; use **Show saved image** to locate the result.

Use the optional pixel region to isolate a face or process a restoration crop. Mask coordinates use the full transformed canvas before the editor crop; restoration coordinates use the currently cropped render. A restoration region produces only that region, not a patch in the original photograph. Exporting a 2× result is limited to 100 megapixels; crop inputs larger than 25 megapixels first.

Cancellation stops between processing stages and tiles; a running model call must finish first. Changing the photograph cancels its pending enhancement. Concurrent adjustment changes prevent a finished mask from replacing newer edits.

## Choose speed and detail

| Profile  | Mask refinement                                     | Deblur / upscale                  |
| -------- | --------------------------------------------------- | --------------------------------- |
| Fast     | Resize inference to a maximum edge of 512 pixels    | 128-pixel tiles, 16-pixel overlap |
| Balanced | Maximum inference edge of 1536 pixels               | 256-pixel tiles, 32-pixel overlap |
| Quality  | Refine native boundary tiles, up to 768 pixels each | 384-pixel tiles, 48-pixel overlap |

Semantic parsing always runs at 512 × 512; its profile does not change model resolution. Use a face region to give the parser more useful detail. For refinement, **Boundary width** is the search radius in source pixels: increase it when the coarse selection misses strands, but inspect for softened interior coverage and background leakage. It cannot discover details far outside the unknown boundary band.

Native refinement blends overlapping predictions and preserves known foreground/background. Where a tile lacks enough local context, it keeps the coarse selection and reports a warning with `coarse_fallback_tiles`. If no tile can run learned refinement, the operation fails without changing the mask. Try a narrower boundary or Balanced profile in that case.

Larger restoration tiles offer more context and use more memory. They do not guarantee a better photograph or a faster job. Semantic selections can miss part of a waterfall or include wet rock; refine the result with ordinary mask tools. Whole-image time includes rendering, padding, overlapping tiles and output creation, so a single tile benchmark is not an export-time estimate.

**Mac mini, 16 GB:** start with Auto and Balanced for masks; Auto selects CPU, capped at four inference threads. Start restoration on a small area in Fast, and use the NVIDIA server for larger enlargement jobs. Reserve Quality for inspected detail. CoreML is available only for validated ViTMatte inference. Face parsing is blocked on CoreML because the tested runtime can abort inside MPSGraph; restoration models also remain on CPU.

**Linux NVIDIA server:** Auto attempts CUDA with initialization fallback to CPU. Explicit CUDA reports an error if the runtime cannot initialize. Install the compatible runtime following the [Linux ONNX guide](../mcp/ONNX-CUDA.md). A 4 GiB CUDA arena limit bounds that allocator, not total GPU memory. Existing denoise/masking provider defaults remain unchanged; this Auto policy applies to the new enhancement operations.

Only one enhancement model session is cached at a time. Repeated work with the same model reuses it; switching models releases the previous session. This keeps memory use more predictable on a 16 GB computer. Provider receipts identify the registered provider and any initialization fallback; unsupported operators may still execute on CPU.

## Apple Silicon runtime

Apple Silicon source builds bundle the official **ONNX Runtime 1.30.0** CPU/CoreML library and require **macOS 14 or later**. The build verifies the release archive, extracted library and license notices before replacing cached resources. The Mac app and default local MCP engine use this bundled library. Model files and editing sessions do not need conversion.

Intel Mac builds retain 1.22.0. Upstream [stopped publishing Intel Mac binaries and raised the minimum macOS version](https://github.com/microsoft/onnxruntime/releases/tag/v1.24.1); this upgrade does not introduce an untested custom Intel runtime. The Linux CUDA runtime remains separately configured.

CPU remains the default on Mac. Upgrading the runtime does not enable CoreML for models that failed its compatibility checks; explicit CoreML remains limited to ViTMatte.

New subject selections can differ from 1.22 because the quantized SAM model amplifies small numerical changes. A comparison of three photographs found comparable portrait and bird coverage, but additional spill into protected hills in the landscape case. The strict numerical comparison failed; this upgrade does not promise identical new SAM masks. Inspect new selections and use the dedicated Sky tool for sky adjustments. Existing saved mask pixels are preserved.

Local inpainting uses a targeted CPU setting for the bundled 1.30.0 build to avoid a slow FP16 matrix kernel. This reduces the observed slowdown, but large LaMa repairs remain slower than with 1.22 on the tested Mac mini. Smaller repair regions reduce the work. Other models and platforms retain their existing session settings.

## Measured native performance

The following September 2026 baseline predates the Apple Silicon runtime upgrade. It used a Mac mini M4 with 16 GB unified memory and a Ryzen 7 9700X server with an RTX 5060 Ti 16 GB. These are representative single-photo measurements, not statistical throughput guarantees or a comparison of hardware alone. The Mac used the former bundled ONNX Runtime 1.22.0 with CPU inference; the server used ONNX Runtime 1.30.0 with CUDA. Both used the native application path and four CPU inference threads.

| Workload                                           | Mac mini M4 | RTX 5060 Ti server |
| -------------------------------------------------- | ----------: | -----------------: |
| Hair refinement, 2048 × 2048, Balanced, warm       |      5.47 s |             0.85 s |
| Mild motion deblur, 1280 × 720, Fast, warm         |      8.93 s |             1.00 s |
| 2× enlargement, 1024 × 1024 input, Fast, first use |    159.61 s |             5.21 s |
| 2× enlargement, 3072 × 2048 input, Balanced, warm  |     Not run |            30.93 s |
| Semantic scene mask, 6960 × 4640 input, warm model |      7.99 s |             2.48 s |

Times include native rendering, inference and result creation. Opening the source and final TIFF export are measured separately. The larger server enlargement added 1.31 seconds for TIFF export; the 32-megapixel mask case added 5.42 seconds on Mac and 1.52 seconds on the server. The Mac scene-mask run sampled a peak of 2.68 GiB process-tree RSS. The 22-call server profile sweep sampled a peak of 4.14 GiB process-tree RSS and 3438 MiB whole-device GPU memory, including a 282 MiB baseline. Sampling can miss brief peaks and RSS can count shared pages twice.

An isolated Mac comparison with ONNX Runtime 1.30.0 reduced warm Balanced deblur from 23.46 to 4.24 seconds. A first-use Balanced 1024-pixel enlargement still took 153.63 seconds, so a newer runtime alone did not make full-image enlargement interactive. The remaining expensive Mac enlargement repetitions were stopped; their missing measurements are not counted as successful runs. That comparison used an external library before the default bundle was upgraded.

A repeat through the Mac app bundle containing the official ONNX Runtime 1.30.0 library measured the following native operations on the same Mac mini. Each warm value has at least one preceding call with that model. These are individual observations, not averages across repeated benchmark sessions:

| Workload                                           | Bundled 1.30.0, Mac CPU |
| -------------------------------------------------- | ----------------------: |
| Hair refinement, 2048 × 2048, Balanced, warm       |                  2.80 s |
| Mild motion deblur, 1280 × 720, Fast, warm         |                  3.99 s |
| Mild motion deblur, 1280 × 720, Balanced, warm     |                  4.02 s |
| 2× enlargement, 1024 × 1024 input, Fast, first use |                137.41 s |
| Semantic scene mask, 6960 × 4640 input, warm model |                 16.28 s |

Refinement and deblur improved in these examples; enlargement remained expensive, and the full-photo scene mask was slower than the earlier baseline. Its TIFF export added 6.71 seconds. Whole-photo performance includes work outside ONNX and can vary with memory pressure; the newer runtime is not a universal speed improvement.

With the targeted inpainting settings, fresh native LaMa runs took 2.11 seconds warm at 448 × 448 and 7.54 seconds at 768 × 768. The complete MCP regression suite observed 6.39 and 26.42 seconds respectively, versus 2.00 and 11.18 seconds on its 1.22 baseline. Keep the workload distinction when estimating repair latency; the small isolated result is not a guarantee for an active editing session.

Separate ONNX Runtime 1.30.0 microbenchmarks found a warm ViTMatte 512-pixel inference of 0.36 seconds on Mac CPU versus 0.26 seconds on CoreML, but CoreML initialization took roughly 2.5–3.3 seconds instead of 0.14–0.25 seconds on CPU. These model-only timings exclude the native render and save path. They support keeping CPU as the casual-edit default, not a whole-photo latency claim.

The former 1.22.0 bundle's native CoreML matting path also passed a 512-pixel case: 2.74 seconds first use and 0.65 seconds warm. CPU remains the default because this did not establish a useful single-edit advantage.

Both machines completed the native acceptance cases, including source preservation, revision guards, mask history, restart rendering, 16-bit sRGB export, and background cancellation/resume. Hair and feather detail, a cropped portrait, waterfall selection, noisy restoration rejection and motion-blur/enlargement outputs received rendered review. Refinement recovered useful boundary detail; scene selections needed cleanup; deblur gains were modest. These observations do not establish general photographic acceptance.

In two controlled enlargement checks, native 512-pixel feather and eye/cheek crops were downsampled to 256 pixels and restored to 512. SwinIR at strength 0.7 improved PSNR over bicubic interpolation by 0.45 and 0.50 dB respectively. This measures reconstruction of a known synthetic degradation, including source noise; it does not prove recovery of unknown detail or better aesthetic quality.

## Install model assets

`rapidraw_enhancement_models` reports readiness, source, license, filename and supported providers. ViTMatte and Face Parsing have pinned downloadable ONNX assets. UperNet, NAFNet and SwinIR require local preparation using the included exporters, then import. Models are optional and installed separately from application code.

Use Python 3.13 in an isolated environment. The following paths are placeholders outside the repository:

```sh
python3.13 -m venv /path/to/enhancement-venv
/path/to/enhancement-venv/bin/pip install -r bench/enhance/restoration-requirements.txt
/path/to/enhancement-venv/bin/pip install transformers==4.57.3
/path/to/enhancement-venv/bin/python bench/enhance/prepare_mask_models.py \
  --output /path/to/enhancement-models --models vitmatte face landscape
/path/to/enhancement-venv/bin/python bench/enhance/restoration_export.py \
  --model nafnet_gopro_w32 --output-dir /path/to/enhancement-models
/path/to/enhancement-venv/bin/python bench/enhance/restoration_export.py \
  --model swinir_lightweight_x2 --output-dir /path/to/enhancement-models
```

Exporters retain source revisions, license references, hashes and numerical parity results. PyTorch is needed for preparation, not for native inference. A successful parity check proves agreement with the source implementation, not photographic quality.

| Model ID    | Prepared filename            | Upstream                                                                                                                       |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `matting`   | `vitmatte-small-f32.onnx`    | [ViTMatte checkpoint](https://huggingface.co/hustvl/vitmatte-small-composition-1k), Apache-2.0 checkpoint / MIT implementation |
| `face`      | `face-parsing-resnet18.onnx` | [Face Parsing](https://github.com/yakhyo/face-parsing), MIT                                                                    |
| `landscape` | `upernet-convnext-tiny.onnx` | [OpenMMLab UperNet](https://huggingface.co/openmmlab/upernet-convnext-tiny), MIT                                               |
| `deblur`    | `nafnet_gopro_w32.onnx`      | [NAFNet](https://github.com/megvii-research/NAFNet), MIT architecture / Apache-2.0 BasicSR utilities                           |
| `upscale`   | `swinir_lightweight_x2.onnx` | [SwinIR](https://github.com/JingyunLiang/SwinIR), Apache-2.0                                                                   |

For ready-made downloads, call `rapidraw_install_enhancement_model` with `model_id`. For a prepared asset, also pass its absolute `path` and the SHA-256 recorded by the exporter. Desktop import computes and records the selected local file's hash. Installed assets are verified before inference and captured with background jobs.

## MCP

Call `rapidraw_enhance` with the current session revision. This example selects vegetation:

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 4,
  "request": {
    "operation": "semantic_mask",
    "domain": "landscape",
    "classes": ["vegetation"],
    "confidence": 0.5,
    "provider": "auto"
  }
}
```

Operations are `refine_mask`, `semantic_mask`, `deblur` and `upscale`. Refinement also needs `mask_id`; specify `sub_mask_id` when a mask contains multiple components. Restoration accepts `strength` from 0 to 1. A request's optional `region` is `[x, y, width, height]` in pixels. Read live schemas and category lists rather than guessing class names.

For long jobs, use `rapidraw_start_operation` with `operation: "enhance"` and the same payload in `arguments`. The worker captures the source session and model hashes, leaving the parent editable. Cancel through `rapidraw_cancel_operation_job`; explicit resume recomputes the captured operation in a new worker. Apply or open the returned independent session after inspecting its render.

Receipts record the model hash, profile, dimensions, provider, cache state and timings. An unstable deblur result raises `ENHANCEMENT_UNSTABLE_OUTPUT` before it can be saved. The guard rejects nonfinite output or a significant extreme-value fraction; it does not detect every subtle artifact. Inspect every restored result at native detail.

## Reproduce checks

The native acceptance runner uses photographs and assets supplied in a private manifest:

```sh
cd mcp
npm ci
npm run build
RAPIDRAW_BINARY=/path/to/RapidRAW \
RAPIDRAW_WORKSPACE=/path/to/new-test-workspace \
RAPIDRAW_ENHANCEMENT_MANIFEST=/path/to/manifest.json \
node scripts/enhancement-e2e.mjs
```

The manifest contains `models: [{"id": "matting", "path": "/path/to/model.onnx"}]` and `cases: [{"id": "hair", "path": "/path/to/photo.png", "mask_path": "/path/to/coarse.png", "request": {"operation": "refine_mask"}}]`. Include all models required by the cases. Optional `expected_error` verifies a rejected case; `background_check: true` exercises cancellation and resume on a successful case. Results include source integrity, revision guards, mask history or independent restoration state, restart rendering and 16-bit sRGB export. Photographic acceptance remains a separate rendered review.

Use [benchmark_onnx.py](../bench/enhance/benchmark_onnx.py) for model/provider microbenchmarks and the native runner for application behavior. Keep cold initialization, warm inference, whole-photo time and photographic quality as separate measurements.

For existing subject, foreground, sky, depth, inpainting and denoise models, use the native [ONNX provider regression runner](../mcp/scripts/onnx-provider-e2e.mjs) with the setup in the [regression guide](../mcp/ONNX-CUDA.md). It supports comparing runtimes through `ORT_DYLIB_PATH` and saved baseline reports. Preserve failed comparisons when evaluating numerical changes; operation success and photographic usability are separate checks.

The desktop CLIP tagging path has an opt-in native regression test. From the repository root, supply the application's pinned CLIP model, its tokenizer and a photograph; paths below are placeholders:

```sh
cd src-tauri
ORT_DYLIB_PATH=/path/to/libonnxruntime.dylib \
RAPIDRAW_CLIP_MODEL=/path/to/clip.onnx \
RAPIDRAW_CLIP_TOKENIZER=/path/to/tokenizer.json \
RAPIDRAW_CLIP_FIXTURE=/path/to/photo.png \
RAPIDRAW_CLIP_REPORT=/path/to/tagging-result.json \
cargo test --lib --features mcp --locked \
  runtime_regression_tests::clip_tagging_runtime_regression -- --ignored --nocapture
```

This test exercises native preprocessing and tag generation with fixed candidate labels, verifies the model hash and source integrity, and records runtime information for comparison. It does not evaluate tagging accuracy across a photo library.
