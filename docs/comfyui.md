# ComfyUI with RapidRAW

Run generative photo edits and optional Marigold depth, directional light and colour masks on your own GPU server. RapidRAW uses **one AI connector address and one ComfyUI instance**, with explicit workflow choices and saved results that remain editable.

**Start here:** [Install the connector](../ai-connector/README.md#start-the-connector) · [Choose an editing profile](ai-editing-workflows.md) · [Enable Marigold depth](../ai-connector/MARIGOLD.md) · [Download chosen workflows](../ai-connector/workflows/README.md)

These fork features require a [current source build](desktop-guide.md#build-this-fork). Installing workflows in ComfyUI does not add them to RapidRAW's profile selector. Model weights are separate downloads with their own terms.

## What is available

| Capability                                              | Integration                                                    | Starting choice                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Removal, recolouring, replacement and instruction edits | Desktop AI panel and MCP generative retouch                    | Klein 4B, 1 MP                                                                                 |
| Alternative generative profiles                         | Same connector and selector                                    | Closer-context Klein 4B, Klein 9B KV, Boogu Turbo or Qwen Image 2.1 for a specific failed edit |
| Marigold depth masks                                    | Optional desktop/MCP provider, disabled by default             | Q4 shared-GPU profile                                                                          |
| Saved depth visualization                               | Desktop depth-component properties, built-in and Marigold maps | Visualize depth; no new inference                                                              |

Configuring the AI connector does not remove local depth. Enable **Depth Selection** separately, then choose **Add New Mask → Depth Selection**. Existing components also offer **Analyse depth**. See the [depth guide](../ai-connector/MARIGOLD.md#use-it) for setup, MCP arguments and saved-map behavior.

Enable **Shape Light and Surface Colour** separately for [normals dodge/burn and albedo colour masks](../ai-connector/SURFACES.md#use-in-rapidraw). They reuse this connector and ComfyUI, with saved RGB16 maps, desktop/MCP controls and native exports.

## Tested versions

These are reproducibility pins, not a claim that all workflows were tested on every later ComfyUI release.

| Test scope                                                                                                                           | ComfyUI commit                                                                                                                                             | Date                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Generative profile, alternative inpainting and super-resolution evaluation                                                           | [`c75d8c966c29cb0392259af791f43373315b72db`](https://github.com/Comfy-Org/ComfyUI/tree/c75d8c966c29cb0392259af791f43373315b72db) — reported version 0.35.0 | 13–14 September 2026 |
| Marigold INT8/Q4, export, offloading and depth-mask integration                                                                      | [`36da3ff763687eab86a35e1019995dd1fb369b0d`](https://github.com/Comfy-Org/ComfyUI/tree/36da3ff763687eab86a35e1019995dd1fb369b0d)                           | 15 September 2026    |
| Shared-server regression: fixed-seed generative edit before/after depth, concurrent connector requests and RapidRAW CUDA coexistence | Same `36da3ff76368` revision                                                                                                                               | 15 September 2026    |
| Normals/albedo Q4 maps, desktop controls, native rendering, offline persistence and portable sessions                                | Same `36da3ff76368` revision                                                                                                                               | 16 September 2026    |

The shared-server regression does not requalify every generative profile on the newer revision. The [catalog](../ai-connector/workflows/catalog.json) identifies the tested revision for each chosen workflow.

**Measured hardware/runtime:** Linux, NVIDIA RTX 5060 Ti, 16,311 MiB reported VRAM, driver 595.58.03 and PyTorch 2.12.0+cu130. The Marigold environment used comfy-kitchen 0.2.34, comfy-aimdo 0.5.3, frontend 1.52.7 and workflow templates 0.11.60. The CUDA suffix describes the PyTorch build; it is separate from RapidRAW's ONNX runtime.

The Klein and Boogu generative profiles use native ComfyUI nodes. Qwen Image 2.1 additionally requires `TextEncodeQwenImage21` and `QwenImage21Cache` (see its [model and node requirements](../ai-connector/README.md#qwen-image-21)). Marigold additionally requires [ComfyUI-GGUF at `6ea2651e7df66d7585f6ffee804b20e92fb38b8a`](https://github.com/city96/ComfyUI-GGUF/tree/6ea2651e7df66d7585f6ffee804b20e92fb38b8a) and the [bundled optional sampler](../ai-connector/comfy-nodes/rapidraw_marigold/__init__.py). Marigold task weights were verified from Comfy-Org/marigold-v2-0 revision `70e2127d026c8f6b62d8049b73f5392e1e81ebfa`, and the Q4 backbone from QuantStack/Qwen-Image-Edit-2509-GGUF revision `84a3006979126011422eeeefe0c9485ddf431ef5`. Exact filenames, SHA-256 values and source links are in the [model manifest](../ai-connector/workflows/models.json).

For reproducible validation, record `git rev-parse HEAD` in ComfyUI and each required custom-node checkout, plus installed package versions. Install the requirements matching that revision in its own Python environment. Before updating an existing server, preserve its configuration and workflow files; after updating, repeat the acceptance checks below.

## One connector, one ComfyUI

Follow the [connector installation guide](../ai-connector/README.md) for model locations, Python requirements and startup commands. The connector runs on the ComfyUI host, under the same operating-system user, because it writes inference inputs into ComfyUI's input directory.

| Setting                           | Purpose                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `COMFY_ROOT`                      | Existing ComfyUI directory                                            |
| `COMFY_URL`                       | Existing ComfyUI API, default `http://127.0.0.1:8188`                 |
| `PROFILE_DIR`                     | Enabled generative profile catalog and configurations                 |
| `STATE_DIR`                       | Private generation receipts, outside source control                   |
| `MARIGOLD_DEPTH_CONFIG`           | Optional depth configuration; omit to leave depth routes disabled     |
| `MARIGOLD_MATERIALS_CONFIG`       | Optional normals/albedo configuration; omit to disable surface routes |
| RapidRAW `marigoldSurfaceEnabled` | Explicit opt-in to new normals/albedo requests                        |
| RapidRAW `aiConnectorAddress`     | The same connector address for generation, depth, normals and albedo  |
| RapidRAW `marigoldDepthEnabled`   | Explicit opt-in to new Marigold requests                              |

Run one connector worker. Its generation, depth, normals and albedo jobs share a lock. On a workflow change, it checks ComfyUI's queue, unloads the previous models and waits briefly before submitting the new graph. It does not interrupt work submitted directly by other Comfy clients. A busy external queue can temporarily prevent switching; wait for it to finish before retrying.

`/materials/capabilities` reports optional normals and albedo readiness. The health endpoint checks connectivity; `/capabilities` advertises generative profiles. `/depth/capabilities` separately checks Marigold nodes, compatible memory settings and pinned model files. An invalid optional Marigold setup leaves generation endpoints available.

The connector has no authentication or TLS. Keep its loopback binding and use the [SSH tunnel example](../ai-connector/README.md#start-the-connector) for another computer. Receipts, Comfy input/output and history contain photo pixels and prompts; the [retention guidance](../ai-connector/README.md#request-protocol-and-private-receipts) explains their locations and safe cleanup conditions.

## Workflow and model inventory

The repository includes eleven chosen connector workflows:

| Workflow                  | Public graph                                                                                                 | Runtime configuration                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Klein 4B                  | [API example](../ai-connector/workflows/klein4-v1.api.json)                                                  | [1 MP default, 1 or 2 MP](../ai-connector/profiles/configs/klein4-v1.json)                 |
| Klein 4B closer context   | [API example](../ai-connector/workflows/klein4-tight2mp.api.json)                                            | [2 MP default, 1 or 2 MP](../ai-connector/profiles/configs/klein4-tight2mp.json)           |
| Klein 9B KV               | [API example](../ai-connector/workflows/klein9-kv.api.json)                                                  | [1 MP](../ai-connector/profiles/configs/klein9-kv.json)                                    |
| Boogu Edit Turbo          | [API example](../ai-connector/workflows/boogu-turbo4-context.api.json)                                       | [1 MP](../ai-connector/profiles/configs/boogu-turbo4-context.json)                         |
| Klein 4B native edit      | Runtime graph builder only; no standalone API example                                                        | [Experimental, 1 or 2 MP](../ai-connector/profiles/configs/klein4-native-v1.json)          |
| Qwen Image 2.1            | Runtime graph builder only; no standalone API example                                                        | [1 or 2 MP](../ai-connector/profiles/configs/qwen21-v1.json)                               |
| Qwen Image 2.1 Remove     | Runtime graph builder only; no standalone API example                                                        | [Removal, 1 or 2 MP](../ai-connector/profiles/configs/qwen21-remove-v1.json)               |
| Qwen remove PE            | Runtime graph builder only; no standalone API example                                                        | [Prompt-enhanced removal, 1 MP](../ai-connector/profiles/configs/qwen21-remove-pe-v1.json) |
| Marigold V2 Q4 shared GPU | [Actual connector template](../ai-connector/rapidraw_connector/depth_profiles/marigold-v2-q4.json)           | [Optional depth setup](../ai-connector/MARIGOLD.md)                                        |
| Marigold V2 normals Q4    | [Actual connector template](../ai-connector/rapidraw_connector/surface_profiles/marigold-v2-normals-q4.json) | [Optional surface setup](../ai-connector/SURFACES.md)                                      |
| Marigold V2 albedo Q4     | [Actual connector template](../ai-connector/rapidraw_connector/surface_profiles/marigold-v2-albedo-q4.json)  | [Optional surface setup](../ai-connector/SURFACES.md)                                      |

The [download guide](../ai-connector/workflows/README.md) explains API format, input/mask conventions and the difference between a standalone crop output and RapidRAW's native composite. The four Klein and Boogu generative examples are exported from the tested runtime graph builder with neutral input names, a replacement prompt and example geometry. The native-edit and Qwen profiles are runtime-builder-only. The Marigold link points directly to the template used by the connector.

Graphs include the model filenames; the [model manifest](../ai-connector/workflows/models.json) supplies recorded download provenance and checksum information. The [connector model table](../ai-connector/README.md#requirements) and [Marigold model table](../ai-connector/MARIGOLD.md#set-up-the-existing-server) give the supported setup paths. Download only assets needed by the workflows you select. RapidRAW's license does not replace upstream code/model licenses.

## VRAM and workflow switching

The integrated Marigold Q4 profile uses batch one, one step and about 0.70 million analysis pixels. Its optional sampler targets roughly **7 GiB of workload capacity through CPU offloading**, with the memory override scoped to Marigold sampling and restored after success or failure. Other samplers keep their normal settings. Use normal or low-VRAM Comfy operation; `--highvram`, `--gpu-only` and `--disable-smart-memory` conflict with this profile.

| Measured workload on the 16 GB test GPU | Observation                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Integrated Marigold depth masks         | Comfy process peak 7,384 MiB (7.21 GiB)                                                                                      |
| Normals/albedo five-scene map batch     | Comfy process peak 7,482 MiB (7.31 GiB); RapidRAW remained resident at about 1,530 MiB                                       |
| Later six-scene lens-blur comparison    | Comfy process peak 7,290 MiB (7.12 GiB)                                                                                      |
| Actual RapidRAW CUDA coexistence check  | Four renders completed while depth ran; sampled allocations during depth were 3,386 MiB for Comfy and 4,484 MiB for RapidRAW |

These sampled measurements are not hard allocation caps. Resolution, aspect ratio, cache state, other applications and model changes affect memory and time. Offloading also needs substantial host RAM.

**Use the scoped profile for a shared server.** Avoid adding a global `--reserve-vram` setting solely for Marigold: it would affect generative workflows as well.

**A 4 GiB limit is not currently exposed in RapidRAW or the connector.** A lower budget needs a separate sampler/profile change and new measurements: test uncached inference, record process/device peaks, compare output quality, then switch back to fixed-seed generative editing and test alongside RapidRAW. Comfy's reservation/offload mechanism alone does not enforce a hard 4 GiB ceiling. Reducing analysis resolution may change fine boundaries and also needs visual comparison.

## What the quality tests support

The [generative study](ai-editing-experiments.md) supports Klein 4B at 1 MP as the practical first attempt. Larger models and neural upscaling did not reliably improve final native-detail integration. Inspect the final patch and original selection boundary; generation size is separate from export canvas size.

Marigold Q4 retained useful feather, fur and scene-layer detail in six tested scenes. Fine fur could still become serrated, and relative depth can carry texture/shading patterns. Offloading reproduced the compared Q4 depth arrays exactly; it did not improve their boundaries. The integrated fixed-seed generative regression produced identical output pixels before and after depth, and concurrent requests serialized successfully.

**Lens blur remains an experiment.** Six 1024-pixel scenes and two 32.3 MP exports were compared using the existing native lens-blur renderer. Marigold sometimes retained finer feather/fur edges and improved scene separation; several whole-frame differences were small. Narrow focus bands or strong blur could still create halos or soften a subject/perch. There was no human portrait/hair test or calibrated ground truth.

Built-in CPU depth took 0.88–1.11 seconds on the six 1024-pixel inputs; four fresh Marigold requests took 4.76–8.38 seconds. Cache hits are excluded from those Marigold numbers. With maps already available, full-size PNG export took about 4.2 seconds with either map. These observations support an optional future quality mode; they do not establish a reason to replace the default or imply an implemented Marigold lens-blur selector.

## Acceptance checks after setup or upgrade

1. Run the connector's [CPU contract tests](../ai-connector/README.md#cpu-tests). They validate request handling and graph construction without downloading weights or exercising a GPU.
2. Check connectivity, the enabled profile catalog and optional depth capabilities. Generate with each profile you intend to offer; model/node presence alone does not verify execution.
3. Save a fixed-seed generative result, run a fresh Marigold request, then repeat the identical generative request. Inspect native boundaries and compare returned RGB, mask and placement.
4. Submit depth and generation through the same connector. Verify serialization, switch behavior and failure recovery without interrupting unrelated Comfy jobs.
5. Sample process and total-device VRAM while RapidRAW is active. Report cold model loads, fresh inference and cached completions separately; Comfy can return a fully cached graph without inference.
6. Save/reopen a depth, normals or albedo mask with the connector unavailable. Inspect rotation, flips and crop, range changes, the saved-map viewer and a portable-bundle render. Regenerate Marigold after changing lens distortion or perspective.

Keep test images, raw receipts and GPU traces in your own workspace. Public graph templates contain replacement input names and prompts, so new photographs require their own visual acceptance.
