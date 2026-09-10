# Read-only agent evaluations

`evaluation.xml` contains ten independent questions about realistic editing decisions: coordinate conversion, safe persistence, automatic adjustments, mask limits, curve validation, master precision and remote retouch selection. Answers were checked against the built native bridge through the real MCP server, using only `capabilities`, `get_engine_settings`, `tools/list` and the workflow resource. No photos or edits are needed to answer them.

`reference.json` freezes the returned capabilities, full native edit schema, tool discovery and workflow as **fixture version 1**. Its workspace path is normalized to `/fixture/rapidraw`; other contract data is preserved. This is an interface-understanding evaluation, not a claim that a model has completed a successful artistic edit. The XML has reference answers; no external language-model benchmark has been run.

Use the matching checkout's MCP server and give an evaluator access to discovery, `rapidraw_capabilities`, `rapidraw://adjustment-schema` and `rapidraw://workflow`. The questions permit only read-only operations. Against future versions, use the frozen reference to distinguish intentional schema changes from regressions, then version both fixture and answers together.

Regenerate the reference only after intentionally changing the contract:

```sh
RAPIDRAW_BINARY=/absolute/RapidRAW/src-tauri/target/debug/RapidRAW \
RAPIDRAW_WORKSPACE=/absolute/separate-evaluation-workspace \
node mcp/evaluations/capture-reference.mjs
```

A separate workspace is required if another client owns the editing workspace. Native macOS Tauri startup may require the host's permission to launch outside its execution sandbox. Source photos, model downloads and remote credentials are not used.
