# MCP verification record

These dated results apply to the recorded builds and fixtures. They are historical evidence, not a passing test report for every later commit. The [Linux SSH guide](REMOTE-SSH.md) and [ONNX CUDA guide](ONNX-CUDA.md) describe a separately tested Debian/NVIDIA configuration; earlier entries retain their original platform boundaries. Use the [test instructions](testing-matrix.md) to produce evidence for your build.

## 2026-09-12 guided AI and manual local edits

Mask acceptance depends on the intended edit. A subtle subject lift needs visible tonal benefit without changing protected surroundings; extraction and strong recoloring need closer boundary precision. The strict fresh-mask findings below retain their original criteria and do not establish that automatic selections are unusable starting points for restrained local edits.

The [guided-mask workflow](../skills/rapidraw-mcp/references/guided-masking.md) combines useful AI selections with named additive/subtractive brush repairs, or starts an independent manual mask when the intended area is simpler. The [photographic regression runner](scripts/guided-mask-workflow-e2e.mjs) passed **118 actual MCP calls and 12 checks** on one inspected bird photograph: 116 successful results, two expected stale-revision rejections, nine pixel checks and three state checks, with zero unexpected failures or skips. The protocol/worker/evidence suite passed **103 tests**, including four guided-manifest contract tests.

The run used native executable SHA-256 `379ad99a9364c5238313cce65ecb4636a2545b4c0b10ba244d8934520d8e587b` and runtime-source SHA-256 `eee06e6cec1ccfdffbb36e4735aa14113564bd08e05d077986ba5ea4f68892f3`, matching the lens-correction build below. This is a reused photographic regression, not a fresh holdout. The earlier native-library result of 125 tests remains attributed to that unchanged build.

| Guided editing check | Measured result |
| --- | --- |
| Preserve the starting AI selection | Named version and independent correction fork retain the original mask, local grade and baseline pixels |
| Restore an omitted toe with an additive brush | Annotated mean coverage increases from 0.6103 to 0.9929; existing AI components remain unchanged |
| Remove selected perch with a subtractive brush | Annotated mean coverage falls from 1 to 0; existing grade and mask identity remain unchanged |
| Apply the actual local grade | Exposure 0.4 and shadows 8 change the selected breast probe by mean absolute RGB difference 0.08289; the protected perch probe is exactly unchanged |
| Create a manual mask independently | A brush-only soft breast lift applies the same grade, with the selected breast changed and protected perch exactly unchanged; no AI submask is present |
| History and saved editing | Both corrected-AI and manual sessions reject stale edits, restore exact state/pixels through undo/redo, and retain exact adjustment state and PNG bytes after save/reconnect, including captured native regions |
| Source preservation | Original and existing sidecar integrity checks pass |

Named AI review finds the corrected whole-bird lift and independent soft breast lift useful at overview size, with no conspicuous grade halo in the viewed contact details. A separate native 512×512 review of the manual brush transition shows a smooth interior lift while retaining the source outline and neighboring background. The manually restored toe remains a painted approximation with some fine background spill; **this is acceptance of the restrained local edit, not complete-matte approval or a claim of recovered anatomical detail**. The numerical probes cover only their annotated regions. Optional point refinement is supported by the runner but was not exercised in this brush-focused run; its evidence remains in the separate point-refinement record. [Reproduction and review instructions](testing-matrix.md#guided-ai-and-manual-mask-edits) keep contract assertions, photographic review and user approval separate.

## 2026-09-12 fresh masks and automatic lens matching

Three new RAW capture groups test foreground hair, a guided bird subject, and sky around fine branches and a building. Engine and execution/review skills were frozen before the selected photographs were inspected; native source-only review then fixed 23 inclusion, exclusion and edge annotations before inference. Originals were checked against download size/checksum and independent SHA-256, with prior source/capture exclusions. These are first-attempt mask observations, not refinements of the earlier bird fixture. Reproduction uses the [fresh-mask runner](scripts/fresh-mask-e2e.mjs) and [annotation contract](testing-matrix.md#fresh-mask-examples-and-native-edges).

The mask run uses native executable SHA-256 `42bc39183ddcfa94f6da060c0bd24268ed657113432fc4fa3000b890f65ee602` and runtime-source SHA-256 `771035a2d8e5090311c835a775ff3059ea7cee47f0a38c828e41bc907ef8ea0a`. It completed **53 successful native MCP calls**, including three mask generations and 40 matched renders. The preserved output contains 120 PNGs: three overview triplets and 37 native-region triplets, with no resizing of native detail. Thirteen predeclared interior/background mean-opacity probes produce 11 passes and two failures. Those numerical results do not approve any complete mask.

| Fresh mask | Probe result | Independent AI review of native edges |
| --- | --- | --- |
| Person foreground | Three probes pass | Fails: fine crown/neck flyaways are omitted, some hair gaps fill in, and a background pole touching the head is included. The separately sampled pole is correctly excluded; passing that probe does not establish complete background rejection. |
| Guided bird subject | Five probes pass; left toe and wing–tail opening fail | Fails: the left-toe probe has only 20.22% coverage and the background opening retains 10.54%. Native detail also shows perch spill, incomplete claw selection and filled feather gaps. Many feather tips remain, but the complete matte is inadequate. |
| Sky around branches/building | Three probes pass | Fails: coarse block boundaries merge foliage, lose internal sky openings and include thin outer branches as sky. Roof exclusion passes. The roof mostly meets foliage, so this does not establish an isolated architectural edge against open sky. |

All 53 calls completed, but the original suite **failed during editable-state evidence finalization** because a summary-only session response omitted adjustments. It is excluded from passing aggregates. The corrected runner requires full adjustment state, and four separate read-only MCP calls verified all three saved sessions without repeating inference. An independent audit checked all 163 declared image/metadata/state artifacts, recomputed every probe, and confirmed unchanged session/sidecar files and originals. This recovery verifies the retained evidence; it does not change the original suite's failed status or grant visual-review credit.

These are scoped AI observations, not photographer approval. Source noise and optical softness are recorded separately from mask omissions, spill and block boundaries. Fine-edge research is conditional on the requested editing precision and the limits of guided corrections; see the [gap assessment](GAP-ASSESSMENT.md).

### Lens aperture correction

A real wide-angle RAW has a matching installed Canon RF-S 18–150 mm profile, with distortion, chromatic-aberration and vignetting calibration. Its unmodified camera/lens metadata supplies the automatic lookup. The lens fixture was preview-inspected before the freeze could be established and is explicitly an acceptance/regression photograph, not a blind photographic holdout. Native source review precedes the first correction.

Inspection found the resolver preferred `ApertureValue` over `FNumber`, treating its logarithmic value as an f-number and ignoring an MCP aperture override whenever both fields existed. EXIF defines `ApertureValue` in APEX units. [CIPA specification](https://cipa.jp/std/documents/e/DC-X010-2017.pdf). The [resolver](../src-tauri/src/file_management.rs) now prefers a finite positive `FNumber`; if unavailable, it converts the APEX fallback using `2^(Av/2)`. Existing metadata strings remain intact. Three native regressions verify actual calibration-row selection, override precedence and invalid-value fallback.

This correction uses native executable SHA-256 `379ad99a9364c5238313cce65ecb4636a2545b4c0b10ba244d8934520d8e587b` and runtime-source SHA-256 `eee06e6cec1ccfdffbb36e4735aa14113564bd08e05d077986ba5ea4f68892f3`. The preceding fresh-mask record remains attributed to its original frozen build. Native library tests pass **125 cases**, including both Metal tests; direct Node protocol/worker/evidence tests pass **99 cases**. Clippy with and without MCP, MCP ESLint and the locked/offline native build pass.

The final [real-lens suite](scripts/lens-profile-photo-e2e.mjs) passes **67 actual MCP calls and nine checks**: 66 successful calls, one passing stale-revision rejection, seven pixel checks and two state checks, with zero failures or skips. Automatic selection uses only the RAW's own EXIF, then compares the returned coefficients with independently inspected installed XML. Separate distortion, TCA and vignette controls change their intended pixels; all-disabled correction reproduces the baseline exactly. Distortion moves the sampled coordinates by up to 27.924 pixels with a maximum roundtrip error of 0.003143 pixels. Isolated TCA leaves the green channel exact, and vignette correction lifts the sampled corner more than the center.

An explicit f/8 override selects the database's nearest f/7.1 vignette calibration despite the original aperture metadata, changes pixels and undoes exactly. Original automatic-profile rendering survives save/restart and portable bundle import with **exact 1024-pixel overview pixels** and unchanged original bytes. Native 512-pixel before/after detail is captured and reviewed separately; native-detail restart parity is not claimed. Stored coefficient comparison allows a maximum `1e-12` JSON roundtrip difference, while rendered-pixel equality remains exact.

All 11 final PNGs match the preceding corrected-build artifacts byte for byte. Named AI review finds continuous geometry and gradual corner brightening, with no obvious new local structural break in the viewed door/rail regions. **Residual red/green fringing remains, and the rail is already soft/noisy in the source.** This establishes a genuine automatic match, correct parameter application and persistence; it does not establish calibrated optical accuracy or complete photographic correction. The fixture instructions and reproduction manifest are in [the lens test guide](testing-matrix.md#automatic-lens-profile-photographs).

## 2026-09-12 focused follow-up

The fork adds [point-guided subject refinement](SUBJECT-REFINEMENT.md), schema-aware coverage attribution, explicit derived-state checks and focused rendering/photographic regressions. The tool count remains 62. New point fields and saved SAM state extend the newer inventory; the older broad acceptance below remains a separate build record.

The focused rendering and refinement runs used native executable SHA-256 `7216e7086fca9a2b8bd3214c42b541d4dfe71bcd5d4ceed12dbdb29423bac174` and runtime-source SHA-256 `988de4d6be5ecad9db6f685869d1b8e1f7bd225b172c321aabbc6fd8c39c993c`.

| Check | Result |
| --- | --- |
| Full native library tests, including both explicitly enabled Metal tests | 114 passed; zero failed or ignored |
| MCP TypeScript build and protocol/worker/evidence tests | 93 passed; zero failed or skipped |
| Focused native rendering acceptance | 353 MCP calls: 350 successes and 3 passing expected errors; 26 pixel scenarios and 3 derived-state checks; zero failures/skips |
| Point-refinement native contract acceptance | 284 MCP calls: 267 successes and 17 passing expected rejections; 23 pixel scenarios and one native-state check; zero failures/skips |
| Full-resolution wildlife refinement regression | 28 successful MCP calls; all six annotated inclusion, exclusion and preservation probes passed; photographic limits below |
| MCP source, scripts and tests ESLint | Passed |
| Clippy all targets with and without MCP, warnings denied; Rustfmt and whitespace checks | Passed |

Signed SAM prior conversion previously clamped logits to the image range, causing a full-resolution correction to recover the tail while dropping the body and selecting background. The repaired conversion preserves signs and amplitudes, with an explicit native regression. Failed photographic attempts remain separate from the corrected acceptance below.

The corrected 32 MP wildlife regression recovers both annotated tail areas from zero selection to approximately full selection, removes the annotated twig from approximately full selection to zero, preserves crown/breast selection and keeps the background probe clear. An independent AI review verified all 66 final artifact hashes and inspected the overview and native crown details. The final images are byte-identical to the preceding corrected regression; supplemental native foot/tail detail from that earlier run confirms remaining lower-foot omission, partial upper claws and filled gaps between tail feathers. **The scoped tail/twig improvement passes; the complete matte is not approved.** Fine feather edges remain soft. These are reused regression images, not a fresh holdout or human sign-off.

Refinement also preserves grow/feather outside the legacy prior, composites retouch patches into the inference image, rejects incompatible source/session/submask placement changes, and supports hidden/zero-opacity targets without confusing final composition with generated subject selection. Native pixel and state tests cover these boundaries. A deterministic worker test reproduces and fixes starting the next operation after the previous one reports terminal status while its native process is still closing.

Distinct rendering tests also found that zero-strength lens correction could force interpolation and change border pixels. Distortion, TCA and vignette predicates now use their effective controls: zero strength or neutral coefficients preserve exact pixels/precision, including when another geometric transform is active. Positive controls still change interior pixels.

The combined rendering, point-contract and wildlife regression record contains **665 actual MCP calls and 54 explicit checks**, with zero failed/skipped checks. Of the calls, 645 succeeded and 20 were passing expected rejections. Its 1,946-requirement inventory has 478 direct-input/native-call rows, 14 native-assertion rows, 82 pixel-assertion rows and six derived-state rows; these levels overlap, and 1,456 requirements still lack evidence in this focused subset. It is not merged with the older broad build. [Rendering oracles](scripts/distinct-rendering-e2e.mjs), [point contracts](scripts/point-refinement-e2e.mjs), [photographic probes](scripts/mask-refinement-quality-e2e.mjs).

Historical coverage repair uses the original 15 successful ledgers and original 1,893-row inventory: native-call rows **657 → 664**, requirements without evidence **1,226 → 1,219**. Calls, state assertions and pixel assertions are unchanged; reclassification is report repair, not a new native run. [Reclassification implementation and safeguards](scripts/reclassify-coverage.mjs).

### Panorama repair and final native validation

The subsequent panorama and numeric-validation fixes use native executable SHA-256 `42bc39183ddcfa94f6da060c0bd24268ed657113432fc4fa3000b890f65ee602` and runtime-source SHA-256 `771035a2d8e5090311c835a775ff3059ea7cee47f0a38c828e41bc907ef8ea0a`. The earlier 665-call rendering/refinement record remains a separate build; it is not silently attributed to this executable.

| Check | Result |
| --- | --- |
| Full native library tests, including both explicitly enabled Metal tests | 122 passed; zero failed or ignored |
| MCP TypeScript build and protocol/worker/evidence tests | 93 passed; zero failed or skipped |
| Native panorama contracts | 10 actual MCP calls and four checks passed; includes three expected error cases and a 901×421 low-contrast three-panel merge with exact restart pixels |
| Genuine full-resolution panorama regression | 30 successful MCP calls and three checks; two adjacent 4032×3024 originals produce 9455×7124, with exact overview and native-detail pixels after restart |
| Clippy all targets with and without MCP, warnings denied | Passed |
| Native locked/offline build, MCP ESLint, Rustfmt and whitespace checks | Passed |

A genuine three-frame drone capture failed its preserved first attempt: the original detector found only 15–56 features per image and could not match the overlapping panels. The same-resolution normalized fallback finds 1,198–1,813 features, recovering 376 and 287 inliers on the adjacent pairs without relaxing ratio, RANSAC or inlier thresholds. Existing accepted match edges are retained. A central matched reference avoids the reference-plane crossing exposed by anchoring the wide sequence at an endpoint; singular/non-finite transforms and remaining plane crossings are rejected.

MCP panorama merges now require every input to connect. A disconnected image can no longer be silently omitted while its session is listed as a contributing source. The desktop retains its partial-result warning behavior. A projected-canvas check enforces the MCP 100 MP budget before allocation. The genuine three-frame scene projects to approximately 105.4 MP and passed the explicit `PANORAMA_CANVAS_TOO_LARGE` rejection check; it has no stitched-image quality approval. The [panorama contract suite](scripts/panorama-contract-e2e.mjs) also checks disconnected and featureless controls. Seven native CPU regressions cover the detector, graph, projection and budget boundaries.

The two adjacent full-resolution originals have a 31.5-degree recorded yaw difference and meaningful shared scene overlap. Their 67.36 MP stitched canvas expands to 2.345 times one input's width, includes useful new scene content and retains uncovered borders. The full-resolution source group, failed first attempt and narrower regression remain separately recorded; no same-image crops or resized substitutes supplied the photographic merge. The two final panorama suites combine into **40 actual MCP calls and seven checks**, with 37 successful calls, three passing expected rejections and zero failures/skips. They cover 25 direct-input/native-call requirements, two native-assertion requirements and four pixel-assertion requirements in the 1,946-row inventory. This is a focused panorama record, not full application coverage.

Independent AI visual review confirms added scene coverage and retains the corresponding house, windows, parked cars, road junction and trees without conspicuous doubling or breakage. Supplemental native sky/horizon strips show a gradual tonal gradient and locally continuous ridge, without an abrupt step or obvious doubled horizon in those regions. Four additional native render reads preserved all five session manifests and remain outside the acceptance aggregate. **The complete panorama is not approved:** strong rightward projective stretching, softer right-side sampling and large uncovered wedges remain. Projection/framing improvements and broader parallax/exposure testing are listed in the [gap assessment](GAP-ASSESSMENT.md). This is a scoped AI review, not human approval or a guarantee of seamless full-raster output.

The final validation pass additionally found decimal-encoded saved SAM canvas dimensions could pass generic integer validation and panic during native extraction. They now return an explicit validation error, with a regression for each dimension and invalid ranges.

Film-negative photographic quality remains unverified. Existing mechanical negative-conversion tests do not establish it.

## 2026-09-12 workflow expansion

The local fork now exposes 62 MCP tools: 57 native methods and five host worker methods. Native bridge 1.2.0 adds portable sessions, selective edit copying, workspace presets/LUTs, geometry and sampling diagnostics, matched mask reviews, bounded preview caching, explicit export profiles, and isolated workers for expensive operations. The [full application/MCP table](CAPABILITY-MATRIX.md) identifies desktop-only areas that remain outside this editing expansion.

This run uses macOS arm64/Metal, Rust 1.98.1, the official MCP v2 client and server, and a debug native executable. Native executable SHA-256: `5bed70144ab1d48d61c7f1d901ebc7129c3d5cefb9b8c6d805eb5c61defa366a`. Runtime-source SHA-256: `156a1df83a594e9fc3543363e9a4d0fe5fb16d8083702749f8ddf76df0dfd6b6`. Suite and documentation changes are recorded separately from runtime sources. The results below summarize the recorded run; generated artifacts, source photographs and model weights are not distributed with this repository. Reproduce the checks with the [test-suite instructions](testing-matrix.md#running-the-suites), using your own fixtures where required.

| Check | Result |
| --- | --- |
| Native library tests, including both explicitly enabled Metal tests | 102 passed, zero failed/ignored |
| MCP TypeScript build and protocol/worker/evidence tests | 77 passed, zero failed/skipped |
| Native locked/offline debug build | Passed |
| Clippy all targets with MCP, warnings denied | Passed after the final native preview correction |
| Clippy all targets without MCP, warnings denied | Passed; subsequent native changes are confined to the MCP-only render module |
| Final native MCP acceptance | 1,490 calls across 15 ledgers / 14 suites; all 62 tools have successful calls; 202 explicit checks |
| Fresh photographic regressions | Seven operations completed, 366 calls, zero technical failures/skips; separate visual outcomes below |
| Exact RAW preview cache | 32 MP RAW: 21.54 ms cached versus 5.335 s uncached, identical bytes, edit invalidation and undo equality; one local sample |
| Final MCP source/scripts/tests ESLint, Rust fmt, whitespace checks and skill validation | Passed |

### Defects found by actual execution

The acceptance work found and repaired several defects that schema-only tests would miss:

- Color-profile tests now inspect the actual embedded ICC bytes, D50 adaptation, tag bounds/alignment and independent ColorSync-reference transforms. JPEG/PNG/TIFF/WebP exports carry the verified sRGB profile under their documented policy; unsupported explicit profile requests fail clearly.
- JPEG XL tests exposed invalid portrait/multigroup output. Opaque lossy output retains its quality mapping; quality 100 and affected transparent images use a verified lossless compatibility encoder. Transparent fallback returns an explicit warning. Independent macOS ImageIO decodes the raster, with exact lossless pixel comparisons.
- A 25,184×256 source exposed aspect-ratio rounding during export resizing. Width 1024 now yields exactly 1024×10, with a minimum 1-pixel companion axis. Native tests cover the mirrored case and 16-bit retention.
- Large-image rendering now uses full-image coordinates through streaming tiles, including effect halos, local-only flare and tall-image blur overlap. Metal tests compare native sampled pixels and tile boundaries rather than accepting nonempty output.
- Operation workers capture verified model files with their source/settings snapshot. Result import, cancellation, restart/resume, model corruption, source isolation and parent-edit independence are tested separately.
- A real portrait mask review produced a 17,771,270-byte MCP response and closed the default 10 MiB SDK transport. The [native response-budget regression](scripts/response-budget-e2e.mjs) now checks this failure boundary. Color review previews now consistently use 8-bit display encoding while native processing/export precision remains unchanged. The server enforces an 8 MiB JSON-RPC response budget, returns `RESPONSE_TOO_LARGE` with bounded recovery IDs/revision, and keeps the connection usable. Completed mutations are never automatically replayed. Tests cover images, UTF-8 metadata, resources, long errors and prompt inputs; review runners tile native details without resizing them.

### Final native and photographic evidence

The recorded acceptance results were combined using the checked-in [coverage aggregator](scripts/coverage-report.mjs) and its strict native-tool gate. Of 1,490 calls, 1,453 succeeded, 35 were passing expected-error checks and two were explicit optional skips: an unconfigured generative provider and an unmatched automatic lens profile for that fixture. Every advertised tool has at least one successful native call. The final native transport regression generated a 19,228,311-byte response, received the bounded error, then rendered/edited successfully on the same connection with unchanged pre-edit revision.

The original inventory is preserved by [historical reclassification](scripts/reclassify-coverage.mjs); no calls or pixel assertions were added by the repair. The inventory includes 62 tool requirements, 482 parameter requirements and 1,349 nested adjustment requirements. All tool requirements have evidence; 161 parameter and 1,058 adjustment requirements still lack evidence after schema-aware historical reclassification corrected seven retouch paths. Across overlapping evidence levels, 664 requirements have native-call evidence, 87 have explicit state assertions and 171 have pixel/delivery assertions. Do not add these overlapping counts or interpret tool coverage as exhaustive parameter coverage. The automatic ledger gives no visual-review credit; named AI reviews of actual artifacts are stored separately.

| Real photographic fixture | Visual outcome |
| --- | --- |
| Portrait foreground mask | Needs refinement: main person is selected, but fine flyaway hair is omitted |
| Guided wildlife subject mask | Fails stated criteria: tail omitted despite lying inside the guide, and perch pixels included; the guide may also be tight around the lower foot |
| Building sky mask | Partial: broad separation works, but architectural edges are coarse/soft with slight facade spill |
| Macro depth mask | Passes coarse separation/no-hole criteria in reviewed areas; weak background residuals remain, and silhouette quality is not established |
| Two-frame mountain panorama | Passes this limited overlap case at overview plus four native detail regions; 8431×6820 output retains uncovered borders requiring a finishing crop |
| Full-resolution portrait AI denoise | Passes reviewed face/glasses/hair/snow regions with noise reduction and no obvious geometry/tonal drift |
| Full-resolution 32 MP wildlife BM3D | Passes reviewed crown/eye details with moderate noise reduction and preserved feathers; no full-raster quality guarantee |

The table above summarizes AI visual reviews, not human sign-off. Reviews recorded artifact hashes, native/runtime provenance, criteria, defects and limitations. Five supplemental native-detail reads preserved the existing session manifests and are not added to the strict aggregate. The [photographic runner](scripts/photo-quality-e2e.mjs) and [fixture/review instructions](testing-matrix.md#genuine-photographic-evaluation) describe how to create a separate review record with your own images.

The reported passing aggregate excludes unsuccessful attempts. The [evidence harness](scripts/coverage-evidence.mjs) preserves first attempts, and the [aggregator](scripts/coverage-report.mjs) rejects failed suites and mixed builds.

### What the evidence does and does not establish

Each acceptance call crosses the real SDK→stdio server→native executable boundary. Parameter coverage, state assertions, pixel assertions and photographic review remain separate. The generated inventory has 1,893 schema-derived requirements; invoking every public tool does not establish every nested parameter, enum or adjustment combination. The aggregation command rejects failed/incomplete ledgers and mixed runtime/binary provenance.

Photographic originals were verified against server byte length/SHA-1 and independent SHA-256. Their original hashes and sidecar existence/hashes are checked again after execution. These photographs were inspected during development and are regression fixtures, not blind holdouts. The two mountain frames have near-total overlap and establish only that limited alignment case.

Genuine HDR exposure brackets, genuine focus brackets, a negative-film scan, a configured remote generative provider, and fresh-machine Windows/Linux/native acceptance remain unverified. Reproducible runners and explicit fixture/environment gates are implemented; an unavailable fixture or provider is not counted as passed. The local model download test independently verified a fresh 106 MiB model download, repair of a corrupt owned target, SHA-256 and cached repeat on the preceding native build; it is reported separately from the final-build aggregate.

The frontend was not changed by this expansion. Earlier unchanged-base TypeScript/lint diagnostics remain documented below; the current native/protocol checks do not establish a globally clean frontend, release packaging, or successful installation into every MCP host.

## Earlier 2026-09-12 macOS build and connection checks

Rebuilt the source checkout on macOS after reinstalling both Node dependency sets with `npm ci`. The native debug executable, frontend production build, and native check with the MCP feature disabled passed. The MCP TypeScript build and all 25 protocol/client tests passed; native library tests passed 70 cases with the existing GPU-specific test left ignored.

The real `test:review-jobs` acceptance script passed through the rebuilt binary on a local CR3 original in an isolated workspace. It checked native comparison output, exposure diagnostics, named-version restoration, asymmetric gradients, BM3D completion/cancellation, editing during a worker job, captured-edit inheritance, restart/resume, result persistence, and unchanged original SHA-256. The optional AI-model branch was not rerun; its earlier evidence remains below. This run verifies execution and persistence, not a new aesthetic evaluation.

Targeted MCP/client ESLint passed. Frontend typecheck still reports 76 diagnostics, and ESLint on the two changed frontend files still reports 120 diagnostics. A fresh archive of the unchanged base revision produces the same normalized diagnostic sets; this update adds none. The frontend checks are not globally clean.

The public setup documentation now includes Skills CLI installation, a macOS debug-build quick start, and explicit Windows/other-platform limits. Installing a skill does not configure a host connection. Windows, Linux, packaged releases, and a fresh machine installation were not tested in this run. Reproduction instructions are in the [setup and verification guide](README.md#verification).

## 2026-09-11 comparison and background-job update

Native bridge 1.1.0 now advertises 47 tools. Implemented combined local exposure diagnostics and actual RGB differences, temporary matched comparisons, durable named references, smooth/asymmetric gradient fades (native engine, schema and desktop controls), and recoverable AI/BM3D jobs. The maintained and installed execution skills were updated and validated.

| Check | Result |
| --- | --- |
| Native MCP library tests | 70 passed; 1 existing GPU test remains intentionally ignored |
| MCP TypeScript build and protocol/schema tests | 25 passed |
| Native debug executable and frontend production build | Passed |
| ESLint on changed MCP source, protocol tests and new acceptance script | Passed |
| Real MCP comparison/job acceptance, including AI | Passed |
| Saved night-photo review regression | Both sessions retained identical state, source and sidecar hashes |
| Execution skill validation and installed-file matching | Passed |
| Frontend TypeScript diagnostics | 76, identical to unchanged HEAD after normalizing line positions and generated translation-key union counts |
| Translation runtime diagnostics | 88, identical to unchanged HEAD |

The real acceptance script tests four distinct native comparison images with matched geometry and unchanged manifests/sidecars, geometry rejection, native gradient output, version restoration after the 32-entry undo history is exceeded, stale-revision rejection, AI/BM3D completion and cancellation, editing/rendering while a worker runs, captured-edit inheritance, result persistence without polling, interruption detection, explicit restart, and preservation of explicitly closed result sessions. AI tests use a 64-pixel native export and verified already-installed assets. They validate worker behavior, not full-resolution denoise quality or star preservation. BM3D tests use a 512-pixel native export for completion and a 2400-pixel source for interruption/cancellation.

Read-only inspection and temperature comparisons also ran on the two prior night-photo sessions: photo 1 revision 11 (2400×1600) and photo 2 revision 59 (6960×4640, retained RAW interpretation). Their unchanged edits rendered successfully at 1000 pixels; diagnostic and comparison outputs were visually inspected. These are compatibility checks, not newly accepted photo edits. Desktop controls passed the production build; pointer interactions were not automated.

Reproduce the [comparison/job acceptance suite](scripts/review-jobs-e2e.mjs) with `npm run test:review-jobs --prefix mcp` after setting the binary, fixture and workspace variables in the [verification guide](README.md#verification); add `RAPIDRAW_TEST_AI=1` for installed-model AI coverage. The version-2 read-only contract fixture has ten checked reference answers; no autonomous language-model benchmark was run.

A workspace permits one denoise worker. Cancellation waits for native work boundaries; process interruption requires explicit restart from the captured input, with recomputation. Windows, Linux and a packaged release were not tested in this update.

## Earlier validation record

Verified on 2026-09-10 on macOS with Metal, Rust 1.98.1 and the optional `mcp` feature. The tested native executable was a debug build. Evidence and private photos remain in ignored local workspaces; no source photos, generated images, model binaries or credentials are included in the repository.

## Build and protocol

| Check | Result |
| --- | --- |
| Frontend production build | Passed |
| Native MCP build | Passed |
| Native library tests with MCP | 59 passed, 1 GPU integration test intentionally ignored |
| Explicit Metal precision suite, including ignored test | 5 passed |
| Native check with MCP feature disabled | Passed |
| MCP TypeScript build and official-client protocol tests | 18 passed |
| ESLint for MCP source and acceptance scripts | Passed |
| Read-only evaluation answer/reference consistency | 10 answers verified |

The protocol tests exercise real SDK v2 and SDK v1.30 clients, including the MCP 2025 initialize handshake, against a fake native subprocess. They verify tool schemas, resources, prompts, native image blocks, actionable errors, serialization, cancellation, timeouts and shutdown. They are not image-processing tests. The ten evaluation questions test understanding of the recorded contract; they are not an autonomous model or artistic-quality benchmark.

The separate frontend typecheck still reports errors in unchanged upstream TS/TSX files. No frontend implementation files were changed. Windows, Linux, a packaged release build and installation into a particular MCP host were not tested in this run.

## Real native engine acceptance

All calls below used an official MCP client, the TypeScript stdio server, and the compiled native bridge.

| Suite | Evidence and result |
| --- | --- |
| Core RAW workflow | 65 calls on two CR3 originals: open, original/edited/detail/mask renders, actual pixel changes, validation and stale revisions, history, metadata, recipe/session persistence, restart, exports, partial batch errors and overwrite protections |
| Local AI and composition | 58 calls: subject/foreground/sky/depth masks, depth-driven blur, clone/heal/retouch/liquify/local inpaint, AI and BM3D denoise, negative conversion, lens lookup/error handling, HDR/focus/panorama and persistence |
| Assets and delivery | 62 calls, 17 checks, zero skipped cases: auto-adjust/undo, orientation/crop/ROI, recipe roundtrip, installed preset migration, local curve create/update/remove pixel changes, CUBE precision, owned LUT portability/restart, resize modes, watermark, mask exports, six raster formats and source protection |
| Linear denoise regression | 21 calls: zero-strength exact no-op, retained recipe and RAW interpretation, highlight headroom, actual noise reduction, reconnect render identity and AI-generated local curve rendering |

Original RAW files and their existing sidecars retained identical hashes and existence. Advanced tests also verified that all seven installed ONNX model files were unchanged. Model installation reused verified local assets; a fresh network download was not exercised. External generative retouch was not configured or called; only its invalid/unconfigured request handling was checked.

The broad AI/merge tests used small exports from the RAW sample to keep inference bounded. HDR/focus used repeated source fixtures to validate operation and preservation, not genuine exposure-bracket or focus-bracket photographic quality. A separate panorama test used overlapping crops offset by 448 pixels, found 71 inliers and produced a visually continuous stitched result. The four-point native homography repair has four mathematical regressions and is isolated in its own commit.

The denoise regression uses a synthetic 96×64 float TIFF, with only its isolated test manifest marked as linear RAW. It tests the same source-domain state without claiming full-resolution CR3 inference quality. At strength 25, both filters retained values above 1.0; measured noise standard deviation fell about 18–25%, with mean linear drift below 0.0006 on the fixture. This is a regression measurement, not a general denoising-quality claim.

## Precision and export

Both full-resolution masters decoded as 6960×4640 RGB16 TIFFs. Their rasters contained 65,536 and 65,313 distinct values, respectively; sample inspection rejects merely expanded 8-bit output. The 33³ CUBE test found 91,343 channel values off the 8-bit grid. The Metal suite additionally covers a narrow high-precision ramp, tile boundaries and cropped regions.

JPEG, PNG and WebP metadata were independently inspected with ImageMagick, including the repaired WebP extended header. TIFF, AVIF and JXL report unsupported metadata retention honestly with `metadata_applied: false` and warnings. The native AVIF verifier checks the container; the acceptance script additionally used ImageMagick to decode it. JXL was decoded by the native decoder because the installed ImageMagick lacks its delegate. A zero-skipped acceptance summary does not imply an independent decoder exists for every format.

## Visual proof and remaining limits

A restrained edit of a wildlife CR3 photograph was reviewed at overview and native head-detail scale, with the local mask inspected separately. It was refined and exported as a 2700×1800 JPEG at quality 95 and a full-resolution RGB16 TIFF. The editable recipe and working `.rrdata` were retained. This demonstrates one completed host-agent workflow, not guaranteed professional results for arbitrary photographs.

The earlier server exposed 37 tools and the `pro_photo_edit` workflow prompt. A vision-capable host model must still inspect images and make artistic decisions; the MCP server does not run its own language model. Previews currently render at full resolution before resizing, so large RAW files can take several seconds per review.

Original RAW working copies and ordinary sidecars support GUI continuation. Linear denoised TIFF intermediates require their saved MCP session to preserve RAW interpretation; opening one directly in the GUI can change its appearance. Use MCP export for a portable display image.

See [setup and reproducible acceptance commands](README.md#verification), [native build/integration checks](../MCP.md#build-and-verify), and the [testing matrix](testing-matrix.md) for current runners, fixture requirements and report generation. Use a new workspace for each run.
