# Chosen ComfyUI workflows

These are the five workflows offered by the RapidRAW connector. Use [connector setup](../README.md) for ordinary editing; RapidRAW then prepares source pixels, computes context, uploads the selection and applies the returned crop at its original coordinates.

| Workflow                  | Download                                                                       | Choice in RapidRAW                                |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Klein 4B                  | [API JSON](klein4-v1.api.json)                                                 | Generative profile; 1 MP default, 1 or 2 MP       |
| Klein 4B closer context   | [API JSON](klein4-tight2mp.api.json)                                           | Generative profile; 2 MP default, 1 or 2 MP       |
| Klein 9B KV               | [API JSON](klein9-kv.api.json)                                                 | Generative profile; 1 MP                          |
| Boogu Edit Turbo          | [API JSON](boogu-turbo4-context.api.json)                                      | Generative profile; 1 MP                          |
| Marigold V2 Q4 shared GPU | [Connector template](../rapidraw_connector/depth_profiles/marigold-v2-q4.json) | Optional Marigold Depth mask; fixed 0.67 Comfy MP |

The four generative examples come from the connector's [runtime graph builder](../rapidraw_connector/workflows.py), using its [profile configurations](../profiles/profiles.json). The depth link is the actual runtime template, so there is no separate copy to drift from the connector.

## Tested versions and dependencies

Generative workflows were evaluated on ComfyUI commit `c75d8c966c29cb0392259af791f43373315b72db`. Marigold and the subsequent shared-server regression used `36da3ff763687eab86a35e1019995dd1fb369b0d`. See the [ComfyUI guide](../../docs/comfyui.md#tested-versions) for exact dependency revisions and acceptance scope.

- Generative profiles need native ComfyUI nodes and the weights listed in [model requirements](../README.md#requirements).
- Marigold needs native Marigold V2 nodes, `SaveImageAdvanced`, ComfyUI-GGUF and the [optional scoped sampler](../comfy-nodes/rapidraw_marigold/__init__.py). Follow [Marigold setup](../MARIGOLD.md#set-up-the-existing-server).
- [catalog.json](catalog.json) records each graph's SHA-256, required node classes, model filenames and tested Comfy revision. [models.json](models.json) contains recorded model download revisions and checksums. Weights are not included; check each model's license.

## Use an API example directly

These files use **ComfyUI API prompt format**, not the UI canvas format. Submit a prepared graph to ComfyUI's `/prompt` endpoint, or let the connector build and submit it for you. Downloading a graph does not configure a RapidRAW profile.

For a standalone generative example:

1. Provide `source.png` and `selection.png` in ComfyUI's input directory, or replace both `LoadImage.image` values with your uploaded filenames. The example canvas is 1024 × 1024. `selection.png` must be RGBA: **alpha 255 selects the edit and alpha 0 protects the source**. RGB colour is irrelevant. The graph deliberately inverts Comfy's `LoadImage` mask output to recover that selection support.
2. Replace the placeholder text in `CLIPTextEncode` or `TextEncodeBooguEdit`. Preserve intended negative conditioning: the Klein graphs zero it; Boogu receives a separate negative prompt.
3. If your input has other dimensions, change the paired source/mask `ImageCrop` bounds together. Keep `ImageScale`, latent dimensions and scheduler dimensions consistent with the generation size. Dimensions should be divisible by 16; the production connector computes these values from the selection and advertised MP budget.
4. Keep an explicit seed for comparisons. Submit `{"prompt": GRAPH_OBJECT}` as JSON to `/prompt`; read the returned `prompt_id`, wait for `/history/<prompt_id>`, then retrieve output with `/view`. The generative output node is `99`.

The example geometry and prompt are replacements, not the original test photographs. The graphs retain tested model/sampling settings; a new source and prompt still need execution and visual review on your installation.

The graph returns **unblended generated RGB for the context crop**. Standalone output is not a finished masked photo: restore it to the native context size, place it at the captured coordinates and apply the original full-resolution selection alpha once. The RapidRAW connector and engine already perform this contract; use that path for normal editing.

## Marigold template

The connector replaces `SOURCE` with its prepared full-frame input and `RESULT` with a unique output prefix. For direct API use, supply a Comfy input filename and unique prefix yourself. The output node is `16`, saving a 16-bit PNG with nearer regions brighter. Keep `img_to_img_velocity`, shift 1.73, Euler, sigmas `0.5, 0`, disabled noise and LoRA strength 1.0.

Install the scoped sampler before submission. It applies its memory policy during Marigold sampling; no second ComfyUI process or global reservation flag is needed. The connector additionally handles caching, checksum validation, job serialization and workflow switching. Direct API submissions bypass those connector protections and should wait for the shared queue to be idle.

Depth is relative log depth, not metres or an alpha matte. Inspect boundaries and ranges through the editor's **Visualize depth** function and rendered mask overlays. The current optional feature supplies depth masks; it does not add a Marigold lens-blur selector.
