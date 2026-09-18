# Contributing to RapidRAW + MCP

Contributions to this fork should improve the photographic editing workflow while preserving the original RapidRAW application. The MCP bridge is optional: ordinary startup and the export CLI must continue to work without the `mcp` feature.

## Report an issue

Open [an issue in this fork](https://github.com/sheldonxxxx/RapidRAW/issues) for MCP behaviour or a problem reproduced with this fork. Include:

- The commit or build version, operating system, GPU/backend, and MCP client when relevant.
- The smallest reproducible sequence, expected result, actual result and exact error.
- Whether the problem occurs in the desktop editor, the export CLI, MCP, or more than one entry point.
- A permitted sample or redacted diagnostic when needed. Remove credentials, personal paths and identifying metadata before sharing it.

For an issue reproduced in the unmodified upstream application, use [upstream RapidRAW](https://github.com/CyberTimon/RapidRAW/issues). Camera decoder problems may belong to [dnglab/rawler](https://github.com/dnglab/dnglab/issues); missing lens calibration may belong to [Lensfun](https://github.com/lensfun/lensfun/issues). Include the relevant upstream issue when proposing a fork change.

Lightweft review and style workflows belong in [Lightweft](https://github.com/sheldonxxxx/lightweft/issues). Saved Insta360 media preparation belongs in [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit/issues). The projects can be used together, but have separate dependencies and contribution workflows.

## Make a focused change

Read the [native integration guide](MCP.md) before changing the bridge, and the [MCP contribution scope](#mcp-contribution-scope-and-acceptance) for its state, rendering and delivery contracts. Use the [desktop guide](docs/desktop-guide.md#build-this-fork) or [MCP setup guide](mcp/README.md#build-and-connect) to build the entry point you are changing.

Preserve original photographs and existing sidecars. Keep schemas aligned with native behaviour, reject unsupported fields, and retain revision guards and saved-state compatibility. Test scripts, images, models and credentials have different sharing requirements; include only fixtures you have permission to distribute.

## MCP contribution scope and acceptance

The MCP integration exposes RapidRAW's native editing engine through reversible sessions. Contributions should extend that editing workflow while preserving original photographs, existing sidecars, revision guards and saved-state compatibility. See the [native integration guide](MCP.md) for application boundaries. Desktop features the MCP does not expose are tracked in the [historical capability snapshot](docs/mcp/history/capability-matrix-2026-09.md); the live tool inventory is `rapidraw_capabilities`.

Contracts to preserve by editing area:

| Area | Contracts to preserve | Current guidance and checks |
| --- | --- | --- |
| Adjustments and native rendering | Executable schemas, visible control effects, high-precision processing, clipping overlays, exact preview caching and bounded large-image rendering | [Geometry and review](docs/mcp/geometry-review.md) |
| Selective edits | Consistent coordinates, matched mask/photograph views, atomic submask operations and revision-guarded AI refinement | [Subject refinement](docs/mcp/subject-refinement.md) |
| Sessions and reusable assets | Independent forks, portable dependencies/history/versions, selective copy and owned preset/LUT libraries | [Portable sessions](docs/mcp/portable-sessions.md) |
| Expensive operations | Captured inputs/settings/models, isolated workers, cancellation, durable results and explicit recovery | [Testing and evidence](docs/mcp/testing.md) |
| Delivery and setup | Accurate profile/codec reporting, independently decoded exports, verified local models and explicit environment requirements | [Remote SSH](docs/mcp/remote-ssh.md), [ONNX CUDA](docs/mcp/onnx-cuda.md) |
| Photographic review | Unchanged first attempts, source integrity, stated quality criteria and separate overview/native-detail judgments | [Testing and evidence](docs/mcp/testing.md) |

Acceptance distinguishes four evidence levels: schema/protocol tests establish argument handling and transport; actual SDK-to-native calls establish execution; state and decoded-pixel assertions establish their stated contracts; photographic acceptance additionally requires review against explicit image-specific criteria — a successful operation or numeric probe alone does not establish it.

Record the tested source and executable identities, preserve failed attempts and explicit skips, and keep results from different builds separate. Report actual results with reproducible scripts instead of private artifacts; the [September 2026 verification snapshot](docs/mcp/history/verification-2026-09.md) shows how prior results were recorded. Use genuine capture groups for HDR/focus/panorama claims, film scans for negative-conversion quality, and configured providers for remote-operation checks. Freeze the implementation before inspecting a fresh photographic holdout; previously inspected images remain regression inputs.

## Validate at the changed boundary

Choose checks from [the test instructions](docs/mcp/testing.md). Protocol tests exercise transport and arguments. Native tests exercise the engine. Decoded-pixel assertions check the stated rendering contract. A photographic quality claim also needs inspection of the actual output against explicit criteria.

For an MCP change, a useful starting point is:

```sh
npm test --prefix mcp
```

This includes a server build and uses a fake native subprocess for transport tests; it is not image-processing acceptance. Run the relevant real-engine suite for native behaviour. For a UI change, inspect the affected interaction and use the [UI benchmark](bench/README.md) when performance is the concern. Record skipped checks and platform limits accurately.

For frontend changes, run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Linting requires zero warnings. Frontend tests cover state transitions and native-call arguments with local fixtures; they do not run model inference. Type checking is separate from the production build, and both must pass. Run `npm run i18n:check` after changing translated interface text.

## Open a pull request

Explain the concrete problem, the resulting behaviour and the checks that ran. Identify limitations that matter to reviewers. Include a screenshot or rendered comparison when it demonstrates the change, with permission to share the content.

Review [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md) before submitting. Add relevant fork behaviour changes under **Unreleased**; do not imply they are packaged releases. Keep setup instructions and capability claims consistent with the final implementation, and make repository-relative documentation links resolve.

Describe any AI assistance plainly and review the submitted work. Contributions remain subject to the project's [AGPL-3.0 license](LICENSE).
