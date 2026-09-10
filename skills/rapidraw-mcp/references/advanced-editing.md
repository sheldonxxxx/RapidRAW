# Selective and advanced editing

Read only the sections needed for the task. Tool names below include the server's `rapidraw_` prefix; use the host's actual exposed name. Read live schemas for parameter details rather than extending these examples by guesswork.

## Coordinates and masks

| Operation | Coordinate space |
| --- | --- |
| `render.region`, `analyze.region` | Full-resolution rendered pixels after crop and geometry, before preview resizing; integer bounds |
| Mask geometry, AI subject `region` | Oriented full-resolution source pixels before user crop |
| Adjustment `crop` | Full-resolution pixels after orientation, flips, and rotation; inside the transformed canvas; `unit: "px"` |

Read `rendered_width`, `rendered_height`, `region`, and `coordinates` from a render. The response gives the preview-to-rendered mapping:

```text
rendered_x = region.x + preview_x * coordinates.preview_to_rendered_scale.x
rendered_y = region.y + preview_y * coordinates.preview_to_rendered_scale.y
```

Round/clamp a detail region within the rendered bounds. This mapping alone does not map a cropped preview into source-space mask coordinates. For mask placement, inspect a full uncropped reference and account for orientation, geometry, and crop explicitly. Do not use a simple scale when a transform invalidates it.

Choose geometric masks with `rapidraw_mask_create` (`radial`, `linear`, `brush`, `flow`), sampled range masks (`color`, `luminance`), or `all`. AI selections use `rapidraw_mask_generate` (`subject`, `foreground`, `sky`, `depth`); subject `region` is a rectangle around the intended subject. `rapidraw_generate_depth` produces a depth map and optionally enables blur. Check local model availability first.

Example for a measured subject near the center of an uncropped 640 × 480 image. Replace the geometry, session, and revision for the actual photo:

```json
{"tool":"rapidraw_mask_create","arguments":{"session_id":"SESSION_ID","expected_revision":1,"type":"radial","name":"Subject lift","parameters":{"centerX":320,"centerY":240,"radiusX":140,"radiusY":180,"rotation":0,"feather":0.8},"adjustments":{"exposure":0.18,"shadows":8}}}
```

`feather` is 0–1 for this geometry; mask `opacity` is 0–100. Keep the returned `mask_id`. Render it with `rapidraw_render` using `mask_id`, inspect coverage/edges, then render normally to judge the effect. Empty coverage is a failed selection, even if a mask record exists. A geometric approximation is not an AI subject selection.

Refine with `rapidraw_mask_update`; local adjustments go under `patch.adjustments`, and mask opacity under `patch.opacity`. If replacing `subMasks`, read the complete existing composition first; arrays replace the existing array. Remove a mask with `rapidraw_mask_remove` or undo the edit.

## Retouch and models

Use content-removing retouch when requested or implied by the user's edit. Choose clone/heal for controllable source sampling, local inpaint for suitable reconstruction, and generative mode when the user has authorized the remote workflow. Inspect fine detail and repeat patterns after retouching.

`rapidraw_retouch` requires native `sub_masks`, each with `id`, `type`, `visible`, `mode` (`additive`, `subtractive`, `intersect`), and `parameters`. Read the native submask schema; do not pass a plain rectangle or a mask ID as a replacement for this structure. Brush lines have a `tool`, `brushSize`, and point coordinates. Clone/heal can use `source_point`. Generated bitmap/patch fields belong to the engine.

`rapidraw_models` reports installation status. `rapidraw_install_model` accepts `kind: "masks"`, `"inpaint"`, or `"denoise"`. Install missing assets when authorized and necessary. If a suitable geometric or non-AI operation meets the request, it may avoid the download; explain any reduced capability accurately.

Read `rapidraw_get_engine_settings` to identify the processing provider. A configured provider alone does not authorize uploading an image. Generative mode uses the selected connector or a request-scoped cloud token. Keep tokens out of recipes, durable notes, and settings files. Connection setup is described in [connection.md](connection.md).

## Derived sessions, corrections, and assets

| Task | Tool and behavior that matters |
| --- | --- |
| Denoise | `rapidraw_denoise`, `method: "ai"` or `"bm3d"`, intensity 0–100. Zero is a no-op; nonzero returns a new session inheriting the existing adjustments. Inspect native texture before accepting. |
| Lens correction | `rapidraw_lens_profile` with `mode: "lookup"` inspects; `mode: "auto"` applies. Review geometry and edges after applying. |
| Film negative | `rapidraw_negative_convert` returns a derived session without inherited adjustments. Use its `parameters`, not obsolete negative-conversion adjustment keys. |
| HDR, focus, panorama | `rapidraw_merge` with `kind: "hdr"`, `"focus"`, or `"panorama"` takes at least two source paths and returns a new session. Inspect alignment, ghosting, and seams. |
| Preset | Discover with `rapidraw_list_presets`, then `rapidraw_apply_preset` with returned `preset_id` and optional intensity. Inspect warnings for legacy field migration. |
| LUT | Discover with `rapidraw_list_luts`, then `rapidraw_apply_lut` with the actual local path. The session retains its own LUT asset. |
| Recipe | `rapidraw_load_recipe` accepts merge or replace; choose deliberately. A CUBE LUT represents global color, not crop, masks, or other spatial edits; keep a recipe for those. |
| Metadata | `rapidraw_get_metadata`, then `rapidraw_set_metadata` for rating, tags, or EXIF. Save/export to persist and inspect the output metadata. |

Save a denoised RAW-derived session through MCP to retain its linear TIFF interpretation. Opening that derived TIFF directly in the GUI cannot recover the same interpretation from `.rrdata` alone; use an MCP export for a portable display image. Original RAW working copies and their saved sidecars can be continued in the GUI.

## Delivery options

For a short-edge target, use this shape instead of `long_edge`:

```json
{"tool":"rapidraw_export","arguments":{"session_id":"SESSION_ID","path":"short-edge.jpg","format":"jpeg","quality":92,"resize":{"mode":"shortEdge","value":1080,"dont_enlarge":true}}}
```

Other resize modes are `longEdge`, `width`, and `height`. `export_masks`, watermark configuration, metadata preservation, timestamps, and 16-bit PNG/TIFF are available in the current tool schema; use only what the delivery requires. Inspect actual output properties rather than inferring precision from the filename.

`rapidraw_batch_export` takes `items: [{session_id, path}, ...]` and shared `options` with export settings. Export names still resolve under the workspace's `exports` directory. A partially failed batch can already have written successful files; inspect each item before any retry.
