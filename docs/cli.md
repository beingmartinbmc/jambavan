# CLI reference

Every command below is local. None of them call an LLM, send telemetry, or upload code.

These CLI commands start their own short-lived process. In particular, `npx jambavan doctor` cannot see the index or watcher held by an already-running MCP server. For active-server root, tool-count, index, and watcher health, call MCP `jambavan_doctor {}` from the host.

```bash
npm install
npm run build
node dist/index.js --help
node dist/index.js
```

Set `JAMBAVAN_ROOT=/path/to/project` when launching outside the target repo. Jambavan reads the launch process environment; it does not auto-load `.env` or `.env.example`.

## One-shot commands

```bash
npx jambavan doctor
npx jambavan review-pack --base origin/main --format json --max-files 200
npx jambavan html-handoff --out /tmp/handoff.html --share-safe
npx jambavan gui
npx jambavan badges
npx jambavan memory migrate --root /path/to/repository
```

## Review packs in CI

```bash
npx jambavan review-pack --base origin/main --format json --max-files 200
npx jambavan review-pack --base origin/main --include-worktree
```

JSON includes `touchedCount`, `analyzedCount`, `truncated`, `files[]`, `rinMarkers[]`, and `failures[]`. The bundled [`.github/workflows/jambavan-review.yml`](https://github.com/beingmartinbmc/jambavan/blob/main/.github/workflows/jambavan-review.yml) renders it into one idempotent PR comment.

## PR and session handoffs

`npx jambavan handoff --write-pr-template` injects the same handoff card as `jambavan_session_handoff` into `.github/pull_request_template.md`, creating the file if needed. Re-running replaces the old block in place.

```bash
npx jambavan handoff --write-pr-template [--scope <scope>] [--share-safe]
npx jambavan handoff --write-pr-template --post
```

`--post` shells out to your authenticated `gh pr comment`, so it is opt-in and has the same trust boundary as the `bash` tool.

`npx jambavan html-handoff` writes a self-contained HTML report for humans: memory timeline, rin debt, indexed-symbol stats, dirty files, recent commits, collapsible sections, and copy buttons.

## GUI visualizer

`npx jambavan gui` indexes the project and serves a dependency-free local page over Node's built-in `http`, bound to `127.0.0.1` only.

```bash
npx jambavan gui
npx jambavan gui --port 5000
npx jambavan gui --no-open
```

The page has three tabs: code graph, Rin Debt, and Failures. It includes search, pan/zoom, heat markers, and click-through source/caller/callee details. All data comes from local JSON endpoints.

<p align="center">
  <img src="https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/assets/gui-screenshot.svg" alt="Local Jambavan GUI showing graph, Rin Debt, and Failures tabs" width="820">
</p>

## Badges

`npx jambavan badges` prints three local markdown lines you can paste into a README.

```bash
npx jambavan badges
```

The lines summarize context-token savings for the current repo, Rin Ledger debt markers (`// rin:` comments), and Failure Memory (`FailureRecord` memories in the default project scope). The command makes no network calls. If you want rendered badge images, use a [shields.io static badge](https://shields.io/badges/static-badge) URL explicitly; README renders will then fetch from shields.io's CDN.

## Live index watching

Use the `jambavan_watch` tool (`action: start|stop|status`) to keep the index live within an MCP session: supported source-file changes incrementally update the index while the session runs. Most MCP hosts restart the server per session, so there is nothing to manage between sessions.

> **Removed in 1.0:** the standalone background daemon (`jambavan daemon start|stop|status`). A PID file is discovery metadata, not proof of identity, so it could never be signalled safely. If a pre-1.0 daemon left a `.jambavan/daemon.pid` behind, `jambavan_watch` and awaken print a one-line notice telling you to stop that process manually and delete the file — Jambavan never signals it.
