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

Read the [native integration guide](MCP.md) before changing the bridge, and the [contribution scope](mcp/IMPLEMENTATION-PLAN.md) for its state, rendering and delivery contracts. Use the [desktop guide](docs/desktop-guide.md#build-this-fork) or [MCP setup guide](mcp/README.md#build-and-connect) to build the entry point you are changing.

Preserve original photographs and existing sidecars. Keep schemas aligned with native behaviour, reject unsupported fields, and retain revision guards and saved-state compatibility. Test scripts, images, models and credentials have different sharing requirements; include only fixtures you have permission to distribute.

## Validate at the changed boundary

Choose checks from [the test instructions](mcp/testing-matrix.md). Protocol tests exercise transport and arguments. Native tests exercise the engine. Decoded-pixel assertions check the stated rendering contract. A photographic quality claim also needs inspection of the actual output against explicit criteria.

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
