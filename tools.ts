import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  buildStructuredMemoryContent,
  type CompactClusterReport,
  deleteMemoryFile,
  ensureProjectMemoryInitialized,
  expandConceptSearchFamilies,
  filterSupersededEntries,
  findCompactClusters,
  findConceptContainmentDuplicate,
  findIdFamilyRoute,
  findMemoryFileById,
  formatMemoryRead,
  getCurrentDate,
  getMemoryCatalog,
  getMemoryDir,
  isDatedMemoryId,
  markRecordSuperseded,
  memoryFileFromCatalogEntry,
  normalizeConceptSearchQuery,
  normalizeMemoryConcepts,
  parseMemoryFacts,
  readMemoryFile,
  rebuildMemoryCatalog,
  resolveMemoryFile,
  resolveMemoryPath,
  resolveMemoryWriteTarget,
  supersededByExists,
  upsertMemoryCatalog,
  validateMemoryContent,
  writeMemoryFile,
} from "./memoryMdCore.js";
import { type SearchField, searchMemoryFiles } from "./search-engine.js";
import type {
  ConceptDuplicateHint,
  MemoryFrontmatter,
  MemoryMdSettings,
  MemoryReadView,
  StructuredMemoryFields,
} from "./types.js";

// Re-export types for convenience
export type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
export type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

// ============================================================================
// Render Utilities - Inline for simplicity
// ============================================================================

function renderText(text: string): Text {
  return new Text(text, 0, 0);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? `"${value}"` : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object" && value !== null) return "{...}";
  return String(value);
}

function buildToolCallText(name: string, args: Record<string, unknown>, theme: Theme): string {
  const text = theme.fg("toolTitle", theme.bold(name));
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return text;
  const preferred = entries.find(([k]) => k === "path" || k === "action" || k === "from" || k === "to") || entries[0];
  return `${text} ${theme.fg("accent", formatValue(preferred[1]))}`;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function formatConceptDuplicateHints(hints?: ConceptDuplicateHint[]): string {
  if (!hints?.length) return "";
  return [
    "Possible duplicate concepts:",
    ...hints.map((hint) => `- ${hint.concept} is similar to ${hint.candidate} (${hint.score})`),
  ].join("\n");
}

const SENSITIVE_MEMORY_PATTERN =
  /\b(?:api[-_\s]?key|credential|identity[-_\s]?file|password|passwd|private[-_\s]?key|secret|ssh|(?:api|access|auth|bearer|refresh|session|oauth)[-_\s]?token|token\s*[=:]\s*\S+)\b/i;

function hasSensitiveMemoryInput(value: unknown): boolean {
  if (typeof value === "string") return SENSITIVE_MEMORY_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((entry) => hasSensitiveMemoryInput(entry));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, entry]) => SENSITIVE_MEMORY_PATTERN.test(key) || hasSensitiveMemoryInput(entry),
    );
  }
  return false;
}

function formatMemoryWriteWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return ["Memory write warnings:", ...warnings.map((warning) => `- ${warning}`)].join("\n");
}

function buildMemoryWriteWarnings(input: {
  summary?: string;
  claims?: string[];
  facts?: Record<string, unknown>;
  content?: string;
  finalSensitive: boolean;
  detectedSensitive: boolean;
  hygieneWarnings?: string[];
}): string[] {
  const warnings: string[] = [];
  if (input.hygieneWarnings?.length) warnings.push(...input.hygieneWarnings);
  if (!input.summary?.trim()) warnings.push("Add a one-sentence summary so future searches do not need full prose.");
  if (!input.claims?.length && Object.keys(input.facts ?? {}).length === 0) {
    warnings.push("Add at least one claim or fact for durable retrieval.");
  }
  if (input.content && input.content.length > 800) {
    warnings.push("Raw content is long; prefer structured fields plus short notes.");
  }
  if (input.detectedSensitive) {
    warnings.push("Sensitive-looking content was marked sensitive and will not be injected automatically.");
  } else if (input.finalSensitive) {
    warnings.push("Sensitive record will not be injected automatically.");
  }
  return warnings;
}

type MemoryOverwriteDiffSummary = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
  additions: number;
  removals: number;
  lineRange: string;
  text: string;
};

function splitMarkdownLines(text: string): string[] {
  return text.split("\n");
}

function formatMemoryOverwriteLineRange(
  diff: Pick<MemoryOverwriteDiffSummary, "oldStart" | "newStart" | "oldLines" | "newLines">,
): string {
  const oldEnd = diff.oldStart + Math.max(0, diff.oldLines.length - 1);
  if (diff.oldLines.length <= 1 && diff.newLines.length <= 1) return `:${diff.oldStart}`;
  const newEnd = diff.newStart + Math.max(0, diff.newLines.length - 1);
  return `:${diff.oldStart}-${Math.max(oldEnd, newEnd)}`;
}

function formatMemoryOverwriteDiff(
  diff: Pick<MemoryOverwriteDiffSummary, "lineRange" | "oldLines" | "newLines">,
): string {
  return [
    "── diff ──",
    diff.lineRange,
    ...diff.oldLines.map((line) => `- ${line}`),
    ...diff.newLines.map((line) => `+ ${line}`),
  ].join("\n");
}

function buildMemoryOverwriteDiff(beforeRaw: string, afterRaw: string): MemoryOverwriteDiffSummary | undefined {
  const before = splitMarkdownLines(beforeRaw);
  const after = splitMarkdownLines(afterRaw);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix === before.length && prefix === after.length) return undefined;

  const diff = {
    oldStart: prefix + 1,
    newStart: prefix + 1,
    oldLines: before.slice(prefix, before.length - suffix),
    newLines: after.slice(prefix, after.length - suffix),
  };
  const lineRange = formatMemoryOverwriteLineRange(diff);
  const summary = {
    ...diff,
    additions: diff.newLines.length,
    removals: diff.oldLines.length,
    lineRange,
    text: "",
  };
  summary.text = formatMemoryOverwriteDiff(summary);
  return summary;
}

function renderMemoryDiffLine(theme: Theme, line: string): string {
  if (line === "── diff ──") return theme.fg("muted", "diff");
  if (/^:\d+(?:-\d+)?$/.test(line)) return theme.fg("muted", line);
  if (line.startsWith("+ ")) return theme.fg("success", line);
  if (line.startsWith("- ")) return theme.fg("error", line);
  return theme.fg("toolOutput", line);
}

function renderMemoryOutput(text: string, diff: MemoryOverwriteDiffSummary | undefined, theme: Theme): string {
  if (!diff) return theme.fg("toolOutput", text);
  let inDiff = false;
  return text
    .split("\n")
    .map((line) => {
      if (line === "── diff ──") {
        inDiff = true;
        return renderMemoryDiffLine(theme, line);
      }
      if (inDiff && line === "") {
        inDiff = false;
        return theme.fg("toolOutput", line);
      }
      return inDiff ? renderMemoryDiffLine(theme, line) : theme.fg("toolOutput", line);
    })
    .join("\n");
}

function buildExpandHint(totalLines: number, theme: Theme): string {
  const remaining = totalLines - 1;
  if (remaining <= 0) return "";
  return (
    "\n" +
    theme.fg("muted", `... (${remaining} more lines,`) +
    " " +
    keyHint("app.tools.expand", "to expand") +
    theme.fg("muted", ")")
  );
}

function renderCollapsed(summary: string, fullText: string, options: { expanded: boolean }, theme: Theme): Text {
  if (options.expanded) return renderText(theme.fg("toolOutput", fullText));
  return renderText(theme.fg("success", summary) + buildExpandHint(fullText.split("\n").length, theme));
}

function renderMemoryResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  defaults?: { description?: string; tags?: string[]; notice?: string; diff?: MemoryOverwriteDiffSummary },
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Reading..."));
  const details = result.details as
    | { error?: boolean; frontmatter?: { description?: string; tags?: string[] }; diff?: MemoryOverwriteDiffSummary }
    | undefined;
  if (details?.error) return renderText(theme.fg("error", getResultText(result) || "Error"));

  const description = defaults?.description || details?.frontmatter?.description || "Memory file";
  const tags = defaults?.tags || details?.frontmatter?.tags || [];
  const text = getResultText(result);
  const notice = defaults?.notice;
  const diff = defaults?.diff ?? details?.diff;
  const overwriteStats = diff
    ? `${theme.fg("success", `+${diff.additions}`)}${theme.fg("muted", " / ")}${theme.fg("error", `-${diff.removals}`)}${theme.fg("muted", " overwrite")}`
    : "";

  if (!options.expanded) {
    const summary = [
      theme.fg("success", description),
      overwriteStats,
      theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`),
      notice ? theme.fg("warning", notice) : "",
    ]
      .filter(Boolean)
      .join("\n");
    return renderText(summary + buildExpandHint(text.split("\n").length + 1, theme));
  }

  return renderText(
    theme.fg("success", description) +
      `\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}${notice ? `\n${theme.fg("warning", notice)}` : ""}\n${renderMemoryOutput(text, diff, theme)}`,
  );
}

function renderCountResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  label: string,
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Loading..."));
  const details = result.details as { count?: number } | undefined;
  const text = getResultText(result);
  if (!options.expanded)
    return renderText(
      theme.fg("success", `${details?.count ?? 0} ${label}`) + buildExpandHint(text.split("\n").length, theme),
    );
  return renderText(theme.fg("toolOutput", text));
}

export function registerMemoryRead(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read a project memory file by relative path or stable @id with full, summary, or knowledge projection",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative path (e.g. 'records/state.runtime.md' or logical 'state/runtime.md') or stable ID (e.g. '@state.runtime')",
      }),
      view: Type.Optional(
        Type.Union([Type.Literal("full"), Type.Literal("summary"), Type.Literal("knowledge")], {
          description: "Projection to return: full Markdown, compact summary, or semantic knowledge only",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: pathOrId, view = "full" } = params as { path: string; view?: MemoryReadView };
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      try {
        const fullPath = resolveMemoryFile(memoryDir, pathOrId);
        const memory = readMemoryFile(fullPath);
        if (!memory) throw new Error("File could not be parsed");

        const supersededNote =
          memory.frontmatter.supersededBy && findMemoryFileById(memoryDir, memory.frontmatter.supersededBy)
            ? `\n\nNote: superseded by @${memory.frontmatter.supersededBy}`
            : "";

        return {
          content: [{ type: "text", text: `${formatMemoryRead(memory, view)}${supersededNote}` }],
          details: { path: path.relative(memoryDir, fullPath), frontmatter: memory.frontmatter, view },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to read memory file: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_read", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderMemoryResult(result, options, theme),
  });
}

export function registerMemoryWrite(pi: ExtensionAPI, settings: MemoryMdSettings, onOwnMutation?: () => void): void {
  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Create or replace a structured project memory record. Logical state/ and events/ paths are stored under records/<stable-id>.md. " +
      "Prefer summary, concepts, claims, facts, relations, and optional notes over long prose. " +
      'To merge N records into one, write the distilled record with supersedes: ["@a", "@b", ...]; the new record is written first, then each listed record is marked superseded so it drops out of injection and listings. ' +
      "The first write in a project creates the local memory structure automatically.",
    parameters: Type.Object({
      path: Type.String({
        description: "Relative .md path under logical state/ or events/, or records/<stable-id>.md",
      }),
      content: Type.Optional(
        Type.String({ description: "Full Markdown content; optional when structured fields are provided" }),
      ),
      description: Type.String({ description: "Concise purpose shown in the recent-memory index" }),
      summary: Type.Optional(Type.String({ description: "One-sentence semantic summary for compact reads" })),
      concepts: Type.Optional(Type.Array(Type.String({ description: "Core concepts captured by this memory" }))),
      claims: Type.Optional(Type.Array(Type.String({ description: "Important conclusions or decisions" }))),
      facts: Type.Optional(
        Type.Record(Type.String(), Type.Any({ description: "Machine-readable scalar/array fact values" })),
      ),
      relations: Type.Optional(Type.Record(Type.String(), Type.String({ description: "Relation target stable @id" }))),
      notes: Type.Optional(Type.String({ description: "Optional prose/evidence rendered after structured knowledge" })),
      tags: Type.Optional(Type.Array(Type.String())),
      sensitive: Type.Optional(Type.Boolean({ description: "Mark this record as non-injectable sensitive memory" })),
      kind: Type.Optional(
        Type.Union([Type.Literal("state"), Type.Literal("event")], {
          description: "Optional lifecycle; inferred from logical path or record ID and must match it",
        }),
      ),
      forceCreate: Type.Optional(
        Type.Boolean({ description: "Bypass the dated-ID block and pre-write dedup checks and force a fresh record" }),
      ),
      supersedes: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Stable @id or path of records this write replaces; they are marked superseded. A non-empty list also skips the pre-write dedup checks.",
          }),
        ),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      onOwnMutation?.();
      const {
        path: relPath,
        content,
        description,
        summary,
        concepts,
        claims,
        facts,
        relations,
        notes,
        tags,
        sensitive,
        kind: requestedKind,
        forceCreate,
        supersedes,
      } = params as {
        path: string;
        content?: string;
        description: string;
        tags?: string[];
        sensitive?: boolean;
        kind?: "state" | "event";
        forceCreate?: boolean;
        supersedes?: string[];
      } & StructuredMemoryFields;
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      try {
        // Auto-init: the first write in a project creates records/ plus the default records.
        const initialized = ensureProjectMemoryInitialized(memoryDir);

        const hasStructuredFields = Boolean(
          summary ||
            concepts?.length ||
            claims?.length ||
            Object.keys(facts ?? {}).length ||
            Object.keys(relations ?? {}).length ||
            notes,
        );
        if (!content && !hasStructuredFields) throw new Error("Either content or structured fields must be provided");
        if (content && (Object.keys(facts ?? {}).length || Object.keys(relations ?? {}).length || notes)) {
          throw new Error("facts, relations, and notes are only generated when content is omitted");
        }
        const conceptNormalization = normalizeMemoryConcepts(memoryDir, concepts);
        const normalizedConcepts = conceptNormalization.concepts;
        const memoryContent =
          content ??
          buildStructuredMemoryContent({
            description,
            summary,
            concepts: normalizedConcepts,
            claims,
            facts,
            relations,
            notes,
          });

        const detectedSensitive = hasSensitiveMemoryInput({
          content: memoryContent,
          concepts: normalizedConcepts,
          description,
          facts,
          relations,
          summary,
          claims,
          notes,
          tags,
        });

        const contentValidation = validateMemoryContent(memoryContent);
        if (!contentValidation.valid) throw new Error(contentValidation.error);

        const legacyPath = resolveMemoryPath(memoryDir, relPath);
        const legacyExists = fs.existsSync(legacyPath);
        const legacyExisting = legacyExists ? readMemoryFile(legacyPath) : null;
        let target = resolveMemoryWriteTarget(
          memoryDir,
          relPath,
          requestedKind,
          legacyExisting?.frontmatter.id,
          legacyExisting?.frontmatter.kind,
        );
        let targetExists = fs.existsSync(target.filePath);
        let existingPath = targetExists ? target.filePath : legacyExists && legacyExisting ? legacyPath : null;

        // Pre-write lifecycle guard: dated state IDs are refused (they read as events).
        if (!forceCreate && target.kind === "state" && isDatedMemoryId(target.id)) {
          throw new Error(
            `Memory ID '@${target.id}' looks like a dated event ID. Events are append-only; write it with kind:'event', or pass forceCreate:true to use a dated state ID.`,
          );
        }

        // Pre-write dedup for state creates only (events are append-only and untouched):
        // deterministic ID-family routes to an overwrite; concept containment rejects with a hint.
        // A non-empty supersedes list is itself the dedup decision, so it skips both checks.
        let routedTo: string | null = null;
        if (!forceCreate && !supersedes?.length && !targetExists && target.kind === "state") {
          const route = findIdFamilyRoute(memoryDir, target.id);
          if (route) {
            target = { filePath: route.filePath, id: route.id, kind: "state" };
            targetExists = true;
            existingPath = target.filePath;
            routedTo = route.id;
          } else {
            const containment = findConceptContainmentDuplicate(memoryDir, target.kind, normalizedConcepts ?? []);
            if (containment) {
              throw new Error(
                `Similar state record @${containment.id} exists (concepts: ${containment.concepts.join(", ")}). Overwrite it by writing to '${containment.path}', or pass forceCreate:true to create a separate record.`,
              );
            }
          }
        }

        const beforeRaw = existingPath ? fs.readFileSync(existingPath, "utf-8") : undefined;
        const existing = targetExists ? readMemoryFile(target.filePath) : legacyExisting;

        // Validate supersede targets before any file is touched, so a bad reference never leaves
        // a half-applied write behind. Already-superseded targets are skipped later (reported,
        // not fatal). Structured fields are captured here for the merge receipt.
        const supersedeTargets: Array<{
          filePath: string;
          id: string;
          supersededBy?: string;
          claims?: string[];
          factKeys: string[];
          concepts: string[];
        }> = [];
        if (supersedes?.length) {
          for (const ref of supersedes) {
            const filePath = resolveMemoryFile(memoryDir, ref);
            const memory = readMemoryFile(filePath);
            if (!memory?.frontmatter.id) throw new Error(`Supersede target not found: ${ref}`);
            if (memory.frontmatter.id === target.id) throw new Error(`A record cannot supersede itself: ${ref}`);
            supersedeTargets.push({
              filePath,
              id: memory.frontmatter.id,
              supersededBy: memory.frontmatter.supersededBy,
              claims: memory.frontmatter.claims,
              factKeys: Object.keys(parseMemoryFacts(memory.content).facts ?? {}),
              concepts: memory.frontmatter.concepts ?? [],
            });
          }
        }

        const finalSensitive = sensitive === undefined ? detectedSensitive : sensitive;
        const today = getCurrentDate();
        const frontmatter: MemoryFrontmatter = {
          ...existing?.frontmatter,
          description,
          summary,
          concepts: normalizedConcepts,
          claims,
          created: existing?.frontmatter.created ?? today,
          updated: today,
          ...(tags && { tags }),
        };
        if (finalSensitive) frontmatter.sensitive = true;
        else delete frontmatter.sensitive;
        delete frontmatter.id;
        delete frontmatter.kind;
        // An explicit write makes the record current again, so a supersede marker on it is cleared.
        const clearedSuperseder =
          frontmatter.supersededBy && supersededByExists(memoryDir, frontmatter.supersededBy)
            ? frontmatter.supersededBy
            : undefined;
        delete frontmatter.supersededBy;
        delete frontmatter.supersededAt;

        // Write-then-mark: the new record is written FIRST, so an interrupted run leaves the new
        // record plus a few not-yet-hidden records (harmless duplication) instead of lost content.
        writeMemoryFile(target.filePath, memoryContent, frontmatter);
        const afterRaw = fs.readFileSync(target.filePath, "utf-8");
        const overwriteDiff = beforeRaw === undefined ? undefined : buildMemoryOverwriteDiff(beforeRaw, afterRaw);
        upsertMemoryCatalog(memoryDir, target.filePath);

        // Mark superseded targets after the new record exists, so supersededBy always points at a
        // live record. Targets a live record already supersedes are skipped and reported.
        const supersededIds: string[] = [];
        const skipped: Array<{ id: string; reason: string }> = [];
        try {
          for (const supersedeTarget of supersedeTargets) {
            if (supersedeTarget.supersededBy && supersededByExists(memoryDir, supersedeTarget.supersededBy)) {
              skipped.push({
                id: supersedeTarget.id,
                reason: `already superseded by @${supersedeTarget.supersededBy}`,
              });
              continue;
            }
            markRecordSuperseded(memoryDir, supersedeTarget.filePath, target.id);
            supersededIds.push(supersedeTarget.id);
          }
        } catch (error) {
          // Best-effort restore (not a guarantee): put back the target record (prior bytes when it
          // pre-existed, otherwise delete the fresh file) and clear the markers already written.
          try {
            if (targetExists && beforeRaw !== undefined) {
              fs.writeFileSync(target.filePath, beforeRaw);
            } else {
              fs.rmSync(target.filePath, { force: true });
            }
          } catch {
            // ignore: the restore write failed or the file was already gone
          }
          for (const id of supersededIds) {
            try {
              const markedPath = findMemoryFileById(memoryDir, id);
              const markedMemory = markedPath ? readMemoryFile(markedPath) : null;
              if (markedPath && markedMemory) {
                const restored = { ...markedMemory.frontmatter };
                delete restored.supersededBy;
                delete restored.supersededAt;
                writeMemoryFile(markedPath, markedMemory.content, restored);
              }
            } catch {
              // ignore per-record restore failures
            }
          }
          rebuildMemoryCatalog(memoryDir);
          throw new Error(`memory_write failed partway and was rolled back best-effort: ${(error as Error).message}`);
        }

        const relTarget = path.relative(memoryDir, target.filePath);
        const duplicateHints = formatConceptDuplicateHints(conceptNormalization.audit.possibleDuplicates);
        const writeWarnings = formatMemoryWriteWarnings(
          buildMemoryWriteWarnings({
            summary,
            claims,
            facts,
            content,
            finalSensitive,
            detectedSensitive,
            hygieneWarnings: conceptNormalization.audit.warnings,
          }),
        );
        const operation = beforeRaw === undefined ? "create" : "overwrite";

        // Merge receipt: structured fields of each marked source the distilled
        // record did NOT carry over. Claims match fuzzily (normalized equality
        // or containment in the merged content); fact keys and concepts exactly.
        // Makes the merge loss visible at merge time, before passive prune can
        // delete the source record for good.
        const normalizeClaimText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
        const mergedFactKeys = new Set(Object.keys(parseMemoryFacts(memoryContent).facts ?? {}));
        const mergedConceptSet = new Set(frontmatter.concepts ?? []);
        const mergedClaimSet = new Set((frontmatter.claims ?? []).map(normalizeClaimText));
        const mergedContentNorm = normalizeClaimText(memoryContent);
        const receipts: Array<{
          id: string;
          missingClaims: string[];
          missingFactKeys: string[];
          missingConcepts: string[];
        }> = [];
        for (const source of supersedeTargets) {
          if (!supersededIds.includes(source.id)) continue;
          const missingClaims = (source.claims ?? []).filter((claim) => {
            const norm = normalizeClaimText(claim);
            return !mergedClaimSet.has(norm) && !mergedContentNorm.includes(norm);
          });
          const missingFactKeys = source.factKeys.filter((key) => !mergedFactKeys.has(key));
          const missingConcepts = source.concepts.filter((concept) => !mergedConceptSet.has(concept));
          if (missingClaims.length || missingFactKeys.length || missingConcepts.length) {
            receipts.push({ id: source.id, missingClaims, missingFactKeys, missingConcepts });
          }
        }

        const status = routedTo
          ? `Memory file routed to overwrite: ${relTarget} (@${target.id}) (ID-family match)`
          : operation === "overwrite"
            ? `Memory file overwritten: ${relTarget} (@${target.id})`
            : `Memory file written: ${relTarget} (@${target.id})`;
        const responseParts = [status];
        if (initialized) responseParts.push(`Initialized project memory: ${memoryDir}`);
        if (supersededIds.length) responseParts.push(`Superseded: ${supersededIds.map((id) => `@${id}`).join(", ")}`);
        if (skipped.length) {
          responseParts.push(`Skipped: ${skipped.map((entry) => `@${entry.id} (${entry.reason})`).join(", ")}`);
        }
        if (clearedSuperseder) {
          responseParts.push(
            `Cleared superseded marker (was superseded by @${clearedSuperseder}); record is current again.`,
          );
        }
        if (overwriteDiff?.text) responseParts.push(overwriteDiff.text);
        if (receipts.length) {
          const receiptLines = receipts.map((r) => {
            const parts: string[] = [];
            if (r.missingClaims.length)
              parts.push(`${r.missingClaims.length} claim(s): ${r.missingClaims.map((c) => `"${c}"`).join(", ")}`);
            if (r.missingFactKeys.length)
              parts.push(`${r.missingFactKeys.length} fact key(s): ${r.missingFactKeys.join(", ")}`);
            if (r.missingConcepts.length)
              parts.push(`${r.missingConcepts.length} concept(s): ${r.missingConcepts.join(", ")}`);
            return `  @${r.id} - ${parts.join("; ")}`;
          });
          responseParts.push(
            ["Merge receipt - not carried over (fold into this record or accept the loss):", ...receiptLines].join(
              "\n",
            ),
          );
        }
        if (duplicateHints) responseParts.push(duplicateHints);
        if (writeWarnings) responseParts.push(writeWarnings);
        return {
          content: [{ type: "text", text: responseParts.join("\n\n") }],
          details: {
            path: target.filePath,
            operation,
            initialized,
            diff: overwriteDiff,
            frontmatter: { ...frontmatter, id: target.id, kind: target.kind },
            concepts: conceptNormalization.audit,
            receipt: receipts,
            superseded: supersededIds,
            skipped,
            warnings: buildMemoryWriteWarnings({
              summary,
              claims,
              facts,
              content,
              finalSensitive,
              detectedSensitive,
              hygieneWarnings: conceptNormalization.audit.warnings,
            }),
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to write memory file: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_write", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as {
        frontmatter?: { description?: string; tags?: string[] };
        concepts?: { possibleDuplicates?: ConceptDuplicateHint[] };
        diff?: MemoryOverwriteDiffSummary;
      };
      return renderMemoryResult(result, options, theme, {
        description: details?.frontmatter?.description,
        tags: details?.frontmatter?.tags,
        notice: formatConceptDuplicateHints(details?.concepts?.possibleDuplicates),
        diff: details?.diff,
      });
    },
  });
}

export function registerMemoryDelete(pi: ExtensionAPI, settings: MemoryMdSettings, onOwnMutation?: () => void): void {
  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description:
      "Delete a project memory record by stable @id or path, then update derived catalog and concept dictionary",
    parameters: Type.Object({
      path: Type.String({ description: "Stable @id or memory path to delete" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      onOwnMutation?.();
      const { path: target } = params as { path: string };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      try {
        const deleted = deleteMemoryFile(memoryDir, target);
        const responseParts = [`Memory deleted: ${deleted.path} (@${deleted.id})`];
        if (deleted.unhidden.length) {
          responseParts.push(
            `Superseded markers cleared (resurrected): ${deleted.unhidden.map((id) => `@${id}`).join(", ")}`,
          );
        }
        return {
          content: [{ type: "text", text: responseParts.join("\n\n") }],
          details: { ...deleted, conceptCount: deleted.dictionary.concepts.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to delete memory: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_delete", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderCollapsed("Memory delete", getResultText(result), options, theme),
  });
}

// Cluster warnings replace the old memory_check discovery: same-kind records sharing a canonical
// concept are reported with a ready-to-copy merge call (memory_write + supersedes).
function formatClusterWarnings(clusters: CompactClusterReport[]): string {
  if (!clusters.length) return "";
  const sections = clusters.map((cluster) => {
    const ids = cluster.ids.map((id) => `@${id}`);
    const merge = `memory_write({ path: "state/${cluster.concept}-summary.md", description: "${cluster.concept} summary", supersedes: [${cluster.ids.map((id) => `"@${id}"`).join(", ")}] })`;
    return `- ${cluster.ids.length} ${cluster.kind} records share concept "${cluster.concept}", candidates for merge: [${ids.join(", ")}]\n  Merge: ${merge}`;
  });
  return `\n\nCluster warnings (${clusters.length} cluster${clusters.length > 1 ? "s" : ""}):\n${sections.join("\n")}`;
}

// One label rule for both output modes: the supersede marker is shown only when the superseding
// record still exists, which is the same condition that hides the record from default results.
function supersededSuffix(memoryDir: string, supersededBy?: string): string {
  return supersededBy && supersededByExists(memoryDir, supersededBy) ? ` (superseded by @${supersededBy})` : "";
}

function buildMemoryListResult(memoryDir: string, kind?: "state" | "event", includeSuperseded?: boolean) {
  const catalogEntries = getMemoryCatalog(memoryDir);
  const visibleEntries = includeSuperseded ? catalogEntries : filterSupersededEntries(memoryDir, catalogEntries);
  const files = visibleEntries
    .filter((entry) => !kind || entry.kind === kind)
    .map((entry) => ({
      path: entry.path,
      id: entry.id,
      kind: entry.kind,
      description: entry.description,
      supersededBy: entry.supersededBy,
    }));
  const list = files
    .map(
      (entry) =>
        `  - ${entry.path} (@${entry.id})${supersededSuffix(memoryDir, entry.supersededBy)}\n    ${entry.kind}: ${entry.description ?? "No description"}`,
    )
    .join("\n");
  const clusters = findCompactClusters(memoryDir);
  return {
    content: [
      {
        type: "text" as const,
        text: `Memory files (${files.length}):\n\n${list}${formatClusterWarnings(clusters)}`,
      },
    ],
    details: { mode: "list", files, count: files.length, clusters },
  };
}

export function registerMemorySearch(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search memory files by content, tags, or description, or omit query to list every record with its @id." +
      " Supports regex (e.g. 'typescript|javascript', 'fail.*build')." +
      " Multi-word queries use OR logic ranked by relevance -- use keywords, not full sentences." +
      " The list mode also reports clusters of records that should be merged into one record.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance. Omit to list all records.",
        }),
      ),
      searchIn: Type.Optional(
        Type.Union(
          [
            Type.Literal("content"),
            Type.Literal("tags"),
            Type.Literal("description"),
            Type.Literal("summary"),
            Type.Literal("concepts"),
            Type.Literal("claims"),
            Type.Literal("id"),
            Type.Literal("all"),
          ],
          { description: "Where to search; defaults to all. Ignored when query is omitted." },
        ),
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal("state"), Type.Literal("event")], {
          description: "Limit results to current state or time-bound events",
        }),
      ),
      includeSuperseded: Type.Optional(
        Type.Boolean({ description: "Include records hidden because a newer record supersedes them" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        query,
        searchIn = "all",
        kind,
        includeSuperseded,
      } = params as {
        query?: string;
        searchIn?: SearchField;
        kind?: "state" | "event";
        includeSuperseded?: boolean;
      };
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      try {
        if (!query?.trim()) return buildMemoryListResult(memoryDir, kind, includeSuperseded);

        const catalogEntries = getMemoryCatalog(memoryDir);
        const visibleEntries = includeSuperseded ? catalogEntries : filterSupersededEntries(memoryDir, catalogEntries);
        const fileMap = new Map<string, import("./types.js").MemoryFile>();
        const needsContent = searchIn === "content" || searchIn === "all";
        for (const entry of visibleEntries) {
          fileMap.set(
            entry.path,
            needsContent
              ? memoryFileFromCatalogEntry(memoryDir, entry)
              : {
                  path: path.join(memoryDir, entry.path),
                  frontmatter: {
                    id: entry.id,
                    kind: entry.kind,
                    description: entry.description,
                    summary: entry.summary,
                    concepts: entry.concepts,
                    claims: entry.claims,
                    tags: entry.tags,
                    created: entry.created,
                    updated: entry.updated,
                  },
                  content: "",
                },
          );
        }

        const normalizedQuery = searchIn === "concepts" ? normalizeConceptSearchQuery(memoryDir, query) : query;
        const conceptAliasFamilies =
          searchIn === "concepts" && normalizedQuery.trim()
            ? expandConceptSearchFamilies(memoryDir, normalizedQuery.split(/\s+/))
            : undefined;
        const hits = searchMemoryFiles({
          files: fileMap,
          query: normalizedQuery,
          searchIn,
          kind,
          conceptAliasFamilies,
        });

        const catalogByPath = new Map(catalogEntries.map((entry) => [entry.path, entry]));
        const results = hits.map((h) => {
          const entry = catalogByPath.get(h.path);
          const id = entry?.id ?? h.path;
          return {
            path: h.path,
            id,
            kind: entry?.kind,
            supersededBy: entry?.supersededBy,
            match: h.snippet,
            matchCount: h.matchCount,
            matchedIn: h.matchedIn,
            next: `memory_read({ path: "@${id}", view: "knowledge" })`,
          };
        });

        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "No results found."
                  : `Found ${results.length} result(s):\n\n${results
                      .map(
                        (r) =>
                          `  ${r.path} (@${r.id})${supersededSuffix(memoryDir, r.supersededBy)}\n  ${r.match}\n  Next: ${r.next}`,
                      )
                      .join("\n\n")}`,
            },
          ],
          details: { mode: "search", results, count: results.length, query: normalizedQuery },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to search memory: ${(error as Error).message}` }],
          details: { error: true },
        };
      }
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_search", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { mode?: string };
      return renderCountResult(result, options, theme, details?.mode === "list" ? "memory files" : "result(s)");
    },
  });
}

export function registerAllMemoryTools(pi: ExtensionAPI, settings: MemoryMdSettings, onOwnMutation?: () => void): void {
  registerMemoryRead(pi, settings);
  registerMemoryWrite(pi, settings, onOwnMutation);
  registerMemorySearch(pi, settings);
  registerMemoryDelete(pi, settings, onOwnMutation);
}
