# RapidRAW + MCP

**Give your AI agent a native, reversible photo editor.**

This independent fork of [RapidRAW](https://github.com/CyberTimon/RapidRAW) adds an optional Model Context Protocol (MCP) interface to its GPU-accelerated RAW editor. An agent can inspect a photograph, adjust light and colour, refine masks, compare rendered alternatives, and export a finished image while preserving the original and its existing sidecar.

Use RapidRAW on its own, connect it to your preferred MCP client, or pair it with [Lightweft](https://github.com/sheldonxxxx/lightweft), the central workspace for photographic direction, rendered review and personal style exploration. Lightweft and the [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit) are separate, optional projects.

**[Set up MCP](mcp/README.md#macos-quick-start)** · **[Use the desktop editor](docs/desktop-guide.md)** · **[Explore Lightweft](https://github.com/sheldonxxxx/lightweft)** · **[See tested capabilities](mcp/CAPABILITY-MATRIX.md)**

<p align="center">
  <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/editor.jpg" alt="Upstream RapidRAW desktop editor showing a photograph and adjustment controls">
</p>

_Desktop screenshot from upstream RapidRAW. The MCP interface is an addition maintained in this fork._

**[AI editing test report](docs/ai-editing-experiments.md):** what we tested on a 16 GB GPU and how we chose the current workflows.

**[ComfyUI integration guide](docs/comfyui.md):** one connector for generative editing and optional depth, tested ComfyUI revisions, GPU memory guidance and [downloadable chosen workflows](ai-connector/workflows/README.md).

For repeated MCP editing and test runs, see [storage and model-cache guidance](mcp/README.md#storage-for-repeated-editing-and-tests).

**Optional Marigold depth masks:** [set up depth selections](ai-connector/MARIGOLD.md) using the same AI connector and ComfyUI as generative editing. This source-build feature is disabled by default and keeps built-in depth and lens blur available.

## Choose your starting point

| You want to…                                                      | Start here                                                                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit photographs directly in a desktop application                | [Desktop guide](docs/desktop-guide.md) and [upstream application downloads](https://github.com/CyberTimon/RapidRAW/releases)                                                                 |
| Let an AI agent use RapidRAW's native engine                      | Use a fork beta package or source build and follow the [MCP setup guide](mcp/README.md)                                                                                                      |
| Give your agent an editing workflow and a place to review results | Start with [Lightweft](https://github.com/sheldonxxxx/lightweft), then add RapidRAW as an optional execution tool                                                                            |
| Prepare saved Insta360 files before editing                       | Use the independent [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit), then follow the [spherical handoff guide](skills/rapidraw-mcp/references/spherical-photos.md) |

**Fork beta packages include the native MCP bridge.** Choose a matching asset from the [fork releases](https://github.com/sheldonxxxx/RapidRAW/releases), then [build and connect the separate Node host](mcp/README.md#connect-a-beta-package). Source builds require the `mcp` Cargo feature. Upstream application downloads do not contain this fork's bridge. The server uses your MCP client's model; it does not include a language model or a hosted editing service.

Apple Silicon builds require macOS 14 or later and bundle ONNX Runtime 1.30.0 for local AI inference. Intel Mac builds retain the existing runtime. See the [runtime and hardware guide](docs/local-enhancement.md#apple-silicon-runtime).

**Apple Silicon Beta 1 installation:** the published package has an incomplete bundle signature and can be reported as damaged. See the [installation troubleshooting guide](docs/desktop-guide.md#macos-beta-1-signature-error).

**First beta:** `fork-v0.1.0-beta.1`, installed as **RapidRAW MCP** with separate application preferences and model storage. See the [release notes](docs/releases/0.1.0-beta.1.md) for installation and beta limits.

## What an agent can do

- **Develop the photograph:** exposure, white balance, colour, curves, crop, perspective, lens corrections, presets and LUTs through the native RAW pipeline.
- **Work selectively:** AI subject, sky, foreground and depth selections; point-guided refinement; additive and subtractive brush repairs; geometric and range masks.
- **Review actual pixels:** original and edited previews, matched alternatives, mask overlays, native detail crops, histograms and regional measurements.
- **Keep edits recoverable:** revision guards, undo/redo, named versions, independent session forks, portable bundles, recipes and saved native sidecars.
- **Finish and deliver:** local retouch, BM3D/AI denoise, background operations, batch exports, explicit sRGB profile handling and high-precision 16-bit TIFF output.

The desktop AI panel and MCP also offer [local mask and detail enhancement](docs/local-enhancement.md): learned edge refinement, scene and portrait-part masks, experimental motion deblur and conservative 2× enlargement. Optional model assets run locally, with profiles for smaller computers and Linux NVIDIA servers.

Compatible AI Connectors also expose workflow, AI resolution and seed choices in the desktop AI panel and generative MCP retouch. Actual generation dimensions stay with the patch when the provider supplies them. Set up the included [Comfy Connector](ai-connector/README.md) and see the [generative editing controls](docs/desktop-guide.md#generative-editing-controls) for resolution and compatibility details. These controls require a current build of this fork.

For removal, recolouring, adding objects and lettering, follow the [AI editing workflows](docs/ai-editing-workflows.md). Start with Klein 4B at 1 MP and compare the rendered result before changing models or resolution.

The server exposes **65 MCP tools** over stdio. Local AI operations need their model assets installed. HDR, focus merging, panorama and negative conversion are also exposed, with photographic acceptance limits documented in the [capability matrix](mcp/CAPABILITY-MATRIX.md). The live `rapidraw_capabilities` response defines the available tools and schemas for your build.

## Connect an agent

1. Build and connect the fork using the [macOS quick start](mcp/README.md#macos-quick-start) or the [Linux GPU server guide](mcp/REMOTE-SSH.md).
2. Optionally install the execution skill:

   ```sh
   npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp
   ```

3. Reconnect your MCP client and call `rapidraw_capabilities`. Installing the skill alone does not connect the engine.
4. Start with one photograph and a clear brief. Review the original, an edited overview and native detail before exporting.

For example:

> Edit this landscape for natural evening light. Preserve the original and its sidecar, show me a restrained edit beside a warmer alternative, and export the chosen result with an editable session.

The [execution skill](skills/rapidraw-mcp/SKILL.md) covers state, masks, comparisons and delivery. It works with a direct brief or your preferred art-direction skill; Lightweft supplies an optional shared workflow around it.

## Three independent projects, one connected workflow

| Project                                                                   | Responsibility                                                               | Handoff                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Lightweft](https://github.com/sheldonxxxx/lightweft)                     | Central workspace for direction, review and personal style                   | An image-specific brief and rendered candidates for comparison |
| **RapidRAW + MCP**                                                        | Native photographic editing, persistent state and exports                    | Previews, editable sessions, recipes and delivery files        |
| [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit) | Postprocessing saved Insta360 media and preparing verified photo derivatives | A stitched sphere or selected flat reframe for editing         |

Each project has its own installation, dependencies and repository. RapidRAW does not require either companion. When combined, the agent coordinates their file handoffs; installing one project does not automatically install or configure the others.

RapidRAW edits the pixels it receives. Camera-native fisheye stitching and spherical reframing belong to the preparation tool. Review a full sphere's seams and poles and verify its final projection metadata after editing; the [handoff guide](skills/rapidraw-mcp/references/spherical-photos.md) explains the boundary.

## Tested configurations and current limits

| Configuration                                                 | Evidence and setup                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS with Metal, native debug build                          | Native editing, state, rendering and export acceptance in the [verification record](mcp/VERIFICATION.md); [setup](mcp/README.md#macos-quick-start) |
| Debian 13 x86-64, NVIDIA GPU, SSH and Xvfb                    | Exercised server workflow documented in the [Linux guide](mcp/REMOTE-SSH.md); this is a specific tested configuration                              |
| Optional Linux ONNX CUDA inference                            | Foreground/sky masks, depth and AI denoise; [model policy and runtime setup](mcp/ONNX-CUDA.md)                                                     |
| Windows, packaged MCP releases and fresh-machine installation | No completed native acceptance claim                                                                                                               |

Existing mask and denoise operations default to CPU on every platform. Their Linux CUDA support is opt-in and separate from GPU photo rendering; subject selection and local inpainting retain CPU compatibility paths.

Passing an operation or test does not establish the quality of a photograph. Fine hair/feather masks, wide panorama framing, genuine HDR/focus brackets and film-negative quality have remaining acceptance gaps. See the [verification record](mcp/VERIFICATION.md), [capability matrix](mcp/CAPABILITY-MATRIX.md) and [remaining priorities](mcp/GAP-ASSESSMENT.md) for precise boundaries. Upstream platform availability is separate from this fork's MCP testing.

## Originals, privacy and local state

MCP editing uses isolated working copies in a workspace you choose. Original images and existing sidecars remain read-only to the workflow. Working files, model assets and saved exports are stored on the machine running the engine. With SSH, that is the server's filesystem.

Your MCP host receives requested previews and structured results, so choose its model and data handling accordingly. Model installation downloads local assets. Remote generative retouch is a separate, explicitly selected provider operation that sends image content and requires authorization and configuration.

Exports go under the MCP workspace's `exports` directory; replacing an existing export requires an explicit overwrite option. GPS stripping defaults on. These MCP protections are described in the [preservation contract](mcp/README.md#preservation-and-error-behavior); the desktop application and original export CLI have their own file-management behaviour.

## Documentation and contributions

| Guide                                                           | Use it for                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [MCP setup and tool reference](mcp/README.md)                   | Builds, connections, examples, preservation and recovery                        |
| [Desktop guide](docs/desktop-guide.md)                          | Standalone editing, build commands, CLI export and tethering                    |
| [Local masks and detail enhancement](docs/local-enhancement.md) | Native learned masks, experimental deblur, 2× enlargement and hardware profiles |
| [AI editing workflows](docs/ai-editing-workflows.md)            | Choose a use-case workflow, write a precise prompt and inspect generative edits |
| [Execution skill](skills/rapidraw-mcp/SKILL.md)                 | Agent editing, mask review, comparisons and delivery                            |
| [Portable sessions and presets](mcp/PORTABLE-SESSIONS.md)       | Independent alternatives, reusable looks and moving edits                       |
| [Geometry and review](mcp/GEOMETRY-REVIEW.md)                   | Coordinate mapping, native detail and diagnostic previews                       |
| [Testing and evidence](mcp/testing-matrix.md)                   | Reproducing protocol, native and photographic checks                            |
| [Contribution guide](CONTRIBUTING.md)                           | Reporting issues and proposing changes                                          |
| [Native integration guide](MCP.md)                              | Developing the optional bridge and merging upstream changes                     |
| [Fork changelog](CHANGELOG.md)                                  | Additions and fixes, with unreleased changes identified                         |

Report fork/MCP issues in [this repository](https://github.com/sheldonxxxx/RapidRAW/issues). Contributions that improve edit quality, recovery, installation and reproducible photographic review are welcome.

## Credits and license

RapidRAW was created by [Timon Käch](https://github.com/CyberTimon). This fork preserves the original editor and adds its optional MCP integration. Follow [upstream RapidRAW](https://github.com/CyberTimon/RapidRAW) for the original application's releases, development history and community, or [support the original author](https://ko-fi.com/cybertimon).

RapidRAW and this fork are licensed under [AGPL-3.0](LICENSE). See the [acknowledgments](docs/acknowledgments.md) for the libraries, models and communities behind the project.
