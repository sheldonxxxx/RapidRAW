# Run RapidRAW MCP on a Linux GPU server

Run both the Node MCP server and native RapidRAW engine on the Linux machine. A local MCP client can launch them through SSH and use the existing stdio transport. Previews travel as MCP image blocks; RAW inputs, session files, models and exports use the server's filesystem. Transfer originals and delivery files separately with SFTP, rsync or shared storage.

The native bridge still initializes Tauri/GTK. It needs a display server, but no full desktop environment or physical monitor. Xvfb supplies the display while Vulkan performs offscreen GPU processing. ONNX inference defaults to CPU. Linux MCP deployments can separately enable [validated CUDA inference](ONNX-CUDA.md) for foreground/sky masks, depth and AI denoise; installing CUDA alone does not select that provider.

## Build on the server

The SSH workflow has been exercised on Debian 13 x86-64 in an LXC container with an NVIDIA RTX 5060 Ti, driver 595.58.03, Node 24 and Rust 1.98.1. This establishes that configuration, not every Linux distribution, driver or packaged build.

Install the [Tauri Linux dependencies](https://v2.tauri.app/start/prerequisites/#linux), Xvfb and Vulkan tools. For Debian 13:

```sh
sudo apt-get install --no-install-recommends \
  build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf clang cmake \
  xvfb xauth dbus-x11 vulkan-tools libvulkan1
```

Configure the GPU driver and, for a container, its device access and matching userspace libraries. `vulkaninfo --summary` must identify the intended hardware GPU. A working `nvidia-smi` alone does not prove Vulkan access.

With Git, Node.js 22.12+ (including npm), and Rust installed, build this fork and its Node server on the Linux machine:

```sh
git clone https://github.com/sheldonxxxx/RapidRAW.git
cd RapidRAW
rustup toolchain install 1.98.1 --profile minimal
npm ci
npm run build
cargo +1.98.1 build --release --features mcp --manifest-path src-tauri/Cargo.toml --locked
npm ci --prefix mcp
npm run build --prefix mcp
test -x "${CARGO_TARGET_DIR:-$PWD/src-tauri/target}/release/RapidRAW"
test -f "$PWD/mcp/dist/index.js"
```

See [build and connect](README.md#build-and-connect) for toolchain and runtime details. The launcher below uses this release build. Its paths are placeholders; replace them with the actual Node, executable and workspace locations on the server.

## Launch through a virtual display

Create an executable server-side launcher such as `/absolute/bin/rapidraw-mcp`:

```sh
#!/bin/sh
set -eu
export GDK_BACKEND=x11
export WGPU_BACKEND=vulkan
export ORT_DYLIB_PATH=/absolute/RapidRAW/src-tauri/resources/libonnxruntime.so
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/rapidraw-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
exec dbus-run-session -- xvfb-run -e /dev/stderr -a \
  -s '-screen 0 1280x720x24 -nolisten tcp -extension GLX' \
  /absolute/path/to/node /absolute/RapidRAW/mcp/dist/index.js \
  --binary /absolute/RapidRAW/src-tauri/target/release/RapidRAW \
  --workspace /absolute/rapidraw-jobs --timeout-ms 900000
```

This launcher matches the release build linked above. Before connecting, run `test -x /absolute/RapidRAW/src-tauri/target/release/RapidRAW` and `test -f /absolute/RapidRAW/mcp/dist/index.js` on the server. If you deliberately built debug, change both the executable check and launcher to `target/debug/RapidRAW`; honor `CARGO_TARGET_DIR` if configured. Make the launcher executable with `chmod +x /absolute/bin/rapidraw-mcp`.

`-extension GLX` avoids an Xvfb startup crash observed in NVIDIA EGL/GBM initialization inside the tested container; it does not disable Vulkan compute. If adapter discovery needs an explicit NVIDIA ICD, set `VK_DRIVER_FILES` to its verified installed JSON path in this launcher. Keep these settings process-local.

Xvfb and D-Bus live for the connection and terminate when it closes. The launcher must keep stdout exclusively for MCP traffic. Diagnostics belong on stderr, including any remote shell startup messages. Use one workspace per simultaneous client.

## Connect from your computer

Set up SSH keys and verify the host key interactively first. Then register a command-based stdio server with your MCP host:

Codex users should place the following command/arguments in the TOML table from the [Codex guide](CODEX.md#register-the-server); the JSON below is for hosts that accept `mcpServers` configuration.

```json
{
  "mcpServers": {
    "rapidraw_gpu": {
      "command": "/usr/bin/ssh",
      "args": [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "user@gpu-server",
        "/absolute/bin/rapidraw-mcp"
      ]
    }
  }
}
```

`-T` prevents a pseudo-terminal from changing protocol framing. Keepalives detect a broken connection. Configure a host tool timeout that covers native processing; model installation and supported long operations can need up to 30 minutes. Reconnect the host after adding the server, then call `rapidraw_capabilities` and `rapidraw_models`.

For direct inspection, the [persistent skill client](../skills/rapidraw-mcp/scripts/mcp-client.mjs) accepts the same launcher as a plain JSON object containing `command`, `args`, and optional absolute `cwd`:

```sh
node /local/RapidRAW/skills/rapidraw-mcp/scripts/mcp-client.mjs \
  --server /local/RapidRAW/mcp/dist/index.js \
  --connection /local/ssh-connection.json \
  --workspace /local/rapidraw-evidence
```

Here `--server` locates the locally installed MCP SDK, and `--workspace` stores local responses and previews. The remote launcher owns the native binary, remote workspace and native timeout. Do not combine `--connection` with `--binary` or `--timeout-ms`. Read the [client request and recovery contract](../skills/rapidraw-mcp/references/connection.md#persistent-fallback-client) before submitting edits.

## Verify the complete workflow

1. Confirm the live tool inventory, hardware GPU and model status.
2. Open a server-side RAW file with `inherit_sidecar: false`; retain its source hash.
3. Render a preview, apply an adjustment and a local mask, and inspect the returned images and a native detail crop.
4. Save the session and export an original-resolution file. Reconnect and verify the saved adjustments and identical rendered result.
5. Download the export, verify its hash against the server copy, inspect it locally, and check that the original RAW and sidecar remain unchanged.

The [engine regression](scripts/engine-e2e.mjs), [adjustment matrix](scripts/coverage-e2e.mjs), [advanced operations](scripts/advanced-e2e.mjs), [portable sessions](scripts/portable-sessions-e2e.mjs), and [background operations](scripts/operation-jobs-e2e.mjs) exercise the real native engine. Run them under the same virtual-display environment, each with its own `RAPIDRAW_WORKSPACE`; follow their documented fixture requirements. See the [test matrix](testing-matrix.md) for additional coverage and evidence boundaries. Generative provider execution is a separate opt-in test.
