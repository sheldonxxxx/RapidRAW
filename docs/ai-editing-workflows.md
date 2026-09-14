# Choose an AI editing workflow

Start with **Klein 4B at 1 MP** for ordinary object removal. Judge the photograph: more resolution, a larger model or sharper texture does not automatically improve an edit.

See the [test report](ai-editing-experiments.md) for what we tested and how the results led to these choices.

Workflow, AI resolution and seed controls require a [current build of this fork](desktop-guide.md#build-this-fork) and a configured [Comfy Connector](../ai-connector/README.md). Upstream application downloads do not include these controls.

## Choose an included profile

The bundled catalog contains four profiles. Install their required models and enable the entries you use:

| Profile                     | Use it for                                                                  | Default / supported AI resolution |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------- |
| **Klein 4B**                | First attempt for removal, creative recolouring and instruction edits       | 1 MP / 1 or 2 MP                  |
| **Klein 4B closer context** | Isolated subjects needing less context; retain useful landmarks             | 2 MP / 1 or 2 MP                  |
| **Klein 9B KV**             | A bounded alternative when Klein 4B struggles with an instruction           | 1 MP / 1 MP                       |
| **Boogu Edit Turbo**        | Another instruction-edit alternative, including adding or replacing objects | 1 MP / 1 MP                       |

Check the [model requirements and licenses](../ai-connector/README.md#requirements), especially for commercial use of Klein 9B KV.

## Remove objects and preserve structure

Select the complete object, including unwanted cords, supports and fragments. Keep neighbouring objects outside the selection. Describe the replacement surface and what must remain:

> Remove the small marker from the gravel path. Continue the surrounding gravel with matching grain, wear and illumination. Preserve the path edge and nearby plants.

For architecture and overlaps, check continuity beyond the erased object: a removal can omit a rear railing or break a beam.

> Remove the sign and its support. Continue the fence rails behind them in the same perspective. Preserve the posts, wall edges and remaining signs.

Compare closer context at 1 MP, retaining surrounding surface and structural connections. Thin wires and overlaps need careful masks; changing seeds cannot repair an incomplete selection.

## Recolour without losing texture

When folds, droplets, embroidery or veins must remain exact, try **masked photographic colour adjustments first**. Colour or luminance ranges can refine the selection; inspect for neighbouring colours and uneven coverage.

If adjustments cannot produce the colour cleanly, try Klein 4B:

> Change only the petals to warm yellow. Preserve their shape, veins, droplets and shading. Keep the leaves, stem and background colours unchanged.

Compare contours and texture as carefully as hue: generation can replace detail.

## Add or replace an object

Select room for the object and contact shadow. Specify scale, material, placement and lighting:

> Place a small blue ceramic bowl on the table, resting flat with a soft contact shadow matching the window light. Keep the table edge and surrounding objects unchanged.

Start with Klein 4B, then one alternative if needed. Check contact, perspective, reflections and recognisable parts.

Leave room for the **replacement's silhouette**, not just the original object's outline. A selection that closely follows a car can clip the wheels or shadow of a replacement motorcycle. Compare it with a modestly larger selection that includes the supporting surface. Keep nearby objects outside the mask when their exact appearance matters; naming them in the prompt cannot guarantee preservation.

Inspect the instruction separately from the finish. A convincing motorcycle can still face the wrong direction, and a complete bowl can still change nearby food. If a larger selection fixes clipping but the instruction remains wrong, refine the wording or compare another enabled workflow before increasing resolution.

## Change clothing, backgrounds or weather

For a clothing replacement, select the complete garment and allow room for the new collar, sleeves and hem. Protect the face, hair, exposed skin and accessories that should remain. Specify the new garment's cut, material and visible features. Check pose and anatomy as well as the outfit; generation can redraw embroidery, fabric folds or skin inside the selection.

For a background replacement, preserve the subject with a reviewed mask. Inspect hair, translucent edges and contact shadows against the new background. A whole-image selection gives the model more freedom to harmonise lighting, but also allows it to redraw the person and foreground. Use it only when that reconstruction fits the intended result.

Treat a sky change and a weather change differently. A sky selection can preserve buildings, branches and distant turbines, but cannot make the ground wet or remove sunlight elsewhere. A whole-scene weather edit must coordinate sky, illumination, shadows and reflections. Inspect signs, wires, vehicles and people for unintended changes; full-frame generation has no protected pixels outside the selection.

## Replace exact lettering

Specify exact wording, case, font family, weight and surface treatment: “Replace the lettering with ‘OPEN’ in a condensed sans-serif, matching the painted surface and perspective.” Verify spelling, spacing and font character.

**Qwen text and Z-Image workflows are research-only, not packaged connector profiles.** Correct wording still needs font-family and visual-integration checks. For mandatory typography, use a separately prepared text composite rather than relying on generative spelling.

## Compare, inspect and keep the chosen edit

Compare two or three variations with the same source, selection, prompt, workflow and resolution. Leave **Seed** empty for a new variation; enter a result's recorded seed to reuse it. No seed is universally better, and runtime or hardware changes can affect repeats. Shared defects call for selection or prompt changes.

For a mask-size comparison, keep the source, prompt, seed, profile and resolution fixed. The included connector derives context from the selection, so enlarging a mask can also change the crop and the object's effective generation resolution. Compare the recorded context dimensions before attributing the result to mask size alone.

Desktop regeneration replaces the selected patch. **MCP retouch adds a new patch**, including earlier visible AI patches in its source. For agent comparisons, save a pre-edit version and fork each alternative from that version, or restore it before the next attempt.

Inspect the overview and native-size boundaries for structure, grain, shadows and protected colours. Keep the chosen reversible patch and verify the export.

The connector generates a context crop, restores its original coordinates, and RapidRAW applies the full-resolution mask. The canvas stays unchanged; regenerated pixels are not recovered RAW detail. Conditioning uses the decoded original plus other visible AI patches, converted to sRGB for RAW. Ordinary tone, LUT and denoise adjustments are applied later.

One MP is a target area of 1024×1024 pixels, not an edge limit. Try **2 MP only as a matched comparison**. Check the panel's actual generated dimensions, placement dimensions and seed. **Included profiles do not run neural SR**; SR combinations remain research-only and can amplify invented texture.

Older connectors use their defaults without these controls. **Refresh workflows** after connector changes; replace unavailable saved profiles or explicitly use connector defaults. See [compatibility details](desktop-guide.md#generative-editing-controls).
