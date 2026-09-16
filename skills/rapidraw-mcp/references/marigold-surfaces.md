# Marigold normals and albedo

Use these optional tools when the user requests surface-aware lighting or colour selection, or when their photographic benefit justifies analysis. They use the same configured AI connector and ComfyUI as generation/depth, with serialized workflow switching. `marigoldSurfaceEnabled` is a separate opt-in; local editing and built-in depth remain available.

## Choose and generate

- `mask_generate(kind: "normals")` creates directional dodge/burn. `normalAngle` is degrees relative to the displayed photo: 0 right, 90 up. `normalAmount` is signed EV, -1.5 to 1.5. Start modestly. It changes tones; it does not move cast shadows or reconstruct reflections. The selection overlay shows the facing lobe; the rendered edit also darkens opposing surfaces.
- `mask_generate(kind: "albedo")` creates a colour selection from estimated albedo. `surfacePointX/Y` are normalized 0–1 coordinates on the **unrotated stored map**, not the cropped display. `surfaceTolerance` broadens the range (0.005–1). `surfaceColor` is RGB integers 0–255; `surfaceAmount` is 0–1 and starts at zero. At zero, the selection can drive ordinary local adjustments. Recolouring preserves linear luminance before downstream tone mapping; it can reduce saturation near the gamut boundary. Black is not a recolour target; use tonal adjustments to darken.
- Keep current `expected_revision`. Surface inference analyses the full frame; constrain the edit afterward with intersecting brush/subject components, not the generation `region` field.
- Use one normals or albedo component per adjustment mask. Directional light occupies two of the renderer's 32 mask slots; other masks occupy one.

## Reuse and review

Update controls through `mask_update` submask parameter edits. Angle, amount, seed point, colour and tolerance reuse the saved RGB16 map without another model request. Map data stays opaque in model-facing state; preserve it through native saves and portable bundles.

Display rotation, flips and crop follow the saved map. Lens/perspective and retouch changes invalidate it: the surface mask is inactive until regeneration or undo. A failed/discarded generation leaves the previous map intact. Disabling new inference does not disable saved edits or offline export.

Albedo selects colour, not object identity. Similar-colour skin or scenery may spill into a clothing selection. Intersect with a working region, inspect mask boundaries at native scale, then inspect the actual recolour. For normals compare against the same base exposure with amount zero, checking highlights, faces and fine texture. Amount-zero and protected-pixel comparisons should use matched native renders. Do not substitute a CPU prototype for native RAW/export acceptance.

The selected Q4 workflows measured about 7.31 GiB Comfy process memory on the tested 16 GB GPU. This is an observation, not a hard cap; a 4 GB budget is unqualified. Connector failures must not silently invoke another provider or overwrite the saved map. After uncertain timeouts, inspect state before retrying.
