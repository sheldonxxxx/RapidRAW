# Connect RapidRAW MCP to Codex

Build the editor and Node host using the [macOS quick start](README.md#macos-quick-start), or install the [matching beta package and host](README.md#connect-a-beta-package). This guide registers those built components with Codex and verifies native startup. The skill, host registration and working editor are three separate checks.

## Choose paths and check the build

For the macOS source quick start, run from the RapidRAW checkout:

```sh
command -v node
test -f "$PWD/mcp/dist/index.js"
test -x "${CARGO_TARGET_DIR:-$PWD/src-tauri/target}/debug/RapidRAW"
```

Use the absolute Node path printed above. A release build uses `release/RapidRAW`; an installed macOS beta uses `/Applications/RapidRAW MCP.app/Contents/MacOS/rapidraw-mcp`. Use the executable from the route you completed. If a check fails, finish that build before registering the server. For an unbundled macOS build with `CARGO_TARGET_DIR`, keep the directory's final name `target` and retain the adjacent build resources; see [custom build paths](README.md#build-and-connect).

Choose a photo-work directory for skills and configuration, and a separate RapidRAW job directory for each simultaneous connection. Example paths below are placeholders. Keep job state, model caches and photographs outside source control.

## Install the execution skill

From your photo-work directory, install with the Skills CLI:

```sh
npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp
```

For a local source build or an isolated trial, copy the matching checkout's complete skill instead:

```sh
mkdir -p .agents/skills
cp -R /absolute/RapidRAW/skills/rapidraw-mcp .agents/skills/
test -f .agents/skills/rapidraw-mcp/SKILL.md
test -f .agents/skills/rapidraw-mcp/scripts/mcp-client.mjs
```

Use an empty destination or inspect an existing installation before replacing it. Codex discovers project skills in `.agents/skills` and user skills in `~/.agents/skills`. Open the photo-work directory in Codex and confirm `rapidraw-mcp` appears in the skill selector; restart if needed. Lightweft's optional planning/style skills have their own [installation guide](https://github.com/sheldonxxxx/Lightweft/blob/main/docs/getting-started.md). See [Codex skill discovery](https://developers.openai.com/codex/skills/).

## Register the server

Choose one configuration scope:

| Scope | File |
| --- | --- |
| This photo-work project | `.codex/config.toml` inside the project; Codex loads project configuration only after you trust that project |
| Your Codex projects on this host | `~/.codex/config.toml` |

Create the parent directory if needed. Add the following table to the chosen file, preserving other settings and replacing **every** `/absolute/...` path. Inspect an existing `rapidraw` entry before updating it; do not duplicate the table. Codex configuration is TOML; the generic `mcpServers` JSON in the MCP README belongs to hosts that accept that format.

```toml
[mcp_servers.rapidraw]
command = "/absolute/path/to/node"
args = [
  "/absolute/RapidRAW/mcp/dist/index.js",
  "--binary", "/absolute/RapidRAW/src-tauri/target/debug/RapidRAW",
  "--workspace", "/absolute/photo-work/jobs/agent-a",
  "--timeout-ms", "900000"
]
startup_timeout_sec = 30
tool_timeout_sec = 1800

[mcp_servers.rapidraw.env]
RAPIDRAW_MODEL_CACHE = "/absolute/photo-work/model-cache"
```

The `env` table sets the child's cache path even when the GUI does not inherit your shell environment. Keep this cache on the same volume as the job workspaces for clone savings. The native timeout here is 15 minutes and the host wait is 30 minutes; these are separate limits. Model installation and supported long operations retain their documented 30-minute maximum. For Linux over SSH, use the [SSH command and arguments](REMOTE-SSH.md#connect-from-your-computer) in this table instead and set engine/cache variables in the **remote launcher**.

For a user-level CLI registration, `codex mcp add` supports `--env KEY=VALUE -- COMMAND ARG...`; inspect the result and set the timeouts in its TOML entry. For a project-only trial, use the project file above instead. See [Codex MCP configuration](https://developers.openai.com/codex/mcp/) and [configuration scope and trust](https://developers.openai.com/codex/config-basic/).

## Verify each boundary

1. Open and trust the photo-work project in Codex. Save the configuration, then restart the MCP server in the host's MCP settings or start a new Codex session. In the CLI, `/mcp` shows active servers.
2. From that project, `codex mcp get rapidraw --json` shows the resolved command, paths, environment and timeouts. This verifies registration only. If the project entry is missing, check project trust and the directory from which Codex was started.
3. Ask the agent to call `rapidraw_capabilities` with `{"detail":"overview"}`, then `rapidraw_models`. A successful native capabilities response verifies that the fork engine starts. Missing optional models do not prevent basic adjustments and geometric masks. Use the [persistent client](../skills/rapidraw-mcp/references/connection.md#persistent-fallback-client) if tools are not exposed; its `ready` message alone only proves transport startup.
4. Complete the [first-photo loop](README.md#example-editing-loop): open your source, render the intended starting state, make a small edit, inspect and save it, export, reconnect and check saved state. Verify the original and sidecar hashes before and after. Optional AI operations need their own models/provider checks.

If macOS graphics startup is blocked by the host's sandbox, follow [connection recovery](../skills/rapidraw-mcp/references/connection.md#results-and-recovery). A configuration listing or protocol handshake does not prove that native rendering can run.

## Isolated trials and two agents

Use a new photo-work directory, its project-scoped skills/configuration and an empty job directory. Retain your ordinary user configuration. A separate directory on an existing computer does not establish fresh-machine installation: record which Node/Rust/system dependencies and build/model caches were reused.

Before a native test or bulk run, create the output directory and measure its physical free space:

```sh
mkdir -p /absolute/photo-work/jobs/agent-a /absolute/photo-work/model-cache
df -Pk /absolute/photo-work/jobs/agent-a
```

Require at least **20,971,520 available 1K blocks (20 GiB)** before starting, plus room for unique outputs. Check again afterward. `RAPIDRAW_MIN_FREE_GIB` configures test/benchmark guards; it is not a quota or an ordinary-server disk guard. See [storage behavior](README.md#storage-for-repeated-editing-and-tests).

For another simultaneous connection, choose a different entry name and `--workspace`, such as `rapidraw_b` and `jobs/agent-b`. Both can use the same verified model cache. Close this trial's connection when finished, keep accepted exports and saved edits, and retain the other workspace's lock. Separate workspaces isolate editing state; GPU memory is still shared.
