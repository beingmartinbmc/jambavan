# Contributing

## Development

Use Node 22 for the shortest path to the same environment as release and smoke CI:

```bash
npm ci
npm run docs-check
npm run lint
npm run unit
npm run build
```

Run `npm test` and `npm run coverage` before requesting review for runtime changes. Keep changes focused, add a regression test for non-trivial behavior, and do not commit `.jambavan/`, generated benchmark JSON, credentials, or local MCP configuration.

## Pull requests

Explain the problem, the smallest chosen fix, and the checks run. Link an issue when one exists. Update user-facing setup or command documentation when behavior changes. Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.

GitHub Releases provide the project changelog. Add migration instructions to a release or focused document only when a release introduces a breaking configuration, command, or data-format change.

## Releases (maintainers)

Keep `package.json`, `package-lock.json`, `server.json`, and the Claude plugin version aligned; `npm run docs-check` enforces this. The tag-triggered release workflow tests and publishes the npm package. After that package version exists on npm, publish the matching `server.json` to the official MCP Registry with the credentialed publisher:

```bash
mcp-publisher login github
mcp-publisher publish
```

In GitHub Actions, use `mcp-publisher login github-oidc` with only `contents: read` and `id-token: write`. Never run either publish command from pull-request CI.
