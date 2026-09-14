# MCP contribution scope and acceptance

The MCP integration exposes RapidRAW's native editing engine through reversible sessions. Contributions should extend that editing workflow while preserving original photographs, existing sidecars, revision guards and saved-state compatibility. See the [integration guide](../MCP.md) for application boundaries and the [capability matrix](CAPABILITY-MATRIX.md) for desktop features that the MCP does not expose.

## Editing areas

| Area | Contracts to preserve | Maintained guidance and checks |
| --- | --- | --- |
| Adjustments and native rendering | Executable schemas, visible control effects, high-precision processing, clipping overlays, exact preview caching and bounded large-image rendering | [Geometry and review](GEOMETRY-REVIEW.md), [distinct rendering tests](scripts/distinct-rendering-e2e.mjs), [large-image tests](scripts/large-image-e2e.mjs) |
| Selective edits | Consistent coordinates, matched mask/photograph views, atomic submask operations and revision-guarded AI refinement | [Subject refinement](SUBJECT-REFINEMENT.md), [geometry tests](scripts/geometry-review-e2e.mjs), [refinement contracts](scripts/point-refinement-e2e.mjs) |
| Sessions and reusable assets | Independent forks, portable dependencies/history/versions, selective copy and owned preset/LUT libraries | [Portable sessions](PORTABLE-SESSIONS.md), [portability tests](scripts/portable-sessions-e2e.mjs), [asset tests](scripts/asset-e2e.mjs) |
| Expensive operations | Captured inputs/settings/models, isolated workers, cancellation, durable results and explicit recovery | [Worker tests](scripts/operation-jobs-e2e.mjs), [denoise tests](scripts/denoise-e2e.mjs), [RAW performance checks](scripts/photo-performance-e2e.mjs) |
| Delivery and setup | Accurate profile/codec reporting, independently decoded exports, verified local models and explicit environment requirements | [Export interoperability](scripts/export-interoperability-e2e.mjs), [setup checks](scripts/fresh-setup.mjs), [model/provider checks](scripts/model-provider-e2e.mjs) |
| Photographic review | Unchanged first attempts, source integrity, stated quality criteria and separate overview/native-detail judgments | [Photographic evaluation instructions](testing-matrix.md#genuine-photographic-evaluation), [photographic runner](scripts/photo-quality-e2e.mjs), [refinement probes](scripts/mask-refinement-quality-e2e.mjs) |

## Acceptance for a change

Use the [test instructions](testing-matrix.md#running-the-suites) to select checks for the affected behavior. Schema/protocol tests establish argument handling and transport. Actual SDK-to-native calls establish execution. State and decoded-pixel assertions establish their stated contracts. Photographic acceptance additionally requires review against explicit image-specific criteria; a successful operation or numeric probe alone does not establish it.

Record the tested source and executable identities, preserve failed attempts and explicit skips, and keep results from different builds separate. The [evidence recorder](scripts/coverage-evidence.mjs) generates the per-tool/parameter inventory; the [aggregator](scripts/coverage-report.mjs) rejects incomplete, failed or mixed-build suites. Report actual results in the [verification record](VERIFICATION.md), linking to reproducible scripts instead of private artifacts.

Use genuine capture groups for HDR/focus/panorama claims, film scans for negative-conversion quality, and configured providers for remote-operation checks. Preserve explicit skips when required fixtures, providers or platforms are unavailable. Procedural fixtures and repeated-source merges remain useful mechanical tests but cannot substitute for those photographic checks.

Freeze the implementation before inspecting a fresh photographic holdout. Previously inspected images remain regression inputs. Validate Windows, additional Linux configurations and fresh-machine installation on those actual environments before expanding the existing [macOS](VERIFICATION.md) and [Debian/NVIDIA](REMOTE-SSH.md) test claims. The [gap assessment](GAP-ASSESSMENT.md) records priorities and remaining acceptance boundaries.
