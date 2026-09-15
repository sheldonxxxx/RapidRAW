# Optional Marigold depth masks

Select foreground, middle distance or background using a reusable depth map. Marigold V2 is an optional alternative for **depth masks** in the desktop editor and MCP. Built-in depth, subject/sky masks, lens blur and generative profiles keep their existing defaults.

The feature uses the **same AI connector and the same ComfyUI instance** as generative editing. No second address or Comfy server is needed. It is disabled in RapidRAW by default and requires explicit server setup; starting the ordinary connector does not download or load Marigold.

## Set up the existing server

Use ComfyUI with native Marigold V2 nodes, `SaveImageAdvanced`, and [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF). This integration was tested at ComfyUI commit `36da3ff763687eab86a35e1019995dd1fb369b0d`; see [tested dependency revisions](../docs/comfyui.md#tested-versions) and the [chosen workflow catalog](workflows/README.md). Install these weights in ComfyUI's model directories:

| Directory           | File                                           | Source                                                                                         |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `models/unet`       | `Qwen-Image-Edit-2509-Q4_K_M.gguf`             | [QuantStack Qwen Image Edit 2509](https://huggingface.co/QuantStack/Qwen-Image-Edit-2509-GGUF) |
| `models/loras`      | `marigold_v2_depth_log_stage2.safetensors`     | [Comfy-Org Marigold V2](https://huggingface.co/Comfy-Org/marigold-v2-0)                        |
| `models/vae`        | `marigold_v2_depth_log_stage2_vae.safetensors` | Same model collection                                                                          |
| `models/embeddings` | `marigold_v2_depth_conditioning.safetensors`   | Same model collection                                                                          |

The four files require approximately 14 GiB on disk. Reuse existing verified files. The connector checks the pinned SHA-256 values in [depth.py](rapidraw_connector/depth.py); weights are not included with RapidRAW. Retain and review the upstream model licenses and notices.

From `ai-connector`, copy the optional sampler into that Comfy installation:

```sh
cp -R comfy-nodes/rapidraw_marigold "$COMFY_ROOT/custom_nodes/"
```

Create a configuration file outside ComfyUI's input/output directories, replacing the example paths:

```json
{
  "models_dir": "/path/to/ComfyUI/models",
  "state_dir": "/path/to/rapidraw-connector-state/depth"
}
```

Add its absolute path to the environment of your existing connector, then restart that connector and ComfyUI:

```sh
export MARIGOLD_DEPTH_CONFIG=/path/to/marigold-depth.json
```

Keep the existing `COMFY_ROOT`, `COMFY_URL`, `PROFILE_DIR`, address, port and one-worker configuration. Depth always uses those same Comfy connection settings. Use ComfyUI's normal or low-VRAM mode; `--highvram`, `--gpu-only` and `--disable-smart-memory` prevent the offloading this profile requires. Do not add a global `--reserve-vram` setting just for Marigold.

Check `/depth/capabilities` on the connector. It checks required nodes, compatible startup settings and pinned model files; the first checksum check can take a while. Generate a sample depth mask to verify the complete workflow. A failed optional setup leaves the existing generation endpoints available.

## Use it

**Desktop:** open Settings → Processing → AI and enable **Optional Marigold depth**. Use **Check Marigold setup**, then choose **Add New Mask → Marigold Depth** in the mask panel. An existing depth mask can also use **Generate with Marigold**. The shared connector address does not require changing the selected generative AI provider.

Choose **Visualize depth** in a depth component's properties to inspect its saved full-frame map before rotation and crop. The viewer includes a far-to-near legend, Fit, 100% and zoom controls. It works with built-in and Marigold maps without another GPU request or changes to the edit.

On macOS, allow local-network access if the system asks when connecting to your server. If access was denied, check System Settings → Privacy & Security → Local Network. See [Apple's local-network guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

**MCP:** set these keys in the isolated workspace's `engine-settings.json`, using your existing connector address, and reconnect:

```json
{
  "aiConnectorAddress": "127.0.0.1:5002",
  "marigoldDepthEnabled": true
}
```

Create a depth mask explicitly:

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 0,
  "kind": "depth",
  "depth_provider": "marigold",
  "parameters": {
    "minDepth": 45,
    "maxDepth": 100,
    "minFade": 10,
    "maxFade": 0,
    "feather": 0
  }
}
```

Pass this to `rapidraw_mask_generate`, or use `rapidraw_start_operation` with operation `mask_generate` for the existing background-job lifecycle. Use the current session revision. Omitting `depth_provider` selects the built-in model; `marigold` is accepted only for depth masks. `rapidraw_generate_depth` and lens blur retain their built-in path in this release.

## Saved maps and workflow switching

- Analysis uses the geometry-corrected source before orientation and crop. The source is reduced to a 1024-pixel long edge; the full frame goes through a fixed 0.67 Comfy-MP, batch-one, one-step workflow.
- Depth is normalized **relative log depth**, with nearer areas brighter. It is not distance in metres or an exact subject alpha. Inspect fur, foliage, thin objects and depth boundaries before applying a strong edit.
- The 16-bit map and its source, geometry, workflow and map hashes are embedded in the mask. Range changes reuse the map. Saved sessions and portable bundles can render with the connector unavailable or Marigold disabled.
- Saved Marigold masks follow rotation, flips and crop without another inference. Finalize lens distortion and perspective corrections before generating a map; regenerate after changing those corrections.
- Marigold range masks have full selection strength inside the chosen band. Legacy built-in masks retain their existing depth-brightness weighting.
- The connector serializes its generation and depth jobs. When changing workflow, it unloads the previous models before submitting the next graph. Directly submitted Comfy jobs may make a switch temporarily unavailable; the connector does not interrupt them.
- The optional sampler targets roughly 7 GiB of workload capacity through CPU offloading. Its memory override applies only inside Marigold sampling and resets after success or failure. Other samplers use their ordinary settings. This is a tested profile, not a hard GPU allocation cap; memory and latency depend on hardware and other running applications. See [measured VRAM and the 4 GiB limit question](../docs/comfyui.md#vram-and-workflow-switching).
- Discarding a desktop result prevents it from replacing the mask. The GPU job may finish. Switching photos or changing analysis geometry also prevents a late result from being applied.

Disable the desktop/workspace toggle to stop new Marigold requests. Remove `MARIGOLD_DEPTH_CONFIG` and restart the connector to remove the optional server routes. Saved maps remain usable.

## Verify a deployment

Run the connector suite from this directory:

```sh
python -m unittest discover -s tests -v
```

For GPU acceptance, capture a fixed-seed generative result, run an uncached Marigold request, and repeat the same generative request. Compare rendered pixels, record peak process VRAM, and repeat depth with RapidRAW active. Also save/reopen a depth mask with the connector offline and inspect a rotated/cropped mask. A successful request alone does not establish visual quality or memory compatibility.

[Marigold V2 project](https://github.com/huawei-bayerlab/marigold-v2) · [Connector setup](README.md)
