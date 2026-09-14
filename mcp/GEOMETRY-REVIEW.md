# Geometry and review

All diagnostics preserve the saved revision. Use `expected_revision` on subsequent edits.

## Coordinate mapping

`map_coordinates` maps finite points, strokes and region boundaries between:

- `oriented_source`: the loaded source after EXIF decoding orientation, before user geometry.
- `mask`: the full corrected, user-oriented, flipped and rotated canvas before the user crop. Native mask parameters use this canvas.
- `rendered`: the current image after crop, before preview resizing.
- `preview`: a specified preview's `width`, `height` and optional native rendered `region`.

Coordinates are **pixel centers**, so the top-left pixel is `(0, 0)`. Resize mapping uses `rendered_x = region.x + (preview_x + 0.5) * region.width / preview.width - 0.5`, and likewise for y. These locations match the center of the resampling footprint; a resized preview pixel combines nearby source samples.

```json
{
  "session_id": "SESSION",
  "from": "preview",
  "to": "mask",
  "preview": { "width": 800, "height": 600 },
  "points": [{ "x": 120, "y": 200 }],
  "strokes": [
    [
      { "x": 120, "y": 200 },
      { "x": 135, "y": 212 }
    ]
  ]
}
```

Source mapping uses the same homography, manual radial distortion, lens polynomial/PTLens distortion and lens automatic crop as the native image renderer. It then applies native orientation, flips, fine rotation and rounded crop semantics. TCA uses the green-channel sample location because red and blue can have different pre-images. Lens blur/retouch change pixel content, not geometry.

Each output point includes `mapped: true` and x/y, or `mapped: false` and a reason. Cropped-out points, rotation borders, singular warps and nonconvergent/ambiguous inverse geometry are not silently clamped. Source-to-rendered warps use a checked numerical inverse; response tolerance is reported. A point's output canvas membership does not establish selection quality.

A region returns 128 sampled boundary points and `sampled_bounds`. Bounds are approximate when edges curve; unmappable boundary samples are retained. A region can be incomplete while some of its interior is visible. At most 4096 samples are accepted per request, counting each region as 128 samples.

## Resource preflight

`preflight` reports decoded/rendered dimensions, actual GPU texture/buffer limits, individual memory-buffer lower bounds, streaming status, output format/bit-depth compatibility and optional verified model-group availability. Use `model_kind` to require `masks`, `inpaint` or `denoise`; `operation: "mask_generate"` requires the masks group automatically. Denoise and retouch callers must request the applicable group explicitly. It never downloads models and does not validate resize, ICC, provider credentials or a complete export/AI request.

`ready` means no reported blocker was found; it is not a peak-memory or AI success guarantee. Memory accounting explicitly excludes decoder, geometry, AI, merge and GPU scratch allocations. Above the texture limit, render/export use the streamed native path when its pixel-count/effect-halo limits allow it. AI and merge resources remain operation-specific.

## Matched mask review

`render` with `mask_id` retains grayscale output by default. With `mask_mode: "overlay"`, it returns three aligned images: the magenta overlay, edited photograph and grayscale selection. `overlay_opacity` is 0..1 and defaults to 0.5. A supplied `region` produces matched native detail crops; optional `long_edge` resizes all three identically.

Preview color blocks encode 8-bit RGB; native processing, sampling and 16-bit exports retain their precision. The complete MCP response is limited to 8 MiB, including all image blocks and metadata. `RESPONSE_TOO_LARGE` preserves the connection and reports recovery information. Request a smaller overview explicitly, or split a large native detail rectangle into bounded adjacent tiles while retaining their original coordinates. No automatic resizing or encoding change occurs. A mask-generation mutation may already have succeeded before its response exceeds the budget; recover the returned mask/session IDs and inspect them instead of generating again.

Coverage includes nonzero and weighted fractions, rendered-coordinate bounds at thresholds 1 and 128, and, in overlay mode, mask-weighted RGB and linear-luminance statistics. Measurements cover the requested native region before resizing; bounds use full rendered coordinates but are clipped to that region. Empty regions have null bounds and null selected-colour statistics. The mask must be enabled. These measurements do not certify semantic selection accuracy.

## Photometric sampling and white balance

`sample_region` requires a native rendered rectangle (at most 4 megapixels). `stage: "edited"` samples the current edit; `stage: "original"` bypasses user adjustments, including crop and geometry, so use that stage's own coordinates. Both stages use native decoding/baseline processing and rendered sRGB after tone mapping, before resizing/encoding.

The result reports channel means, medians and 5th/95th percentiles; linear-sRGB Rec.709 luminance statistics; and clipping fraction. These are display measurements, not RAW sensor headroom. RGB uses the 16-bit GPU readback; luminance is computed after decoding the sRGB transfer curve.

With `suggest_white_balance: true` on the edited stage, a finite-difference solver renders temporary temperature/tint candidates through the current native pipeline. It preserves masks, LUTs and other adjustments. It returns the proposed patch, initial/candidate neutrality errors, render count and `applied: false`. This assumes that the selected patch should be neutral; it does not identify neutral objects automatically. Very dark/clipped samples return an unavailable suggestion. Applying a suggestion requires a separate normal edit.

## Preview clipping and exact cache

`render.clipping_overlay` controls display clipping: red for any fully clipped white channel, blue for any fully clipped black channel. White takes precedence if both occur. Ordinary previews default to saved `showClipping`; explicit false gives a clean preview. The overlay is applied to full-resolution pixels before preview resize. It cannot be enabled alongside `mask_id`; mask previews, `analyze`, `sample_region` and exports remain clean.

Repeated exact previews use a process-local LRU bounded to 16 entries and 64 MiB of serialized responses; responses larger than 32 MiB are not cached. The key contains effective engine settings, loaded image identity, full adjustments, revision, preview parameters and LUT content. Entries store the requested encoded previews after full-resolution native processing and final resizing. Changes to any key input invalidate reuse. `cache: false` bypasses reading and writing, and each response reports cache status. Restarting the engine clears this cache.

## Atomic submask editing

`mask_update` accepts `patch`, `submask_operations`, or both (patch first). The public MCP schema accepts 1–100 operations per submask batch. All changes validate and commit once; failure leaves saved state unchanged. Operations use `operation` as their discriminator:

```json
{
  "session_id": "SESSION",
  "mask_id": "MASK",
  "expected_revision": 12,
  "submask_operations": [
    {
      "operation": "add",
      "submask": { "type": "linear", "parameters": { "startX": 0, "startY": 200, "endX": 600, "endY": 200 } }
    },
    { "operation": "edit", "submask_id": "EXISTING", "patch": { "opacity": 70 } },
    { "operation": "duplicate", "submask_id": "EXISTING", "index": 1 }
  ]
}
```

- `add`: engine-generated ID, native `submask` object without ID, optional insertion `index`.
- `edit`: stable `submask_id` and recursively merged `patch`; changing ID is rejected.
- `remove`: remove `submask_id`. Native validation still requires at least one submask.
- `duplicate`: clone `submask_id` with a new ID; default insertion is immediately after the original.
- `reorder`: `order` must list every existing submask ID exactly once.

Added/duplicated/edited/removed IDs appear in `submask_ids`. Whole-mask and submask IDs otherwise remain stable.

## Verification

Run the commands below from `mcp/` after building the server and native engine using the [setup guide](README.md#build-and-connect).

Native unit tests compare coordinate ramps to real CPU geometry pixels across orientation, flips, crop, manual perspective, radial/lens distortion, fine rotation and guided correction. They also verify submask atomicity, clipping, linear-luminance sampling, bounds and overlay locality.

`node scripts/geometry-review-e2e.mjs` runs through the actual MCP SDK and native binary selected by `RAPIDRAW_BINARY`. It records native/pixel assertions for mapping, preview resizing, submask mutation/errors, verified sampling/WB candidates, matched mask detail, cache equivalence and export exclusion of clipping overlays. Evidence is saved through the shared coverage harness. Running these fixtures does not establish photographic or AI-mask quality.

`node scripts/large-image-e2e.mjs` creates an independent 16-bit gradient wider than the actual GPU texture limit. It checks full-size PNG16 precision, native regions across streaming boundaries, mask alignment, post-render resizing and mask-only flare. The ignored Metal tests in `gpu_processing::precision_tests` additionally compare forced streaming with whole-texture processing and test tall-image blur at sparse regions. Enable these with `--include-ignored --test-threads=1` on a host with an accessible GPU.
