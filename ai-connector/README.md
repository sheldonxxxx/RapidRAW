# RapidRAW Comfy Connector

Run RapidRAW generative edits on your own ComfyUI machine, with selectable model profiles, explicit seeds and generation resolution. The connector returns a crop at the original image coordinates; RapidRAW applies the original selection mask and retains the rest of the photograph.

The workflow, resolution and seed controls require a current build of this RapidRAW fork. Follow [Build this fork](../docs/desktop-guide.md#build-this-fork); upstream application downloads do not include these additions.

See the [ComfyUI integration guide](../docs/comfyui.md) for tested revisions, shared-GPU behavior and the [chosen workflow downloads](workflows/README.md).

## Requirements

- Python 3.11 or newer, and a working [ComfyUI installation](https://github.com/Comfy-Org/ComfyUI).
- Run the connector on the ComfyUI host, under the same operating-system user. It writes source images and inference masks into ComfyUI's input directory. The connector itself needs no PyTorch or GPU packages.
- ComfyUI must include `Flux2Scheduler`, `ReferenceLatent`, `FluxKVCache`, `TextEncodeBooguEdit`, and the built-in image, mask, loader and sampler nodes used by your enabled profiles. The supplied graphs were checked against [ComfyUI revision c75d8c9](https://github.com/Comfy-Org/ComfyUI/tree/c75d8c966c29cb0392259af791f43373315b72db); older builds may lack these nodes. No custom node package is needed for these examples.
- Download the weights for each profile you enable. Weights are separate downloads with their own license terms.

| Profile          | Diffusion model in `models/diffusion_models/`                                                                                                   | Encoder in `models/text_encoders/`                                                                                      | VAE in `models/vae/`                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Klein 4B         | [`flux-2-klein-4b-fp8.safetensors`](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8)                                               | [`qwen_3_4b.safetensors`](https://huggingface.co/Comfy-Org/flux2-klein-4B/tree/main/split_files/text_encoders)          | [`flux2-vae.safetensors`](https://huggingface.co/Comfy-Org/flux2-klein-4B/tree/main/split_files/vae)                               |
| Klein 9B KV      | [`flux-2-klein-9b-kv-fp8.safetensors`](https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-kv-fp8)                                         | [`qwen_3_8b_fp8mixed.safetensors`](https://huggingface.co/Comfy-Org/flux2-klein-9B/tree/main/split_files/text_encoders) | `flux2-vae.safetensors`                                                                                                            |
| Boogu Edit Turbo | [`boogu_image_edit_turbo_hotfix_1k_20260708_int8_convrot.safetensors`](https://huggingface.co/Comfy-Org/Boogu-Image/tree/main/diffusion_models) | [`qwen3vl_8b_fp8_scaled.safetensors`](https://huggingface.co/Comfy-Org/Boogu-Image/tree/main/text_encoders)             | [`ae.safetensors`](https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/ae.safetensors), saved as `boogu.safetensors` |

Klein 4B and the listed Boogu release use Apache-2.0 weight metadata. Klein 9B KV uses the [FLUX noncommercial license](https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-kv-fp8/blob/main/LICENSE). Check each model's terms for your intended deployment; RapidRAW's [software license](../LICENSE) does not replace them.

## Start the connector

From this directory, create a separate environment:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt

export COMFY_ROOT=/path/to/ComfyUI
export PROFILE_DIR="$PWD/profiles"
export STATE_DIR="$HOME/.local/state/rapidraw-connector"
export COMFY_URL=http://127.0.0.1:8188

python -m uvicorn rapidraw_connector.app:create_app --factory \
  --host 127.0.0.1 --port 5002 --workers 1 --no-access-log
```

`COMFY_ROOT`, `PROFILE_DIR` and `STATE_DIR` are required. `COMFY_URL` defaults to `http://127.0.0.1:8188`; `GENERATION_TIMEOUT` defaults to 1800 seconds. Use one connector worker to serialize its generation requests. ComfyUI may still have jobs submitted by other clients.

Check `http://127.0.0.1:5002/health` for `status: "ok"` and `connected: true`, then set RapidRAW's AI connector address to `127.0.0.1:5002`. The health endpoint confirms ComfyUI connectivity; it does not check model availability or run a generation.

For a separate editing computer, forward the port over SSH:

```sh
ssh -N -L 5002:127.0.0.1:5002 user@comfy-host
```

The service has no authentication or TLS; keep the default loopback binding and use a private tunnel. Its API can access private photo pixels and submit work to ComfyUI.

## Select profiles and resolution

For an opt-in depth-mask workflow on the same connector and ComfyUI instance, see [Marigold depth setup](MARIGOLD.md). It has separate enablement and does not change the default generative profile.

[profiles/profiles.json](profiles/profiles.json) advertises four examples: Klein 4B, Klein 4B with closer context, Klein 9B KV and Boogu Edit Turbo. Remove entries whose models are unavailable and keep `default_profile` set to an enabled entry. Restart the connector after changing the catalog or a configuration file.

For practical selection and prompting, use the [AI editing workflow guide](../docs/ai-editing-workflows.md). It starts with Klein 4B at 1 MP and distinguishes these included profiles from research-only text and super-resolution workflows.

Klein 4B exposes 1 and 2 MP generation budgets; the 9B KV and Boogu examples expose 1 MP. These choices describe the supplied profiles, not hard model limits. One MP here means a target area of 1024 × 1024 pixels, rounded to dimensions divisible by 16. The selection bounds and context margin determine the aspect ratio. The default context margin is half the selection's longest side, with a 64-pixel minimum; the closer-context example uses one tenth.

The generated crop is resized back to the native context dimensions. This preserves output canvas size and alignment; it does not recover original RAW detail in regenerated pixels. Inspect fine textures and boundaries at native size. Klein uses masked latent sampling with a reference image; Boogu's example regenerates the context, then RapidRAW reveals only the original selection. Klein's conditioning uses a zeroed negative branch, so negative prompt text has no effect for these Klein profiles. Boogu receives the negative prompt.

RapidRAW currently prepares the AI source from its original image plus existing AI patches, converting RAW linear RGB to sRGB. Global tone, denoise and style adjustments are applied later during normal rendering, so the conditioning image can differ from the displayed developed photo.

## Request protocol and private receipts

- `GET /capabilities` advertises protocol version 2, seed support, profile IDs and accepted megapixel values.
- `POST /upload_source` accepts multipart fields `source_id` and `file`. Reuploading identical bytes is safe; different bytes under an existing ID return HTTP 409. A missing source returns HTTP 404 from `/inpaint`, allowing RapidRAW to upload and retry.
- `POST /inpaint` accepts `source_id`, `mask_image_base64`, `prompt`, `negative_prompt`, `seed`, and optional `profile` and `megapixels`. Seed 0 chooses and records a random positive seed; explicit seeds range from 1 to 9007199254740991.
- The response contains `x`, `y`, `width`, `height`, PNG `color`, PNG `mask`, and bounded `generation` metadata. RGB remains unblended. The native caller uses the original full-resolution selection alpha exactly once; it must not blend the returned RGB before that step.

Before enqueueing, the connector saves the resolved seed, exact source and request mask bytes, configuration, prompt, hashes and workflow under `STATE_DIR/receipts/<request_id>/`. Completed requests add the raw generated PNG. Submission IDs and failure events are recorded as soon as available. Errors returned to the editor contain a request identifier rather than private paths or raw ComfyUI errors; private error text is capped at 8000 characters and saved histories at 2 MiB.

There is no automatic generation retry or shared-queue cancellation. A timeout or lost submission response may leave a ComfyUI job running; inspect its private receipt and ComfyUI history before requesting another generation. A known submission ID is retained even when subsequent polling or decoding fails.

Receipt files contain private photographs and prompts. The connector also caches source images and inference masks in `COMFY_ROOT/input/rapidraw-connector/`; ComfyUI retains its own history and preview output. No automatic retention policy is applied. Choose a retention period, and clear old receipts and connector cache files only after stopping the connector and confirming its ComfyUI jobs have finished. Cache eviction is safe for later edits: RapidRAW uploads a missing source again. Keep `STATE_DIR` outside ComfyUI's input/output directories and outside source control; include ComfyUI's temporary files and history in your privacy and storage policy.

## CPU tests

```sh
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

Tests use synthetic pixels and fixed graph fixtures. They cover all four profile graphs, native coordinates and single mask application, multipart upload/retry behavior, cache conflicts, request validation and receipts for successful and failed generation. They do not download weights or use a GPU; a successful test run is not a visual quality evaluation.
