# pi-workspace-memory

Project-scoped Markdown memory for the Pi coding agent — durable state, reports, and research as an auxiliary channel, independent from task-management systems.

## Overview

```text
 Pi session
 │
 ├─ session_start ──▶ snapshot memory context
 ├─ each turn ──────▶ inject: 5 newest state + 5 newest event records
 │                    (non-sensitive, maxTokens budget)
 │                    modes: message-append | system-prompt | off
 │
 ├─ tools — the whole lifecycle in 4
 │   memory_search ── scan content/metadata; no query = list + merge hints
 │   memory_read ──── @id or path → full | summary | knowledge
 │   memory_write ─── create | overwrite (+diff) | merge via supersedes
 │   memory_delete ── remove one record + reconcile metadata
 │
 └─ storage — per Git workspace (slug = git-root basename), local-only
     ~/.pi/memory-md/projects/<slug>/
     ├── records/         state.*.md  event.*.md   ← source of truth
     ├── .catalog.json    slim rebuildable index    (derived)
     └── .concepts.json   concepts + alias map      (derived)
```

- `state` = still-current facts; `event` = append-only reports. Writes are identity-addressed: `memory_write(path="events/foo.md", kind="event")` stores `records/event.foo.md` (legacy `state/`/`events/` paths remain readable).
- Cross-session updates: when another session (or any external write) changes project memory, the next turn appends a compact `+ ~ −` notice listing changed ids (message-append mode). Append-only, so the system prompt and cached prefix stay byte-identical.
- No init tool, no git layer: the first `memory_write` creates `records/` plus two defaults (`state.identity`, `state.preferences`). Renaming a project folder means moving `projects/<slug>/` by hand.

## Install

```bash
pi install git:github.com/sting8k/pi-workspace-memory
```

Local development does not need `node_modules` — runtime frontmatter support is built in:

```bash
pi -e /absolute/path/to/pi-workspace-memory/index.ts
```

## Agent workflow

```text
START: memory_search({ query: "task keywords", searchIn: "all" })
READ:  memory_read({ path: "@event.or-state-id", view: "knowledge" })
END:   memory_write({ path: "events/<topic>.md", kind: "event", summary, claims or facts })
```

Default to `event`; use `state` only for knowledge still true tomorrow. Update state in place instead of dated snapshots. Write durable findings only.

## Write semantics

`memory_write` generates compact Markdown from structured fields — `summary`, `concepts`, `claims`, `facts` (JSON scalars/arrays; nested objects flatten to dotted keys), `relations` (`@id` links), `notes` (loaded only in full view). One machine-checkable facts block per record:

```markdown
<!-- memory:facts:v1 -->
runtime.supported_modes = ["git", "npm", "local"]
relation.follow_up -> @event.next-investigation
<!-- /memory:facts -->
```

- **Overwrite diff** — replacing an existing record returns a compact line diff; fresh creates keep the plain response.
- **Sensitive** — `sensitive: true` blocks auto-injection; sensitive-looking content (keys, tokens, passwords) is flagged with a warning, not rejected. The flag is recomputed on overwrite.
- **Supersedes** (manual compaction) — `supersedes: ["@a", "@b"]` validates every ID before touching disk, writes the distilled record, then marks each target `supersededBy`. Hiding is derived at read time: a record stays hidden only while its superseder exists, deleting the superseder resurrects it, and writing to a hidden record clears the marker.
- **Pre-write dedup (state creates only)** — an ID-family match (`-v2`, `-final`, date suffix, …) routes to an overwrite; concept containment (one set contains the other) rejects with a hint naming the similar record. `forceCreate: true` or a non-empty `supersedes` bypasses both. Events are never deduped.
- **Dated state IDs refused** — dates belong to events; the error suggests `kind: "event"` or `forceCreate: true`.

`memory_search` hides superseded records by default (`includeSuperseded: true` to list them); list mode appends cluster warnings — same-kind records sharing a concept with 4+ members — each with a ready-to-copy merge call. `memory_read` reads hidden records and appends a supersede note. The catalog rebuilds entirely from frontmatter; no migration needed.

## Configuration

`~/.pi/agent/settings.json`:

```json
{
  "pi-workspace-memory": {
    "enabled": true,
    "localPath": "~/.pi/memory-md",
    "injection": "message-append"
  }
}
```

The legacy `pi-memory-md` key is still honored as a fallback.

## Development

```bash
npm test
npx tsc --noEmit
npx biome check <changed-files>
```

## License

MIT
