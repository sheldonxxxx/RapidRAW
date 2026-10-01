# Craft moves in RapidRAW

How to carry out the light-shaping moves a direction skill (such as Lightweft's `photo-edit-master`) asks for. The numbers are starting points in RapidRAW's native units (exposure in EV; most other sliders −100 to 100). Judge every result on the rendered pixels.

## Recommended order

1. **Denoise first** when the file is noisy (for example ISO ≥ 1600 on APS-C at dusk): `start_denoise` with `method: "nonlocal"`, then continue in the returned `result_session_id`. Use `intensity: 100` for smooth backgrounds and action. For feather, fur and skin close-ups, compare `intensity: 50–70`, or add fine grain afterwards (`grainAmount` 5–10, `grainSize` 10–20) so the texture doesn't look waxy.
2. **Geometry and base in one merge:** `set_adjustments` with `crop` (`unit: "px"`, full-resolution pixels after rotation), `aspectRatio`, `rotation`, then `temperature`, `tint`, `contrast`, `highlights`, `whites`, `blacks`, `vibrance`, and the vignette fields.
3. **Subject/environment pair:**
   ```json
   {"tool":"mask_generate","arguments":{"session_id":"…","expected_revision":1,"kind":"subject","name":"Subject",
     "region":{"x":…,"y":…,"width":…,"height":…},
     "adjustments":{"exposure":0.35,"shadows":15,"clarity":10,"structure":10,"temperature":6}}}
   {"tool":"mask_duplicate","arguments":{"session_id":"…","expected_revision":2,"mask_id":"SUBJECT_MASK_ID","name":"Environment","invert":true,"link":true}}
   {"tool":"mask_update","arguments":{"session_id":"…","expected_revision":3,"mask_id":"ENV_MASK_ID",
     "patch":{"adjustments":{"exposure":-0.5,"saturation":-20,"clarity":-15,"temperature":-6}}}}
   ```
   Choose how to select the subject first (see [Choosing the subject selection](#choosing-the-subject-selection)); the AI subject above is the quickest starting point. Render the subject mask (`render(mask_id, mask_mode: "grayscale")`) before duplicating it. If it misses high-contrast parts (white patches on dark plumage, beak, eye, prey), refine it with `mask_generate(kind: "subject", refine: {mask_id}, include_points: [...])` in pre-crop coordinates, or pass `coordinate_space` to give the points in the preview you inspected. With `link: true` the environment mask follows every later change to the subject selection (refinement, brushes, grow/feather); an unlinked duplicate doesn't, so after refining it you would have to remove and duplicate it again.
   `mask_generate` accepts `adjustments` directly. `region` is in pre-crop full-resolution pixels and should box the whole animal, including anything it's holding. `mask_duplicate` clears the copy's adjustments by default, so set them with `mask_update`.
4. **Burns and dodges:** `mask_create` with `type: "linear"` for sky, foreground or bright strips (the start→end line is the boundary; left→right selects above it). Use `type: "radial"` with `feather` 0.7–0.9 for an eye dodge or corner burns.
5. **Vignette:** `vignetteAmount` −15 to −35, `vignetteMidpoint` 30–50, `vignetteFeather` 50–80. It applies to the cropped frame.
6. **Finish:** `sharpness` 15–30 globally at most; subject detail via `structure` or `clarity` inside the subject mask.

## Choosing the subject selection

A Marigold depth band follows the real silhouette better than the AI subject: it leaves openings (an open beak, the space between legs or wing feathers) out of the subject, where the AI subject fills them. The band covers everything nearer than its threshold, though, so pick the combination by what else sits at the subject's depth.

| Scene                                                                                              | Selection                              | How                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subject clear of everything else in depth: a close portrait or a bird against distant water or sky | Marigold band, edge refined by matting | `mask_generate` with `kind: "depth"`, `depth_provider: "marigold"`, `parameters: {minDepth, maxDepth: 100, minFade: 5, maxFade: 0}`, then `enhance` with `request: {operation: "refine_mask", profile: "quality", boundary_radius: 24}` on the depth submask |
| Water, ice, a perch, splash or foreground at the subject's depth or nearer                         | Marigold band ∩ AI subject             | AI subject mask first, then the same depth `mask_generate` with `target_mask_id` set to it and `mode: "intersect"`                                                                                                                                           |

- **Threshold:** render the depth mask at a few `minDepth` values (for example 35–85 in steps of 10) and keep the one that best fits the subject's outline. Depth is relative to each photograph, so don't reuse a value between photographs.
- **Check extremities:** a tail, wingtip or far leg can fall outside the band. The intersection also inherits anything the AI subject misses. Compare with the AI subject mask and add missed parts back with `include_points` or a brush.
- **Check the edge at 100%:** a band edge can show a fine sawtooth along high-contrast outlines; matting reduces it but doesn't always remove it. Keep the environment adjustment moderate there, or soften it with the `grow`/`feather` approach under [Halos and edges](#halos-and-edges).

## Gaps inside the subject

AI subject masks fill small openings; a Marigold selection usually avoids this. With an AI subject selection, background seen through an open beak, between legs or between wing feathers is treated as subject and lifted, while the background around it is darkened. Don't hand-paint the gap with scanline or single brush strokes; they leave staircase edges or bars. Create a small correction parent instead: a generous `brush` over the opening, then a `color` submask in `intersect` mode sampled on the background inside the gap (`tolerance` 12–20, `feather` 10–20). Give it roughly the environment adjustment minus the subject adjustment, then match the gap's brightness to the nearby open background (`inspect_edit` should no longer list the gap). Check that the colour sample isn't on the subject (an orange beak, a pale fish), or the intersect will select the subject instead.

Masks can also end at a strong highlight inside the subject, such as the pale edge of a mandible, leaving the part beyond it in the environment mask. `inspect_edit` reports this as similar pixels treated differently. Refine the subject with `include_points` on the missed part; a linked environment mask follows automatically.

## Halos and edges

A strong environment darkening next to a soft subject mask can leave a pale rim hugging the subject. Check with `render(region)` at 100% along the subject's edge, and with `render(mask_id, mask_mode: "overlay")`.

- Keep the environment exposure moderate (−0.3 to −0.6) and add depth with a gradient or vignette rather than one heavy inverse mask.
- A thin rim that follows real light (backlight, sky reflection on feathers) is fine. An even glow all the way round is not.
- If a rim remains, set the same `grow` (about −10) and a low `feather` (about 4) on the AI submask of **both** the subject and the environment parent, so the transition sits just inside the subject. Around −20 and beyond, a dark line appears along bright edges such as beaks. Then re-render both overlays.
- `inspect_edit` with `subject_mask_id` reports a `rim_index` for the band just outside the subject (about 1 means no halo) and lists the edge sectors that differ. To measure by hand, compare `sample_region` `stage: "edited"` with `stage: "aligned_original"` on the same region.
- Pass `cache: false` to `render` when checking a mask or edge change you just made.

## Measure before delivering

Run `inspect_edit` (with `subject_mask_id` when there is a subject) on each candidate. It compares the edit with an aligned reference that keeps the crop, geometry and retouching but has default tone and colour and no masks. It returns:

- frame brightness against the reference, bright and deep-shadow fractions, and each corner relative to the frame mean;
- subject vs. surround brightness (in stops) and warmth difference, for the reference and the edit;
- `rim_index` for the band just outside the subject;
- `look_here` regions in rendered coordinates: edge sectors with a brighter or darker rim, and areas that looked like their neighbours but were treated much differently. The heatmap shows brightness change against the reference (red brightened, blue darkened), with the `look_here` regions boxed in yellow.

It compares pixels, not meaning. It can miss background fully enclosed by the subject, or a missed part that already looked different from its surroundings in the reference, so look at the mask overlay and the heatmap as well as the list.

These are measurements, not rules. A deliberate glow, a darkened dusk, a subject that matches its background or a local accent can all produce values that look "wrong" out of context. Use them to find what to inspect at native size, then decide. Record the measurements you relied on next to the export.
