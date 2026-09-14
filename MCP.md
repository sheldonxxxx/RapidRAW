# Developing the optional MCP integration

The public stdio server lives in `mcp/`. The optional native bridge lives in `src-tauri/src/mcp_bridge/` and is compiled only with `--features mcp`. The regular application and its original export CLI retain their entry points. The bridge uses the existing RAW loader, adjustments, mask generation, AI models, geometry, retouch, merge and export code.

For first-time setup, use the [MCP connection guide](mcp/README.md). For issue reports and pull requests, read [CONTRIBUTING.md](CONTRIBUTING.md). Lightweft and Insta360 workflows integrate through optional handoffs described in the [ecosystem overview](README.md#three-independent-projects-one-connected-workflow); the bridge does not depend on either repository.

The bridge operates on copies under a caller-selected workspace. It never writes to an original photo or its existing sidecar. Each session records its source hash, working file, revision, metadata and bounded undo history. Edits are saved atomically; `save_session` additionally creates a native `.rrdata` beside the working copy. Exports stay in `workspace/exports`, and recipes stay in `workspace/recipes`.

## Build and verify

This checkout requires Node.js 22.12 or later, Rust 1.98 or later, and the native prerequisites described in the [setup guide](mcp/README.md#build-and-connect). A pinned toolchain can be installed without changing the machine's default:

```sh
rustup toolchain install 1.98.1 --profile minimal --component rustfmt,clippy
npm ci
npm run build
cargo +1.98.1 build --release --manifest-path src-tauri/Cargo.toml --features mcp --locked
npm ci --prefix mcp
npm test --prefix mcp
```

Run native state/schema tests and verify that the optional feature does not break the standard build:

```sh
RUST_MIN_STACK=16777216 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo +1.98.1 test --manifest-path src-tauri/Cargo.toml --features mcp --lib --locked
CARGO_PROFILE_DEV_DEBUG=0 cargo +1.98.1 check --manifest-path src-tauri/Cargo.toml --locked
```

The precision tests include a real GPU ramp, cropped region, and tile-boundary test. This requires a working GPU adapter and is deliberately excluded from ordinary headless test runners:

```sh
RUST_MIN_STACK=16777216 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo +1.98.1 test --manifest-path src-tauri/Cargo.toml --lib gpu_processing::precision_tests -- --include-ignored --nocapture
```

Use the sample-image command in [the MCP README](mcp/README.md#verification) to verify the complete stdio-to-native path. That test hashes the original before and after, checks real rendered outputs, and saves evidence in its isolated workspace. Transport tests use a fake engine and must not be reported as photo-processing validation.

## Upstream integration boundaries

Keep the fork's `origin` remote pointed at `sheldonxxxx/RapidRAW`, and keep `upstream` pointed at `CyberTimon/RapidRAW`. Develop MCP changes on a branch. After committing or stashing local work, merge an explicitly chosen upstream revision:

```sh
git fetch upstream
git merge upstream/main
```

Review these integration points when upstream changes them:

| Existing area | MCP integration | What to recheck |
| --- | --- | --- |
| Cargo features and `lib.rs` | Optional module and early `--mcp-bridge` entry | Standard startup and feature-disabled build |
| `app_state.rs` | Shared `Default` constructor | New native fields initialized identically for UI and bridge |
| `app_settings.rs` | Process-local settings override | No GUI preference migration or modification during MCP work |
| `ai_processing.rs` | Workspace model directory and shared model constants | Model names, checksums, readiness and ONNX runtime compatibility |
| Export and negative helpers | Crate-visible access to native operations | Correct format, resize, metadata and conversion semantics |
| `denoising.rs` | Additional source-domain denoise helper | Preserve linear RAW values, highlight headroom and subsequent edits |
| Panorama homography calculation | Four-point DLT nullspace repair | Identity, translation, projective and overdetermined regressions |
| `gpu_processing.rs` and export sampling shader | Additional float32/16-bit render path | Shader bindings, color behavior, GPU precision tests |
| Frontend default adjustments and native parsers | Validated adapter schema | Every field, range, curve representation and mask geometry |

The MCP schema intentionally rejects unknown fields. If upstream adds an adjustment, add it to the adapter's defaults/schema, verify its native parameter mapping, and exercise a visible output change. Do not silently accept fields that the engine ignores. Keep the adapter thin; improvements useful to the GUI should be implemented in native helpers and used from both entry points.

MCP does not supply artistic judgment by itself. Its prompt guides the host model through original inspection, reversible edits, fit/detail/mask review, histogram checks, and verified exports. Local AI operations use existing model assets. Remote generative retouch must be selected explicitly and requires the caller's provider configuration.

RAW denoising keeps a linear float TIFF and the source interpretation in the saved MCP session. Continue through that session for matching results; an independent GUI open of this intermediate TIFF does not reproduce the RAW interpretation from `.rrdata` alone. Use MCP export to create a portable display image. Original RAW working copies and their ordinary adjustment sidecars can be continued in the GUI.
