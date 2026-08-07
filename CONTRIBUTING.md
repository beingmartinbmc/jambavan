# Contributing

## Your first contribution

1. Search [issues](https://github.com/beingmartinbmc/jambavan/issues) and [Discussions](https://github.com/beingmartinbmc/jambavan/discussions) before starting. Ask usage questions in Discussions; reserve issues for reproducible bugs and focused feature requests.
2. Fork the repository, create a branch from `main`, and keep the change focused on one problem.
3. Install Node 22 and run `npm ci`.
4. Add or update the smallest relevant test for non-trivial behavior, then make the change.
5. Run the validation matrix below and open a pull request using the repository template.

Small documentation, test, and issue improvements are welcome. For larger behavior or interface changes, start a Discussion or issue first so the approach can be agreed before implementation.

## Development setup

Use Node 22 for the shortest path to the same environment as release and smoke CI:

```bash
npm ci
```

Keep changes focused, add a regression test for non-trivial behavior, and do not commit `.jambavan/`, generated benchmark JSON, credentials, or local MCP configuration.

## Validation matrix

| Change | Required checks |
| --- | --- |
| Community or documentation only | `npm run docs-check` |
| Installer or host setup | `npm run docs-check`, `npm run installer-check` |
| Runtime, CLI, or tool behavior | `npm run lint`, `npm test`, `npm run coverage` |
| Dependencies or distributable contents | `npm run lint`, `npm test`, `npm run build`, `npm pack --dry-run` |
| Release preparation | `npm run docs-check`, `npm run installer-check`, `npm run lint`, `npm test`, `npm run coverage`, `npm run build`, `npm pack --dry-run` |

Run any narrower test that directly exercises the changed behavior as well. If a listed check is not applicable or cannot run, explain why in the pull request.

## Pull requests

Explain the problem, the smallest chosen fix, and the checks run. Link an issue when one exists. Update user-facing setup or command documentation when behavior changes. Review the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.

GitHub Releases provide the project changelog. Add migration instructions to a release or focused document only when a release introduces a breaking configuration, command, or data-format change.

## Releases (maintainers)

Keep `package.json`, `package-lock.json`, `server.json`, and the Claude plugin version aligned; `npm run docs-check` enforces this. The tag-triggered release workflow tests and publishes the npm package. After that package version exists on npm, publish the matching `server.json` to the official MCP Registry with the credentialed publisher:

```bash
mcp-publisher login github
mcp-publisher publish
```

In GitHub Actions, use `mcp-publisher login github-oidc` with only `contents: read` and `id-token: write`. Never run either publish command from pull-request CI.
