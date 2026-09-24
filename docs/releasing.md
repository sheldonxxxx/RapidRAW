# Release the fork

Whole-application tags use `fork-v<version>`, such as `fork-v0.1.0-beta.1`. Prereleases use a SemVer suffix; stable releases use `fork-v0.1.0`. Keep upstream tags and the native bridge/MCP server component versions separate.

1. Align `package.json`, its lockfile, `src-tauri/Cargo.toml`, its lockfile and `src-tauri/tauri.conf.json`. Review the README and changelog, and write user-facing release notes under `docs/releases/`.
2. Run the frontend and MCP checks, plus the native checks relevant to the changes. Commit and push the reviewed version metadata and notes through a pull request. Package builds run for code changes; documentation-only pull requests skip them.
3. Merge the pull request after its required checks pass. Create and push an annotated tag at the merged release commit on `main`, then create a **draft** GitHub release using the same tag; mark beta releases as prereleases.
4. Run **Release: Build & Package App** from GitHub Actions on `main`, entering the existing tag. The workflow checks tag/version consistency, requires the tag commit to be contained in `main`, and requires a draft release. It builds from the tag and uploads packages to that draft. Every package includes `mcp`; the matrix covers macOS ARM64 and Linux x86_64 on Ubuntu 22.04 and 24.04. Android and Intel Mac packaging are not part of this matrix.
5. Inspect every job and the draft's assets. Check executable version, native MCP startup and packaging on available platforms. Distinguish successful compilation from installation and photographic acceptance in release notes.
6. Publish the draft after checks pass. Publishing does not rebuild the packages. Never move a published tag; release a new beta or patch for subsequent changes.

The release workflow uses locked frontend dependencies. Apple Silicon bundles declare macOS 14 as their minimum for the bundled inference runtime. Signing credentials are not configured by this workflow.

The published `fork-v0.4.0` release still contains Intel Mac packages. The matrix above applies to subsequent releases; do not remove assets from an existing release when changing platform support.
