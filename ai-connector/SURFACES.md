# Directional light and colour with Marigold

Use Marigold V2 for **directional dodge and burn** and **colour selections that are less sensitive to lighting**. Estimate a map once through your existing AI connector, then adjust the effect in RapidRAW without running the model again.

These optional source-build features are disabled by default. The Masks panel and MCP use the same native renderer for previews and exports. Maps are saved with the edit and included in portable sessions. Local depth, generative editing and Marigold depth remain independently available.

## Two useful starting points

| Control                        | What it does                                                                                                            | Best early use                                                 | Limits                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Normals directional dodge/burn | Brightens surfaces facing the chosen direction and darkens opposing surfaces, up to 1.5 exposure stops                  | Shaping a face, separating building planes, lifting a tabletop | Changes exposure only. It cannot move cast shadows or reconstruct reflections. Strong amounts can clip highlights or reveal map errors.        |
| Albedo colour selection        | Picks similar surface colours from the estimated albedo, then recolours original pixels while retaining their luminance | Clothing, petals, painted surfaces under uneven lighting       | Similar colours on other objects can be selected. Use a region mask and inspect boundaries. Albedo is an estimate, not a measured material ID. |

The edit uses the source photo's texture, shadows and highlights. It does not substitute the albedo image for the photo. Normals encode **X right, Y up, Z toward the viewer**. The Comfy postprocessor saves albedo in **sRGB**; the preview tool converts it to linear light for selection and colour math. Normals are numeric vectors and receive no colour transfer function. See the [upstream model](https://github.com/huawei-bayerlab/marigold-v2) and [normal conventions](https://huggingface.co/docs/diffusers/main/en/using-diffusers/marigold_usage).

## Enable on the existing connector

First complete the [shared ComfyUI setup](MARIGOLD.md#set-up-the-existing-server), including the Q4 backbone, ComfyUI-GGUF and bundled optional sampler. Use the existing ComfyUI instance and connector worker. No additional GPU server or listener is needed.

The chosen [normals workflow](rapidraw_connector/surface_profiles/marigold-v2-normals-q4.json) and [albedo workflow](rapidraw_connector/surface_profiles/marigold-v2-albedo-q4.json) are the actual connector templates. They share the depth Q4 backbone and sampler; task adapters, conditioning and decoders differ. Sampling stays at one step, batch one and about 0.70 million pixels. These mask tools have separate endpoints and do not appear in the generative profile selector.

Download the following files into the existing ComfyUI `models` directory. Names are relative to that directory. The backbone is shared with depth; do not download another copy.

| Task    | Additional files                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Normals | `loras/marigold_v2_normals.safetensors`, `vae/marigold_v2_normals_vae.safetensors`, `embeddings/marigold_v2_normals_conditioning.safetensors` |
| Albedo  | `loras/marigold_v2_albedo.safetensors`, `vae/marigold_v2_albedo_vae.safetensors`, `embeddings/marigold_v2_albedo_conditioning.safetensors`    |

Use [Comfy-Org/marigold-v2-0 revision `70e2127d026c8f6b62d8049b73f5392e1e81ebfa`](https://huggingface.co/Comfy-Org/marigold-v2-0/tree/70e2127d026c8f6b62d8049b73f5392e1e81ebfa). Both tasks add about **3.65 GiB** combined. Exact SHA-256 values are in [`TASK_ASSETS`](rapidraw_connector/materials.py); readiness verifies them. Install only the task assets you need. Upstream model terms apply.

Create a configuration outside Comfy input/output and source control. Replace these placeholder paths with your deployment paths:

```json
{
  "models_dir": "/path/to/ComfyUI/models",
  "state_dir": "/path/to/private/surface-state"
}
```

Add `MARIGOLD_MATERIALS_CONFIG=/path/to/surface-config.json` to the existing connector environment, then restart that connector with its normal command. Keep any existing `MARIGOLD_DEPTH_CONFIG`. Omit the new variable to disable surface routes. A missing or invalid optional configuration leaves ordinary generation available.

One connector worker serializes generation, depth, normals and albedo requests. When the task changes, the existing workflow switch checks the Comfy queue and unloads idle models before submission. It refuses to switch while an external Comfy job is queued or running. A failed or timed-out submission is not automatically replayed.

## Use in RapidRAW

1. Complete the server setup above. In **Settings**, enable **Optional Marigold directional light and colour**, confirm the shared AI connector address, then choose **Check normals and albedo setup**.
2. Open a photo. In **Masks → Add New Mask**, choose **Marigold Directional Light** or **Marigold Colour**. A new component generates its map once. The controls also provide **Generate map**, **Regenerate map** and **Discard result** while a request is pending.
3. For directional light, set the direction and dodge/burn strength. **0°** lights from the right and **90°** from above. Positive strength brightens facing surfaces and darkens opposing surfaces; negative strength reverses that effect. Zero strength adds no lighting. The overlay shows the facing selection, while the photo shows both sides of the effect.
4. For colour, choose **Choose colour on albedo map** and click the material colour. Adjust **Colour range**, choose **Recolour to**, then raise **Recolour amount**. It starts at zero. At zero, the selection can still drive ordinary local adjustments. Black has no recolouring effect because it has no chromaticity; use exposure for darkening.
5. Intersect with an existing subject mask or brush region to protect similar colours or unrelated surfaces. Use one surface component per adjustment mask. The renderer has 32 mask slots; directional light uses two, other masks one.

The map viewer shows analysis geometry before display rotation and crop. Display rotation, flips and crop follow the saved map without another request. Lens/perspective changes and retouch changes make the surface mask inactive until regeneration or undo. Regenerating replaces the stored map only after success; a discarded, failed or outdated request preserves the previous map.

Maps are specific to the analysed photo; regenerate after copying a mask or preset to another photograph. The RGB16 map and provenance hashes remain in saved edits and portable bundles. Turning the optional setting off prevents new inference; already saved maps continue to render offline. Map precision does not imply full-resolution inferred detail: the photo and export keep their source dimensions, but uncertain analysis edges still need inspection.

## MCP

Enable `marigoldSurfaceEnabled` in engine settings and use the existing `aiConnectorAddress`. `rapidraw_mask_generate` accepts `kind: "normals"` or `kind: "albedo"`:

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 1,
  "kind": "normals",
  "parameters": { "normalAngle": 90, "normalAmount": 0.4 }
}
```

For albedo, use `surfacePointX` / `surfacePointY` (0–1 on the unrotated stored map), `surfaceTolerance` (0.005–1), `surfaceColor` (three RGB integers, 0–255) and `surfaceAmount` (0–1). Update these through ordinary `rapidraw_mask_update` submask parameter edits; no further inference is needed. Combine regional submasks using `intersect` and review both the overlay and rendered photograph. A generation `region` argument is not used for surface maps; they analyse the full image before display rotation and crop.

Use normal save, undo/redo, named-version, sidecar and portable-bundle tools. Map payloads remain opaque assets in model-facing responses. Fetch schemas for the precise field contract and use a current native build with the matching MCP server.

## Request and preserve a map

Use an already oriented **RGB PNG, 64–1024 pixels per edge, at most 8 MiB**. Export the same full-frame geometry as the photo you intend to edit. Cropping or changing geometry afterward invalidates alignment; matching aspect ratios alone cannot prove alignment.

Set `CONNECTOR_URL` to your existing connector address. The example below uses the port from the connector setup guide; keep your configured port if it differs.

```sh
CONNECTOR_URL=http://127.0.0.1:5002
curl --fail "$CONNECTOR_URL/materials/capabilities"
curl --fail -F file=@analysis.png \
  "$CONNECTOR_URL/materials/normals" > normals-response.json
```

Use `/materials/albedo` for albedo. Each response includes `map_png_base64`, `cached`, and metadata containing map/source/model/workflow hashes, coordinate space and dimensions. Save the map without an 8-bit conversion:

```sh
python - <<'PY'
import base64, json
from pathlib import Path
data = json.loads(Path('normals-response.json').read_text())
with Path('normals.png').open('xb') as output:
    output.write(base64.b64decode(data['map_png_base64']))
PY
```

Keep the response metadata with its source and map. Maps are full-frame **RGB16 PNGs**. An exact source/workflow match can use the private cache even while Comfy is offline. Comfy files and connector state contain photo pixels; follow the [retention and access guidance](README.md#request-protocol-and-private-receipts).

## Render an optional CPU preview

From the `ai-connector` directory, install the preview dependencies in your Python environment:

```sh
python -m pip install -r requirements-surface.txt
```

The source must be an already oriented, rendered sRGB photo. The tool does not develop RAW files, apply ICC conversion or update RapidRAW sidecars. Maps can be smaller than the photo; normals are resized and renormalized. Output keeps the source dimensions, but the inferred boundaries remain limited by the analysis resolution. The output is an 8-bit PNG preview with a JSON parameter/hash receipt.

```sh
python -m rapidraw_connector.surface_tools normals \
  --source photo.png --map normals.png --output directional-preview.png \
  --angle 180 --amount 0.5

python -m rapidraw_connector.surface_tools albedo \
  --source photo.png --map albedo.png --output colour-preview.png \
  --point 0.45 0.8 --tolerance 0.10 --color 90 160 220 --amount 0.7 \
  --mask region.png --mask-output selection.png
```

`--angle` selects right (0°), up (90°), left (180°) or an intermediate direction. `--amount` is exposure stops for normals and a 0–1 blend for recolouring. `--point` is a normalized colour-pick position; `--tolerance` broadens the colour range. Optional `--mask` is a grayscale region mask at source dimensions: black protects pixels and white allows the edit. Existing output files are refused. Amount zero preserves source pixels exactly; black region-mask pixels remain exact.

Compare against a simple gradient or ordinary colour selection using identical framing, base exposure and working region. Inspect the whole photo and full-resolution boundaries before accepting a candidate. Do not treat a clean overview as proof of a clean mask.

## Measured experiment

Five rendered photographs covered a portrait, food, a flower, a street and fine feathers. Normals and albedo each completed on all five. On an RTX 5060 Ti with 16 GB VRAM and ComfyUI commit [`36da3ff763687eab86a35e1019995dd1fb369b0d`](https://github.com/Comfy-Org/ComfyUI/tree/36da3ff763687eab86a35e1019995dd1fb369b0d), the first request for each task took **14.1–14.9 seconds**; later requests took **4.5–5.4 seconds**. These timings are specific to this small test and include connector execution.

Comfy's process memory peaked at **7,482 MiB (7.31 GiB)** in 100 ms samples while a RapidRAW process held about 1,530 MiB. This is an observed peak, not a hard VRAM cap or an assurance for every scene/runtime. The sampler uses the same scoped CPU-offloading policy as depth; a 4 GB budget has not been qualified. See the [runtime pins and memory guidance](../docs/comfyui.md#vram-and-workflow-switching).

In offline CPU prototype comparisons, albedo produced a more consistent clothing selection across a shadow and a cleaner petal selection than the same chromaticity selector applied to the source. A full-resolution 6960×4640 portrait preview retained source texture; protected pixels and zero-amount output were exact. Similar-colour spill still needed a working-region mask. Normals gave useful control over face and tabletop shape and opposing building planes, with less benefit on fine feathers. These observations support optional tools, not automatic replacement of existing editing methods.

Native integration acceptance on 16 September 2026 verified both desktop map generators and viewers, a 6960×4640 PNG export, and a 16-bit TIFF with values beyond 8-bit precision. Saved-map renders matched after offline reopening and portable-bundle import. Zero strength and protected-region comparisons were exact; display rotation/crop remained aligned, and lens/perspective changes disabled stale maps. The checks below reproduce those contracts on your own photograph.

## Developer checks

```sh
python -m pip install -r requirements-dev.txt -r requirements-surface.txt
python -m unittest discover -s tests -v
```

Tests cover disabled/broken optional setup, the shared generation/depth/surface queue, RGB16 precision, offline cache use, task separation, protected pixels, normal coordinates, linear-light colour math and zero-amount identity. Native geometry, precision and optional-setting checks run with `cargo test --manifest-path src-tauri/Cargo.toml --features mcp marigold_surface`; frontend request-lifetime checks run with `npm test` from the repository root. For live acceptance, generate both maps, inspect a native render/export, save and reopen offline, and render an imported portable bundle. Include display rotation/crop, stale geometry, amount-zero and protected-region comparisons.

### Live native acceptance

Use a current native build and a photograph with a visible, nonblack colour at the chosen point. The test creates a fresh isolated workspace, sends analysis pixels to the configured connector, and preserves the source and its sidecar. Replace these placeholder values:

```sh
RAPIDRAW_BINARY=/path/to/rapidraw-mcp \
RAPIDRAW_TEST_IMAGE=/path/to/photo.jpg \
RAPIDRAW_CONNECTOR=127.0.0.1:5002 \
RAPIDRAW_WORKSPACE=/path/to/new-test-workspace \
RAPIDRAW_SURFACE_POINT='[0.45,0.8]' \
npm --prefix mcp run test:surfaces
```

Run from the repository root. Keep at least 20 GiB free. The [native acceptance script](../mcp/scripts/marigold-surfaces-e2e.mjs) checks disabled defaults, zero strength, regional protection, light direction, undo/redo, offline reopening, portable bundles, stale geometry, source hashes and a 16-bit TIFF. It records full-size PNG exports for visual and boundary inspection. A passing pixel test does not establish photographic quality for every image.
