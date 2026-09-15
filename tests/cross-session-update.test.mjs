import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diffCatalogSignatures,
  ensureProjectMemoryInitialized,
  getMemoryDir,
  readCatalogSignature,
  readPrunedIds,
  renderUpdateNotice,
  upsertMemoryCatalog,
} from "../.test-dist/memoryMdCore.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-xsession-"));
  const workspace = path.join(root, "My Project");
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  const settings = { localPath: path.join(root, "memory") };
  const memoryDir = getMemoryDir(settings, workspace);
  return { root, workspace, settings, memoryDir };
}

function writeRecord(memoryDir, id, description, extra = {}) {
  const filePath = path.join(memoryDir, "records", `${id}.md`);
  fs.writeFileSync(
    filePath,
    [
      "---",
      `description: "${description}"`,
      `created: "${extra.created ?? "2026-09-15T00:00:00.000Z"}"`,
      `updated: "${extra.updated ?? "2026-09-15T00:00:00.000Z"}"`,
      extra.supersededBy ? `supersededBy: "${extra.supersededBy}"` : "",
      extra.sensitive ? "sensitive: true" : "",
      "---",
      "",
      `# ${description}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
    "utf8",
  );
  upsertMemoryCatalog(memoryDir, filePath);
  return filePath;
}

test("signature diff detects add, update, and remove", () => {
  const { memoryDir } = fixture();
  ensureProjectMemoryInitialized(memoryDir);
  const before = readCatalogSignature(memoryDir);

  writeRecord(memoryDir, "event.foreign", "Foreign write");
  writeRecord(memoryDir, "state.identity", "Updated identity", { updated: "2026-09-15T01:00:00.000Z" });
  const victim = before.get("state.preferences");
  fs.rmSync(path.join(memoryDir, victim.path));
  const catalogPath = path.join(memoryDir, ".catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  catalog.entries = catalog.entries.filter((e) => e.id !== "state.preferences");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));

  const after = readCatalogSignature(memoryDir);
  const delta = diffCatalogSignatures(before, after);
  assert.ok(delta);
  assert.deepEqual(
    delta.added.map((e) => e.id),
    ["event.foreign"],
  );
  assert.deepEqual(
    delta.updated.map((e) => e.id),
    ["state.identity"],
  );
  assert.deepEqual(
    delta.removed.map((e) => e.id),
    ["state.preferences"],
  );
});

test("supersededBy transition counts as an update", () => {
  const { memoryDir } = fixture();
  ensureProjectMemoryInitialized(memoryDir);
  writeRecord(memoryDir, "state.old", "Old record");
  const before = readCatalogSignature(memoryDir);

  writeRecord(memoryDir, "state.old", "Old record", {
    updated: "2026-09-15T02:00:00.000Z",
    supersededBy: "state.new",
  });
  writeRecord(memoryDir, "state.new", "Replacement");
  const after = readCatalogSignature(memoryDir);

  const delta = diffCatalogSignatures(before, after);
  assert.ok(delta);
  assert.deepEqual(
    delta.added.map((e) => e.id),
    ["state.new"],
  );
  assert.deepEqual(
    delta.updated.map((e) => e.id),
    ["state.old"],
  );
});

test("identical signatures produce no delta", () => {
  const { memoryDir } = fixture();
  ensureProjectMemoryInitialized(memoryDir);
  const a = readCatalogSignature(memoryDir);
  const b = readCatalogSignature(memoryDir);
  assert.equal(diffCatalogSignatures(a, b), null);
});

test("notice rendering: marks, sensitive masking, pruned label, cap", () => {
  const entry = (id, description, sensitive = false) => ({
    id,
    kind: "event",
    description,
    sensitive,
    mtimeMs: 1,
  });

  const delta = {
    added: [entry("event.one", "First"), entry("event.secret", "has credentials", true)],
    updated: [entry("state.two", "Second")],
    removed: [entry("event.gone", "Removed"), entry("event.gc", "Collected")],
  };
  const notice = renderUpdateNotice(delta, new Set(["event.gc"]));
  assert.match(notice, /\+ @event\.one — First/);
  assert.match(notice, /\+ @event\.secret \(sensitive\)/);
  assert.doesNotMatch(notice, /has credentials/);
  assert.match(notice, /~ @state\.two — Second/);
  assert.match(notice, /- @event\.gone — Removed/);
  assert.match(notice, /- @event\.gc \(pruned\) — Collected/);

  const many = { added: Array.from({ length: 14 }, (_, i) => entry(`event.n${i}`, `n${i}`)), updated: [], removed: [] };
  const capped = renderUpdateNotice(many, new Set());
  assert.match(capped, /\(\+4 more\)/);
  assert.equal(capped.split("\n").length, 12);
});

test("readPrunedIds parses the .pruned.log tail and tolerates absence", () => {
  const { memoryDir } = fixture();
  ensureProjectMemoryInitialized(memoryDir);
  assert.equal(readPrunedIds(memoryDir).size, 0); // no log yet

  fs.appendFileSync(
    path.join(memoryDir, ".pruned.log"),
    "2026-09-15T00:00:00.000Z\tevent.old\trecords/event.old.md\tsupersededBy=@state.new\tsupersededAt=2026-09-14T00:00:00.000Z\n",
    "utf8",
  );
  const ids = readPrunedIds(memoryDir);
  assert.ok(ids.has("event.old"));
  assert.equal(ids.size, 1);
});
