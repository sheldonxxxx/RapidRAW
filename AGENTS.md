# RapidRAW agent instructions

## Application releases

Follow [the fork release guide](docs/releasing.md) for every `fork-v...` application release. The Node MCP host has its own `mcp-v...` tags and [release guide](docs/mcp/releasing.md); do not couple its version or publication to an application release.

1. Prepare one release pull request with aligned versions in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Review `README.md` and `CHANGELOG.md`, add release notes under `docs/releases/`, and run the affected local checks.
2. Let the pull request's required checks finish. Code changes run the three-platform package matrix; Markdown-only changes skip those builds but must still pass **Package build gate** and the other required checks. Do not start extra package builds to compensate for a documentation-only skip.
3. Merge the release pull request, then verify its merge commit is contained in `origin/main`. Create and push the annotated `fork-v...` tag at that merged commit. Create a draft GitHub release for the tag. Never tag an unmerged release branch for publication.
4. Dispatch **Release: Build & Package App** on `main` with the existing tag. Wait for validation and all three package jobs: Apple Silicon, Ubuntu 22.04 x86_64, and Ubuntu 24.04 x86_64. The release workflow builds from the tag and uploads assets to the draft. It does not package Intel Macs.
5. Inspect the complete draft asset list and verify the executable version, native MCP startup, and packaged installation on available platforms. Report installation or photographic acceptance separately from CI compilation. Publish the draft only after the requested release has passed these checks.
6. Once published, do not move the tag or rebuild over its assets. Make subsequent fixes in a new beta or patch release. Keep existing assets on historical releases, including the Intel Mac assets in `fork-v0.4.0`.

PR packaging and release packaging serve different checks. Merges to `main` run Lint and MCP checks without another package build. Treat a failed job as a specific issue to investigate; do not dispatch an additional full release run just to repeat successful builds.
