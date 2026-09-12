# MCP testing and evidence

The evidence harness discovers the current MCP tools and native adjustment schema at connection time. It creates requirements for **every tool, input property, boolean/enum mode, nested adjustment and discriminated mask parameter**. Adding a tool or schema property automatically creates a visible coverage gap. There is no hardcoded tool count.

`inventory.json` records the advertised schemas, source revision, full-repository dirty hash, runtime-source SHA-256, suite-script SHA-256, executable SHA-256, OS/architecture and Node version. Runtime provenance includes engine/frontend/server source and dependency manifests; test runner and documentation changes are recorded separately. `evidence.jsonl` records actual SDK → MCP server → native-engine calls, assertions, failures and skips. `coverage.json` includes every requirement, including those without evidence; `coverage.md` gives a tool-level table. Source fixture, runtime source and executable hashes are checked again at shutdown. Use a **new workspace for every run**; evidence paths are local and may contain private photo names.

Evidence levels are separate:

| Level | Meaning |
|---|---|
| `native_call` | A successful real MCP call. Schema acceptance alone is not a pixel assertion. |
| `native_assertion` | Explicit output/state/persistence assertion through the native tool. |
| `pixel_assertion` | Explicit decoded pixel, placement, precision or independently decoded delivery assertion. Only named requirements get credit. |
| `visual_review` | Reserved for an attributable review of saved images. Rendering an image never implies visual approval. Current automated runners grant no visual-review credit. |

Protocol/fake-worker tests verify transport, validation and lifecycle contracts. They **never** count as native or photographic evidence. A failed/empty AI mask remains a failed first attempt. A skip is never a pass.

## Running the suites

Build the MCP server with `npm run build --prefix mcp`. Build the native application with the optional `mcp` feature as described in [MCP.md](../MCP.md). Set `RAPIDRAW_BINARY` to its absolute executable path, and `ORT_DYLIB_PATH` to the native runtime when exercising models. Run native GPU suites sequentially.

```sh
RAPIDRAW_WORKSPACE=/absolute/new/output/adjustments node mcp/scripts/coverage-e2e.mjs
RAPIDRAW_WORKSPACE=/absolute/new/output/geometry node mcp/scripts/geometry-review-e2e.mjs
RAPIDRAW_WORKSPACE=/absolute/new/output/portable node mcp/scripts/portable-sessions-e2e.mjs
RAPIDRAW_WORKSPACE=/absolute/new/output/jobs node mcp/scripts/operation-jobs-e2e.mjs
RAPIDRAW_WORKSPACE=/absolute/new/output/delivery node mcp/scripts/export-interoperability-e2e.mjs
RAPIDRAW_WORKSPACE=/absolute/new/output/response-budget node mcp/scripts/response-budget-e2e.mjs
```

The adjustment matrix tests texture/color/luminance changes, compound-control prerequisites, exact reset identity, flips/crop/regions, brush/flow locality, all/radial intersection/subtraction/inversion/opacity, color/luminance selection and real `list_images`/`list_jobs` calls. `RAPIDRAW_TEST_ADJUSTMENTS=sharpness,hue` narrows diagnostic reruns; those are partial runs. A no-effect control fails its test rather than gaining support credit. Synthetic fixtures establish processing semantics, not photographic aesthetics.

The delivery matrix independently decodes PNG with a small CRC-validating decoder and TIFF with an independent strip decoder. ImageMagick (`RAPIDRAW_MAGICK`, default `magick`) provides additional format, ICC and GPS checks. When ImageMagick lacks JXL support, macOS ImageIO decodes the file, materializes the full raster and finalizes a PNG that the independent PNG decoder reads. Quality-100 JXL must match every RGB8 sample of the matching lossless PNG baseline. A platform without a usable independent decoder gets an explicit skip; the native result remains separate. True 16-bit sample values, requested timestamp preservation, resize/no-enlargement and explicit unsupported ICC policies have assertions.

ICC checks reject color-profile decoder warnings, require four-byte tag alignment and the [ICC-specified D50 illuminant](https://www.color.org/security/malformed/bad-illuminant/), and independently inspect media white, colorant sums and chromatic adaptation. An explicit-sRGB PNG also passes through ImageMagick/LittleCMS into an independent reference sRGB profile; decoded colors must remain within recorded fixed-point/TRC tolerances. On macOS the reference defaults to the installed ColorSync sRGB profile. Set `RAPIDRAW_REFERENCE_SRGB_ICC` elsewhere; an unavailable reference/transform is an explicit skip. Missing EXIF-property warnings remain allowed when testing intentional metadata removal.

The operation job suite runs actual independent native export workers, changes parent edits after capture, checks captured output, cancels/resumes, reconnects and checks durable results. Negative conversion, distinct synthetic HDR inputs and clone retouch also verify imported main-workspace result sessions, changed decoded pixels, unchanged parents and identical rendering after restart. Set `RAPIDRAW_TEST_WORKER_MODELS=1` to require local model installation and cover the remaining depth-mask and depth-map worker operations; otherwise unavailable model cases are explicit skips. These are processing checks, not photographic quality claims. Unit fake-worker tests additionally cover interrupted work, malformed manifests, capture failure cleanup, changed source hashes, settings capture and credential rejection.

The response-budget suite renders a deterministic high-entropy PNG through the real native engine and official SDK. An oversized three-image response must return an actionable `RESPONSE_TOO_LARGE` within the 8 MiB budget, preserve session revision and keep the same connection usable. Explicitly smaller overviews and 512×512 native detail then verify all three matched RGB8/Luma8 image blocks and a subsequent edit. This is an expected-error assertion, not a skipped preview or evidence of photographic quality.

Existing `engine-e2e.mjs`, `asset-e2e.mjs`, `review-jobs-e2e.mjs`, `advanced-e2e.mjs` and `denoise-e2e.mjs` support `RAPIDRAW_COVERAGE=1` to add their actual calls to the same ledger while retaining legacy artifacts/assertions. Advanced tests use small derived fixtures; repeated-source merges are mechanical execution evidence only. Accepted empty-mask/missing-profile conditions are recorded as skips. The denoise domain regression explicitly marks its isolated synthetic float-TIFF session as RAW; its decoded-pixel checks do not establish photographic full-resolution RAW quality.

Combine only matching source/native builds:

```sh
node mcp/scripts/coverage-report.mjs /absolute/output/adjustments /absolute/output/geometry /absolute/output/portable
node mcp/scripts/coverage-report.mjs /absolute/output/adjustments /absolute/output/geometry /absolute/output/portable --require-native-tools
```

The aggregator requires each suite's completed, passed `summary.json` and `coverage.json`, with matching provenance and ledger call counts. Missing summaries, reported suite errors and failed calls/assertions are rejected before aggregate files are written, including legacy assertions thrown outside a tagged check. It also rejects mixed runtime-source hashes, executable hashes or schema inventories. It retains each suite's script/full-repository provenance, allowing different suites and documentation edits against the same runtime to combine fairly. `--require-native-tools` fails until every advertised tool has a successful native call. `--require-pixel-adjustments` is a deliberately strict audit gate: state-only fields and all untested variants remain gaps. Do not use a successful partial suite to claim full coverage.

To repair attribution in historical evidence, use a new output directory and the original completed ledgers (the paths below are placeholders):

```sh
node mcp/scripts/reclassify-coverage.mjs --output /absolute/new/reclassified-report /absolute/completed/run-one /absolute/completed/run-two
```

Reclassification reads each run's recorded schemas and successful arguments, retaining its original requirement IDs, inventory and provenance. It refuses failed/incomplete or incompatible runs and existing outputs. It neither executes the engine nor infers missing state/pixel assertions; its report cannot be submitted as a new native run. Requirement groups identify repeated schemas for planning only. Direct-input evidence and explicitly asserted derived-state evidence remain separate; use `--require-direct-adjustments` with the ordinary aggregator when auditing direct adjustment-input contracts.

## Models and a generative provider

```sh
RAPIDRAW_WORKSPACE=/absolute/new/output/model-download RAPIDRAW_TEST_MODEL_DOWNLOAD=1 \
  RAPIDRAW_TEST_MODEL_KINDS=inpaint node mcp/scripts/model-provider-e2e.mjs
```

Only a new workspace is accepted for download testing. Deliberately corrupt disposable model targets bypass installed-application copy reuse, exercising a real verified download and corruption repair. Expected SHA-256 is verified independently and a second install checks idempotence. Application models are untouched. Masks and denoise groups are optional larger downloads.

Controlled HTTP transport faults run with `cargo test --manifest-path src-tauri/Cargo.toml --features mcp --lib ai_processing::download_fault_tests`. These use the real downloader against local HTTP sockets to verify unavailable network, HTTP 503, truncated response bodies, cancellation and hash mismatch, each followed by an explicit successful retry. Failed transfers preserve existing assets; hash verification occurs before the final asset path is published. These are native downloader tests, **not MCP installation/inference evidence**. The MCP install/cancellation boundary remains a separately reported gap until it is exercised under controlled end-to-end transport faults.

Successful remote generation is opt-in with `RAPIDRAW_TEST_GENERATIVE=1` and `RAPIDRAW_TEST_PROVIDER_SETTINGS=/absolute/provider-settings.json`. Only the generated 96×64 test texture is sent. `RAPIDRAW_TEST_PROVIDER_TOKEN` is optional and redacted. The check requires a returned patch, changed rendered pixels, and undo restoring exact output. It does not approve the generated image aesthetically. Missing provider setup produces an explicit skip.

## Genuine photographic evaluation

Use local manifests with `RAPIDRAW_PHOTO_MANIFEST=/absolute/manifest.json node mcp/scripts/photo-quality-e2e.mjs`. Never commit source photographs, generated artifacts, model binaries or credential settings. Example group; paths and hashes are placeholders:

```json
{
  "version": 1,
  "groups": [{
    "id": "new-hdr-001",
    "kind": "hdr",
    "partition": "fresh-holdout",
    "capture_group": "new-capture-sequence-001",
    "provenance": "Immich original download; record asset IDs in local notes",
    "derived_from_same_image": false,
    "sources": [
      {"path": "/absolute/photos/dark.CR3", "sha256": "REPLACE_WITH_HASH", "exposure_ev": -2},
      {"path": "/absolute/photos/light.CR3", "sha256": "REPLACE_WITH_HASH", "exposure_ev": 2}
    ],
    "review_criteria": ["Retained highlight detail", "No moving-subject ghosts", "Natural shadow noise"]
  }]
}
```

The validator rejects duplicate hashes, same-image derivations, missing provenance and missing capture differences. HDR groups need distinct recorded exposure EVs; focus groups need distinct `focus_plane`; panoramas need `frame_position` and `overlap_description`. Other kinds are `ai-mask`, `denoise`, `negative`, with kind-specific parameters allowed. A genuine negative fixture and photographic brackets are necessary for quality claims. Distinct file hashes alone do not prove a genuine bracket; acquisition notes must be truthful.

First attempts are written exclusively into `first-attempts/<id>`; reruns cannot overwrite them. Each result gets `review-required.json` with explicit criteria and `not_reviewed` status. Review full images and native-detail crops, including mask edges, stars, feathers/hair, deghosting, focus transitions and panorama seams. Preserve reviewer identity, date, artifacts and criteria judgments in a separate local record. Existing regression images cannot become fresh holdouts by renaming them; use new capture groups from Immich when authorized.

Every source gets an original overview and native 1:1 detail before processing. The result includes overview and native detail; AI masks additionally save all three matched overlay/photograph/grayscale blocks at both scales. PNG overviews explicitly start at a 1024px long edge. An actionable `RESPONSE_TOO_LARGE` can trigger a smaller overview, with each attempted request retained in the ledger. Native review rectangles are covered by 512px tiles without resizing, so a requested 1024×1024 region retains all its pixels in four matched crops. Artifact hashes, operation output, original/result session IDs and exact tile coordinates are included in `review-required.json`. Set `review_region` to an explicit integer rendered-pixel rectangle; otherwise each image uses its central native crop. Completed mutations with oversized responses recover their returned session/mask/job identifiers and are never replayed. A transport disconnect marks all remaining fixtures `not_attempted` instead of issuing meaningless calls on a dead client. Denoise processes the full original resolution. Set a denoise group's `background` to `true` to exercise `start_denoise` and monotonic progress polling; the default preserves the synchronous compatibility case.

The validator checks recorded provenance, capture differences and partitions; it cannot independently establish that a source is a genuine negative or bracket, that focus labels are correct, or that a declared holdout was never used in an earlier run. Partition separation is checked within this manifest. The runner verifies execution and decodable review artifacts, and leaves photographic quality `not_reviewed`; it does not score denoising, alignment, texture recovery, ghosts or selection accuracy. A central crop, or identical numeric coordinates across merge inputs and output, need not show the same scene feature after alignment/projection. Select additional corresponding native details for seam and feature review before approving a merge. Record failed criteria and revised attempts separately from the preserved first attempt.

## Focused rendering and refinement checks

The [distinct-rendering suite](scripts/distinct-rendering-e2e.mjs) uses deterministic native pixel oracles for global/local section switches, parametric curves, lens-blur aperture shapes, horizontal guided perspective, scene-referred LUTs and lens controls. It compares disabled controls to an exact baseline, includes positive controls, and checks representative history, persistence and batch forwarding. Run it with a new `RAPIDRAW_WORKSPACE` using `node mcp/scripts/distinct-rendering-e2e.mjs`.

The [point-refinement contract suite](scripts/point-refinement-e2e.mjs) checks point bounds and revision guards, stable mask identity, geometry, persistence and captured-worker behavior. Set `RAPIDRAW_TEST_IMAGE` to an original photograph with a clear subject. Set `RAPIDRAW_TEST_POINT_PROMPTS` to a JSON file containing `normalized_source.include_points`, `normalized_source.exclude_points` and an optional `normalized_source.region`; coordinates are fractions in [0, 1] of the natively exported fixture. Defaults assume a centered subject and background near the upper-left corner. Run `node mcp/scripts/point-refinement-e2e.mjs` with a new workspace. Its small native-derived fixture establishes contracts; full-resolution photographic quality requires a separate run.

The [photographic refinement runner](scripts/mask-refinement-quality-e2e.mjs) accepts a private `RAPIDRAW_PHOTO_MANIFEST` containing `ai-mask` groups. Each group needs a region-only baseline, `refinement.include_points` and/or `refinement.exclude_points`, and independently annotated `probes`. A probe records a safe `id`, an `intent` (`include`, `exclude`, or `preserve`), a native `region` no larger than 512×512, and explicit `minimum_after`, `maximum_after`, or directional `minimum_change` opacity bounds. For exclusion, a positive minimum change means opacity must decrease. Establish these regions and thresholds before inference. First baseline/refined overviews, native detail and probe triplets are saved before assertions; failures remain reviewable. Numeric probes cover only their annotated regions and never automatically grant photographic approval.

Panorama photo groups can require `minimum_width_expansion` greater than one. The runner checks capture provenance and saved-session pixel identity after restart, and renders distributed native tiles across the output. Width expansion includes the uncropped canvas and must be accompanied by visual proof of useful new scene content, seam continuity and absence of alignment artifacts.

Run `node mcp/scripts/panorama-contract-e2e.mjs` in a new workspace for [procedural panorama contracts](scripts/panorama-contract-e2e.mjs): a low-contrast three-panel scene must retain its full width and restart pixels, while featureless or disconnected inputs must fail. MCP panorama merges require all supplied inputs to connect; the desktop stitcher can still warn and offer a partial result. Procedural fixtures establish these contracts separately from genuine-capture quality.

Optionally set `RAPIDRAW_PANORAMA_LIMIT_MANIFEST` to a private single-group photographic manifest whose projected panorama is known to exceed 100 MP. That case must return `PANORAMA_CANVAS_TOO_LARGE` before a stitched image is allocated. It verifies the resource boundary and original integrity; it supplies no stitched-image quality evidence. Full-resolution source dimensions alone do not determine the projected canvas size.

## Guided AI and manual mask edits

Use the [guided-mask workflow suite](scripts/guided-mask-workflow-e2e.mjs) to test an actual local edit on an inspected photograph. It preserves an AI selection and its grade as a named version, forks an independent correction session, adds both additive and subtractive brush submasks, and checks that existing selection components and local adjustments remain intact. It also creates an independent brush-only mask for a separately named lighting intent. [Editing guidance](../skills/rapidraw-mcp/references/guided-masking.md) explains how to choose useful corrections; the runner reproduces those measured choices rather than deciding them automatically.

The suite requires local mask models and a version-1 photographic manifest with `kind: "ai-mask"`, `partition: "regression"`, one verified source and capture provenance. These inputs have already been inspected; they are not blind holdouts. The example below illustrates a 640×480-or-larger canvas. Every path, hash, coordinate, brush size and threshold is a placeholder to replace using the actual source and intended edit. Exposure values are image-specific, not a default recipe.

```json
{
  "version": 1,
  "groups": [{
    "id": "bird-local-lift",
    "kind": "ai-mask",
    "partition": "regression",
    "capture_group": "inspected-bird-capture",
    "provenance": "Original acquisition and prior-use record",
    "derived_from_same_image": false,
    "sources": [{"path": "/absolute/photos/original.CR3", "sha256": "REPLACE_WITH_ORIGINAL_SHA256"}],
    "review_criteria": ["Brighten the bird naturally", "Keep the perch unchanged", "Avoid visible halos or painted gaps"],
    "ai": {"kind": "subject", "region": {"x": 100, "y": 80, "width": 440, "height": 320}},
    "local_adjustments": {"exposure": 0.2, "shadows": 5},
    "effect_probes": {
      "selected": {"region": {"x": 250, "y": 240, "width": 16, "height": 16}, "minimum_mean_absolute_difference": 0.002},
      "protected": {"region": {"x": 450, "y": 360, "width": 8, "height": 8}, "maximum_mean_absolute_difference": 0.001}
    },
    "corrections": [
      {
        "id": "restore-toe", "mode": "additive",
        "parameters": {"lines": [{"tool": "brush", "brushSize": 18, "feather": 0.35, "points": [{"x": 300, "y": 350}, {"x": 315, "y": 355}]}]},
        "probe": {"region": {"x": 301, "y": 350, "width": 4, "height": 4}, "minimum_opacity_delta": 0.1},
        "review_criteria": ["Restore the visible toe without joining it to the perch"]
      },
      {
        "id": "remove-perch", "mode": "subtractive",
        "parameters": {"lines": [{"tool": "brush", "brushSize": 24, "feather": 0.25, "points": [{"x": 440, "y": 365}, {"x": 470, "y": 365}]}]},
        "probe": {"region": {"x": 450, "y": 360, "width": 8, "height": 8}, "minimum_opacity_delta": 0.1},
        "review_criteria": ["Remove selected perch while retaining adjacent feathers"]
      }
    ],
    "manual": {
      "intent": "Soft breast lift",
      "parameters": {"lines": [{"tool": "brush", "brushSize": 120, "feather": 0.8, "points": [{"x": 250, "y": 240}, {"x": 270, "y": 270}]}]},
      "effect_probes": {
        "selected": {"region": {"x": 250, "y": 240, "width": 16, "height": 16}, "minimum_mean_absolute_difference": 0.002},
        "protected": {"region": {"x": 450, "y": 360, "width": 8, "height": 8}, "maximum_mean_absolute_difference": 0.001}
      }
    },
    "review_regions": [{"id": "bird-perch-contact", "region": {"x": 200, "y": 200, "width": 320, "height": 240}, "criteria": ["Keep contact edges natural and preserve gaps"]}]
  }]
}
```

`ai.kind` accepts `subject`, `sky` or `foreground`; only subject uses `region`. Optional subject-only `ai.refinement` contains measured `include_points` and/or `exclude_points`, at most 64 combined. Point refinement is not required before manual correction. At least two corrections must exercise both submask modes; each needs a direction-specific coverage probe and photographic criteria. Corrections use painted `tool: "brush"` lines: an eraser in a separate brush submask cannot erase the AI sibling. Every line specifies feather in 0..1 and diameter in full mask-canvas pixels. Successive points are connected; use separate lines across protected gaps.

The independent `manual` case has its own intent and selected/protected probes; a soft interior dodge does not claim whole-object extraction. Local grades use nonzero `exposure` within −5..5 and optional `shadows` within −100..100. Effect gates measure mean absolute decoded RGB difference in 0..1; correction gates measure the intended increase or decrease of mean mask opacity. Choose explicit native regions no larger than 512×512 and thresholds appropriate to the image. These small probes support, but cannot replace, whole-frame and edge review.

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
RAPIDRAW_PHOTO_MANIFEST=/absolute/fixtures/guided-mask-manifest.json \
RAPIDRAW_WORKSPACE=/absolute/new/output/guided-masks \
  node mcp/scripts/guided-mask-workflow-e2e.mjs

node --test mcp/test/guided-mask-workflow.test.mjs
```

Each `regressions/<id>` retains the original overview, graded AI baseline, correction-probe triplets, final AI/manual overviews and native regions, complete editable state and a `review-required.json` with source/manifest/runtime/artifact hashes. Overviews start at 1024 pixels; explicit native regions are never resized. The same declared grade is used on the AI baseline and corrected selection. Neutral-versus-graded comparisons separately establish the actual local effect. Both corrected and manual sessions check stale-revision rejection, undo/redo, and exact state and PNG equality after saving and reconnecting, including the captured native regions. The untouched baseline and original/sidecar integrity have separate assertions.

Photographic status remains `not_reviewed` even when all checks pass. Review the intended local effect and protected areas at delivery size, then inspect changed contact points and boundaries at native resolution. Record reviewer identity, artifact hashes, improvements and remaining defects separately, and publish the retained candidates through the review application's manifest contract. Existing strict matte failures remain valid for those original criteria; accepting a useful tonal edit does not approve extraction quality.

## Automatic lens-profile photographs

The [automatic lens-profile suite](scripts/lens-profile-photo-e2e.mjs) requires an unmodified RAW whose actual camera/lens EXIF matches a bundled calibration. Choose visible edge detail and corner illumination before applying the profile. The runner calls `lens_profile(mode: "auto")` with no maker, model, focal-length or aperture override. It checks native EXIF, independently supplied calibration coefficients, correction pixels, coordinate changes, separate distortion/TCA/vignette behavior, disabled identity, history, stale revisions, explicit aperture overrides in the presence of APEX metadata, restart, portable bundle import and original/sidecar integrity.

Create a private JSON manifest. The following calibration values come from the [bundled Canon database](../src-tauri/lensfun_db/mil-canon.xml) for the RF-S 18–150mm lens at 18mm and f/3.5; use an actual photograph with those settings, or independently derive expectations for your selected lens and exposure. Paths and hashes below are placeholders. The explicit f/8 override selects the nearest f/7.1 vignette calibration in this database. Never obtain expected coefficients from the `lens_profile` response being tested.

```json
{
  "schema_version": 1,
  "id": "wide-angle-architecture",
  "source": {
    "path": "/absolute/photos/original.CR3",
    "sha256": "REPLACE_WITH_ORIGINAL_SHA256"
  },
  "expected_metadata": {
    "make": "Canon",
    "camera_model": "Canon EOS R7",
    "lens_model": "Canon RF-S 18-150mm F3.5-6.3 IS STM",
    "focal_length": 18,
    "f_number": 3.5
  },
  "expected_profile": {
    "maker": "Canon",
    "model": "RF-S 18-150mm F3.5-6.3 IS STM",
    "xml_path": "/absolute/RapidRAW/src-tauri/lensfun_db/mil-canon.xml",
    "xml_sha256": "REPLACE_WITH_XML_SHA256",
    "coefficients": {
      "model": 1,
      "k1": 0.0317062, "k2": -0.110518, "k3": 0.089312,
      "tca_vr": 1.0004398, "tca_vb": 1.0000314,
      "vig_k1": -0.8702, "vig_k2": 0.5268, "vig_k3": -0.3554
    }
  },
  "aperture_override": {
    "aperture": 8,
    "vignetting": {"vig_k1": -0.4258, "vig_k2": 0.0751, "vig_k3": -0.0270}
  },
  "review_regions": [{"x": 100, "y": 1350, "width": 512, "height": 512}]
}
```

Run from the repository root with an MCP-enabled native binary and a new workspace:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
RAPIDRAW_LENS_MANIFEST=/absolute/fixtures/lens-manifest.json \
RAPIDRAW_WORKSPACE=/absolute/new/output/lens-profile \
  node mcp/scripts/lens-profile-photo-e2e.mjs
```

The actual native Lensfun resource XML must match the manifest's XML hash. It defaults to `lensfun_db/<XML filename>` beside the executable; set `RAPIDRAW_LENS_RESOURCE_XML` for a packaged resource location. Native detail regions must fit the image and be no larger than 512×512; they are never resized. The full RAW remains the processing input; the 1024px overview is only a review output. Restart and bundle-import parity require exact overview pixels; native-detail crops are captured and reviewed separately, without claiming native-detail parity across those persistence steps. Stored coefficients allow at most `1e-12` JSON roundtrip error, while independent XML expectations allow `1e-6` for native float32 conversion.

`review-required.json` records immutable manifest/source hashes, runtime provenance, artifact hashes, exact native regions and any declared inspection timing. Optional `provenance.runtime_freeze` contains `path`, `sha256`, `runtime_tree_sha256` and `binary_sha256`; when supplied, the runner rejects a changed freeze declaration or runtime. Declare prior preview inspection in `provenance.inspection_timing` and keep blind-holdout claims separate. The generated `shared-review-manifest.json` registers overview and native-detail comparisons. Its media root defaults to the run workspace; set `RAPIDRAW_REVIEW_MEDIA_ROOT` explicitly when publishing into an application with a wider media root.

A matching name and nonzero correction establish neither optical calibration accuracy nor photographic improvement. Inspect geometry, color fringes, interpolation detail and corner brightness in a separate named review. Correction changes geometry, so identical output crop coordinates can contain shifted scene features. A calibrated chart or independent ground truth is required for optical-accuracy claims; the suite makes no such claim.

## Fresh installation and platforms

`node mcp/scripts/fresh-setup.mjs --build --native` reinstalls locked Node dependencies, builds frontend/native MCP, checks the feature-disabled build, runs protocol tests and the generated-fixture native suites. Use `npm run test:setup -- --build --native` on Windows so the Node/npm CLI path is explicit. Build dependencies still come from the platform setup in [MCP.md](../MCP.md) and upstream build documentation. Set `RAPIDRAW_SETUP_OUTPUT` for the setup summary location.

`RAPIDRAW_FRESH_MACHINE=1` is an explicit runner declaration, appropriate only for an actually fresh host/VM with empty dependency/model caches. A run on an existing Mac does not establish Windows/Linux, installer, or fresh-machine support. The separate CI workflow runs only portable evidence/fixture contracts on all three OSes and labels those tests accordingly. Native GPU, model and photographic suites need suitable runners and recorded output before a platform can be marked verified.

## Fresh mask examples and native edges

The [fresh-mask runner](scripts/fresh-mask-e2e.mjs) preserves automatic first attempts for people, wildlife and sky boundaries. Build/connect the MCP and make its verified local mask models available before evaluation. Freeze and record the native executable, runtime source and execution-skill versions **before inspecting new capture groups**. The harness checks native executable/runtime/source preservation during its run; truthful prior-use and skill-freeze records remain the evaluator's responsibility.

Inspect only the original photograph or source-only native rendering when preparing annotations. Choose distinct capture groups and record acquisition provenance and original SHA-256 values. Establish positive interior, rejected background and manual edge regions, criteria and numeric bounds before mask inference; retain the finished manifest and its hash. Do not move a failed probe or redefine an edge criterion after inspecting the generated mask and call it the same first attempt.

Use a version-1 photographic manifest with these category/mask-kind combinations:

| Category | `mask_kind` | Useful native edge criteria |
| --- | --- | --- |
| `person-hair` | `foreground` or `subject` | Flyaway strands, dark neck hair, garment boundaries and adjacent background spill |
| `wildlife-feet-feathers` | `subject` | Complete feet/claws, feather tips, spaces between limbs/tail and perch rejection |
| `sky-architecture` | `sky` | Roof/façade edges, thin branches, small sky openings and foreground spill |

Each group requires `kind: "ai-mask"`, `partition: "fresh-holdout"`, one source and at least one annotation of each intent. Subject baselines require a guiding `region`; foreground/sky baselines do not accept an unused guide. The following single group illustrates the structure; add the other distinct categories for a three-photo evaluation. Paths, hashes, coordinates and thresholds are placeholders to replace from source inspection.

```json
{
  "version": 1,
  "groups": [{
    "id": "wildlife-edges",
    "kind": "ai-mask",
    "partition": "fresh-holdout",
    "category": "wildlife-feet-feathers",
    "mask_kind": "subject",
    "capture_group": "distinct-wildlife-capture",
    "provenance": "Original acquisition and prior-use record",
    "derived_from_same_image": false,
    "sources": [{"path": "/absolute/photos/original.CR3", "sha256": "REPLACE_WITH_ORIGINAL_SHA256"}],
    "region": {"x": 100, "y": 100, "width": 1800, "height": 1400},
    "review_criteria": ["Keep the entire visible bird", "Exclude the perch and background", "Retain feet and feather-edge gaps"],
    "annotations": [
      {"id": "body", "intent": "include", "region": {"x": 400, "y": 400, "width": 128, "height": 128}, "criteria": ["Solid body interior remains selected"], "minimum_opacity": 0.95},
      {"id": "background", "intent": "exclude", "region": {"x": 2000, "y": 200, "width": 128, "height": 128}, "criteria": ["Separate background stays clear"], "maximum_opacity": 0.05},
      {"id": "feet", "intent": "edge", "region": {"x": 500, "y": 900, "width": 512, "height": 512}, "criteria": ["Visible toes/claws are complete and adjacent perch is excluded"]},
      {"id": "feathers", "intent": "edge", "region": {"x": 1000, "y": 600, "width": 512, "height": 512}, "criteria": ["Fine feather tips and intervening background gaps remain distinguishable"]}
    ]
  }]
}
```

Annotation rectangles use integer full native mask-canvas pixels before crop, with a maximum of 2048 pixels per side; 512-pixel tiles preserve every requested pixel without resizing. Include annotations require an explicit `minimum_opacity`, and exclude annotations require `maximum_opacity`, both mean coverage in 0..1. Edge annotations require manual criteria and reject opacity thresholds: neither a dark nor a bright edge crop proves correct boundaries. Add more edge regions when one crop cannot represent the intended subject.

Run from the repository root with a new workspace. Omit `refinement` for a first-baseline-only evaluation:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
RAPIDRAW_PHOTO_MANIFEST=/absolute/fixtures/fresh-mask-manifest.json \
RAPIDRAW_WORKSPACE=/absolute/new/output/fresh-masks \
  node mcp/scripts/fresh-mask-e2e.mjs
```

Each `first-attempts/<id>` contains the frozen fixture description, editable state, matched photograph/overlay/grayscale overview and annotated native tiles, render metadata and `review-required.json` with native provenance and artifact hashes. The full original remains the inference input; only explicitly sized overviews are reduced. Original and sidecar integrity is checked independently. Numeric failures preserve all review outputs and continue the other independent cases; an unavailable transport explicitly marks remaining cases unattempted. Failed gates make the run fail even when other cases pass.

`mask-review-index.json` separates numeric outcomes from photographic review. Every baseline retains `status` and `photographic_quality: "not_reviewed"`, including when all probes pass. Review source detail, whole-subject omissions and spill beyond the annotated interiors, then save a separate named review with artifact hashes and criterion judgments. Publish these retained image comparisons through the chosen review application's manifest contract; the runner does not approve photographs.

An optional predeclared subject-only `refinement` accepts include/exclude points and an optional region. It runs after all first baselines, uses independent forked sessions and writes `corrections/<id>/point-refinement` records marked `regression`. Original baseline state and review records are checked unchanged. Adaptive corrections chosen after visual review also belong in separate regression work; they cannot replace the fresh first-attempt judgment. [Manifest/review contract tests](test/fresh-mask-contract.test.mjs) check these input and evidence boundaries separately from native processing or photographic quality.
