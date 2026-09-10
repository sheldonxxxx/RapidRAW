# Connection and recovery

Use an existing RapidRAW MCP connection when available. If tools are absent, first inspect the available tool inventory and the user's existing MCP configuration. The native bridge requires this fork built with the `mcp` Cargo feature; a stock installed RapidRAW application does not supply it. Installing this skill does not itself register an MCP server.

## Local stdio launch

The server takes absolute paths to its compiled JavaScript, native executable, and job workspace:

```sh
node /absolute/RapidRAW/mcp/dist/index.js \
  --binary /absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
  --workspace /absolute/rapidraw-photo-jobs
```

Use the actual debug/release or `CARGO_TARGET_DIR` output. `RAPIDRAW_BINARY` and `RAPIDRAW_WORKSPACE` can supply equivalent settings. This process speaks MCP over stdio; it is not a one-command JSON editing CLI. Diagnostics go to stderr. Keep a client connection open across calls and close it when finished.

In a RapidRAW checkout, inspect `mcp/README.md` for the current build procedure and `.mcp-workspace/mcp-config.json` if present for local paths. `mcp/src/tools.ts` defines tool inputs; `src-tauri/src/mcp_bridge/validation.rs` defines native adjustments. Do not assume this skill is installed next to the repository or invent missing binaries. Build/connect only when needed for the user's task and supported by the environment.

An MCP host configuration uses this shape, with real absolute paths:

```json
{"mcpServers":{"rapidraw":{"command":"node","args":["/absolute/RapidRAW/mcp/dist/index.js","--binary","/absolute/RapidRAW/src-tauri/target/debug/RapidRAW","--workspace","/absolute/rapidraw-photo-jobs"]}}}
```

If a configured host cannot expose the tools during the current task, an official MCP client using the installed server dependencies can communicate over stdio. Reuse repository client examples where available. Keep source files outside a new isolated test workspace; do not bypass the server with GUI internals, direct `.rrdata` writes, or the legacy export CLI. Otherwise report the concrete missing connection or binary.

Only one connection can own a workspace at a time. Use separate workspaces for concurrent clients; do not delete an active `.bridge.lock` or interrupt another editing session to claim its workspace.

## Results and recovery

Success returns `structuredContent`; a render additionally returns an MCP image block. Failures have `isError: true` and a structured error code/message, or per-item results for batch failure. Never translate a failure into a claim that a blank edit or export succeeded.

| Symptom | Next action |
| --- | --- |
| `REVISION_CONFLICT` | Get the current session including adjustments. Reconcile the patch against it and use the current revision. |
| Invalid argument, mask, or crop | Read the live schema and coordinate metadata; correct the input. Repeating the same invalid request will not help. |
| Missing model | Inspect `rapidraw_models`; install the required kind when within scope or choose a suitable available method. |
| `INCOMPATIBLE_ENGINE`, unsupported method | Check the selected fork binary and live capabilities. A stock app or mismatched build cannot be fixed by changing photo parameters. |
| `GENERATION_NOT_CONFIGURED` | Inspect engine settings and the requested provider. Complete authorized provider setup or use an appropriate local operation. |
| Timeout, crash, protocol error, active cancellation | Close/reconnect the client, list sessions, inspect the affected session and filesystem outputs, then decide what remains. Never automatically replay a mutation. |
| Existing export/recipe | Inspect it. Choose a new name, or use `overwrite: true` for an intended export replacement. Recipes always require a new path. |

Edits persist inside the workspace; `rapidraw_save_session` additionally writes the native sidecar. After reconnecting, use the existing session ID instead of reopening the original into a fresh session. `rapidraw_close_session` releases it from memory; its saved manifest becomes available on the next bridge startup.

Default native request timeout is 300000 ms, configurable with `--timeout-ms` or `RAPIDRAW_TIMEOUT_MS`. Model installation, merge, and batch export have 30-minute limits. Ensure the host timeout can cover the selected operation. A cancelled queued request is skipped; cancellation during active native processing can invalidate the bridge, so inspect state before retrying.

## Optional provider settings

`workspace/engine-settings.json` accepts the native camelCase keys returned by `rapidraw_get_engine_settings`; unknown keys are rejected. Changes take effect after reconnecting and do not modify the GUI application's preferences.

For an explicitly selected connector, `aiProvider: "ai-connector"` and `aiConnectorAddress: "host:port"` must match the actual running provider. Cloud mode uses `aiProvider: "cloud"` and a request-scoped `token` on generative retouch. Do not store tokens in this file. Configure a provider only for an authorized workflow; ordinary global edits, geometric masks, and local processing do not need remote setup.
