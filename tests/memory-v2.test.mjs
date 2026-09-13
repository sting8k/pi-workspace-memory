import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter, stringifyFrontmatter } from "../.test-dist/frontmatter.js";
import {
  addConceptAlias,
  buildMemoryContext,
  buildStructuredMemoryContent,
  createMemoryId,
  deleteMemoryFile,
  findMemoryFileById,
  formatMemoryRead,
  getConceptDictionary,
  getMemoryCatalog,
  getMemoryDir,
  MEMORY_FACTS_END,
  MEMORY_FACTS_START,
  memoryFileFromCatalogEntry,
  normalizeConceptLabel,
  normalizeConceptSearchQuery,
  normalizeMemoryConcepts,
  parseMemoryFacts,
  readMemoryFile,
  rebuildMemoryCatalog,
  resolveMemoryPath,
  resolveMemoryWriteTarget,
  sweepPrunableMemory,
  upsertMemoryCatalog,
  validateMemoryContent,
  writeMemoryFile,
} from "../.test-dist/memoryMdCore.js";
import { searchMemoryFiles } from "../.test-dist/search-engine.js";
import {
  registerMemoryDelete,
  registerMemoryRead,
  registerMemorySearch,
  registerMemoryWrite,
} from "../.test-dist/tools.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-v2-"));
  const workspace = path.join(root, "My Project");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  const settings = { localPath: path.join(root, "memory") };
  return { root, workspace, settings };
}

function fakePi() {
  const tools = new Map();
  return {
    tools,
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
  };
}

initTheme(undefined, false);

const renderTheme = {
  fg: (role, text) => `[${role}]${text}[/${role}]`,
  bold: (text) => text,
};

function renderToolText(component) {
  return component.render(500).join("\n");
}

test("memory_write create returns success with soft quality warnings", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = new AbortController().signal;

    const result = await tools.get("memory_write").execute(
      "write-create",
      {
        path: "events/create-diff.md",
        kind: "event",
        description: "Create diff test",
        content: "# Created\n",
      },
      signal,
      () => {},
      { cwd: workspace },
    );

    assert.equal(result.details.operation, "create");
    assert.equal(result.details.diff, undefined);
    assert.match(
      result.content[0].text,
      /^Memory file written: records\/event\.create-diff\.md \(@event\.create-diff\)/,
    );
    assert.match(result.content[0].text, /Memory write warnings:/);
    assert.match(result.content[0].text, /Add a one-sentence summary/);
    assert.deepEqual(result.details.warnings, [
      "Add a one-sentence summary so future searches do not need full prose.",
      "Add at least one claim or fact for durable retrieval.",
    ]);
    assert.doesNotMatch(result.content[0].text, /overwritten|── diff ──/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write marks sensitive-looking records as non-injectable", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const result = await tools.get("memory_write").execute(
      "write-sensitive",
      {
        path: "events/ops-access.md",
        kind: "event",
        description: "Ops access token path",
        summary: "Ops access details include credential paths",
        claims: ["Sensitive records should not be injected automatically"],
        facts: { "ssh.identity_file": "/tmp/key" },
      },
      new AbortController().signal,
      () => {},
      { cwd: workspace },
    );

    assert.equal(result.details.frontmatter.sensitive, true);
    assert.match(result.content[0].text, /Sensitive-looking content was marked sensitive/);
    const context = buildMemoryContext(settings, workspace);
    assert.doesNotMatch(context, /Ops access token path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write overwrite diff preserves a terminal-newline change", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const tool = tools.get("memory_write");
    const signal = new AbortController().signal;

    await tool.execute(
      "write-no-terminal-newline",
      {
        path: "events/terminal-newline.md",
        kind: "event",
        description: "Terminal newline test",
        content: "# Terminal newline",
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    const result = await tool.execute(
      "write-with-terminal-newline",
      {
        path: "events/terminal-newline.md",
        kind: "event",
        description: "Terminal newline test",
        content: "# Terminal newline\n",
      },
      signal,
      () => {},
      { cwd: workspace },
    );

    assert.equal(result.details.operation, "overwrite");
    assert.equal(result.details.diff.newLines.at(-1), "");
    assert.match(result.content[0].text, /\n\+ /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write overwrite response includes compact diff and renderer stats", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const tool = tools.get("memory_write");
    const signal = new AbortController().signal;

    await tool.execute(
      "write-before",
      {
        path: "events/overwrite-diff.md",
        kind: "event",
        description: "Overwrite diff test",
        summary: "First summary",
        claims: ["first claim"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    const result = await tool.execute(
      "write-after",
      {
        path: "events/overwrite-diff.md",
        kind: "event",
        description: "Overwrite diff test",
        summary: "Second summary",
        claims: ["second claim"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );

    const text = result.content[0].text;
    assert.equal(result.details.operation, "overwrite");
    assert.match(text, /^Memory file overwritten: records\/event\.overwrite-diff\.md \(@event\.overwrite-diff\)/);
    assert.match(text, /── diff ──\n:\d+(?:-\d+)?/);
    assert.match(text, /- summary: "First summary"/);
    assert.match(text, /\+ summary: "Second summary"/);
    assert.match(text, /- # First summary/);
    assert.match(text, /\+ # Second summary/);
    assert.equal(result.details.diff.text, text.split("\n\n")[1]);
    assert.equal(result.details.diff.additions, result.details.diff.newLines.length);
    assert.equal(result.details.diff.removals, result.details.diff.oldLines.length);

    const collapsed = renderToolText(tool.renderResult(result, { expanded: false, isPartial: false }, renderTheme));
    assert.match(collapsed, new RegExp(`\\[success\\]\\+${result.details.diff.additions}\\[/success\\]`));
    assert.match(collapsed, new RegExp(`\\[error\\]-${result.details.diff.removals}\\[/error\\]`));
    assert.match(collapsed, /overwrite/);
    assert.match(collapsed, new RegExp(`\\(${text.split("\n").length} more lines,`));

    const expanded = renderToolText(tool.renderResult(result, { expanded: true, isPartial: false }, renderTheme));
    assert.match(expanded, /\[success\]\+ summary: "Second summary"\[\/success\]/);
    assert.match(expanded, /\[error\]- summary: "First summary"\[\/error\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write overwrite diff can use compatible legacy existing markdown", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const legacyPath = path.join(memoryDir, "events", "legacy-overwrite.md");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      stringifyFrontmatter("# Legacy heading\n", {
        id: "event.legacy-overwrite",
        kind: "event",
        description: "Legacy original",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      }),
    );

    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const result = await tools.get("memory_write").execute(
      "write-legacy",
      {
        path: "events/legacy-overwrite.md",
        kind: "event",
        description: "Legacy replacement",
        content: "# Replacement heading\n",
      },
      new AbortController().signal,
      () => {},
      { cwd: workspace },
    );

    assert.equal(result.details.operation, "overwrite");
    assert.match(
      result.content[0].text,
      /^Memory file overwritten: records\/event\.legacy-overwrite\.md \(@event\.legacy-overwrite\)/,
    );
    assert.match(result.content[0].text, /- # Legacy heading/);
    assert.match(result.content[0].text, /\+ # Replacement heading/);
    assert.equal(fs.existsSync(path.join(memoryDir, "records", "event.legacy-overwrite.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frontmatter parser reads legacy folded descriptions and block tags", () => {
  const parsed = parseFrontmatter(`---
description: >-
  A folded legacy
  description
updated: '2026-06-30'
tags:
  - comfyui
  - benchmark
---
# Report`);
  assert.equal(parsed.data.description, "A folded legacy description");
  assert.deepEqual(parsed.data.tags, ["comfyui", "benchmark"]);
  assert.equal(parsed.content, "# Report");
});

test("frontmatter v2 round-trips without external dependencies", () => {
  const serialized = stringifyFrontmatter("# Runtime", {
    id: "state.runtime",
    kind: "state",
    description: "Current runtime",
    tags: [],
    created: "2026-07-11",
  });
  const parsed = parseFrontmatter(serialized);
  assert.deepEqual(parsed.data.tags, []);
  assert.equal(parsed.data.id, "state.runtime");
  assert.equal(parsed.content, "# Runtime");
});

test("project memory is scoped to the Git root slug", () => {
  const { root, workspace, settings } = fixture();
  try {
    const nested = path.join(workspace, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(getMemoryDir(settings, nested), path.join(settings.localPath, "projects", "my-project"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new writes use identity-addressed records with inferred metadata", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const target = resolveMemoryWriteTarget(memoryDir, "events/size-report.md", "event");
    assert.equal(target.id, "event.size-report");
    assert.equal(path.relative(memoryDir, target.filePath), path.join("records", "event.size-report.md"));

    writeMemoryFile(target.filePath, "# Size report", {
      description: "Size report",
      tags: ["benchmark"],
      created: "2026-07-11",
      updated: "2026-07-11",
    });
    upsertMemoryCatalog(memoryDir, target.filePath);

    const memory = readMemoryFile(target.filePath);
    assert.equal(memory.frontmatter.id, "event.size-report");
    assert.equal(memory.frontmatter.kind, "event");
    assert.equal(findMemoryFileById(memoryDir, "@event.size-report"), target.filePath);
    assert.equal(getMemoryCatalog(memoryDir).at(0).path, path.join("records", "event.size-report.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory paths cannot escape the current project", () => {
  assert.throws(() => resolveMemoryPath("/tmp/project-memory", "../other.md"), /must stay inside/);
});

test("logical IDs are deterministic for new files", () => {
  assert.equal(
    createMemoryId("/memory/projects/demo", "/memory/projects/demo/events/2026-07-11-report.md", "event"),
    "event.2026-07-11-report",
  );
});

test("facts DSL accepts JSON values and stable relations", () => {
  const valid = `${MEMORY_FACTS_START}\nruntime.vram_gib = 24\nrelated.report -> @event.benchmark-1\n${MEMORY_FACTS_END}`;
  assert.deepEqual(validateMemoryContent(valid), { valid: true });

  const invalid = `${MEMORY_FACTS_START}\nruntime.vram = 24 GiB\n${MEMORY_FACTS_END}`;
  assert.match(validateMemoryContent(invalid).error ?? "", /valid JSON/);
});

test("concept dictionary normalizes aliases and registers safe new concepts", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["cafe-memory", "identity-addressed-record", "metadata-cache", "semantic-projection"],
          aliases: { "id-based-record": "identity-addressed-record", "knowledge-view": "semantic-projection" },
        },
        null,
        2,
      )}\n`,
    );

    const normalized = normalizeMemoryConcepts(memoryDir, [
      "ID based records",
      "Knowledge View",
      "compact context",
      "metadata-cash",
      "compact context",
    ]);

    assert.deepEqual(normalized.concepts, [
      "compact-context",
      "identity-addressed-record",
      "metadata-cash",
      "semantic-projection",
    ]);
    assert.deepEqual(normalized.audit.registered, ["compact-context", "metadata-cash"]);
    assert.equal(normalized.audit.resolvedAliases["id-based-records"], "identity-addressed-record");
    assert.equal(normalized.audit.resolvedAliases["knowledge-view"], "semantic-projection");
    assert.deepEqual(normalized.audit.possibleDuplicates, [
      { concept: "metadata-cash", candidate: "metadata-cache", score: 0.86 },
    ]);

    const dictionary = getConceptDictionary(memoryDir);
    assert.deepEqual(dictionary.concepts, [
      "cafe-memory",
      "compact-context",
      "identity-addressed-record",
      "metadata-cache",
      "metadata-cash",
      "semantic-projection",
    ]);
    assert.equal(normalizeConceptSearchQuery(memoryDir, "id based record"), "identity-addressed-record");
    assert.equal(normalizeConceptLabel("Café Memory"), "cafe-memory");
    assert.equal(
      normalizeConceptSearchQuery(memoryDir, "id based record knowledge view"),
      "identity-addressed-record semantic-projection",
    );
    assert.equal(normalizeConceptSearchQuery(memoryDir, "free form query"), "free-form-query");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory tools normalize concepts transparently", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["identity-addressed-record", "metadata-cache", "semantic-projection"],
          aliases: { "id-based-record": "identity-addressed-record", "knowledge-view": "semantic-projection" },
        },
        null,
        2,
      )}\n`,
    );

    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = new AbortController().signal;

    const writeResult = await tools.get("memory_write").execute(
      "write-1",
      {
        path: "events/concept-tool.md",
        kind: "event",
        description: "Concept tool test",
        summary: "Concept aliases are normalized before records are written",
        concepts: ["ID based records", "Knowledge View", "ID based record", "metadata cash"],
        claims: ["Tool calls should store canonical concepts"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );

    assert.deepEqual(writeResult.details.frontmatter.concepts, [
      "identity-addressed-record",
      "metadata-cash",
      "semantic-projection",
    ]);
    assert.equal(writeResult.details.concepts.resolvedAliases["id-based-records"], "identity-addressed-record");
    assert.equal(writeResult.details.concepts.resolvedAliases["knowledge-view"], "semantic-projection");
    assert.match(writeResult.content[0].text, /Possible duplicate concepts:/);
    assert.match(writeResult.content[0].text, /metadata-cash is similar to metadata-cache/);
    assert.match(writeResult.details.frontmatter.created, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(writeResult.details.frontmatter.updated, /^\d{4}-\d{2}-\d{2}T/);

    const searchResult = await tools
      .get("memory_search")
      .execute("search-1", { query: "id based record", searchIn: "concepts" }, signal, () => {}, { cwd: workspace });
    assert.equal(searchResult.details.query, "identity-addressed-record");
    assert.equal(searchResult.details.count, 1);
    assert.equal(searchResult.details.results[0].path, path.join("records", "event.concept-tool.md"));

    await tools.get("memory_write").execute(
      "write-2",
      {
        path: "events/concept-distractor.md",
        kind: "event",
        description: "Concept distractor test",
        summary: "This record has only one of the searched concepts",
        concepts: ["ID based record"],
        claims: ["Exact concept search should not return this record for two-concept queries"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    const multiConceptSearch = await tools
      .get("memory_search")
      .execute("search-2", { query: "id based record Knowledge View", searchIn: "concepts" }, signal, () => {}, {
        cwd: workspace,
      });
    assert.equal(multiConceptSearch.details.query, "identity-addressed-record semantic-projection");
    assert.equal(multiConceptSearch.details.count, 1);
    assert.equal(multiConceptSearch.details.results[0].path, path.join("records", "event.concept-tool.md"));

    const unknownConceptSearch = await tools
      .get("memory_search")
      .execute("search-3", { query: "unknown cleanup live orphan token", searchIn: "concepts" }, signal, () => {}, {
        cwd: workspace,
      });
    assert.equal(unknownConceptSearch.details.query, "unknown-cleanup-live-orphan-token");
    assert.equal(unknownConceptSearch.details.count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory delete removes records and reconciles derived metadata", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["alias-target", "kept-concept", "temporary-cleanup-concept", "unused-concept"],
          aliases: { "legacy-cleanup": "alias-target" },
        },
        null,
        2,
      )}\n`,
    );

    const keptTarget = resolveMemoryWriteTarget(memoryDir, "events/kept.md", "event");
    writeMemoryFile(keptTarget.filePath, "# Kept", {
      description: "Kept",
      concepts: ["kept-concept"],
      tags: [],
    });
    upsertMemoryCatalog(memoryDir, keptTarget.filePath);

    const deleteTarget = resolveMemoryWriteTarget(memoryDir, "events/delete-me.md", "event");
    writeMemoryFile(deleteTarget.filePath, "# Delete me", {
      description: "Delete me",
      concepts: ["temporary-cleanup-concept"],
      tags: [],
    });
    upsertMemoryCatalog(memoryDir, deleteTarget.filePath);

    const deleted = deleteMemoryFile(memoryDir, "@event.delete-me");
    assert.equal(deleted.id, "event.delete-me");
    assert.equal(fs.existsSync(deleteTarget.filePath), false);
    assert.deepEqual(
      getMemoryCatalog(memoryDir).map((entry) => entry.id),
      ["event.kept"],
    );

    const dictionary = getConceptDictionary(memoryDir);
    assert.deepEqual(dictionary.aliases, { "legacy-cleanup": "alias-target" });
    assert.deepEqual(dictionary.concepts, ["alias-target", "kept-concept", "unused-concept"]);

    const { pi, tools } = fakePi();
    registerMemoryDelete(pi, settings);
    assert.equal(tools.has("memory_delete"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("structured memory facts normalize nested objects and keys", () => {
  const content = buildStructuredMemoryContent({
    description: "Nested benchmark",
    facts: {
      task_times: { T2_seconds: 72, "Review score": "3/9" },
      "Run ID": "olm-glm-5.2",
    },
    relations: { "Evidence Link": "event.memory-v3" },
  });

  assert.deepEqual(validateMemoryContent(content), { valid: true });
  const semantic = parseMemoryFacts(content);
  assert.deepEqual(semantic.facts, {
    "task_times.t2_seconds": 72,
    "task_times.review_score": "3/9",
    run_id: "olm-glm-5.2",
  });
  assert.equal(semantic.relations["relation.evidence_link"], "@event.memory-v3");
});

test("structured memory records support compact semantic read and search", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const target = resolveMemoryWriteTarget(memoryDir, "events/structured-benchmark.md", "event");
    const content = buildStructuredMemoryContent({
      description: "Structured benchmark",
      summary: "V3 optimizes semantic memory reads with compact projections",
      concepts: ["identity-addressed-record", "semantic-projection"],
      claims: ["Structured records avoid loading prose when facts are enough"],
      facts: { "benchmark.v3.write_ms": 0.269, "benchmark.sizes": [50, 1000, 10000] },
      relations: { implementation: "@event.memory-v3" },
      notes: "Evidence prose stays optional and should not appear in knowledge view.",
    });

    assert.deepEqual(validateMemoryContent(content), { valid: true });
    writeMemoryFile(target.filePath, content, {
      description: "Structured benchmark",
      summary: "V3 optimizes semantic memory reads with compact projections",
      concepts: ["identity-addressed-record", "semantic-projection"],
      claims: ["Structured records avoid loading prose when facts are enough"],
      tags: ["memory-v4", "structured"],
      created: "2026-07-11",
      updated: "2026-07-11",
    });
    upsertMemoryCatalog(memoryDir, target.filePath);

    const memory = readMemoryFile(target.filePath);
    const semantic = parseMemoryFacts(memory.content);
    assert.equal(semantic.facts["benchmark.v3.write_ms"], 0.269);
    assert.equal(semantic.relations["relation.implementation"], "@event.memory-v3");

    const catalogEntry = getMemoryCatalog(memoryDir).at(0);
    assert.equal(catalogEntry.summary, "V3 optimizes semantic memory reads with compact projections");
    assert.deepEqual(catalogEntry.concepts, ["identity-addressed-record", "semantic-projection"]);
    assert.equal("content" in catalogEntry, false);
    assert.equal("facts" in catalogEntry, false);
    assert.equal("relations" in catalogEntry, false);
    assert.doesNotMatch(content, /^## Summary$/m);
    assert.doesNotMatch(content, /^## Concepts$/m);
    assert.doesNotMatch(content, /^## Claims$/m);

    const knowledge = formatMemoryRead(memory, "knowledge");
    assert.match(knowledge, /## Facts/);
    assert.match(knowledge, /benchmark\.v3\.write_ms = 0\.269/);
    assert.doesNotMatch(knowledge, /Evidence prose/);

    const summary = formatMemoryRead(memory, "summary");
    assert.match(summary, /## Concepts/);
    assert.doesNotMatch(summary, /## Claims/);

    const hits = searchMemoryFiles({
      files: new Map([[catalogEntry.path, memoryFileFromCatalogEntry(memoryDir, catalogEntry)]]),
      query: normalizeConceptSearchQuery(memoryDir, "semantic projection"),
      searchIn: "concepts",
    });
    assert.equal(hits[0].path, path.join("records", "event.structured-benchmark.md"));
    assert.deepEqual(hits[0].matchedIn, ["concepts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_search returns stable IDs and knowledge-read next steps", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const target = resolveMemoryWriteTarget(memoryDir, "events/search-next.md", "event");
    writeMemoryFile(target.filePath, "# Search next\n", {
      description: "Search next step",
      summary: "Search results guide agents to compact knowledge reads",
      claims: ["Search output should include the stable ID and next read call"],
    });
    upsertMemoryCatalog(memoryDir, target.filePath);

    const { pi, tools } = fakePi();
    registerMemorySearch(pi, settings);
    const result = await tools
      .get("memory_search")
      .execute("search-next", { query: "compact knowledge", searchIn: "all" }, new AbortController().signal, () => {}, {
        cwd: workspace,
      });

    assert.equal(result.details.results[0].id, "event.search-next");
    assert.equal(result.details.results[0].next, 'memory_read({ path: "@event.search-next", view: "knowledge" })');
    assert.match(result.content[0].text, /records\/event\.search-next\.md \(@event\.search-next\)/);
    assert.match(result.content[0].text, /Next: memory_read\(\{ path: "@event\.search-next", view: "knowledge" \}\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search treats metric queries literally while preserving explicit regex", () => {
  const files = new Map([
    [
      "records/event.benchmark.md",
      {
        path: "records/event.benchmark.md",
        frontmatter: {
          id: "event.benchmark",
          kind: "event",
          description: "Memory benchmark metrics",
          tags: ["benchmark"],
        },
        content: [
          "benchmark.v2.id_read_ms_10000 = 98.517",
          "benchmark.v2.latest-10 = 149.367",
          "benchmark.v3.catalog_lookup_ms_10000 = 0",
          "failure occurred during build",
        ].join("\n"),
      },
    ],
    [
      "records/event.decoy.md",
      {
        path: "records/event.decoy.md",
        frontmatter: { id: "event.decoy", kind: "event", description: "Decoy", tags: [] },
        content: "98x517 unrelated value",
      },
    ],
  ]);

  const metrics = searchMemoryFiles({
    files,
    query: "98.517 latest-10 catalog_lookup_ms_10000",
    searchIn: "all",
    kind: "event",
  });
  assert.equal(metrics[0].path, "records/event.benchmark.md");
  assert.equal(metrics[0].matchCount, 3);
  assert.equal(
    metrics.some((hit) => hit.path === "records/event.decoy.md"),
    false,
  );

  const regex = searchMemoryFiles({ files, query: "fail.*build", searchIn: "content" });
  assert.deepEqual(
    regex.map((hit) => hit.path),
    ["records/event.benchmark.md"],
  );
});

test("context injects only the ten most recently updated memories", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 12; day++) {
      const filePath = path.join(memoryDir, day % 2 === 0 ? "state" : "events", `memory-${day}.md`);
      const date = `2026-07-${String(day).padStart(2, "0")}`;
      writeMemoryFile(filePath, `# Memory ${day}`, {
        id: `${day % 2 === 0 ? "state" : "event"}.memory-${day}`,
        kind: day % 2 === 0 ? "state" : "event",
        description: `Memory ${day}`,
        created: date,
        updated: date,
      });
    }

    const secretPath = path.join(memoryDir, "events", "secret.md");
    writeMemoryFile(secretPath, "# Secret", {
      id: "event.secret",
      kind: "event",
      description: "Secret token path",
      sensitive: true,
      created: "2026-07-20",
      updated: "2026-07-20",
    });
    const context = buildMemoryContext(settings, workspace);
    assert.equal(context.split("\n").filter((line) => line.startsWith("- ")).length, 10);
    assert.match(context, /Memory 12/);
    assert.doesNotMatch(context, /Secret token path/);
    assert.match(context, /Memory 3/);
    assert.doesNotMatch(context, /Memory 2(?:\D|$)/);
    assert.doesNotMatch(context, /Memory 1(?:\D|$)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context rebuilds old catalogs before filtering sensitive memories", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const publicPath = path.join(memoryDir, "events", "public.md");
    const secretPath = path.join(memoryDir, "events", "secret.md");
    writeMemoryFile(publicPath, "# Public", {
      id: "event.public",
      kind: "event",
      description: "Public context",
      created: "2026-07-10",
      updated: "2026-07-10",
    });
    writeMemoryFile(secretPath, "# Secret", {
      id: "event.secret",
      kind: "event",
      description: "Secret token path",
      sensitive: true,
      created: "2026-07-20",
      updated: "2026-07-20",
    });

    const publicStats = fs.statSync(publicPath);
    const secretStats = fs.statSync(secretPath);
    fs.writeFileSync(
      path.join(memoryDir, ".catalog.json"),
      `${JSON.stringify(
        {
          version: 3,
          entries: [
            {
              path: path.relative(memoryDir, publicPath),
              id: "event.public",
              kind: "event",
              description: "Public context",
              concepts: [],
              claims: [],
              tags: [],
              created: "2026-07-10",
              updated: "2026-07-10",
              mtimeMs: publicStats.mtimeMs,
              size: publicStats.size,
            },
            {
              path: path.relative(memoryDir, secretPath),
              id: "event.secret",
              kind: "event",
              description: "Secret token path",
              concepts: [],
              claims: [],
              tags: [],
              created: "2026-07-20",
              updated: "2026-07-20",
              mtimeMs: secretStats.mtimeMs,
              size: secretStats.size,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const context = buildMemoryContext(settings, workspace);
    assert.match(context, /Public context/);
    assert.doesNotMatch(context, /Secret token path/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(memoryDir, ".catalog.json"), "utf-8")).version, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Kind-aware injection quota (5 state + 5 event, two-way backfill)
// ============================================================================

function injectedRecordIds(context) {
  return [...context.matchAll(/\(@([^)]+)\)/g)].map((match) => match[1]);
}

function writeDatedMemory(memoryDir, kind, id, day, datePrefix) {
  const filePath = path.join(memoryDir, kind === "state" ? "state" : "events", `${id}.md`);
  const date = `${datePrefix}-${String(day).padStart(2, "0")}`;
  writeMemoryFile(filePath, `# ${id}`, {
    id: `${kind}.${id}`,
    kind,
    description: `${kind} ${id}`,
    created: date,
    updated: date,
  });
}

test("context injects newest state and event records within a 5/5 quota", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 10; day++) {
      writeDatedMemory(memoryDir, day % 2 === 0 ? "state" : "event", `memory-${day}`, day, "2026-08");
    }
    const context = buildMemoryContext(settings, workspace);
    const ids = injectedRecordIds(context);
    const states = ids.filter((id) => id.startsWith("state."));
    const events = ids.filter((id) => id.startsWith("event."));
    assert.equal(ids.length, 10);
    assert.equal(states.length, 5);
    assert.equal(events.length, 5);
    assert.deepEqual(states, [
      "state.memory-10",
      "state.memory-8",
      "state.memory-6",
      "state.memory-4",
      "state.memory-2",
    ]);
    assert.deepEqual(events, [
      "event.memory-9",
      "event.memory-7",
      "event.memory-5",
      "event.memory-3",
      "event.memory-1",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context backfills missing state quota with newest events", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 3; day++) writeDatedMemory(memoryDir, "state", `memory-${day}`, day, "2026-09");
    for (let day = 4; day <= 15; day++) writeDatedMemory(memoryDir, "event", `memory-${day}`, day, "2026-09");
    const context = buildMemoryContext(settings, workspace);
    const ids = injectedRecordIds(context);
    const states = ids.filter((id) => id.startsWith("state."));
    const events = ids.filter((id) => id.startsWith("event."));
    assert.equal(ids.length, 10);
    assert.deepEqual(states, ["state.memory-3", "state.memory-2", "state.memory-1"]);
    assert.equal(events.length, 7);
    assert.deepEqual(events, [
      "event.memory-15",
      "event.memory-14",
      "event.memory-13",
      "event.memory-12",
      "event.memory-11",
      "event.memory-10",
      "event.memory-9",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context backfills missing event quota with newest states", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 8; day++) writeDatedMemory(memoryDir, "state", `memory-${day}`, day, "2026-10");
    for (let day = 9; day <= 10; day++) writeDatedMemory(memoryDir, "event", `memory-${day}`, day, "2026-10");
    const context = buildMemoryContext(settings, workspace);
    const ids = injectedRecordIds(context);
    const states = ids.filter((id) => id.startsWith("state."));
    const events = ids.filter((id) => id.startsWith("event."));
    assert.equal(ids.length, 10);
    assert.equal(states.length, 8);
    assert.equal(events.length, 2);
    assert.deepEqual(states, [
      "state.memory-8",
      "state.memory-7",
      "state.memory-6",
      "state.memory-5",
      "state.memory-4",
      "state.memory-3",
      "state.memory-2",
      "state.memory-1",
    ]);
    assert.deepEqual(events, ["event.memory-10", "event.memory-9"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context injects only events when a project has no state records", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 12; day++) writeDatedMemory(memoryDir, "event", `memory-${day}`, day, "2026-11");
    const context = buildMemoryContext(settings, workspace);
    const ids = injectedRecordIds(context);
    assert.equal(ids.length, 10);
    assert.equal(ids.filter((id) => id.startsWith("state.")).length, 0);
    assert.equal(ids.filter((id) => id.startsWith("event.")).length, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context is empty for a project with no memory files", () => {
  const { root, workspace, settings } = fixture();
  try {
    assert.equal(buildMemoryContext(settings, workspace), "");
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    assert.equal(buildMemoryContext(settings, workspace), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Concept hygiene and concept aliases
// ============================================================================

test("concept hygiene blocks hash/number/date concepts and warns on sentence-like concepts", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["identity-addressed-record"],
          aliases: {},
        },
        null,
        2,
      )}\n`,
    );

    const normalized = normalizeMemoryConcepts(memoryDir, [
      "deadbeefcafef00d", // hex hash 7-40 chars
      "42", // pure number
      "3.14", // pure number
      "2024-01-01", // YYYY-MM-DD date
      "20240101", // YYYYMMDD date
      "release-2025-03-01", // contains a date
      "123456789", // 9+ digit number must warn as number, not date
      "this is a very long concept sentence", // 7 words -> warn but register
      "identity-addressed-record", // valid existing concept
    ]);

    assert.deepEqual(normalized.concepts, ["identity-addressed-record", "this-is-a-very-long-concept-sentence"]);
    assert.equal(normalized.audit.warnings.length, 8);
    assert.match(normalized.audit.warnings[0], /looks like a hash/);
    assert.match(normalized.audit.warnings[1], /looks like a number/);
    assert.match(normalized.audit.warnings[2], /looks like a number/);
    assert.match(normalized.audit.warnings[3], /looks like a date/);
    assert.match(normalized.audit.warnings[4], /looks like a date/);
    assert.match(normalized.audit.warnings[5], /looks like a date/);
    assert.match(normalized.audit.warnings[6], /looks like a number/);
    assert.match(normalized.audit.warnings[7], /looks like a sentence/);

    const dictionary = getConceptDictionary(memoryDir);
    assert.deepEqual(dictionary.concepts, ["identity-addressed-record", "this-is-a-very-long-concept-sentence"]);
    assert.equal(dictionary.concepts.includes("deadbeefcafef00d"), false);
    assert.equal(dictionary.concepts.includes("42"), false);
    assert.equal(dictionary.concepts.includes("2024-01-01"), false);
    assert.equal(dictionary.concepts.includes("20240101"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concept aliases are added, converted, and rejected", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["identity-addressed-record", "metadata-cash", "metadata-cache"],
          aliases: { "short-hand": "metadata-cache" },
        },
        null,
        2,
      )}\n`,
    );

    // create new alias
    const created = addConceptAlias(memoryDir, "id based record", "identity-addressed-record");
    assert.equal(created.ok, true);
    assert.equal(created.alias, "id-based-record");
    assert.equal(created.canonical, "identity-addressed-record");
    assert.equal(created.converted, false);
    assert.equal(normalizeConceptSearchQuery(memoryDir, "id based record"), "identity-addressed-record");

    // standalone concept -> alias conversion
    const converted = addConceptAlias(memoryDir, "metadata-cash", "metadata-cache");
    assert.equal(converted.ok, true);
    assert.equal(converted.converted, true);
    const dictionary = getConceptDictionary(memoryDir);
    assert.equal(dictionary.concepts.includes("metadata-cash"), false);
    assert.equal(dictionary.aliases["metadata-cash"], "metadata-cache");
    assert.equal(normalizeConceptSearchQuery(memoryDir, "metadata cash"), "metadata-cache");

    // canonical must exist in the dictionary
    const missing = addConceptAlias(memoryDir, "whatever", "does-not-exist");
    assert.equal(missing.ok, false);
    assert.match(missing.error, /canonical concept not found/);

    // conflict: alias is the canonical of another alias in use
    const conflict = addConceptAlias(memoryDir, "metadata-cache", "identity-addressed-record");
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /canonical of another alias/);

    // second alias for the same canonical
    const second = addConceptAlias(memoryDir, "id-records", "identity-addressed-record");
    assert.equal(second.ok, true);
    assert.equal(getConceptDictionary(memoryDir).aliases["id-records"], "identity-addressed-record");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Sensitive detection and flag recomputation
// ============================================================================

test("sensitive detection requires credential-shaped token mentions", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = new AbortController().signal;

    const harmless = await tools.get("memory_write").execute(
      "write-harmless",
      {
        path: "events/token-cost.md",
        kind: "event",
        description: "Token cost review",
        summary: "LLM token usage summary",
        claims: ["Bare token mentions should not be treated as sensitive"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    assert.equal(harmless.details.frontmatter.sensitive, undefined);

    const credential = await tools.get("memory_write").execute(
      "write-credential",
      {
        path: "events/api-token.md",
        kind: "event",
        description: "API token rotation",
        summary: "Access token replaced after rotation",
        claims: ["Tokens should be rotated periodically"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    assert.equal(credential.details.frontmatter.sensitive, true);
    assert.match(credential.content[0].text, /Sensitive-looking content was marked sensitive/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write sensitive flag follows caller and recomputes from new content", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = new AbortController().signal;
    const write = (relPath, params) =>
      tools
        .get("memory_write")
        .execute("write", { path: relPath, kind: "state", ...params }, signal, () => {}, { cwd: workspace });

    // branch 1: explicit sensitive: true wins over harmless content
    const explicit = await write("state/flag.md", {
      description: "Flagged",
      summary: "Explicitly sensitive",
      sensitive: true,
      claims: ["Caller controls the flag"],
    });
    assert.equal(explicit.details.frontmatter.sensitive, true);

    // branch 2: explicit sensitive: false clears a previously sensitive record
    const cleared = await write("state/flag.md", {
      description: "Unflagged",
      summary: "No longer sensitive",
      sensitive: false,
      claims: ["Caller clears the flag"],
    });
    assert.equal(cleared.details.frontmatter.sensitive, undefined);

    // branch 3: no explicit flag + harmless new content recomputes instead of inheriting the old flag
    await write("state/flag.md", {
      description: "Sensitive secret path",
      summary: "Contains api_token details",
      claims: ["Stored as sensitive"],
    });
    const recomputed = await write("state/flag.md", {
      description: "Public note",
      summary: "Plain metadata",
      claims: ["No longer sensitive-looking"],
    });
    assert.equal(recomputed.details.frontmatter.sensitive, undefined);
    assert.doesNotMatch(recomputed.content[0].text, /marked sensitive/);

    // and stays sensitive when the new content still looks sensitive
    const kept = await write("state/flag.md", {
      description: "Still secret",
      summary: "Password rotation completed",
      claims: ["Stays sensitive"],
    });
    assert.equal(kept.details.frontmatter.sensitive, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_search finds records stored under a concept later converted to an alias", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, ".concepts.json"),
      `${JSON.stringify(
        {
          version: 1,
          concepts: ["metadata-cache", "metadata-cash"],
          aliases: {},
        },
        null,
        2,
      )}\n`,
    );

    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = new AbortController().signal;

    // record written while "metadata-cash" was still a standalone concept
    await tools.get("memory_write").execute(
      "write-1",
      {
        path: "events/pre-alias.md",
        kind: "event",
        description: "Pre alias record",
        summary: "Stored under metadata-cash before conversion",
        concepts: ["metadata-cash"],
        claims: ["Concept later converted to an alias"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );
    // record written under the canonical
    await tools.get("memory_write").execute(
      "write-2",
      {
        path: "events/post-alias.md",
        kind: "event",
        description: "Canonical record",
        summary: "Stored under metadata-cache",
        concepts: ["metadata-cache"],
        claims: ["Canonical concept"],
      },
      signal,
      () => {},
      { cwd: workspace },
    );

    // convert the standalone concept into an alias
    const alias = addConceptAlias(getMemoryDir(settings, workspace), "metadata-cash", "metadata-cache");
    assert.equal(alias.ok, true);

    // query by the alias name
    const byAlias = await tools
      .get("memory_search")
      .execute("search-1", { query: "metadata cash", searchIn: "concepts" }, signal, () => {}, { cwd: workspace });
    assert.equal(byAlias.details.query, "metadata-cache");
    assert.equal(byAlias.details.count, 2);
    assert.deepEqual(
      byAlias.details.results.map((r) => r.path),
      [path.join("records", "event.post-alias.md"), path.join("records", "event.pre-alias.md")],
    );

    // query by the canonical name
    const byCanonical = await tools
      .get("memory_search")
      .execute("search-2", { query: "metadata-cache", searchIn: "concepts" }, signal, () => {}, { cwd: workspace });
    assert.equal(byCanonical.details.query, "metadata-cache");
    assert.equal(byCanonical.details.count, 2);
    assert.deepEqual(
      byCanonical.details.results.map((r) => r.path),
      [path.join("records", "event.post-alias.md"), path.join("records", "event.pre-alias.md")],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write surfaces hygiene warnings for blocked concepts in response text", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const result = await tools.get("memory_write").execute(
      "write-hygiene",
      {
        path: "events/hygiene.md",
        kind: "event",
        description: "Hygiene warning test",
        summary: "Blocked concepts must be visible in the response",
        concepts: ["deadbeefcafef00d", "20260101", "ok-concept"],
        claims: ["Blocked concepts are dropped with a visible warning"],
      },
      new AbortController().signal,
      () => {},
      { cwd: workspace },
    );
    assert.match(result.content[0].text, /Memory file written/);
    assert.match(result.content[0].text, /looks like a hash/);
    assert.match(result.content[0].text, /looks like a date/);
    assert.deepEqual(result.details.frontmatter.concepts, ["ok-concept"]);
    assert.ok(result.details.warnings.some((warning) => /looks like a hash/.test(warning)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Round 2/3: dated-ID block, supersedes, pre-write dedup, merge writes, cluster discovery
// ============================================================================

function toolSignal() {
  return new AbortController().signal;
}

test("memory_write rejects dated state IDs unless forceCreate bypasses", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const base = { description: "Deploy run", summary: "Dated write must be blocked", claims: ["run"] };

    const rejected = await tools
      .get("memory_write")
      .execute("w1", { path: "state/deploy-20260725.md", kind: "state", ...base }, signal, () => {}, cwd);
    assert.match(rejected.content[0].text, /dated event ID/);
    assert.match(rejected.content[0].text, /kind:'event'/);
    assert.match(rejected.content[0].text, /forceCreate:true/);

    const rejectedDashed = await tools
      .get("memory_write")
      .execute("w2", { path: "state/deploy-2026-07-25.md", kind: "state", ...base }, signal, () => {}, cwd);
    assert.match(rejectedDashed.content[0].text, /dated event ID/);

    // year-only IDs are not dated and pass
    const yearOnly = await tools
      .get("memory_write")
      .execute(
        "w3",
        { path: "state/plan-2026.md", kind: "state", description: "Year plan", claims: ["y"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(yearOnly.content[0].text, /Memory file written/);

    // event IDs may carry dates (append-only lifecycle is event)
    const eventWrite = await tools
      .get("memory_write")
      .execute(
        "w4",
        { path: "events/deploy-20260725.md", kind: "event", description: "Dated event", claims: ["e"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(eventWrite.content[0].text, /Memory file written/);

    // forceCreate bypasses the block
    const forced = await tools
      .get("memory_write")
      .execute(
        "w5",
        { path: "state/deploy-20260725.md", kind: "state", forceCreate: true, ...base },
        signal,
        () => {},
        cwd,
      );
    assert.match(forced.content[0].text, /Memory file written/);
    assert.equal(forced.details.frontmatter.id, "state.deploy-20260725");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supersedes hides old records, survives rebuild, and resurrects on delete", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    registerMemoryRead(pi, settings);
    registerMemoryDelete(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    await tools
      .get("memory_write")
      .execute(
        "w-c",
        { path: "events/c.md", kind: "event", description: "Record C", claims: ["c"] },
        signal,
        () => {},
        cwd,
      );
    const writeB = await tools.get("memory_write").execute(
      "w-b",
      {
        path: "events/b.md",
        kind: "event",
        description: "Record B",
        claims: ["b"],
        supersedes: ["@event.c"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(writeB.content[0].text, /Superseded: @event\.c/);
    assert.deepEqual(writeB.details.superseded, ["event.c"]);

    // marker persisted on the old record's frontmatter + catalog
    const cPath = findMemoryFileById(memoryDir, "@event.c");
    assert.equal(readMemoryFile(cPath).frontmatter.supersededBy, "event.b");
    assert.equal(getMemoryCatalog(memoryDir).find((entry) => entry.id === "event.c").supersededBy, "event.b");

    // rebuild keeps the marker (catalog is derived from frontmatter)
    rebuildMemoryCatalog(memoryDir);
    assert.equal(getMemoryCatalog(memoryDir).find((entry) => entry.id === "event.c").supersededBy, "event.b");

    // list mode hides by default, shows with includeSuperseded
    const listDefault = await tools.get("memory_search").execute("l1", {}, signal, () => {}, cwd);
    assert.ok(!listDefault.content[0].text.includes("@event.c"));
    const listAll = await tools.get("memory_search").execute("l2", { includeSuperseded: true }, signal, () => {}, cwd);
    assert.match(listAll.content[0].text, /@event\.c[^\n]*\(superseded by @event\.b\)/);

    // search mode uses the same marker: superseded hit is labelled, live hit is not
    const searchAll = await tools
      .get("memory_search")
      .execute("s1", { query: "Record", includeSuperseded: true }, signal, () => {}, cwd);
    assert.match(searchAll.content[0].text, /@event\.c\) \(superseded by @event\.b\)/);
    assert.match(searchAll.content[0].text, /@event\.b\)\n/);
    assert.ok(!/@event\.b\) \(superseded by/.test(searchAll.content[0].text));

    // read by id still works and notes the superseder
    const readC = await tools.get("memory_read").execute("r1", { path: "@event.c" }, signal, () => {}, cwd);
    assert.match(readC.content[0].text, /Record C/);
    assert.match(readC.content[0].text, /Note: superseded by @event\.b/);

    // injection excludes the hidden record
    assert.ok(!buildMemoryContext(settings, workspace).includes("event.c"));

    // transitive chain: A supersedes B -> both B and C hidden
    await tools.get("memory_write").execute(
      "w-a",
      {
        path: "events/a.md",
        kind: "event",
        description: "Record A",
        claims: ["a"],
        supersedes: ["@event.b"],
      },
      signal,
      () => {},
      cwd,
    );
    const contextAfterA = buildMemoryContext(settings, workspace);
    assert.ok(!contextAfterA.includes("event.b"));
    assert.ok(!contextAfterA.includes("event.c"));

    // delete A -> B resurrected (marker cleared), C stays hidden (its superseder B lives)
    await tools.get("memory_delete").execute("d1", { path: "@event.a" }, signal, () => {}, cwd);
    const contextAfterDelete = buildMemoryContext(settings, workspace);
    assert.ok(contextAfterDelete.includes("event.b"));
    assert.ok(!contextAfterDelete.includes("event.c"));
    const bPath = findMemoryFileById(memoryDir, "@event.b");
    assert.equal(readMemoryFile(bPath).frontmatter.supersededBy, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-write dedup: ID-family auto-route and concept-containment reject for state", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "state/base.md", kind: "state", description: "Base config", concepts: ["alpha"], claims: ["base"] },
        signal,
        () => {},
        cwd,
      );

    // ID-family: state.base-v2 routes to overwrite @state.base
    const routed = await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "state/base-v2.md", kind: "state", description: "Base config v2", concepts: ["alpha"], claims: ["v2"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(routed.content[0].text, /routed to overwrite/);
    assert.match(routed.content[0].text, /@state\.base/);
    assert.match(routed.content[0].text, /ID-family match/);
    assert.equal(routed.details.operation, "overwrite");
    assert.equal(routed.details.frontmatter.id, "state.base");
    const baseFamily = getMemoryCatalog(memoryDir).filter((entry) => entry.id.startsWith("state.base"));
    assert.equal(baseFamily.length, 1);
    assert.equal(baseFamily[0].id, "state.base");

    // version suffix without an existing base is a fresh record, not a route
    const fresh = await tools.get("memory_write").execute(
      "w3",
      {
        path: "state/only-v2.md",
        kind: "state",
        description: "Fresh versioned record",
        concepts: ["beta"],
        claims: ["x"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(fresh.content[0].text, /Memory file written/);
    assert.equal(fresh.details.frontmatter.id, "state.only-v2");

    // concept containment: new set is a superset of an existing record's set -> reject with hint
    await tools.get("memory_write").execute(
      "w4",
      {
        path: "state/report.md",
        kind: "state",
        description: "Deploy report",
        concepts: ["deployment", "rollback"],
        claims: ["report"],
      },
      signal,
      () => {},
      cwd,
    );
    const rejected = await tools.get("memory_write").execute(
      "w5",
      {
        path: "state/report-summary.md",
        kind: "state",
        description: "Deploy report summary",
        concepts: ["deployment", "rollback", "incident"],
        claims: ["summary"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(rejected.content[0].text, /Similar state record @state\.report/);
    assert.match(rejected.content[0].text, /forceCreate:true/);
    assert.ok(!fs.existsSync(path.join(memoryDir, "records", "state.report-summary.md")));

    // forceCreate bypasses the containment reject
    const forced = await tools.get("memory_write").execute(
      "w6",
      {
        path: "state/report-summary.md",
        kind: "state",
        forceCreate: true,
        description: "Deploy report summary",
        concepts: ["deployment", "rollback", "incident"],
        claims: ["summary"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(forced.content[0].text, /Memory file written/);

    // events are append-only and never deduped
    await tools
      .get("memory_write")
      .execute(
        "w7",
        { path: "events/e1.md", kind: "event", description: "E1", concepts: ["deployment"], claims: ["x"] },
        signal,
        () => {},
        cwd,
      );
    const eventCreate = await tools
      .get("memory_write")
      .execute(
        "w8",
        { path: "events/e2.md", kind: "event", description: "E2", concepts: ["deployment"], claims: ["y"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(eventCreate.content[0].text, /Memory file written/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write merge writes the distill, supersedes targets, and skips already-superseded ids", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    for (const name of ["e1", "e2", "e3"]) {
      await tools
        .get("memory_write")
        .execute(
          `w-${name}`,
          { path: `events/${name}.md`, kind: "event", description: `Event ${name}`, claims: [`${name} detail`] },
          signal,
          () => {},
          cwd,
        );
    }
    await tools
      .get("memory_write")
      .execute(
        "w-e0",
        { path: "events/e0.md", kind: "event", description: "Event e0", claims: ["e0 detail"] },
        signal,
        () => {},
        cwd,
      );
    await tools.get("memory_write").execute(
      "w-super",
      {
        path: "events/super.md",
        kind: "event",
        description: "Superseding event",
        claims: ["super"],
        supersedes: ["@event.e0"],
      },
      signal,
      () => {},
      cwd,
    );

    const result = await tools.get("memory_write").execute(
      "c1",
      {
        path: "state/incidents.md",
        description: "Incident lifecycle summary",
        summary: "Distilled from four events",
        claims: ["distilled"],
        supersedes: ["@event.e0", "@event.e1", "@event.e2", "@event.e3"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(result.content[0].text, /Memory file written: records\/state\.incidents\.md \(@state\.incidents\)/);
    assert.match(result.content[0].text, /Superseded: @event\.e1, @event\.e2, @event\.e3/);
    assert.match(result.content[0].text, /Skipped: @event\.e0 \(already superseded by @event\.super\)/);
    assert.deepEqual(result.details.superseded, ["event.e1", "event.e2", "event.e3"]);
    assert.deepEqual(result.details.skipped, [{ id: "event.e0", reason: "already superseded by @event.super" }]);

    // distill exists first; marked records carry supersededBy pointing at it
    assert.ok(fs.existsSync(path.join(memoryDir, "records", "state.incidents.md")));
    for (const id of ["event.e1", "event.e2", "event.e3"]) {
      const memory = readMemoryFile(findMemoryFileById(memoryDir, `@${id}`));
      assert.equal(memory.frontmatter.supersededBy, "state.incidents");
    }

    // hidden from list mode and injection
    const listDefault = await tools.get("memory_search").execute("l1", {}, signal, () => {}, cwd);
    assert.ok(!listDefault.content[0].text.includes("@event.e1"));
    const context = buildMemoryContext(settings, workspace);
    assert.ok(context.includes("state.incidents"));
    assert.ok(!context.includes("event.e1"));

    // validation: a missing supersede id aborts before anything is written
    const bad = await tools
      .get("memory_write")
      .execute(
        "c2",
        { path: "state/bad.md", description: "Bad merge", claims: ["bad"], supersedes: ["@event.nope"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(bad.content[0].text, /Memory ID not found: @event\.nope/);
    assert.ok(!fs.existsSync(path.join(memoryDir, "records", "state.bad.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_search list mode reports cluster warnings for same-kind concept groups", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const extras = ["login", "session", "refresh", "logout"];
    for (const extra of extras) {
      await tools.get("memory_write").execute(
        `w-${extra}`,
        {
          path: `state/auth-${extra}.md`,
          kind: "state",
          description: `Auth ${extra}`,
          concepts: ["auth-flow", extra],
          claims: [extra],
        },
        signal,
        () => {},
        cwd,
      );
    }
    const result = await tools.get("memory_search").execute("check", {}, signal, () => {}, cwd);
    assert.match(result.content[0].text, /4 state records share concept "auth-flow", candidates for merge/);
    assert.match(result.content[0].text, /@state\.auth-login/);
    assert.match(result.content[0].text, /Merge: memory_write\(\{ path: "state\/auth-flow-summary\.md"/);
    assert.match(result.content[0].text, /supersedes: \["@state\.auth-login"/);
    assert.equal(result.details.clusters.length, 1);
    assert.equal(result.details.clusters[0].kind, "state");
    assert.equal(result.details.clusters[0].concept, "auth-flow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebuildMemoryCatalog reconstructs supersededBy from frontmatter", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    const pathA = path.join(memoryDir, "records", "state.a.md");
    const pathB = path.join(memoryDir, "records", "state.b.md");
    writeMemoryFile(pathA, "# A", {
      id: "state.a",
      kind: "state",
      description: "A",
      created: "2026-01-01",
      updated: "2026-01-01",
    });
    writeMemoryFile(pathB, "# B", {
      id: "state.b",
      kind: "state",
      description: "B",
      created: "2026-01-02",
      updated: "2026-01-02",
      supersededBy: "state.a",
    });
    upsertMemoryCatalog(memoryDir, pathA);
    upsertMemoryCatalog(memoryDir, pathB);
    const rebuilt = rebuildMemoryCatalog(memoryDir);
    assert.equal(rebuilt.find((entry) => entry.id === "state.b").supersededBy, "state.a");
    assert.equal(rebuilt.find((entry) => entry.id === "state.a").supersededBy, undefined);
    assert.equal(getMemoryCatalog(memoryDir).find((entry) => entry.id === "state.b").supersededBy, "state.a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write rollback restores a pre-existing distill target when marking fails", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    // Pre-existing distill target with known content
    await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "state/benchmark.md", kind: "state", description: "Benchmark conclusions v1", claims: ["v1 content"] },
        signal,
        () => {},
        cwd,
      );
    const distillPath = path.join(memoryDir, "records", "state.benchmark.md");
    const beforeRaw = fs.readFileSync(distillPath, "utf-8");

    // Supersede target that will fail during the mark step (read-only file -> EACCES)
    await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "events/old.md", kind: "event", description: "Old event", claims: ["old"] },
        signal,
        () => {},
        cwd,
      );
    const oldPath = path.join(memoryDir, "records", "event.old.md");
    fs.chmodSync(oldPath, 0o444);

    const result = await tools.get("memory_write").execute(
      "c1",
      {
        path: "state/benchmark.md",
        description: "Benchmark conclusions v2",
        claims: ["v2 content"],
        supersedes: ["@event.old"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(result.content[0].text, /rolled back best-effort/);

    // The pre-existing distill target is restored byte-for-byte, not deleted
    assert.equal(fs.readFileSync(distillPath, "utf-8"), beforeRaw);
    // The failed target was never marked
    assert.equal(readMemoryFile(oldPath).frontmatter.supersededBy, undefined);
    // Catalog is consistent with the restored file
    assert.equal(
      getMemoryCatalog(memoryDir).find((entry) => entry.id === "state.benchmark").description,
      "Benchmark conclusions v1",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Round 3: consolidated tool surface (write absorbs compact + init, search absorbs list)
// ============================================================================

test("memory_write auto-initializes project memory on the first write only", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    assert.equal(fs.existsSync(memoryDir), false);

    const first = await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "events/first.md", kind: "event", description: "First record", claims: ["first"] },
        signal,
        () => {},
        cwd,
      );
    assert.equal(first.details.initialized, true);
    assert.match(first.content[0].text, /^Memory file written: records\/event\.first\.md \(@event\.first\)/);
    assert.match(first.content[0].text, /Initialized project memory:/);
    assert.equal(fs.existsSync(path.join(memoryDir, "records")), true);
    for (const id of ["state.identity", "state.preferences"]) {
      assert.ok(findMemoryFileById(memoryDir, `@${id}`), `${id} default record missing`);
    }

    const second = await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "events/second.md", kind: "event", description: "Second record", claims: ["second"] },
        signal,
        () => {},
        cwd,
      );
    assert.equal(second.details.initialized, false);
    assert.doesNotMatch(second.content[0].text, /Initialized project memory:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write supersedes bypasses ID-family route and containment reject", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    await tools.get("memory_write").execute(
      "w1",
      {
        path: "state/report.md",
        kind: "state",
        description: "Deploy report",
        concepts: ["deployment", "rollback"],
        claims: ["report"],
      },
      signal,
      () => {},
      cwd,
    );

    // containment would reject this superset of concepts; supersedes is the explicit dedup decision
    const merged = await tools.get("memory_write").execute(
      "w2",
      {
        path: "state/report-summary.md",
        kind: "state",
        description: "Deploy report summary",
        concepts: ["deployment", "rollback", "incident"],
        claims: ["summary"],
        supersedes: ["@state.report"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.match(merged.content[0].text, /Memory file written: records\/state\.report-summary\.md/);
    assert.match(merged.content[0].text, /Superseded: @state\.report/);
    assert.equal(
      readMemoryFile(findMemoryFileById(memoryDir, "@state.report")).frontmatter.supersededBy,
      "state.report-summary",
    );

    // ID-family would route state.base-v2 onto @state.base; supersedes keeps the new record separate
    await tools
      .get("memory_write")
      .execute(
        "w3",
        { path: "state/base.md", kind: "state", description: "Base config", concepts: ["alpha"], claims: ["base"] },
        signal,
        () => {},
        cwd,
      );
    const versioned = await tools.get("memory_write").execute(
      "w4",
      {
        path: "state/base-v2.md",
        kind: "state",
        description: "Base config v2",
        concepts: ["alpha"],
        claims: ["v2"],
        supersedes: ["@state.base"],
      },
      signal,
      () => {},
      cwd,
    );
    assert.doesNotMatch(versioned.content[0].text, /routed to overwrite/);
    assert.equal(versioned.details.frontmatter.id, "state.base-v2");
    assert.equal(
      readMemoryFile(findMemoryFileById(memoryDir, "@state.base")).frontmatter.supersededBy,
      "state.base-v2",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write on a superseded record clears the marker and reports it", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "events/old.md", kind: "event", description: "Old", claims: ["old"] },
        signal,
        () => {},
        cwd,
      );
    await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "events/new.md", kind: "event", description: "New", claims: ["new"], supersedes: ["@event.old"] },
        signal,
        () => {},
        cwd,
      );
    const hidden = await tools.get("memory_search").execute("l1", {}, signal, () => {}, cwd);
    assert.ok(!hidden.content[0].text.includes("@event.old"));

    const rewritten = await tools
      .get("memory_write")
      .execute(
        "w3",
        { path: "events/old.md", kind: "event", description: "Old, revisited", claims: ["still relevant"] },
        signal,
        () => {},
        cwd,
      );
    assert.match(rewritten.content[0].text, /Cleared superseded marker \(was superseded by @event\.new\)/);
    assert.equal(readMemoryFile(findMemoryFileById(memoryDir, "@event.old")).frontmatter.supersededBy, undefined);
    const visible = await tools.get("memory_search").execute("l2", {}, signal, () => {}, cwd);
    assert.ok(visible.content[0].text.includes("@event.old"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_search without a query lists records and filters by kind", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    registerMemorySearch(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };

    await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "events/deploy.md", kind: "event", description: "Deploy run", claims: ["deployed"] },
        signal,
        () => {},
        cwd,
      );
    await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "state/runtime.md", kind: "state", description: "Runtime config", claims: ["runtime"] },
        signal,
        () => {},
        cwd,
      );

    const all = await tools.get("memory_search").execute("l1", {}, signal, () => {}, cwd);
    assert.equal(all.details.mode, "list");
    // two written records plus the two default records created by auto-init
    assert.equal(all.details.count, 4);
    assert.match(all.content[0].text, /Memory files \(4\):/);
    assert.match(all.content[0].text, /records\/event\.deploy\.md \(@event\.deploy\)\n {4}event: Deploy run/);
    assert.match(all.content[0].text, /records\/state\.runtime\.md \(@state\.runtime\)\n {4}state: Runtime config/);
    assert.doesNotMatch(all.content[0].text, /Cluster warnings/);

    const events = await tools.get("memory_search").execute("l2", { kind: "event" }, signal, () => {}, cwd);
    assert.equal(events.details.count, 1);
    assert.deepEqual(
      events.details.files.map((file) => file.id),
      ["event.deploy"],
    );

    // a blank query is still list mode, and search mode is unchanged
    const blank = await tools.get("memory_search").execute("l3", { query: "   " }, signal, () => {}, cwd);
    assert.equal(blank.details.mode, "list");
    const searched = await tools
      .get("memory_search")
      .execute("s1", { query: "runtime", searchIn: "description" }, signal, () => {}, cwd);
    assert.equal(searched.details.mode, "search");
    assert.equal(searched.details.count, 1);
    assert.equal(searched.details.results[0].id, "state.runtime");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// Round 4 (ported back from dsh-memory-md): maxTokens budget, passive prune,
// merge receipt, search recency tie-break
// ============================================================================

test("context enforces systemPrompt.maxTokens by trimming oldest entries first", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    for (let day = 1; day <= 4; day++) {
      writeDatedMemory(memoryDir, "event", `budget-${day}`, day, "2026-12");
    }
    const full = buildMemoryContext(settings, workspace);
    assert.equal(injectedRecordIds(full).length, 4);

    const tight = buildMemoryContext({ ...settings, systemPrompt: { maxTokens: 1 } }, workspace);
    const tightIds = injectedRecordIds(tight);
    assert.equal(tightIds.length, 1);
    assert.equal(tightIds[0], "event.budget-4");

    const partial = buildMemoryContext({ ...settings, systemPrompt: { maxTokens: 10 } }, workspace);
    const partialIds = injectedRecordIds(partial);
    assert.ok(partialIds.length >= 1 && partialIds.length < 4);
    assert.equal(partialIds[0], "event.budget-4");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const OLD_MARKER = "2026-01-01T00:00:00.000Z";

function writeTombstone(memoryDir, id, kind, supersededBy, supersededAt) {
  const filePath = path.join(memoryDir, "records", `${id}.md`);
  writeMemoryFile(filePath, `# ${id}`, {
    id,
    kind,
    description: `${id} description`,
    created: "2026-01-01",
    updated: "2026-01-01",
    supersededBy,
    ...(supersededAt ? { supersededAt } : {}),
  });
  upsertMemoryCatalog(memoryDir, filePath);
  return filePath;
}

test("sweep prunes aged tombstones, keeps the distill, and never resurrects chain tails", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    const liveA = writeTombstone(memoryDir, "state.a", "state", undefined, undefined);
    const tombB = writeTombstone(memoryDir, "state.b", "state", "state.a", OLD_MARKER);
    const tombC = writeTombstone(memoryDir, "state.c", "state", "state.b", OLD_MARKER);

    const context = buildMemoryContext({ ...settings, pruneAfterDays: 1 }, workspace);
    assert.ok(context.includes("@state.a"));
    assert.ok(!context.includes("state.b"));
    assert.ok(!context.includes("state.c"));

    assert.equal(fs.existsSync(liveA), true);
    assert.equal(fs.existsSync(tombB), false);
    assert.equal(fs.existsSync(tombC), false);
    assert.deepEqual(
      getMemoryCatalog(memoryDir).map((entry) => entry.id),
      ["state.a"],
    );

    const log = fs.readFileSync(path.join(memoryDir, ".pruned.log"), "utf-8");
    assert.match(log, /state\.b\t/);
    assert.match(log, /state\.c\t/);
    assert.match(log, /supersededBy=state\.a/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep re-points fresh chain tails instead of resurrecting them", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeTombstone(memoryDir, "state.a", "state", undefined, undefined);
    const tombB = writeTombstone(memoryDir, "state.b", "state", "state.a", OLD_MARKER);
    const freshC = writeTombstone(memoryDir, "state.c", "state", "state.b", new Date().toISOString());

    const pruned = sweepPrunableMemory(memoryDir, 1);
    assert.deepEqual(
      pruned.map((p) => p.id),
      ["state.b"],
    );
    assert.equal(fs.existsSync(tombB), false);
    assert.equal(fs.existsSync(freshC), true);

    const cMemory = readMemoryFile(freshC);
    assert.equal(cMemory.frontmatter.supersededBy, "state.a");
    const context = buildMemoryContext(settings, workspace);
    assert.ok(context.includes("@state.a"));
    assert.ok(!context.includes("state.c"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy tombstones without supersededAt are never pruned", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeTombstone(memoryDir, "state.a", "state", undefined, undefined);
    const legacyB = writeTombstone(memoryDir, "state.b", "state", "state.a", undefined);

    const pruned = sweepPrunableMemory(memoryDir, 1);
    assert.deepEqual(pruned, []);
    assert.equal(fs.existsSync(legacyB), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneAfterDays 0 disables the sweep entirely", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeTombstone(memoryDir, "state.a", "state", undefined, undefined);
    const tombB = writeTombstone(memoryDir, "state.b", "state", "state.a", OLD_MARKER);

    assert.deepEqual(sweepPrunableMemory(memoryDir, 0), []);
    assert.equal(fs.existsSync(tombB), true);
    assert.equal(fs.existsSync(path.join(memoryDir, ".pruned.log")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("memory_write merge receipt lists claims/facts/concepts not carried over", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };

    await tools.get("memory_write").execute(
      "w-src",
      {
        path: "events/src.md",
        kind: "event",
        description: "Source record",
        summary: "Carries one keepable claim and one losable claim",
        concepts: ["keep-concept", "lose-concept"],
        claims: ["keep this claim", "lose this claim"],
        facts: { "keep.key": 1, "lose.key": 2 },
      },
      signal,
      () => {},
      cwd,
    );
    const merged = await tools.get("memory_write").execute(
      "w-distill",
      {
        path: "state/distill.md",
        description: "Distilled record",
        summary: "Only keeps the keepable material",
        concepts: ["keep-concept"],
        claims: ["Keep THIS claim"],
        facts: { "keep.key": 1 },
        supersedes: ["@event.src"],
      },
      signal,
      () => {},
      cwd,
    );

    assert.deepEqual(merged.details.superseded, ["event.src"]);
    assert.equal(merged.details.receipt.length, 1);
    const receipt = merged.details.receipt[0];
    assert.equal(receipt.id, "event.src");
    assert.deepEqual(receipt.missingClaims, ["lose this claim"]);
    assert.deepEqual(receipt.missingFactKeys, ["lose.key"]);
    assert.deepEqual(receipt.missingConcepts, ["lose-concept"]);
    assert.match(merged.content[0].text, /Merge receipt - not carried over/);
    assert.match(merged.content[0].text, /"lose this claim"/);
    assert.match(merged.content[0].text, /lose\.key/);
    assert.match(merged.content[0].text, /lose-concept/);
    assert.ok(!merged.content[0].text.includes('"keep this claim"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rewriting a superseded record resets the prune clock", async () => {
  const { root, workspace, settings } = fixture();
  try {
    const { pi, tools } = fakePi();
    registerMemoryWrite(pi, settings);
    const signal = toolSignal();
    const cwd = { cwd: workspace };
    const memoryDir = getMemoryDir(settings, workspace);

    await tools
      .get("memory_write")
      .execute(
        "w1",
        { path: "events/old.md", kind: "event", description: "Old", claims: ["old"] },
        signal,
        () => {},
        cwd,
      );
    await tools
      .get("memory_write")
      .execute(
        "w2",
        { path: "events/new.md", kind: "event", description: "New", claims: ["new"], supersedes: ["@event.old"] },
        signal,
        () => {},
        cwd,
      );
    const oldPath = findMemoryFileById(memoryDir, "@event.old");
    const marked = readMemoryFile(oldPath);
    assert.ok(marked.frontmatter.supersededAt, "marker must stamp supersededAt");
    assert.match(marked.frontmatter.supersededAt, /^\d{4}-\d{2}-\d{2}T/);

    await tools
      .get("memory_write")
      .execute(
        "w3",
        { path: "events/old.md", kind: "event", description: "Old, revisited", claims: ["still relevant"] },
        signal,
        () => {},
        cwd,
      );
    const revisited = readMemoryFile(findMemoryFileById(memoryDir, "@event.old"));
    assert.equal(revisited.frontmatter.supersededBy, undefined);
    assert.equal(revisited.frontmatter.supersededAt, undefined);

    assert.deepEqual(sweepPrunableMemory(memoryDir, 1), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeDatedRecord(memoryDir, id, kind, body, updated, concepts = []) {
  const filePath = path.join(memoryDir, "records", `${id}.md`);
  writeMemoryFile(filePath, body, {
    id,
    kind,
    description: `${id} description`,
    concepts,
    created: "2026-01-01T00:00:00.000Z",
    updated,
  });
  upsertMemoryCatalog(memoryDir, filePath);
  return filePath;
}

test("natural-language search breaks match-count ties by recency, newest first", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeDatedRecord(memoryDir, "event.a-old", "event", "# Old deploy run notes\n", "2026-01-01T00:00:00.000Z");
    writeDatedRecord(memoryDir, "event.z-new", "event", "# Fresh deploy run notes\n", "2026-09-13T00:00:00.000Z");

    const files = new Map(
      getMemoryCatalog(memoryDir).map((entry) => [entry.path, memoryFileFromCatalogEntry(memoryDir, entry)]),
    );
    const hits = searchMemoryFiles({ files, query: "deploy run", searchIn: "content" });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].path, path.join("records", "event.z-new.md"));
    assert.equal(hits[1].path, path.join("records", "event.a-old.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("match count still wins over recency", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeDatedRecord(memoryDir, "event.old-dense", "event", "# deploy rollback run\n", "2026-01-01T00:00:00.000Z");
    writeDatedRecord(memoryDir, "event.new-sparse", "event", "# deploy run\n", "2026-09-13T00:00:00.000Z");

    const files = new Map(
      getMemoryCatalog(memoryDir).map((entry) => [entry.path, memoryFileFromCatalogEntry(memoryDir, entry)]),
    );
    const hits = searchMemoryFiles({ files, query: "deploy rollback", searchIn: "content" });
    assert.equal(hits[0].path, path.join("records", "event.old-dense.md"));
    assert.equal(hits[0].matchCount, 2);
    assert.equal(hits[1].matchCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regex mode ranks by recency when every hit ties at match count", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeDatedRecord(
      memoryDir,
      "event.alpha-legacy",
      "event",
      "# failure during build (old)\n",
      "2026-01-01T00:00:00.000Z",
    );
    writeDatedRecord(
      memoryDir,
      "event.omega-recent",
      "event",
      "# failure during build (new)\n",
      "2026-09-13T00:00:00.000Z",
    );

    const files = new Map(
      getMemoryCatalog(memoryDir).map((entry) => [entry.path, memoryFileFromCatalogEntry(memoryDir, entry)]),
    );
    const hits = searchMemoryFiles({ files, query: "fail.*build", searchIn: "content" });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].path, path.join("records", "event.omega-recent.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact-concept search ranks by recency when all hits tie at term count", () => {
  const { root, workspace, settings } = fixture();
  try {
    const memoryDir = getMemoryDir(settings, workspace);
    fs.mkdirSync(path.join(memoryDir, "records"), { recursive: true });
    writeDatedRecord(memoryDir, "event.auth-early", "event", "# Auth early\n", "2026-01-01T00:00:00.000Z", [
      "auth-flow",
    ]);
    writeDatedRecord(memoryDir, "event.auth-late", "event", "# Auth late\n", "2026-09-13T00:00:00.000Z", ["auth-flow"]);

    const files = new Map(
      getMemoryCatalog(memoryDir).map((entry) => [entry.path, memoryFileFromCatalogEntry(memoryDir, entry)]),
    );
    const hits = searchMemoryFiles({ files, query: "auth-flow", searchIn: "concepts" });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].path, path.join("records", "event.auth-late.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
