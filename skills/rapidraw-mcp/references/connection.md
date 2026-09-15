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

Read the user's actual MCP host configuration for configured server, binary and workspace paths. In a RapidRAW checkout, `mcp/README.md` provides the [build and connection guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/mcp/README.md#build-and-connect), `mcp/src/tools.ts` defines tool inputs, and `src-tauri/src/mcp_bridge/validation.rs` defines native adjustments. Do not assume this skill is installed next to the repository or invent missing binaries. Build/connect only when needed for the user's task and supported by the environment.

An MCP host configuration uses this shape, with real absolute paths:

```json
{
  "mcpServers": {
    "rapidraw": {
      "command": "node",
      "args": [
        "/absolute/RapidRAW/mcp/dist/index.js",
        "--binary",
        "/absolute/RapidRAW/src-tauri/target/debug/RapidRAW",
        "--workspace",
        "/absolute/rapidraw-photo-jobs"
      ]
    }
  }
}
```

## Persistent fallback client

For an SSH-hosted engine, use the [Linux server connection guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/mcp/REMOTE-SSH.md) in the repository. The client supports `--connection /absolute/launcher.json` with `command`, `args` and optional `cwd`; `--server` then locates the local SDK and `--workspace` stores local evidence. Remote file paths remain server-side. Do not combine this mode with `--binary` or `--timeout-ms`.

If tools are not exposed, use the bundled [mcp-client.mjs](../scripts/mcp-client.mjs). It resolves the official SDK from the server's installed dependencies, keeps one stdio connection, and saves large responses and native image blocks to files. Do not write a new one-shot client for every task.

```sh
node /absolute/skill/scripts/mcp-client.mjs \
  --server /absolute/RapidRAW/mcp/dist/index.js \
  --binary /absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
  --workspace /absolute/rapidraw-photo-jobs
```

Run as an interactive terminal process; retain its execution session ID. `ready` means MCP transport connected, not that the native engine is ready. First send:

```json
{ "tool": "capabilities", "arguments": { "detail": "overview" }, "timeout_ms": 30000 }
```

Send one request, inspect the response, then send the next. Input uses `arguments`, matching MCP. For long masks write a JSON request file with the filesystem tool and submit `{"file":"/absolute/request.json"}`; long terminal lines can be truncated. On completion send `{"close":true}`. Keep the connection alive between related operations; if the host closes it, reconnect and resume the saved session.

Keep exact operations in a JSON array when useful. Select one without copying its large patch, and attach live state using shallow `arguments` overrides:

```json
{
  "file": "/absolute/job/operations.json",
  "index": 0,
  "arguments": { "session_id": "SESSION_ID", "expected_revision": 3 }
}
```

The index is zero-based. Read the returned revision before selecting the next operation. This executes one operation, not an automatic batch.

The client prints method-specific state, `response_path` and image paths. Job/result-session IDs, comparison labels and content indexes, warnings, errors, and export provenance remain available. Saved structured data is under `data`, with opaque native assets replaced by descriptors. These response files are review records, not complete recipes; use native session saves or portable bundles for editable state. The client needs the matching built MCP server, including `dist/model-output.js`. Request selected schemas and reuse them until `schema_id` changes:

```json
{"tool":"capabilities","arguments":{"schema_paths":["properties.temperature","properties.colorGrading"]}}
{"list_tools":["render","mask_create","mask_update"]}
{"tool":"render","arguments":{"session_id":"SESSION_ID","long_edge":1600}}
```

It supports `resource` for MCP resource reads and `timeout_ms` for tool calls. For a longer native operation, launch this client with `--timeout-ms 900000` and give that request a larger client wait, for example `"timeout_ms": 960000`. These are separate limits: the launch flag is forwarded to the server and controls native processing; the JSON field controls how long the client waits. Both default to 300000 ms. The launch flag accepts a positive safe integer; request waits accept 100–1800000 ms. Raising only the request wait does not extend native processing. This client's SDK transport does not forward arbitrary shell environment variables, so use the launch flag rather than relying on `RAPIDRAW_TIMEOUT_MS` set in the parent shell.

`pick` selects dotted paths for stdout, including parsed JSON resources; errors always retain their complete recovery information. For older connected servers, use `{"tool":"capabilities","pick":["coordinate_space","adjustment_schema.properties.temperature"]}`. No-argument capabilities and `detail: "full"` retain the full discovery contract for existing programs. A schema resource is another full schema read; it need not follow a successful selected read.

Image files are raw MCP result bytes, not a substitute renderer. On an MCP/transport error it stops and closes rather than running queued edits or retrying. Inspect its response and persisted state before reconnecting. Keep request secrets out of durable files. If the server SDK dependencies or native binary are missing, report the exact path/error; install/build only when needed and authorized.

Only one connection can own a workspace at a time. Use separate workspaces for concurrent clients; do not delete an active `.bridge.lock` or interrupt another editing session to claim its workspace.

## Results and recovery

Success returns `structuredContent`; a render additionally returns an MCP image block. Failures have `isError: true` and a structured error code/message, or per-item results for batch failure. Never translate a failure into a claim that a blank edit or export succeeded.

| Symptom                                              | Next action                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS startup hangs with LaunchServices/XPC warnings | Treat as a possible graphics sandbox restriction. Close this task's client/child, then relaunch through the host's permission mechanism when authorized. Do not keep waiting through repeated five-minute timeouts or delete another session's lock. List sessions after reconnecting.                                                                                                             |
| `REVISION_CONFLICT`                                  | Get the current session including adjustments. Reconcile the patch against it and use the current revision.                                                                                                                                                                                                                                                                                        |
| `RESPONSE_TOO_LARGE`                                 | The connection is still usable. Read `recovery`: the operation has returned and a mutation may already have completed. Keep its session/revision, mask/job IDs and output paths; do not replay it. Request a smaller overview or bounded native detail, or get session state with `include_adjustments:false`. Batch recovery can be truncated; reconcile omitted items from the original request. |
| Invalid argument, mask, or crop                      | Read the live schema and coordinate metadata; correct the input. Repeating the same invalid request will not help.                                                                                                                                                                                                                                                                                 |
| Missing model                                        | Inspect `rapidraw_models`; install the required kind when within scope or choose a suitable available method.                                                                                                                                                                                                                                                                                      |
| `INCOMPATIBLE_ENGINE`, unsupported method            | Check the selected fork binary and live capabilities. A stock app or mismatched build cannot be fixed by changing photo parameters.                                                                                                                                                                                                                                                                |
| `GENERATION_NOT_CONFIGURED`                          | Inspect engine settings and the requested provider. Complete authorized provider setup or use an appropriate local operation.                                                                                                                                                                                                                                                                      |
| Timeout, crash, protocol error, active cancellation  | Close/reconnect the client, list sessions, inspect the affected session and filesystem outputs, then decide what remains. Never automatically replay a mutation.                                                                                                                                                                                                                                   |
| Existing export/recipe                               | Inspect it. Choose a new name, or use `overwrite: true` for an intended export replacement. Recipes always require a new path.                                                                                                                                                                                                                                                                     |

Edits persist inside the workspace; `rapidraw_save_session` additionally writes the native sidecar. After reconnecting, use the existing session ID instead of reopening the original into a fresh session. `rapidraw_close_session` releases it from memory; its saved manifest becomes available on the next bridge startup.

Default native request timeout is 300000 ms, configurable with `--timeout-ms` or `RAPIDRAW_TIMEOUT_MS`. Model installation, merge, and batch export have 30-minute limits. Ensure the host timeout can cover the selected operation. A cancelled queued request is skipped; cancellation during active native processing can invalidate the bridge, so inspect state before retrying.

Current servers cap outgoing MCP responses at 8 MiB, including images and text/structured metadata, to fit the SDK's default stdio receiver. `capabilities.transport_limits` reports this budget. Choose preview size and encoding explicitly; no silent downsampling occurs. For large native regions, request adjacent bounded tiles and keep their rendered coordinates so the entire intended area is reviewed. Session resources can also exceed the budget; use the smaller session tool response when needed.

## Optional provider settings

`workspace/engine-settings.json` accepts the native camelCase keys returned by `rapidraw_get_engine_settings`; unknown keys are rejected. Changes take effect after reconnecting and do not modify the GUI application's preferences.

For an explicitly selected connector, `aiProvider: "ai-connector"` and `aiConnectorAddress: "host:port"` must match the actual running provider. Cloud mode uses `aiProvider: "cloud"` and a request-scoped `token` on generative retouch. Do not store tokens in this file. Configure a provider only for an authorized workflow; ordinary global edits, geometric masks, and local processing do not need remote setup.
