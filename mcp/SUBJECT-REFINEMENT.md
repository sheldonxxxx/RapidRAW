# Subject mask refinement

`mask_generate` supports include/exclude point prompts for `kind: "subject"` using the existing verified SAM models. A point is guidance to the model; successful inference does not establish that hair, feathers or an omitted subject part was selected correctly. Inspect the matched photograph, overlay and grayscale mask at overview and native detail.

## Generate a new selection

Supply `include_points`, `exclude_points`, or both. A new point-guided selection needs at least one include point or an explicit `region`. There are at most 64 include/exclude points combined. Contradictory labels at the same coordinates, points outside the canvas, malformed points and other AI mask kinds are rejected.

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 4,
  "kind": "subject",
  "region": {"x": 100, "y": 60, "width": 400, "height": 300},
  "include_points": [{"x": 240, "y": 180}, {"x": 450, "y": 220}],
  "exclude_points": [{"x": 390, "y": 120}]
}
```

These coordinates are examples; choose points from the actual image. Coordinates identify pixel centers in the **full mask canvas after geometric correction, orientation, flips and rotation, before crop**. Use `map_coordinates` with `to: "mask"` to translate preview coordinates. A crop changes preview placement without changing this canvas.

A region-only request that omits both point arrays and `refine` keeps the existing selection path. Point-guided inference uses the native full mask canvas directly, with exact aspect-preserving model preprocessing and padding. Visible retouch patches are composited before the existing RAW display conversion and geometry transforms; crop and ordinary color/tone edits are excluded from this inference canvas. Caller points and an explicitly supplied box remain unchanged through both decoder passes; automatic prompts do not replace them.

## Refine an existing AI-subject submask

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 5,
  "kind": "subject",
  "refine": {"mask_id": "MASK_ID", "sub_mask_id": "SUBMASK_ID"},
  "include_points": [{"x": 450, "y": 220}],
  "exclude_points": [{"x": 390, "y": 120}]
}
```

`expected_revision` is required for refinement. Omit `sub_mask_id` only when the target mask contains exactly one AI-subject submask. Other submask types are rejected. Exclude-only prompts are allowed with an existing prior. An optional `region` supplies a new explicit box; omitting it adds no box prompt. Point arrays describe this call's constraints; saved earlier points are retained for inspection but are not automatically replayed on subsequent calls.

Refinement updates only the selected submask's generated parameters. It preserves the mask and submask IDs, sibling corrections, ordering, visibility, inversion, opacity and local grade. Explicit `name`, `adjustments` and `parameters` still apply: adjustment fields merge into the existing local grade, while supplied mask controls override their previous values. Empty model output, stale revisions, invalid references or invalid inputs leave session edits unchanged.

The new model selection is validated before applying preserved mask composition. Consequently, a hidden or zero-opacity parent can be refined successfully. Its combined `mask_statistics` can be empty; `refinement.generated_submask_statistics` describes the generated selection before parent/sibling controls.

## Prior data and persistence

The response includes `mask_id`, `sub_mask_id` and `refinement`, including:

| Field | Meaning |
| --- | --- |
| `mode` | `new_mask` or `replace_submask` |
| `prior_mode` | `none`, `native_logits`, or `coverage_logit_seed` |
| `coordinate_space`, `canvas_dimensions` | The full mask canvas used for inference |
| `include_points`, `exclude_points`, `region` | The actual constraints supplied to both decoder passes |
| `source_sha256`, `geometry_sha256` | Source bytes and canvas identity used by the saved state |
| `generated_submask_statistics` | Model selection coverage before preserved mask composition |
| `prior_conversion` | Explanation when a legacy approximate prior was used |

New point-guided selections retain the decoder's actual 256×256 floating-point logits in `parameters.samRefinement`, together with source/geometry/bitmap hashes and the latest caller prompts. These are native model inputs, independent of the 8-bit display mask. History, session saves, portable bundles and worker snapshots carry this state with the submask. Do not hand-edit the logits or bitmap data.

A legacy AI-subject submask has no saved decoder logits. Its base selection coverage is converted to an **approximate** seed: coverage is clamped to 0.001–0.999, converted to log-odds, placed in SAM's top-left 1024-pixel padded canvas, then resampled to 256×256 while preserving signed values. The seed respects submask placement but excludes grow, feather, opacity, inversion and sibling composition; those preserved controls apply to the resulting selection once. This is labelled `coverage_logit_seed`; it is not recovered native logits or a calibrated probability estimate. Later refinements can use the newly generated native logits.

Source-byte changes or changes to canvas identity invalidate a native prior with `STALE_REFINEMENT`. Identity includes dimensions, RAW interpretation, geometric/lens settings, orientation, flips, rotation and patch state. Changing the generated submask's own placement to a nonzero rotation/orientation or a flip also makes its native prior stale. Crop and ordinary color/tone edits do not invalidate it. Restore the saved geometry and placement or generate a new subject selection when it becomes stale. A bitmap that no longer matches its saved decoder state is rejected with `INVALID_REFINEMENT`.

Background refinement uses `start_operation` with `operation: "mask_generate"` and these same arguments. The caller's revision guards capture of the parent snapshot; the worker uses the revision of its imported snapshot. The result is an independent session, so continue with the returned result session rather than assuming the parent was changed.

## Review and reproduction

Start with [setup and verification](README.md#verification) and the [testing matrix](testing-matrix.md). Pure tests check prompt bounds/labels, logit integrity/padding, schema transport and captured revisions. The native acceptance runner verifies actual inference, edits, history, portable state and workers. Photographic improvement needs a separate review with unchanged first attempts, explicit inclusion/exclusion criteria and representative images.

Use existing `mask_update.submask_operations` to add or edit corrective brush/range masks when appropriate. Assess inclusion, spill and boundary detail independently: growing or blurring a mask alone cannot prove that missing anatomy or fine strands were recovered.
