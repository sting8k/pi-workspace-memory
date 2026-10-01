# Changelog

Each release's GitHub notes are this file's section whose heading matches the tag. Add the section before tagging.

## v0.6.1 - 2026-10-01

- Fix the pi "Extension issues" warning on install: `@sinclair/typebox` is now a `"*"` peer dependency (provided by pi) instead of a dependency, so no second copy is installed. The pi peers use `"*"` too.
- `@biomejs/biome` moved to devDependencies; installing the extension no longer downloads it.

## v0.6.0 - 2026-09-30

Fixes found by auditing two months of real memory data (63 projects, ~1.8k records).

### Search
- `memory_search` list mode (no query) is paged: newest first, `limit` (default 50, max 200) and `page`, with a ready-to-copy call for the next page. A 370-record project dropped from ~36k to ~4.6k tokens per call.
- Cluster warnings consider state records only, show the 5 largest plus "+N more", and appear on page 1 only. They no longer suggest merging append-only events.

### Write
- `memory_write` rejects `summary` over 300 chars and `description` over 160 chars, saying where longer text belongs. Stored records are not re-checked.
- The tool description now says: state = current truth, overwrite it in place; event = a milestone, not a per-action log; no session-local details (pids, /tmp paths, idle status).
- Creating a state whose distinctive ID tokens are contained in an existing live state is rejected, naming up to 3 records to overwrite or supersede instead (`forceCreate: true` still bypasses). The old concept check missed most duplicates because concepts are rarely shared.

### Lifecycle
- Superseded records without `supersededAt` are now aged by file mtime, so the passive prune finally removes them after `pruneAfterDays`.
- The first write no longer creates default `state.identity` / `state.preferences` records.
- Read-only calls on a project with no memory no longer create its directory, catalog or concept file.

## v0.5.0 - 2026-09-15

- Cross-session update notices: at each turn boundary, changes made to project memory by another session or an external write are appended as a compact `+ ~ −` notice (message-append mode). Own writes are absorbed, pruned deletions are labeled, sensitive entries show only their id. The system prompt and cached prefix stay byte-identical.

Earlier versions: see the git history.
