# Optional ONNX CUDA inference on Linux

RapidRAW uses **CPU inference by default on every platform without the pinned runtime pack below**. Linux MCP deployments can opt into CUDA for foreground masking, sky masking, depth estimation and AI denoise. This is separate from the Vulkan/Metal photo renderer: installing a GPU driver or CUDA does not enable ONNX acceleration by itself.

This guide configures the native MCP process. The desktop application's startup can also activate the runtime automatically (see [Install the pinned runtime pack](#install-the-pinned-runtime-pack)), and macOS needs no CUDA libraries, new Cargo feature or runtime replacement. Follow the [Linux SSH/Xvfb guide](remote-ssh.md) first for a server without a desktop environment.

## Provider policy

Set these environment variables in the **server-side MCP launcher**, before starting Node and the native engine. Reconnect after changing them; an initialized session keeps its provider.

| Variable                         | Default         | Meaning                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAPIDRAW_ONNX_PROVIDER`         | `cpu` (or `cuda` when the pinned pack below is installed and the variable is unset) | `cpu` uses CPU; Linux `cuda` requires successful CUDA initialization for supported models; Linux `auto` tries CUDA and creates a CPU session if initialization fails. On other platforms, `auto` uses CPU and `cuda` returns an unsupported-platform error. |
| `RAPIDRAW_ONNX_DEVICE_ID`        | `0`             | Nonnegative CUDA device index, read only when CUDA can be attempted.                                                                                                                                                                                        |
| `RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB` | Model-specific  | Optional positive integer overriding the arena limit of **each CUDA session**, in units of 1024 × 1024 bytes.                                                                                                                                               |
| `ORT_DYLIB_PATH`                 | Bundled runtime | Absolute path to a compatible ONNX Runtime shared library. CUDA requires a GPU build with its matching provider libraries.                                                                                                                                  |

The CUDA policy is deliberately limited to the validated models:

| Operation / model                          | Linux `cuda` or `auto`   | Default CUDA arena limit |
| ------------------------------------------ | ------------------------ | ------------------------ |
| Foreground — `u2net.onnx`                  | CUDA                     | 2048 MiB                 |
| Sky — `skyseg_u2net.onnx`                  | CUDA                     | 2048 MiB                 |
| Depth — `depth_anything_v2_vits.onnx`      | CUDA                     | 2048 MiB                 |
| AI denoise — `nind_denoise_utnet_684.onnx` | CUDA                     | 8192 MiB                 |
| Subject — SAM encoder and decoder          | CPU compatibility policy | —                        |
| Local inpainting — `lama_fp16.onnx`        | CPU compatibility policy | —                        |
| CLIP tagging and other unvalidated models  | CPU compatibility policy | —                        |

Bundled SAM models contain quantized integer operators that execute on CPU within a CUDA session, with substantial transfer and GPU memory costs. Keeping both sessions on CPU leaves room for denoise and rendering. Bundled FP16 LaMa produced nonfinite output on CUDA at the supported 768 × 768 input boundary, so it remains on CPU; Linux inpainting also rejects nonfinite results before converting pixels. CLIP has not been validated for this CUDA path.

These explicit compatibility choices also apply in `cuda` mode. For the four supported models, `cuda` reports an initialization error instead of silently selecting CPU. `auto` records its initialization fallback reason. **Neither mode retries failed inference on CPU**: an out-of-memory error during a run remains an error. `auto` also needs a usable core ONNX runtime; it does not replace a missing or incompatible library with another runtime.

When the pinned runtime pack below is installed, an unset `RAPIDRAW_ONNX_PROVIDER` defaults to `cuda` and an unset `RAPIDRAW_NONLOCAL_PROVIDER` follows it; explicit values (including `cpu`) are always preserved and never promoted.

## Install the pinned runtime pack

The recommended Linux x86_64 path is the pinned NVIDIA runtime pack from the dedicated `nvidia-runtime-v1.0.0` GitHub release. It contains the official ONNX Runtime 1.30.0 CUDA 13 build, cuDNN 9.20.0 for CUDA 13, and CUDA 13.2/13.3 user-space libraries. It requires a compatible NVIDIA driver (supported baseline: 595.58.03 or newer) and nothing else: no root, no pip, no system CUDA toolkit, and no copying files into `/usr/lib`. This pack is x86_64 only; Linux ARM stays on CPU. The archive is ~1.1 GB; reserve ~3 GB free for download plus extraction.

```sh
RUNTIME_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/rapidraw/nvidia-runtime"
PACK=RapidRAW-NVIDIA-CUDA13-ORT1.30-cuDNN9.20.0.48-linux-x86_64
mkdir -p "$RUNTIME_ROOT"
cd "$RUNTIME_ROOT"
curl -fL --retry 2 \
  -o "$PACK.tgz" \
  "https://github.com/sheldonxxxx/RapidRAW/releases/download/nvidia-runtime-v1.0.0/$PACK.tgz"
curl -fL --retry 2 \
  -o "$PACK.tgz.sha256" \
  "https://github.com/sheldonxxxx/RapidRAW/releases/download/nvidia-runtime-v1.0.0/$PACK.tgz.sha256"
sha256sum -c "$PACK.tgz.sha256"
tar -xzf "$PACK.tgz"
ln -sfn "$PACK" current
```

The next normal RapidRAW launch discovers `current`, verifies the pack identity against the pinned release metadata, re-execs with the pack libraries, and defaults unset providers to CUDA. No launcher changes are needed.

To use a different location without reinstalling, set `RAPIDRAW_NVIDIA_RUNTIME=/absolute/path/to/pack`. To disable the runtime and run on CPU, set `RAPIDRAW_NVIDIA_RUNTIME=off` or remove the `current` symlink; the versioned pack directory may be kept or deleted. To restore the original inference configuration permanently, uninstall as above.

## Advanced: manual external GPU runtime

The tested configuration uses Debian 13 x86-64, an NVIDIA RTX 5060 Ti with 16 GB VRAM, driver 595.58.03, CUDA 13.2, cuDNN 9.17 and the official **ONNX Runtime 1.30.0 CUDA 13** release. The runtime successfully served RapidRAW's existing C API version 22. Other combinations require their own validation; use the [official CUDA requirements](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements) when choosing dependencies.

Download the [official release archive](https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0) into a separate directory. The path below is a placeholder for a directory you control:

```sh
RAPIDRAW_RUNTIME_ROOT=/absolute/rapidraw-runtimes
mkdir -p "$RAPIDRAW_RUNTIME_ROOT"
cd "$RAPIDRAW_RUNTIME_ROOT"
curl -fL --retry 2 \
  -o onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz \
  https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz
printf '%s  %s\n' \
  382d79133112388cf94ce5855789b7c9bef12bef76a08b6b277e5a317213adcd \
  onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz | sha256sum -c -
tar -xzf onnxruntime-linux-x64-gpu_cuda13-1.30.0.tgz
ldd onnxruntime-linux-x64-gpu_cuda13-1.30.0/lib/libonnxruntime_providers_cuda.so
```

Keep `libonnxruntime.so`, its versioned target, `libonnxruntime_providers_cuda.so` and `libonnxruntime_providers_shared.so` together from the same release. Preserve the archive's library symlinks. CUDA runtime, cuBLAS, cuRAND, NVIDIA driver libraries and matching cuDNN must be discoverable by the process. A successful `ldd` check covers direct dependencies; executing the models checks libraries loaded later. TensorRT is not used by this policy.

Replace the `ORT_DYLIB_PATH` handling in the [SSH launcher](remote-ssh.md#launch-through-a-virtual-display) with the following, and add the provider selection:

```sh
export ORT_DYLIB_PATH=/absolute/rapidraw-runtimes/onnxruntime-linux-x64-gpu_cuda13-1.30.0/lib/libonnxruntime.so
export RAPIDRAW_ONNX_PROVIDER=cuda
```

A caller-supplied `ORT_DYLIB_PATH` remains supported when `RAPIDRAW_NVIDIA_RUNTIME` is unset or `off`: pre-start planning leaves the manual runtime untouched, never auto-discovers or re-execs a pack, and lets the existing native provider logic validate the manual runtime fail-closed (an unusable manual CUDA runtime still errors instead of silently falling back). If a `current` pack exists but the operator wants the manual runtime, set `RAPIDRAW_NVIDIA_RUNTIME=off` for explicit intent; an explicit `RAPIDRAW_NVIDIA_RUNTIME=/absolute/pack` always wins over manual `ORT_DYLIB_PATH`. Manual CUDA remains responsible for matching CUDA/cuDNN library search paths.

Set these only for the Linux MCP process. Keep the bundled runtime files intact; this setup requires no changes to `Cargo.toml`, `Cargo.lock`, model files or macOS installation. If dependencies are installed in a nonstandard directory, add only that verified directory to the launcher's `LD_LIBRARY_PATH`.

To restore the original inference configuration, remove the CUDA variables from the launcher and restore its bundled runtime path. Selecting `cpu` with the external GPU runtime also uses CPU inference, but continues to use that external runtime version.

## Memory and simultaneous work

The limits constrain individual CUDA arenas, not total GPU memory. Other sessions, allocations outside an arena and the photo renderer also consume VRAM. Some convolution workspaces are allocated inside the arena; the configured conservative workspace preference does not guarantee small temporary allocations on every runtime.

The tested NIND model needed more than a 4 GiB arena for 504 × 504 inference tiles. Lowering the global limit can therefore make denoise fail. Raising every session's limit can increase retained memory and reduce headroom. Compatibility testing with seven loaded model sessions under the default policy recorded about **9.3 GiB of retained GPU process memory** after inference on the tested card; that is not a peak-memory measurement or a guarantee for every workload.

Start with one GPU inference workload at a time. Separate MCP workspaces prevent state conflicts, but they do not reserve or isolate VRAM. Background operation workers and additional MCP clients can coexist with a main process that retains model sessions. Validate their combined memory use before running them simultaneously.

## Verify the native workflow

Call `rapidraw_models` before and after an AI operation. Its `onnx_execution` object reports the requested configuration, per-model session provider, compatibility note, initialization fallback reason and configured arena limit. Models without an entry have not been initialized in that process. The entries describe the last initialization attempt; they are not a live memory-residency inventory.

A `cuda` session is **not proof that every graph operator ran on GPU**. ONNX Runtime may assign unsupported operators to CPU. Use [ONNX profiling](https://onnxruntime.ai/docs/performance/tune-performance/profiling-tools.html) for operator assignments, and observe GPU memory while exercising real operations. `nvidia-smi` activity alone is insufficient.

The [native ONNX provider regression runner](../../mcp/scripts/onnx-provider-e2e.mjs) starts a fresh engine, uses a real RAW to produce a bounded 1024-pixel fixture, exercises all four mask types, inpainting at 448 and 768 pixels, and tiled AI denoise. It verifies provider diagnostics, dimensions, unchanged model/source hashes and rendered outputs. It records first-call and warm operation times; these include native preparation and serialization, rather than isolated ONNX inference time.

Build the [native engine and MCP package](../../mcp/README.md#build-and-connect), install the verified `masks`, `inpaint` and `denoise` model groups through `rapidraw_install_model`, and prepare separate fresh test workspaces with those assets in `models/`. The runner never downloads models or calls generative services. Use a RAW whose subject, foreground, sky and depth selections are nonempty and whose aspect ratio accommodates both inpainting regions. All paths below are placeholders; run from the repository root on the GPU server:

```sh
export RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW
export RAPIDRAW_TEST_IMAGE=/absolute/photos/test.cr3
export RAPIDRAW_ONNX_RUNS=4
export ORT_DYLIB_PATH=/absolute/rapidraw-runtimes/onnxruntime-linux-x64-gpu_cuda13-1.30.0/lib/libonnxruntime.so
export GDK_BACKEND=x11
export WGPU_BACKEND=vulkan

RAPIDRAW_ONNX_PROVIDER=cpu \
RAPIDRAW_WORKSPACE=/absolute/tests/onnx-cpu \
dbus-run-session -- xvfb-run -a \
  -s '-screen 0 1280x720x24 -nolisten tcp -extension GLX' \
  node mcp/scripts/onnx-provider-e2e.mjs

RAPIDRAW_ONNX_PROVIDER=cuda \
RAPIDRAW_WORKSPACE=/absolute/tests/onnx-cuda \
RAPIDRAW_ONNX_BASELINE=/absolute/tests/onnx-cpu/onnx-provider-results.json \
RAPIDRAW_ONNX_EXPECTED_PROVIDERS='{"u2net.onnx":"cuda","skyseg_u2net.onnx":"cuda","depth_anything_v2_vits.onnx":"cuda","nind_denoise_utnet_684.onnx":"cuda","sam_vit_b_01ec64_encoder.onnx":"cpu","sam_vit_b_01ec64_decoder.onnx":"cpu","lama_fp16.onnx":"cpu"}' \
dbus-run-session -- xvfb-run -a \
  -s '-screen 0 1280x720x24 -nolisten tcp -extension GLX' \
  node mcp/scripts/onnx-provider-e2e.mjs
```

Both runs use the same runtime to isolate provider differences. An external runtime upgrade can also change CPU model outputs; retain reference renders and compare runtime versions separately before adopting the upgrade. Configure the same verified Vulkan ICD and runtime directory as your working SSH launcher if the system requires them. Repeated runs require new workspaces; completed evidence is not overwritten.

Results are saved as `onnx-provider-results.json` alongside PNG artifacts. Optional `RAPIDRAW_ONNX_TOLERANCE` sets normalized mean-absolute and 99th-percentile pixel-difference gates; the runner defaults to 0.01 and 0.05. Passing those gates is a regression check, not approval of photographic quality. Inspect the actual mask boundaries, inpainted regions and denoised detail before delivery. See the [test matrix](testing.md) for broader engine validation.
