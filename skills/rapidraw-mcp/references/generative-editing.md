# Generative editing workflows

Use this reference for targeted generative retouch and its local fallback. Tool names omit the host's `rapidraw_` prefix.

## Editorial decisions and tool scope

Distraction removal is a core editing decision. During an editing task, inspect the photograph and decide what to remove, subdue, crop out, or retain to make the strongest image. The user does not need to identify distractions or approve cleanup separately. Use generative inpainting through the established editor connector when suitable; do not ask for object-by-object permission or repeat permission questions for refinements. Keep any permission rule for ChatGPT ImageGen whole-image creation or separate generated assets specific to those operations. Do not silently switch photographs to an unrelated provider.

Choose removals for their effect on attention, composition, and story. Consider whether an element contributes meaningful habitat, behaviour, interaction, or atmosphere before removing it; cleaner is not automatically stronger. Preserve the real subject, useful setting, and explicit keep instructions. Whole-image recreation, added subjects, and separate generated assets are different creative operations. Preserve originals and source resolution, and record reconstructed areas; full-size placement is not recovered captured detail.

## Discover the available workflow

Read the live retouch schema and `get_engine_settings`. Native `capabilities` describes the bridge; `models` describes local mask, inpaint and denoise assets. Neither lists remote generation profiles. For AI Connector, use the configured `aiConnectorAddress` (`host:port`) to read its HTTP `GET /capabilities`. Keep discovery on the configured provider; the desktop discovery command is not an MCP tool.

Current fork builds accept `generation_options` with `profile`, `megapixels` and `seed`. Use advertised profile IDs and resolutions. The included Comfy Connector advertises:

| Profile                | Use                                                                                 | Supported generation MP |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `klein4-v1`            | Starting point for general removal and creative replacement                         | 1, 2; default 1         |
| `klein4-tight2mp`      | Compare closer context for a small target when surrounding structure still fits     | 1, 2; default 2         |
| `klein9-kv`            | A bounded alternative when 4B misses the requested change                           | 1                       |
| `boogu-turbo4-context` | A different reconstruction alternative                                              | 1                       |
| `qwen21-v1`            | Image-guided editing with a literal text prompt                                     | 1, 2                    |
| `qwen21-remove-v1`     | Brush-selected removal with a connector-supplied general instruction; omit `prompt` | 1, 2                    |

Deployments can change this catalog. The package supports Klein, Boogu and Qwen Image 2.1 workflow families; arbitrary profile names do not add another architecture. Z-Image editing and neural super-resolution are not bundled profiles. `install_model` cannot install connector workflows.

For `qwen21-remove-v1`, omit the prompt. The connector supplies a general removal instruction while the brush mask limits final placement. Qwen does not receive the brush as a native inpainting mask and can still redraw the object, so inspect the complete repair and use a scene-specific prompt in `qwen21-v1` or another method if needed. The ordinary Qwen profile uses the prompt exactly as sent.

Explicit options require a capable AI Connector and fail before image upload if unsupported. Cloud and local inpaint do not accept them. Legacy operation is possible with options omitted only when using provider defaults matches the user's intent; do not silently drop requested settings. Report a missing profile or discovery failure before dependent generation.

## Route by the requested result

For distraction and object removal, prefer the established generative connector whenever suitable and available. Use local inpainting as a fallback when the connector is unavailable, unsuitable for the source or intended use, or its inspected result is worse. A tiny defect with a clean matching donor can be handled directly with clone/heal. Choose on rendered quality and subject fidelity, not merely speed or a successful tool response.

| Use case                                                  | First treatment                                                                                                 | Inspect before accepting                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Dust, tiny blemish, controllable texture repair           | Native clone/heal with a verified matching source                                                               | Repeated texture, sampling edge and lighting                        |
| Remove an object from a simple surface                    | Klein 4B at 1 MP, mask the object and unwanted shadow/reflection                                                | Complete removal, replacement texture, visible boundary             |
| Remove an object crossing rails, branches or architecture | Klein 4B at 1 MP with enough context to continue the structure                                                  | Line continuity, occluded landmarks, counts and perspective         |
| Change color while retaining exact shape and texture      | Native selective color adjustment; see [recolor guidance](advanced-editing.md#recolor-neutral-clothing)         | Selection spill, folds, texture and unchanged geometry              |
| Creative recoloring, adding or replacing content          | Klein 4B at 1 MP when reconstruction is intended                                                                | Shape, scale, contact shadows, material and protected surroundings  |
| Exact wording, lettering or logo                          | Establish the required spelling, font and layout; treat generation as a candidate, not typographic verification | Every character, spacing, font, perspective and surface integration |

Prompt the desired visible result and name important retained features. For example: “Remove the bag and its shadow; continue the paving and keep the railing and planter unchanged.” Preservation language helps express intent but does not guarantee fidelity. Klein's bundled graph ignores negative conditioning; put important requirements in the positive prompt. MCP retouch has no `negative_prompt` parameter.

For exact lettering, check whether a separately implemented text workflow is actually available. If it is absent, explain the limitation and distinguish an exploratory Klein candidate from a precise typesetting/compositing workflow. Correct spelling alone does not satisfy a font requirement.

## Select enough room for the requested change

For replacement, cover the original object and allow room for the new silhouette, support and contact shadow. A tight original-object mask can clip a correctly understood replacement. Compare a larger selection when the new geometry needs space, while explicitly subtracting faces, skin, accessories or nearby objects whose appearance must remain. Prompted preservation inside an editable region is a semantic request, not a pixel guarantee.

For clothing, inspect collar, sleeve and hem transitions plus pose, skin and retained embroidery. For backgrounds, review subject and hair boundaries before generation; whole-frame selection permits identity and foreground reconstruction. For weather, distinguish sky-only changes from scene-wide changes to illumination, shadows, wet surfaces and reflections. A full-frame selection has no outside-mask preservation test; inspect structural and semantic fidelity instead.

Separate instruction success from integration quality. Correct object category does not establish orientation, count, scale or pose. Inspect retained content inside an expanded mask, not only unselected pixels. When comparing mask sizes, fix source, prompt, seed, profile and MP, and record actual context geometry: production context is mask-derived, so the crop and effective target resolution can also change. MCP has no explicit context-box option. Do not describe a fixed-crop research comparison as identical to production retouch.

## Native removal coverage and protection

Check that the live retouch schema exposes `removal_options` and `preview_only` before using this workflow; older native builds require an update.

`retouch` in `inpaint` or `generative` mode accepts optional `removal_options`:
`{"expandPixels": 12, "featherPixels": 24}`. Each value is an integer from 0 to 256 in source pixels. Omitted options or two zero values preserve the existing brush mask exactly. Choose values from the photograph and defect; these example values are not a universal preset.

With nonzero controls, additive components define the target. Pixels with at least 50% alpha form a fully replaced core. Expansion grows that core, and the blend width adds a smooth outward transition without weakening the core. Existing softer alpha is retained where stronger. Subtractive components and intersections constrain the final mask after expansion, regardless of component order; use them to protect retained subject or structure. Inverted containers are rejected with nonzero controls. Existing component coordinates follow the normal oriented, uncropped mask contract; pixel widths are applied after conversion to source coordinates.

First call `retouch` with the intended mode, `sub_masks`, `removal_options`, and `preview_only: true`. This returns the effective mask, bounds, and current session revision without generation, model downloads, or a saved edit. A prompt and configured provider are not required for this preview. Inspect it against the source, adjust coverage/protection, then submit the same selection with `preview_only` omitted and the current revision. Preview images may be reduced to 1200 pixels; use returned source dimensions and bounds when assessing scale. Generation returns the effective mask preview and persists the options with the patch. Desktop removal controls use the same native calculation and provide a mask preview.

Keep candidate generation on independent forks of the same saved source version. Diagnose remaining failures separately: revise coverage for remnants; retry generation for missing or malformed retained structure; use native healing or a verified texture donor for sound content with mismatched texture. Do not apply experimental wire fitting, mixed-gradient blending, or unconditional smoothing as general removal defaults. Native mask controls do not automatically identify the object, select a donor, or guarantee photographic quality.

## Generate and compare without compounding edits

1. Save the intended pre-edit state with `save_version`. For a new refinement, such as changing only a sign's font, start from the accepted edit. For alternatives to an earlier removal, start from the version before that removal. Retain the accepted result separately. Read [portable sessions](portable-and-workers.md) for independent alternatives.
2. Prepare native `sub_masks` using the live schema and [coordinate guidance](advanced-editing.md#coordinates-and-masks). A rectangle or existing mask ID alone is not a retouch selection. If selection is uncertain, inspect an ordinary adjustment mask with matching geometry before generating. The returned AI `patch_id` is not an adjustment `mask_id`; mask tools and `render_compare(disabled_masks)` do not toggle AI patches.
3. Generate one candidate using current session/revision and the selected options. Inspect its returned mask preview, overview and matching native-detail regions. Check protected features as well as the repaired area.
4. If needed, compare a small set of explicit seeds with source, mask, prompt, profile and resolution fixed. MCP `retouch` appends a patch and conditions on earlier visible patches. Fork each alternative from the same pre-edit `version_id`, or deliberately restore that version before another call. Desktop regeneration of the same patch differs; MCP exposes no equivalent replacement operation.
5. Change context or generation resolution only to address a visible defect. Compare 2 MP against the accepted 1 MP reference; closer context can improve target scale while losing scene clues. Try another available profile when its different reconstruction may help. Retain the strongest candidate rather than escalating model size automatically.

Seeds are integers from 1 through 9007199254740991. Omission requests a new random seed. Record actual `generation` receipts, including seed, profile, generated dimensions, source dimensions and context; `generationOptions` contains requested settings only. A seed selected for one photo is not a universal preset, and reproducibility also depends on inputs, model and runtime.

## Local inpaint fallback

Local reconstruction needs particular care near an overlapping subject, feathers, fur, thin perches, and other continuous edges. A plausible overview can hide a damaged boundary.

1. Start from the saved state before the failed removal when the reconstructed content or subject boundary is damaged. If the reconstruction is sound and only its integration fails, preserve that reference and follow the targeted integration method below. Cover the complete distraction, including its blur, shadow, or reflection where removal calls for it. Inspect the actual mask and protect retained subject detail and foreground structure; an AI selection can mistakenly include a background branch or miss a wing edge.
2. Inspect the result at intended viewing size and in matched native-resolution crops covering the repaired area and every subject or structural boundary it touches. Check for residual silhouettes, smeared or repeated texture, flat patches, inconsistent blur/noise, tonal seams, halos, and lost or reshaped feathers, fur, beaks, feet, or perches. Compare against the source, not only the preceding failed repair.
3. If the fallback fails those checks, restore the better reference and refine the mask or use a verified clone/heal donor. Do not hide damage with stronger grading, sharpening, or a smaller preview. If no clean repair is achievable, retain the sound version and identify the unresolved removal; do not present the weak repair as finished.

Record the actual method and inspected regions with the saved candidate. Neither local processing nor generative processing establishes visual quality or user acceptance by itself.

## Integrate a convincing repair

Diagnose content, colour, texture and boundaries separately. Removing the object is only the first requirement: a smooth generated patch, a repeated clone pattern or a visible brush outline can still spoil the photograph.

Combine native methods when each addresses a specific remaining defect. A verified clone donor can restore real surface texture; healing can reconcile local illumination; a reshaped, feathered mask can blend the transition while excluding the subject. Keep a convincing core when refining its joins, but restart from the clean reference if the core contains residual objects, invented structure or damaged subject detail. Do not stack full removal attempts indiscriminately.

Recheck protection masks after an object removal. A previous subject selection can still include the removed branch or object, leaving an untreated smooth strip through later texture repairs. Inspect the actual combined repair coverage, not only the foreground outline. Regenerate with corrective points or build a precise manual exclusion when an AI mask includes empty background; inspect the new mask before trusting it.

Choose donor material with compatible surface, focus, grain and lighting. Inspect the entire sampled footprint for objects and repetition. For a visible patch outline, extend and reshape the blend beyond the old boundary rather than tracing it with another narrow stroke. Protect nearby feathers, fur and perches explicitly. Excessive feathering can attenuate grain or spread contamination, so wider is not automatically better.

When only fine texture is wrong, check whether the live heal-submask schema exposes `textureOnly`. If supported, `retouch(mode: "heal")` with `parameters.textureOnly: true` transfers fine donor detail while retaining the destination's broad colour and light. `textureRadius` controls the Gaussian separation scale (sigma) in source pixels (1–32; default 8). A visible heal submask enables this treatment for the entire combined patch, including other selected regions; all visible texture-only submasks must specify the same separation scale and tiling settings. Hidden submasks do not enable it. Use this only on already clean content; it does not remove residual objects or repair geometry. Start from the best clean reference, protect subject edges and inspect the donor for fine structures that could be copied. Inspect for smoothing, repeated grain and edge halos. For a small verified donor area, an exposed `textureTileSize` option (64–2048 source pixels) repeats only its reflected fine detail around `source_point`. Use it only for random fine texture such as camera grain, inspect the entire square donor plus filter margin, and reject visible repeated structures. The normal full-footprint donor mapping applies when this option is omitted. Ordinary healing remains the default. Do not emulate this option with a grid of small healing stamps: repeated transitions can create mottling.

Check the live coordinate contract. In bridge 1.2.0, clone/heal `source_point` aligns with the bounding-box centre of the inverse-transformed cleanup mask, not the first brush point. Changing mask bounds therefore changes the donor displacement unless the source point is adjusted. Returned rendered bounds can be clipped by a crop or detail region: inspect a view containing the entire mask and account for the crop offset. With rotation, lens or perspective transforms, verify mapped source-space placement rather than assuming the rendered box centre is the sampling anchor. Inspect matching overlay and grayscale views before a difficult repair.

Inspect the complete repair and each join separately at native resolution, with untouched context on both sides, then revisit the whole photograph. Compare against both the clean source and the qualities retained from the previous candidate. Grain measurements can support this review but cannot establish an invisible seam. Keep grading, crop and denoise fixed while diagnosing integration; do not disguise the defect with global changes. Record the method, donor geometry, protected boundaries and inspected regions with the saved edit. Keep exact per-photo settings in the private recipe rather than treating one successful mask as a preset.

## High-resolution placement and recovery

Generation MP describes context area: 1 MP targets approximately 1024 × 1024 pixels, with dimensions adjusted for aspect ratio and model alignment. It is not a fixed 1024-pixel edge limit. The connector restores that crop to native placement dimensions; RapidRAW applies the original mask alpha once. Full-size export preserves canvas dimensions but does not recover captured RAW detail inside generated pixels.

Conditioning uses the decoded source plus visible prior AI patches, with RAW converted to sRGB for transmission. Ordinary exposure, LUT and noise-reduction adjustments are not baked into that input. Do not prescribe a grading change as a way to change model conditioning or hand-edit stored patches. Judge the result through the final native grade.

Keep neural upscaling off by default. If the user requests enlargement or a detail experiment, verify a separate supported workflow and compare it against ordinary restoration at identical final dimensions. Inspect invented texture, halos, lettering, grain and seams; extra sharpness is not recovered source detail. The included connector has no neural-upscale switch. For original-size export, omit both `long_edge` and `resize`.

Generative retouch is synchronous and is not supported by `start_operation`/`resume_job`. An ambiguous timeout can leave Comfy processing active. Inspect session state and available connector receipt/history before another attempt; do not replay the mutation blindly or cancel unrelated queue work. Preserve the selected session, saved version, actual settings and review provenance using [feedback comparisons](review-and-jobs.md#revise-from-user-feedback).
