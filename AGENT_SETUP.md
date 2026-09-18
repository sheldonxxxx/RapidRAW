# RapidRAW MCP — Agent Setup

This guide is for any MCP-capable AI coding or desktop agent that is given only this repository URL and asked to install and connect RapidRAW MCP. It is client-agnostic: adapt the JSON/TOML/UI registration to your host, but keep the binaries, paths, and verification calls below.

Architecture: the **fork GitHub Release native engine** performs all photo processing; the **public npm stdio host** (`@sheldonxxxx/rapidraw-mcp`) connects that engine to your MCP client; the optional **execution skill** provides editing guidance; **model assets** are installed separately and on demand through MCP. The goal is a live, verified MCP connection: `rapidraw_capabilities` and `rapidraw_models` succeed against the fork engine.

No repository clone is required for the normal packaged setup below. The npm host never contains or downloads the native application or model weights.

## Compatibility / current release

| Component                                               | Current value                           |
| ------------------------------------------------------- | --------------------------------------- |
| Fork application release                                | `fork-v0.1.0-beta.1`                    |
| npm MCP host                                            | `@sheldonxxxx/rapidraw-mcp@0.1.0`       |
| Native MCP bridge (reported by `rapidraw_capabilities`) | `1.2.0`                                 |
| Node.js                                                 | 22.12 or later (package engine: `>=22`) |

Component versions are independent: the fork release tag, the npm host version, and the native bridge version do not move together. Use the exact pinned pair above. Do not automatically mix unknown future pairs without checking their release notes and compatibility statements.

## Deterministic install flow for an agent

1. **Detect OS, architecture, and tethering need.** Ask whether camera tethering is required. If it is not requested, use the standard fork package. If tethering is requested, use the asset explicitly marked `tethering` and install its system `libgphoto2` dependency first.
2. **Install the matching fork native package from GitHub Releases.** Use only this fork's releases at `https://github.com/sheldonxxxx/RapidRAW/releases`. Never substitute an upstream [CyberTimon package](https://github.com/CyberTimon/RapidRAW/releases): upstream builds do not contain this fork's MCP bridge. Standard packages include the native MCP bridge; assets marked `tethering` additionally enable camera tethering.
3. **Account for the unsigned beta.** The beta packages are not developer-signed or notarized. On macOS, follow the existing [installation troubleshooting](docs/desktop-guide.md#macos-beta-1-signature-error) rather than inventing Gatekeeper bypasses. Do not disable platform security globally.
4. **Ensure Node.js and npm.** Install Node.js 22.12+ with npm and verify `node --version` and `npm --version` before continuing.
5. **Use the published npm host; do not clone this repository.** Run the pinned host directly:

   ```sh
   npx -y @sheldonxxxx/rapidraw-mcp@0.1.0 --binary /absolute/path/to/rapidraw-mcp --workspace /absolute/path/to/workspace
   ```

   Alternatively, install the pinned package once and run it by name:

   ```sh
   npm install -g @sheldonxxxx/rapidraw-mcp@0.1.0
   rapidraw-mcp --binary /absolute/path/to/rapidraw-mcp --workspace /absolute/path/to/workspace
   ```

   This npm package is ONLY the Node stdio MCP host. Source builds remain available as a developer fallback (see below) but are not part of normal packaged setup.

6. **Create an absolute workspace and an optional model cache.** Create one empty directory per MCP connection, for example `/absolute/rapidraw-photo-jobs`, plus an optional shared model-cache directory on the same volume. Keep workspaces, caches, and photographs outside source control. One simultaneous connection owns each workspace through an exclusive native lock; use a separate workspace for each simultaneous agent.
7. **Resolve the native binary absolute path.** Both `--binary` and `--workspace` must be absolute; the host performs no automatic native-binary discovery.
   - macOS packaged install, for example: `/Applications/RapidRAW MCP.app/Contents/MacOS/rapidraw-mcp` (quote this path in shells).
   - Linux packaged install: use the absolute `rapidraw-mcp` executable path installed by the DEB/RPM package on that machine.
   - Windows packaged install: discover the installed `rapidraw-mcp.exe` inside the installation directory on that machine.
8. **Configure stdio MCP with the pinned npm package.** For hosts that accept `mcpServers` JSON, see the example below. For Codex, translate the same command, arguments, environment, and timeouts into its TOML form; see [the Codex adapter](#codex) for registration and trial guidance. For GUI clients with MCP settings UI, map `command`, `args`, and environment variables into the equivalent fields. The wire transport is always stdio: diagnostics go to stderr and stdout carries only MCP protocol traffic.
9. **Optionally install the execution skill.** The skill provides editing workflow guidance; installing it does not connect the engine. Install with `npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp`, or follow the skill link in [RapidRAW MCP](mcp/README.md). Reconnect the MCP client after registration.
10. **Reconnect and verify the live connection.** Call `rapidraw_capabilities` (start with `{"detail":"overview"}`), then `rapidraw_models`. A successful native capabilities response verifies the fork engine starts.
11. **Install required models explicitly.** Missing models do not prevent basic adjustments and geometric masks, but AI operations need their assets. Call `install_model` for each required model group and verify with `rapidraw_models` before running dependent tools. Model installation downloads local assets; models are not bundled with the npm host or the native installer.

For Linux GPU servers over SSH, run both the Node host and the native engine on the server and adapt the paths above to server-side absolute paths; see the [Linux GPU server guide](docs/mcp/remote-ssh.md).

## Provider notes

- Masking, denoise, and inpainting default to CPU on every platform unless explicitly configured.
- On macOS, `RAPIDRAW_NONLOCAL_PROVIDER=coreml` selects the direct CoreML Nonlocal backend; install its pinned bundle once with `install_model kind="nonlocal"`.
- On Linux with NVIDIA hardware, CUDA inference for supported mask/depth/denoise models is opt-in; follow [Optional ONNX CUDA inference on Linux](docs/mcp/onnx-cuda.md). Installing a GPU driver or CUDA runtime alone does not select that provider.
- Model weights are not part of the npm package or the native installer unless the referenced docs explicitly say otherwise. The explicit `install_model` MCP tool is the model-download boundary: the server never downloads models implicitly.

## Generic MCP config example

Complete `mcpServers` JSON for hosts that accept that format. Replace every `/absolute/...` path with the real absolute paths from the steps above.

```json
{
  "mcpServers": {
    "rapidraw": {
      "command": "npx",
      "args": [
        "-y",
        "@sheldonxxxx/rapidraw-mcp@0.1.0",
        "--binary",
        "/absolute/path/to/rapidraw-mcp",
        "--workspace",
        "/absolute/rapidraw-photo-jobs",
        "--timeout-ms",
        "900000"
      ],
      "env": {
        "RAPIDRAW_MODEL_CACHE": "/absolute/rapidraw-model-cache"
      }
    }
  }
}
```

The `env` entry is optional and selects a shared model-cache directory. Omit it to use the application default. Stdout carries only MCP protocol traffic; read stderr for diagnostics. All paths must be absolute. The `--timeout-ms 900000` value sets the 15-minute native-operation timeout; model installation and supported long operations retain their documented 30-minute maximum, so configure the host's own tool timeout accordingly.

## Client adapters

### Codex

Translate the pinned command, arguments, environment, and timeouts from the generic example above into Codex's TOML form. Choose one configuration scope:

| Scope                            | File                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| This photo-work project          | `.codex/config.toml` inside the project; Codex loads project configuration only after you trust that project |
| Your Codex projects on this host | `~/.codex/config.toml`                                                                                       |

Create the parent directory if needed. Add the following table to the chosen file, preserving other settings and replacing **every** `/absolute/...` path. Inspect an existing `rapidraw` entry before updating it; do not duplicate the table. Use the absolute `npx` executable path on that machine (run `command -v npx` to find it) and the installed native binary from step 7 — not a repository checkout path.

```toml
[mcp_servers.rapidraw]
command = "/absolute/path/to/npx"
args = [
  "-y",
  "@sheldonxxxx/rapidraw-mcp@0.1.0",
  "--binary", "/absolute/path/to/rapidraw-mcp",
  "--workspace", "/absolute/photo-work/jobs/agent-a",
  "--timeout-ms", "900000"
]
startup_timeout_sec = 30
tool_timeout_sec = 1800

[mcp_servers.rapidraw.env]
RAPIDRAW_MODEL_CACHE = "/absolute/photo-work/model-cache"
```

The `env` table sets the child's cache path even when the GUI does not inherit your shell environment. Keep this cache on the same volume as the job workspaces. The native timeout here is 15 minutes and the host wait is 30 minutes; these are separate limits. Model installation and supported long operations retain their documented 30-minute maximum, so configure the host's own tool timeout accordingly. For Linux over SSH, use the SSH command and arguments from the [Linux GPU server guide](docs/mcp/remote-ssh.md#connect-from-your-computer) in this table instead and set engine/cache variables in the **remote launcher**.

As an alternative registration route, `codex mcp add` supports `--env KEY=VALUE -- COMMAND ARG...`; inspect the result and set the timeouts in its TOML entry. For a project-only trial, use the project file above instead.

Reconnect and verify: open and trust the photo-work project in Codex, save the configuration, then restart the MCP server or start a new session (`/mcp` shows active servers). Ask the agent to call `rapidraw_capabilities` with `{"detail":"overview"}`, then `rapidraw_models`. A successful native capabilities response verifies the fork engine starts; missing optional models do not prevent basic adjustments and geometric masks.

## Verification checklist

- [ ] Fork native package installed from this fork's releases (not upstream).
- [ ] Node.js 22.12+ available (`node --version`, `npm --version`).
- [ ] Exact npm host available (`npx -y @sheldonxxxx/rapidraw-mcp@0.1.0 --help` succeeds with no repository checkout).
- [ ] Isolated absolute workspace created (one per simultaneous connection).
- [ ] `rapidraw_capabilities` succeeds against the fork engine.
- [ ] `rapidraw_models` succeeds.
- [ ] Required models explicitly installed and verified with `rapidraw_models`.
- [ ] One small photo opened and preview-rendered (`open_photo`, then `render`) in the isolated workspace.

## Source-build fallback

Use a source build only when no compatible packaged release exists for the target, or for fork development. Follow [RapidRAW MCP](mcp/README.md) for the build recipe rather than duplicating it here; the Codex-specific registration and trial steps remain in [the Codex adapter](#codex).

## Uninstall / update boundary

The npm host, the native application, MCP workspaces, and model assets are independent:

- Removing or upgrading the npm host does not delete workspaces or installed models.
- Uninstalling the native application does not remove the npm host, workspaces, or model caches.
- Deleting a workspace does not uninstall the npm host, the native application, or shared model seeds.
- Before upgrading any component independently, check the compatibility table above and the relevant release notes; do not assume a new native package works with an old npm host or vice versa.
