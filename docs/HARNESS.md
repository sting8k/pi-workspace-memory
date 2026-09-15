# Harness

Harness is a repository-level operating layer: durable context and mechanical feedback where they improve the outcome. It does not prescribe reasoning the agent can perform directly.

## Default Flow

```text
Understand -> Implement -> Verify -> Report
```

1. Understand the requested outcome, relevant design, constraints, and likely proof.
2. Implement the smallest change that fits the design.
3. Run focused proof and adjacent regression checks appropriate to the risk.
4. Reconcile the completion contract, then report outcome, evidence, and any unverified gap.

## Completion Contract

Before reporting work as complete, reconcile each applicable clause — a clause that does not apply creates no artifact:

- **Owning documentation** — behavior, schema, architecture, or operator usage changed → update the owning doc.
- **Durable decision** — the work settles a consequential choice future work must inherit → update or create one decision record in `docs/decisions/`.
- **Durable evidence** — release, benchmark, or failure attribution requires retained evidence → record one evidence-focused trace (`docs/TRACE_SPEC.md`).

Routine narrow changes remain direct work: read the affected source, run focused checks, report concisely.

## Proportional Structure

- **Direct work** is the default. No intake, work packet, decision, or trace is required solely because a file changed.
- **Work packet** (one markdown file in `docs/stories/`) only when acceptance criteria need durable tracking, work spans sessions or actors, or risk makes an explicit contract useful. A delegated result is provisional until the integrating actor verifies it.
- **Coordination across sessions** — keep the packet current (objective, scope, acceptance, state, evidence, next action) and reconcile at handoff boundaries.

Lanes guide proof depth (`docs/FEATURE_INTAKE.md`): **tiny** = focused check, **normal** = behavior + regression checks, **high-risk** = explicit contract and validation evidence. Never claim behavior works without evidence; say so when proof is unavailable or skipped.

## Verification and Release

CI (`.github/workflows/ci.yml`) runs on every push and PR:

```bash
npm run lint   # biome ci .
npx tsc --noEmit
npm test
```

Releases are tag-driven. Pushing a tag `v*` that matches `package.json` version runs the checks, then creates a GitHub Release with generated notes. Nothing publishes to npm; installs are `pi install git:github.com/sting8k/pi-workspace-memory`.

## Durable Layer

Policy lives in versioned docs (`docs/decisions/`, `docs/GUARDRAILS.md`, `docs/stories/`). The optional local SQLite layer (`harness.db`, gitignored) is managed by the Rust CLI; commands and schema are documented in `scripts/README.md`:

```bash
scripts/bin/harness-cli init
```

Use the CLI only for records required by the completion contract or a coordination boundary — never to satisfy a sequence.

## Source Hierarchy

```text
User input                    current requested outcome
docs/product/*                accepted product and work contracts
docs/stories/*                durable work packets and evidence
docs/decisions/*              consequential rationale to inherit
docs/GUARDRAILS.md            standing project directives
```

Accepted contracts plus executable tests are the living contract. Retrieval triggers for specialized work: `docs/CONTEXT_RULES.md`.
