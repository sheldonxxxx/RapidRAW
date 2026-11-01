# Shared editing commands

RapidRAW's desktop editor and native MCP bridge use a shared Rust command contract for opening photographs, resolving adjustments, preparing masks, rendering pixels and encoding exports. This keeps the same edit tied to the same geometry, mask order and final-output precision across both entry points.

The versioned registry is available through the desktop's `get_engine_commands` Tauri command and the `engine_commands` field in `rapidraw_capabilities`. Existing desktop command names and MCP tool names remain the public entry points. The registry identifies their shared engine operations; it does not add a second editing session API.

| Operation | Shared behavior                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Open      | Native image loading, including virtual-copy paths and source-domain handling                                           |
| Adjust    | Native adjustment units, defaults and effective values; clipping is explicit for previews and disabled for final output |
| Mask      | Visible-mask order and rasterization against the supplied photograph, using the sampled crop origin                     |
| Render    | Geometry and mask preparation, plus the native eight-bit or sixteen-bit output path                                     |
| Export    | Format and bit-depth options passed to the native encoder                                                               |

The implementation is in [engine_commands.rs](../src-tauri/src/engine_commands.rs). Desktop preview generations, cancellation and caches continue to govern interactive work. MCP recipe validation, revision checks, session history, original protection and output-path restrictions continue to govern agent calls. These transport rules run around the shared engine operations.

## Regression checks

Generated fixtures exercise geometry and masks against independent pixel expectations. GPU checks compare supported exposure and mask operations against a CPU reference, compare ordinary previews with sixteen-bit output, and verify region rendering and sixteen-bit precision. Export checks verify decoded samples and embedded sRGB profiles.

Run the commands in the [testing guide](mcp/testing.md#shared-engine-regressions). The macOS native CI job runs the small GPU checks explicitly, including the existing precision and cached-preview regressions. Model-dependent tests and performance benchmarks remain separate opt-in runs.

These checks cover deterministic processing contracts. They do not constitute a complete CPU implementation of every shader effect or establish photographic quality for a camera, RAW decoder, denoising model or generative provider.
