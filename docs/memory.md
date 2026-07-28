# Memory, scopes, and MemPalace

## The rootless archive

The default archive is `~/.jambavan/memory/<scope>/<slug>.md`. `scope` identifies a project or topic; `collection` is frontmatter used as a logical room without changing the physical `scope/slug` ID layout. Missing collections in older documents are inferred as `decisions` for `Decision`, `failures` for `FailureRecord`, and `general` otherwise.

With a repository root, the default scope is derived without exposing its raw remote or path: validated `JAMBAVAN_SCOPE`, otherwise normalized Git remote path plus the repository's initial commit, otherwise initial commit plus basename, otherwise a path hash for non-Git directories. Without a root, writes default to `global`.

## Migrating a pre-global archive

Pre-global archives remain readable at `<repo>/.jambavan/memory` when the default archive is active. Legacy `general` and old path-derived project scopes appear under the active Git-derived scope, results are labelled `storage: legacy`, global duplicates win, and the legacy documents are never edited. Migrate explicitly and non-destructively:

Preview only:

```bash
npx jambavan memory migrate --root /path/to/repository
```

Copy after a conflict-free preview; the legacy store is retained:

```bash
npx jambavan memory migrate --root /path/to/repository --apply
```

## MemPalace federation

MemPalace is never contacted during ordinary Jambavan recall, automatic context enrichment, or awakening. It is started only when a memory read explicitly sets `provider: "mempalace"` or `provider: "all"`. Jambavan exposes only five validated MemPalace read capabilities, filters the child environment, and never installs MemPalace, initializes a palace, downloads a model, or exposes its write/update/delete tools.

Install the official package separately (Jambavan does not install it):

```bash
uv tool install mempalace==3.5.0
```

Then opt in per call. Jambavan maps `scope → wing` and `collection → room`; `provider: "all"` keeps BM25 and vector results in separate sections rather than comparing their scores.

```text
jambavan_memory_read { "query": "release decision", "provider": "mempalace", "scope": "project", "collection": "decisions" }
jambavan_memory_read { "id": "drawer-id", "provider": "mempalace" }
jambavan_memory_status { "provider": "all" }
```

## Offline interchange bridge

The older portable bridge remains available for offline interchange and makes no network call:

```bash
npx jambavan bridge --to mempalace [--out <dir>] [--scope <scope>]
npx jambavan bridge --from mempalace [--in <dir>]
```

`--to mempalace` writes one file per memory under `<dir>/<wing>/<room>/<title>.md`, mapping collection to room. `--from mempalace` imports the same shape back into Jambavan.
