# Releasing the `@sheldonxxxx/rapidraw-mcp` npm host

npm host releases are **independent** from the application's `fork-v...` releases. The npm package version, the fork release tag, and the native bridge version do not move together.

## Version components

A host release updates three version records together to the same `<semver>` — the `version` in `mcp/package.json`, the root `version` in `mcp/package-lock.json`, and the `rapidraw-mcp-server` version in the MCP protocol metadata in `mcp/src/server.ts`:

1. `mcp/package.json` (`version`) and `mcp/package-lock.json` (root `name`/`version`).
2. The MCP protocol metadata in `mcp/src/server.ts` (`rapidraw-mcp-server` version).

The package name stays `@sheldonxxxx/rapidraw-mcp`, the repository stays `sheldonxxxx/RapidRAW`, `publishConfig.access` stays `public`, and the license stays `AGPL-3.0-only`. npm versions are immutable: a published version is never overwritten, unpublished, or reused. If the registry already has the version, the release fails closed.

## Release steps

1. Update `mcp/package.json`, `mcp/package-lock.json`, and `mcp/src/server.ts` to the new version together.
2. Update the [agent setup compatibility table](../../AGENT_SETUP.md#compatibility--current-release) and pinned `npx` examples only when the recommended fork/npm pair changes.
3. Run the checks: `npm ci`, `npm test`, and `npm pack --dry-run --json` from `mcp/`, and confirm the tarball contains only the intended runtime inventory (`dist`, `README.md`, `LICENSE`, package metadata).
4. Merge the change to `main` through the normal pull-request checks.
5. Create and push the release tag from `main`:

   ```sh
   git tag mcp-vX.Y.Z
   git push origin mcp-vX.Y.Z
   ```

   The tag commit must be contained in `origin/main`. Only tags matching `mcp-v*` trigger publication; app `fork-v...` tags, `main` pushes, pull requests, and GitHub Releases never publish npm.

6. Watch the `npm-publish` workflow run. It validates the tag/package/lock/protocol versions, repository/license/public metadata, `origin/main` containment, tests, pack dry-run, and registry absence of the version — then publishes with `npm publish --access public` via OIDC Trusted Publishing with provenance enabled, and verifies the registry metadata plus a fresh `npx -y @sheldonxxxx/rapidraw-mcp@<version> --help`.

## One-time trusted publisher binding

Publication uses npm Trusted Publishing (OIDC): no long-lived npm token, no `NPM_TOKEN` secret, minimal `contents: read` + `id-token: write` permissions, and setup-node package-manager caching explicitly disabled for the release job. The one-time trust relationship binds the existing package to this repository and workflow file:

```sh
npm trust github @sheldonxxxx/rapidraw-mcp --repo sheldonxxxx/RapidRAW --file npm-publish.yml --allow-publish
```

It becomes operational only once the workflow is committed and pushed to GitHub. Never replace or revoke an unexpected existing trust relationship without review.
