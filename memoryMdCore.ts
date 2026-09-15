import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import type {
  ConceptAliasResult,
  ConceptDictionary,
  ConceptDuplicateHint,
  ConceptNormalizationAudit,
  MemoryFactValue,
  MemoryFile,
  MemoryFrontmatter,
  MemoryKind,
  MemoryMdSettings,
  MemoryReadView,
  ParsedFrontmatter,
  StructuredMemoryFields,
} from "./types.js";

export * from "./types.js";

/**
 * Constants
 */

const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");

/**
 * Settings
 */

let localPath: string;

export function getLocalPath(): string {
  return localPath;
}

export function getCurrentDate(): string {
  return new Date().toISOString();
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function findWorkspaceRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function toProjectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function getProjectSlug(cwd: string): string {
  return toProjectSlug(path.basename(findWorkspaceRoot(cwd)));
}

export function getMemoryDir(settings: MemoryMdSettings, cwd: string): string {
  localPath = expandPath(settings.localPath || DEFAULT_LOCAL_PATH);
  return path.join(localPath, "projects", getProjectSlug(cwd));
}

export function loadSettings(): MemoryMdSettings {
  const DEFAULT_SETTINGS: MemoryMdSettings = {
    enabled: true,
    localPath: DEFAULT_LOCAL_PATH,
    injection: "message-append",
    systemPrompt: {
      maxTokens: 10000,
      includeProjects: ["current"],
    },
  };

  const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!fs.existsSync(globalSettings)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const content = fs.readFileSync(globalSettings, "utf-8");
    const parsed = JSON.parse(content);
    const stored = (parsed["pi-workspace-memory"] ?? parsed["pi-memory-md"]) as MemoryMdSettings | undefined;
    const loadedSettings = { ...DEFAULT_SETTINGS, ...stored };

    if (loadedSettings.localPath) {
      loadedSettings.localPath = expandPath(loadedSettings.localPath);
    }

    return loadedSettings;
  } catch (error) {
    console.warn("Failed to load memory settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * File operations
 */

export const MEMORY_FACTS_START = "<!-- memory:facts:v1 -->";
export const MEMORY_FACTS_END = "<!-- /memory:facts -->";

const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_.-]*$/;
const MEMORY_RECORDS_DIR = "records";
const MEMORY_CATALOG_FILE = ".catalog.json";
const MEMORY_CATALOG_VERSION = 5;
const CONCEPT_DICTIONARY_FILE = ".concepts.json";

export interface MemoryCatalogEntry {
  path: string;
  id: string;
  kind: MemoryKind;
  description: string;
  summary?: string;
  concepts: string[];
  claims: string[];
  sensitive?: boolean;
  tags: string[];
  created?: string;
  updated?: string;
  mtimeMs: number;
  size: number;
  supersededBy?: string;
}

interface MemoryCatalog {
  version: typeof MEMORY_CATALOG_VERSION;
  entries: MemoryCatalogEntry[];
}

function normalizeMemoryId(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

function inferKindFromId(id: string): MemoryKind | null {
  if (id.startsWith("state.")) return "state";
  if (id.startsWith("event.")) return "event";
  return null;
}

function recordPathForId(memoryDir: string, id: string): string {
  return path.join(memoryDir, MEMORY_RECORDS_DIR, `${normalizeMemoryId(id)}.md`);
}

function recordIdFromPath(memoryDir: string, filePath: string): string | null {
  const relative = path.relative(path.join(memoryDir, MEMORY_RECORDS_DIR), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".md")) return null;
  return relative.replace(/\.md$/i, "").split(path.sep).join(".");
}

function catalogPath(memoryDir: string): string {
  return path.join(memoryDir, MEMORY_CATALOG_FILE);
}

function conceptDictionaryPath(memoryDir: string): string {
  return path.join(memoryDir, CONCEPT_DICTIONARY_FILE);
}

function emptyConceptAudit(): ConceptNormalizationAudit {
  return { canonical: [], resolvedAliases: {}, registered: [], possibleDuplicates: [], warnings: [] };
}

export function normalizeConceptLabel(label: string): string {
  return label
    .trim()
    .normalize("NFKD")
    .replace(/[ĐÐ]/g, "D")
    .replace(/[đð]/g, "d")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sanitizeConceptDictionary(value: unknown): ConceptDictionary {
  const input = (value && typeof value === "object" ? value : {}) as Partial<ConceptDictionary>;
  const concepts = new Set<string>();
  for (const concept of Array.isArray(input.concepts) ? input.concepts : []) {
    const normalized = normalizeConceptLabel(concept);
    if (normalized) concepts.add(normalized);
  }

  const aliases: Record<string, string> = {};
  const inputAliases = input.aliases && typeof input.aliases === "object" ? input.aliases : {};
  for (const [alias, target] of Object.entries(inputAliases)) {
    const normalizedAlias = normalizeConceptLabel(alias);
    const normalizedTarget = normalizeConceptLabel(String(target));
    if (!normalizedAlias || !normalizedTarget || normalizedAlias === normalizedTarget) continue;
    concepts.add(normalizedTarget);
    aliases[normalizedAlias] = normalizedTarget;
  }

  return { version: 1, concepts: uniqueSorted(concepts), aliases: Object.fromEntries(Object.entries(aliases).sort()) };
}

function writeConceptDictionary(memoryDir: string, dictionary: ConceptDictionary): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const target = conceptDictionaryPath(memoryDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(dictionary, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

export function rebuildConceptDictionary(memoryDir: string): ConceptDictionary {
  const concepts = new Set<string>();
  for (const filePath of listMemoryFiles(memoryDir)) {
    const memory = readMemoryFile(filePath);
    if (!memory) continue;
    for (const concept of memory.frontmatter.concepts ?? []) {
      const normalized = normalizeConceptLabel(concept);
      if (normalized) concepts.add(normalized);
    }
  }

  const dictionary: ConceptDictionary = { version: 1, concepts: uniqueSorted(concepts), aliases: {} };
  writeConceptDictionary(memoryDir, dictionary);
  return dictionary;
}

export function getConceptDictionary(memoryDir: string): ConceptDictionary {
  try {
    return sanitizeConceptDictionary(JSON.parse(fs.readFileSync(conceptDictionaryPath(memoryDir), "utf-8")));
  } catch {
    return rebuildConceptDictionary(memoryDir);
  }
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let prevDiagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, prevDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      prevDiagonal = saved;
    }
  }
  return previous[b.length];
}

function conceptSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function possibleDuplicateHints(concept: string, candidates: string[]): ConceptDuplicateHint[] {
  return candidates
    .map((candidate) => ({ concept, candidate, score: Number(conceptSimilarity(concept, candidate).toFixed(2)) }))
    .filter((hint) => hint.score >= 0.82 && hint.score < 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function resolveConcept(dictionary: ConceptDictionary, concept: string): { canonical: string; alias?: string } | null {
  const normalized = normalizeConceptLabel(concept);
  if (!normalized) return null;
  if (dictionary.aliases[normalized]) return { canonical: dictionary.aliases[normalized], alias: normalized };
  if (normalized.endsWith("s")) {
    const singular = normalized.slice(0, -1);
    if (dictionary.aliases[singular]) return { canonical: dictionary.aliases[singular], alias: normalized };
    if (dictionary.concepts.includes(singular)) return { canonical: singular, alias: normalized };
  }
  if (dictionary.concepts.includes(normalized)) return { canonical: normalized };
  return { canonical: normalized };
}

function resolveKnownConcept(dictionary: ConceptDictionary, concept: string): string | null {
  const normalized = normalizeConceptLabel(concept);
  if (!normalized) return null;
  if (dictionary.aliases[normalized]) return dictionary.aliases[normalized];
  if (normalized.endsWith("s")) {
    const singular = normalized.slice(0, -1);
    const resolved = dictionary.aliases[singular] ?? (dictionary.concepts.includes(singular) ? singular : null);
    if (resolved) return resolved;
  }
  return dictionary.concepts.includes(normalized) ? normalized : null;
}

function tokenizeConceptQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeKnownConceptSequence(dictionary: ConceptDictionary, query: string): string[] | null {
  const tokens = tokenizeConceptQuery(query);
  if (tokens.length === 0) return null;
  const concepts: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    let matched: { concept: string; length: number } | null = null;
    for (let length = Math.min(6, tokens.length - index); length > 0; length--) {
      const candidate = tokens.slice(index, index + length).join(" ");
      const concept = resolveKnownConcept(dictionary, candidate);
      if (concept) {
        matched = { concept, length };
        break;
      }
    }
    if (!matched) return null;
    concepts.push(matched.concept);
    index += matched.length;
  }
  return concepts;
}

function conceptHygieneBlockWarning(concept: string, normalized: string): string | null {
  if (/^(?=.*[a-f])[0-9a-f]{7,40}$/.test(normalized)) {
    return `Concept "${concept}" looks like a hash; move it into facts instead of concepts.`;
  }
  if (/\d{4}-\d{2}-\d{2}/.test(normalized) || /(?:^|\D)\d{8}(?:\D|$)/.test(normalized)) {
    return `Concept "${concept}" looks like a date; move it into facts or tags instead of concepts.`;
  }
  if (/^[0-9][0-9.-]*$/.test(normalized)) {
    return `Concept "${concept}" looks like a number; move it into facts or tags instead of concepts.`;
  }
  return null;
}

export function normalizeMemoryConcepts(
  memoryDir: string,
  concepts?: string[],
): { concepts?: string[]; audit: ConceptNormalizationAudit } {
  const audit = emptyConceptAudit();
  if (!concepts?.length) return { audit };

  const dictionary = getConceptDictionary(memoryDir);
  const knownBefore = new Set(dictionary.concepts);
  const canonical = new Set<string>();

  for (const concept of concepts) {
    const normalized = normalizeConceptLabel(concept);
    if (!normalized) continue;
    const blockedWarning = conceptHygieneBlockWarning(concept, normalized);
    if (blockedWarning) {
      audit.warnings.push(blockedWarning);
      continue;
    }
    if (normalized.split("-").length >= 6) {
      audit.warnings.push(`Concept "${concept}" looks like a sentence; prefer capturing it as a claim.`);
    }
    const resolved = resolveConcept(dictionary, concept);
    if (!resolved) continue;
    canonical.add(resolved.canonical);
    if (resolved.alias) audit.resolvedAliases[normalized] = resolved.canonical;
    if (!knownBefore.has(resolved.canonical)) {
      audit.registered.push(resolved.canonical);
      audit.possibleDuplicates.push(...possibleDuplicateHints(resolved.canonical, dictionary.concepts));
      dictionary.concepts.push(resolved.canonical);
      knownBefore.add(resolved.canonical);
    }
  }

  dictionary.concepts = uniqueSorted(dictionary.concepts);
  if (audit.registered.length > 0 || Object.keys(audit.resolvedAliases).length > 0)
    writeConceptDictionary(memoryDir, dictionary);
  audit.canonical = uniqueSorted(canonical);
  audit.registered = uniqueSorted(audit.registered);
  return { concepts: audit.canonical, audit };
}

export function normalizeConceptSearchQuery(memoryDir: string, query: string): string {
  const dictionary = getConceptDictionary(memoryDir);
  if (query.includes(",")) {
    const parts = query.split(",").map((part) => part.trim());
    const normalized = parts
      .map((part) => resolveKnownConcept(dictionary, part) ?? normalizeConceptLabel(part))
      .filter(Boolean);
    return uniqueSorted(normalized).join(" ");
  }

  const whole = resolveKnownConcept(dictionary, query);
  if (whole) return whole;
  const sequence = normalizeKnownConceptSequence(dictionary, query);
  return sequence ? uniqueSorted(sequence).join(" ") : normalizeConceptLabel(query);
}

export function addConceptAlias(memoryDir: string, alias: string, canonical: string): ConceptAliasResult {
  const normalizedAlias = normalizeConceptLabel(alias);
  const normalizedCanonical = normalizeConceptLabel(canonical);
  if (!normalizedAlias || !normalizedCanonical) {
    return { ok: false, error: "alias and canonical must be non-empty concept labels" };
  }
  if (normalizedAlias === normalizedCanonical) {
    return { ok: false, error: "alias must differ from the canonical concept" };
  }

  const dictionary = getConceptDictionary(memoryDir);
  const resolvedCanonical = dictionary.aliases[normalizedCanonical] ?? normalizedCanonical;
  if (!dictionary.concepts.includes(resolvedCanonical)) {
    return { ok: false, error: `canonical concept not found in dictionary: ${normalizedCanonical}` };
  }
  if (Object.values(dictionary.aliases).includes(normalizedAlias)) {
    return { ok: false, error: `alias is the canonical of another alias in use: ${normalizedAlias}` };
  }
  if (dictionary.aliases[normalizedAlias] === resolvedCanonical) {
    return { ok: true, alias: normalizedAlias, canonical: resolvedCanonical };
  }
  if (dictionary.aliases[normalizedAlias]) {
    return { ok: false, error: `alias already maps to ${dictionary.aliases[normalizedAlias]}` };
  }

  const converted = dictionary.concepts.includes(normalizedAlias);
  if (converted) dictionary.concepts = dictionary.concepts.filter((concept) => concept !== normalizedAlias);
  dictionary.aliases[normalizedAlias] = resolvedCanonical;
  writeConceptDictionary(memoryDir, dictionary);
  return { ok: true, alias: normalizedAlias, canonical: resolvedCanonical, converted };
}

export function expandConceptSearchFamilies(memoryDir: string, canonicalTerms: string[]): string[][] {
  const dictionary = getConceptDictionary(memoryDir);
  return canonicalTerms.map((term) => {
    const family = new Set<string>([term]);
    for (const [alias, target] of Object.entries(dictionary.aliases)) {
      if (target === term) family.add(alias);
    }
    return [...family];
  });
}
function isMemoryFactValue(value: unknown): value is MemoryFactValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  return (
    Array.isArray(value) &&
    value.every((entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry))
  );
}

export function parseMemoryFacts(content: string): {
  facts: Record<string, MemoryFactValue>;
  relations: Record<string, string>;
} {
  const startCount = content.split(MEMORY_FACTS_START).length - 1;
  const endCount = content.split(MEMORY_FACTS_END).length - 1;

  if (startCount === 0 && endCount === 0) return { facts: {}, relations: {} };
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("Memory content must contain exactly one complete facts block");
  }

  const start = content.indexOf(MEMORY_FACTS_START) + MEMORY_FACTS_START.length;
  const end = content.indexOf(MEMORY_FACTS_END);
  if (end < start) throw new Error("Memory facts end marker must follow the start marker");

  const facts: Record<string, MemoryFactValue> = {};
  const relations: Record<string, string> = {};
  const keys = new Set<string>();

  for (const rawLine of content.slice(start, end).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const relation = line.match(/^([a-z][a-z0-9_.-]*)\s*->\s*@([a-z][a-z0-9_.-]*)$/);
    if (relation) {
      if (keys.has(relation[1])) throw new Error(`Duplicate memory fact key: ${relation[1]}`);
      keys.add(relation[1]);
      relations[relation[1]] = `@${relation[2]}`;
      continue;
    }

    const assignment = line.match(/^([a-z][a-z0-9_.-]*)\s*=\s*(.+)$/);
    if (!assignment || !MEMORY_KEY_PATTERN.test(assignment[1])) {
      throw new Error(`Invalid memory fact line: ${line}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(assignment[2]);
    } catch {
      throw new Error(`Memory fact value must be valid JSON: ${assignment[1]}`);
    }
    if (!isMemoryFactValue(value)) throw new Error(`Memory fact values cannot be objects: ${assignment[1]}`);
    if (keys.has(assignment[1])) throw new Error(`Duplicate memory fact key: ${assignment[1]}`);
    keys.add(assignment[1]);
    facts[assignment[1]] = value;
  }

  return { facts, relations };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeMemoryFactKey(key: string): string {
  return key
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .toLowerCase();
}

function assertUniqueMemoryFactKey(seen: Map<string, string>, key: string, source: string): void {
  const existing = seen.get(key);
  if (existing) throw new Error(`Duplicate memory fact key after normalization: ${source} conflicts with ${existing}`);
  seen.set(key, source);
}

function normalizeStructuredFacts(facts: Record<string, unknown> = {}): Record<string, MemoryFactValue> {
  const normalized: Record<string, MemoryFactValue> = {};
  const seen = new Map<string, string>();

  function visit(value: unknown, sourceKey: string, normalizedKey: string): void {
    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        const childNormalizedKey = normalizeMemoryFactKey(childKey);
        visit(
          childValue,
          `${sourceKey}.${childKey}`,
          normalizedKey ? `${normalizedKey}.${childNormalizedKey}` : childNormalizedKey,
        );
      }
      return;
    }

    if (!MEMORY_KEY_PATTERN.test(normalizedKey)) {
      throw new Error(`Invalid memory fact key after normalization: ${sourceKey} -> ${normalizedKey}`);
    }
    if (!isMemoryFactValue(value)) throw new Error(`Memory fact values cannot be objects: ${normalizedKey}`);
    assertUniqueMemoryFactKey(seen, normalizedKey, sourceKey);
    normalized[normalizedKey] = value;
  }

  for (const [key, value] of Object.entries(facts)) {
    visit(value, key, normalizeMemoryFactKey(key));
  }

  return normalized;
}

function normalizeRelationKey(key: string): string {
  const normalized = normalizeMemoryFactKey(key);
  return normalized.startsWith("relation.") ? normalized : `relation.${normalized}`;
}

function normalizeStructuredRelations(relations: Record<string, string> = {}): Record<string, string> {
  const normalized: Record<string, string> = {};
  const seen = new Map<string, string>();

  for (const [key, target] of Object.entries(relations)) {
    const normalizedKey = normalizeRelationKey(key);
    if (!MEMORY_KEY_PATTERN.test(normalizedKey)) {
      throw new Error(`Invalid memory relation key after normalization: ${key} -> ${normalizedKey}`);
    }
    assertUniqueMemoryFactKey(seen, normalizedKey, key);
    const normalizedTarget = target.trim();
    normalized[normalizedKey] = normalizedTarget.startsWith("@") ? normalizedTarget : `@${normalizedTarget}`;
  }

  return normalized;
}

export function buildStructuredMemoryContent(fields: StructuredMemoryFields & { description: string }): string {
  const lines: string[] = [`# ${fields.summary ?? fields.description}`];
  const normalizedFacts = normalizeStructuredFacts(fields.facts);
  const normalizedRelations = normalizeStructuredRelations(fields.relations);

  const factLines = [
    ...Object.entries(normalizedFacts).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ...Object.entries(normalizedRelations).map(([key, target]) => `${key} -> ${target}`),
  ];
  if (factLines.length) lines.push("", MEMORY_FACTS_START, ...factLines, MEMORY_FACTS_END);
  if (fields.notes) lines.push("", "## Notes", fields.notes);

  return `${lines.join("\n")}\n`;
}

function pushListSection(lines: string[], title: string, values?: string[]): void {
  if (!values?.length) return;
  lines.push("", `## ${title}`, ...values.map((value) => `- ${value}`));
}

function pushMapSection(lines: string[], title: string, values: Record<string, unknown>, separator: string): void {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  lines.push(
    "",
    `## ${title}`,
    ...entries.map(
      ([key, value]) => `- ${key} ${separator} ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
  );
}

export function formatMemoryRead(memory: MemoryFile, view: MemoryReadView = "full"): string {
  const {
    id,
    kind,
    description = "No description",
    tags = [],
    summary,
    concepts = [],
    claims = [],
  } = memory.frontmatter;
  const semantic = parseMemoryFacts(memory.content);
  const lines = [
    `# ${description}`,
    "",
    `ID: ${id ? `@${id}` : "none"}`,
    `Kind: ${kind ?? "legacy"}`,
    `Tags: ${tags.join(", ") || "none"}`,
  ];
  if (view === "full") return [...lines, "", memory.content].join("\n");

  if (summary) lines.push("", "## Summary", summary);
  pushListSection(lines, "Concepts", concepts);

  if (view === "summary") return `${lines.join("\n")}\n`;

  pushListSection(lines, "Claims", claims);
  pushMapSection(lines, "Facts", semantic.facts, "=");
  pushMapSection(lines, "Relations", semantic.relations, "->");
  return `${lines.join("\n")}\n`;
}
function recordInfoFromFilePath(filePath: string): { id: string; kind: MemoryKind } | null {
  const parts = path.normalize(filePath).split(path.sep);
  const recordIndex = parts.lastIndexOf(MEMORY_RECORDS_DIR);
  if (recordIndex < 0) return null;
  const relativeParts = parts.slice(recordIndex + 1);
  if (relativeParts.length === 0) return null;
  const filename = relativeParts.at(-1);
  if (!filename?.endsWith(".md")) return null;
  relativeParts[relativeParts.length - 1] = filename.replace(/\.md$/i, "");
  const id = relativeParts.join(".");
  const kind = inferKindFromId(id);
  return kind ? { id, kind } : null;
}

export function validateMemoryContent(content: string): { valid: boolean; error?: string } {
  try {
    parseMemoryFacts(content);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}

function validateFrontmatter(data: ParsedFrontmatter): { valid: boolean; error?: string } {
  if (!data) {
    return { valid: false, error: "No frontmatter found (requires --- delimiters)" };
  }

  const frontmatter = data as unknown as MemoryFrontmatter;

  if (
    frontmatter.id !== undefined &&
    (typeof frontmatter.id !== "string" || !MEMORY_KEY_PATTERN.test(frontmatter.id))
  ) {
    return { valid: false, error: "'id' must be a dotted lowercase logical ID" };
  }

  if (frontmatter.kind !== undefined && frontmatter.kind !== "state" && frontmatter.kind !== "event") {
    return { valid: false, error: "'kind' must be 'state' or 'event'" };
  }

  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    return { valid: false, error: "'description' must be a string if provided" };
  }

  if (frontmatter.summary !== undefined && typeof frontmatter.summary !== "string") {
    return { valid: false, error: "'summary' must be a string if provided" };
  }

  if (frontmatter.sensitive !== undefined && typeof frontmatter.sensitive !== "boolean") {
    return { valid: false, error: "'sensitive' must be a boolean if provided" };
  }

  if (frontmatter.limit !== undefined && (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)) {
    return { valid: false, error: "'limit' must be a positive number" };
  }

  for (const field of ["tags", "concepts", "claims"] as const) {
    const value = frontmatter[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
      return { valid: false, error: `'${field}' must be an array of strings` };
    }
  }

  return { valid: true };
}

export function readMemoryFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    const recordInfo = recordInfoFromFilePath(filePath);

    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return {
        path: filePath,
        frontmatter: {
          id: recordInfo?.id,
          kind: recordInfo?.kind,
          description: "No description",
        },
        content: content,
      };
    }

    const validation = validateFrontmatter(parsed.data);

    if (!validation.valid) {
      return {
        path: filePath,
        frontmatter: {
          id: recordInfo?.id,
          kind: recordInfo?.kind,
          description: "No description",
        },
        content: content,
      };
    }

    const frontmatter = parsed.data as unknown as MemoryFrontmatter;
    return {
      path: filePath,
      frontmatter: {
        ...frontmatter,
        id: frontmatter.id ?? recordInfo?.id,
        kind: frontmatter.kind ?? recordInfo?.kind,
      },
      content: parsed.content,
    };
  } catch (error) {
    console.error(`Failed to read memory file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(memoryDir);
  return files;
}

export function resolveMemoryPath(memoryDir: string, relPath: string): string {
  const root = path.resolve(memoryDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Memory path must stay inside the current project");
  }
  return resolved;
}

export function inferMemoryKind(memoryDir: string, filePath: string): MemoryKind | null {
  const [namespace] = path.relative(memoryDir, filePath).split(path.sep);
  if (namespace === "state") return "state";
  if (namespace === "events") return "event";
  if (namespace === MEMORY_RECORDS_DIR) {
    const id = recordIdFromPath(memoryDir, filePath);
    return id ? inferKindFromId(id) : null;
  }
  return null;
}

function idSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createMemoryId(memoryDir: string, filePath: string, kind: MemoryKind): string {
  const relative = path.relative(path.join(memoryDir, kind === "state" ? "state" : "events"), filePath);
  const segments = relative.split(path.sep).map(idSegment).filter(Boolean);
  return [kind, ...segments].join(".");
}

function memoryIdFromRelativePath(memoryDir: string, relPath: string, kind: MemoryKind): string {
  return createMemoryId(memoryDir, resolveMemoryPath(memoryDir, relPath), kind);
}

export function resolveMemoryWriteTarget(
  memoryDir: string,
  relPath: string,
  requestedKind?: MemoryKind,
  existingId?: string,
  existingKind?: MemoryKind,
  requireExistingId = false,
  allowLegacyPath = false,
): { filePath: string; id: string; kind: MemoryKind } {
  if (!relPath.endsWith(".md")) throw new Error("Memory path must end with .md");
  const resolvedPath = resolveMemoryPath(memoryDir, relPath);
  const normalizedRel = path.relative(memoryDir, resolvedPath);
  const [namespace] = normalizedRel.split(path.sep);

  if (namespace === MEMORY_RECORDS_DIR) {
    const id = recordIdFromPath(memoryDir, resolvedPath);
    if (!id || !MEMORY_KEY_PATTERN.test(id)) throw new Error("Record path must be records/<stable-id>.md");
    const kind = inferKindFromId(id);
    if (!kind) throw new Error("Record ID must start with state. or event.");
    if (requestedKind && requestedKind !== kind) {
      throw new Error(`kind '${requestedKind}' does not match record lifecycle '${kind}'`);
    }
    return { filePath: resolvedPath, id, kind };
  }

  if (namespace !== "state" && namespace !== "events") {
    throw new Error("Memory path must be under state/, events/, or records/");
  }

  const inferredKind = namespace === "state" ? "state" : "event";
  if (requestedKind && requestedKind !== inferredKind) {
    throw new Error(`kind '${requestedKind}' does not match path lifecycle '${inferredKind}'`);
  }

  const id = existingId ?? memoryIdFromRelativePath(memoryDir, normalizedRel, inferredKind);
  if (requireExistingId && !existingId) throw new Error("Existing legacy file has no stable ID");
  const kind = existingKind ?? inferredKind;
  if (kind !== inferredKind) throw new Error(`Existing kind '${kind}' does not match path lifecycle '${inferredKind}'`);
  return { filePath: allowLegacyPath ? resolvedPath : recordPathForId(memoryDir, id), id, kind };
}

export function findMemoryFileById(memoryDir: string, id: string): string | null {
  const normalized = normalizeMemoryId(id);
  const recordPath = recordPathForId(memoryDir, normalized);
  if (fs.existsSync(recordPath)) return recordPath;

  for (const entry of getMemoryCatalog(memoryDir)) {
    if (entry.id === normalized) return path.join(memoryDir, entry.path);
  }

  for (const filePath of listMemoryFiles(memoryDir)) {
    const memory = readMemoryFile(filePath);
    if (memory?.frontmatter.id === normalized) return filePath;
  }
  return null;
}

export function resolveMemoryFile(memoryDir: string, pathOrId: string): string {
  if (pathOrId.startsWith("@")) {
    const filePath = findMemoryFileById(memoryDir, pathOrId);
    if (!filePath) throw new Error(`Memory ID not found: ${pathOrId}`);
    return filePath;
  }

  const filePath = resolveMemoryPath(memoryDir, pathOrId);
  if (fs.existsSync(filePath)) return filePath;

  const kind = inferMemoryKind(memoryDir, filePath);
  if (kind) {
    const id = createMemoryId(memoryDir, filePath, kind);
    const recordPath = recordPathForId(memoryDir, id);
    if (fs.existsSync(recordPath)) return recordPath;
  }

  return filePath;
}

export function writeMemoryFile(filePath: string, content: string, frontmatter: MemoryFrontmatter): void {
  const fileDir = path.dirname(filePath);
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(filePath, stringifyFrontmatter(content, frontmatter));
}

function catalogEntryFromMemory(memoryDir: string, filePath: string): MemoryCatalogEntry | null {
  const memory = readMemoryFile(filePath);
  if (!memory?.frontmatter.id || !memory.frontmatter.kind) return null;
  const stats = fs.statSync(filePath);
  return {
    path: path.relative(memoryDir, filePath),
    id: memory.frontmatter.id,
    kind: memory.frontmatter.kind,
    description: memory.frontmatter.description ?? "No description",
    summary: memory.frontmatter.summary,
    concepts: memory.frontmatter.concepts ?? [],
    claims: memory.frontmatter.claims ?? [],
    sensitive: memory.frontmatter.sensitive || undefined,
    tags: memory.frontmatter.tags ?? [],
    created: memory.frontmatter.created,
    updated: memory.frontmatter.updated,
    supersededBy: memory.frontmatter.supersededBy,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

/**
 * Lifecycle: supersedes tombstone + derived hiding
 *
 * A record is hidden when its frontmatter carries supersededBy pointing at a record
 * that still exists. Hidden-ness is DERIVED at read time; nothing is persisted beyond
 * the marker on the old record. Chains resolve naturally: C -> B -> A means both B and
 * C are hidden while A exists, and deleting A un-hides B (its superseder is gone) while
 * C stays hidden (its superseder B still exists).
 */

export function supersededByExists(memoryDir: string, id: string): boolean {
  const normalized = normalizeMemoryId(id);
  if (fs.existsSync(recordPathForId(memoryDir, normalized))) return true;
  return getMemoryCatalog(memoryDir).some((entry) => entry.id === normalized);
}

export function filterSupersededEntries(memoryDir: string, entries: MemoryCatalogEntry[]): MemoryCatalogEntry[] {
  return entries.filter((entry) => !entry.supersededBy || !supersededByExists(memoryDir, entry.supersededBy));
}

/**
 * Mark a record as superseded by writing supersededBy into its frontmatter, preserving
 * the body and every other frontmatter field. Updates the catalog entry in place.
 */
export function markRecordSuperseded(memoryDir: string, pathOrId: string, byId: string): { id: string; path: string } {
  const normalizedBy = normalizeMemoryId(byId);
  const filePath = resolveMemoryFile(memoryDir, pathOrId);
  const memory = readMemoryFile(filePath);
  if (!memory?.frontmatter.id) throw new Error(`Memory record not found: ${pathOrId}`);
  if (memory.frontmatter.id === normalizedBy) throw new Error(`A record cannot supersede itself: ${pathOrId}`);
  writeMemoryFile(filePath, memory.content, {
    ...memory.frontmatter,
    supersededBy: normalizedBy,
    supersededAt: getCurrentDate(),
  });
  upsertMemoryCatalog(memoryDir, filePath);
  return { id: memory.frontmatter.id, path: path.relative(memoryDir, filePath) };
}

/**
 * Remove supersededBy markers pointing at a deleted id so the former superseders are
 * resurrected (natural undo). Returns the ids whose markers were cleared.
 */
export function clearSupersededMarkers(memoryDir: string, byId: string): string[] {
  const normalized = normalizeMemoryId(byId);
  const cleared: string[] = [];
  for (const filePath of listMemoryFiles(memoryDir)) {
    const memory = readMemoryFile(filePath);
    if (!memory?.frontmatter.supersededBy || memory.frontmatter.supersededBy !== normalized) continue;
    const frontmatter = { ...memory.frontmatter };
    delete frontmatter.supersededBy;
    delete frontmatter.supersededAt;
    writeMemoryFile(filePath, memory.content, frontmatter);
    upsertMemoryCatalog(memoryDir, filePath);
    if (memory.frontmatter.id) cleared.push(memory.frontmatter.id);
  }
  return cleared;
}

/**
 * Lifecycle: passive prune (lazy GC) for superseded tombstones.
 *
 * A tombstone whose supersede marker is still valid and older than `pruneAfterDays`
 * is deleted outright — the merge has been time-proven and the source record is
 * redundant. This is deliberately NOT `deleteMemoryFile`: the manual-delete path
 * resurrects records pointing at the deleted id, which is exactly wrong for GC.
 * Instead, dangling markers are re-pointed up the chain so hidden records stay
 * hidden (no zombie resurrection). Every prune is appended to `.pruned.log`.
 */
export interface PrunedRecordInfo {
  id: string;
  path: string;
  supersededBy: string;
  supersededAt: string;
}

const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const sweepLastRunByDir = new Map<string, number>();

/** Append one line per pruned record so disappearances stay explainable. */
function appendPrunedLog(memoryDir: string, pruned: PrunedRecordInfo[]): void {
  try {
    const lines = pruned.map(
      (p) =>
        `${new Date().toISOString()}\t${p.id}\t${p.path}\tsupersededBy=${p.supersededBy}\tsupersededAt=${p.supersededAt}`,
    );
    fs.appendFileSync(path.join(memoryDir, ".pruned.log"), `${lines.join("\n")}\n`, "utf-8");
  } catch {
    // Best-effort trace only.
  }
}

/**
 * Delete superseded tombstones older than `pruneAfterDays` (marker age, not record age).
 * Legacy markers without `supersededAt` are kept — their clock starts on the next re-mark.
 * Returns the pruned records for logging by the caller.
 */
export function sweepPrunableMemory(memoryDir: string, pruneAfterDays: number): PrunedRecordInfo[] {
  if (!pruneAfterDays || pruneAfterDays <= 0 || !fs.existsSync(memoryDir)) return [];
  const cutoff = Date.now() - pruneAfterDays * 24 * 60 * 60 * 1000;

  const prunable = new Map<
    string,
    { id: string; filePath: string; path: string; supersededBy: string; supersededAt: string }
  >();
  for (const entry of getMemoryCatalog(memoryDir)) {
    if (!entry.supersededBy || !supersededByExists(memoryDir, entry.supersededBy)) continue;
    const memory = readMemoryFile(path.join(memoryDir, entry.path));
    const supersededAt = memory?.frontmatter.supersededAt;
    if (!supersededAt) continue;
    const ts = Date.parse(supersededAt);
    if (!Number.isFinite(ts) || ts >= cutoff) continue;
    prunable.set(entry.id, {
      id: entry.id,
      filePath: path.join(memoryDir, entry.path),
      path: entry.path,
      supersededBy: entry.supersededBy,
      supersededAt,
    });
  }
  if (prunable.size === 0) return [];

  // Re-point targets: when B (superseded by A) is pruned, every C -> B marker moves
  // up to B's own live superseder. The walk terminates because the top of a
  // supersedes chain is live by construction; cycle guards cover corrupted data.
  const resolveLiveTarget = (prunedId: string): string | undefined => {
    let current = prunable.get(prunedId)?.supersededBy;
    const seen = new Set<string>([prunedId]);
    while (current && prunable.has(current) && !seen.has(current)) {
      seen.add(current);
      current = prunable.get(current)?.supersededBy;
    }
    return current && !prunable.has(current) ? current : undefined;
  };

  const pruned: PrunedRecordInfo[] = [];
  for (const info of prunable.values()) {
    try {
      fs.rmSync(info.filePath, { force: true });
      pruned.push({ id: info.id, path: info.path, supersededBy: info.supersededBy, supersededAt: info.supersededAt });
    } catch {
      // Best-effort GC: a failed unlink must not abort the sweep.
    }
  }
  if (pruned.length === 0) return [];

  for (const filePath of listMemoryFiles(memoryDir)) {
    const memory = readMemoryFile(filePath);
    const marker = memory?.frontmatter.supersededBy;
    if (!marker || !prunable.has(marker)) continue;
    const frontmatter = { ...memory.frontmatter };
    const liveTarget = resolveLiveTarget(marker);
    if (liveTarget && liveTarget !== memory.frontmatter.id) {
      frontmatter.supersededBy = liveTarget;
      // Keep the original supersededAt: C is at least as old as B it pointed at.
    } else {
      delete frontmatter.supersededBy;
      delete frontmatter.supersededAt;
    }
    writeMemoryFile(filePath, memory.content, frontmatter);
  }

  rebuildMemoryCatalog(memoryDir);
  appendPrunedLog(memoryDir, pruned);
  return pruned;
}

/**
 * Throttled sweep hook for injection-time calls: at most once per hour per project
 * directory, so `buildMemoryContext` can ride along without touching the hot path.
 */
export function maybeSweepPrunableMemory(memoryDir: string, settings: MemoryMdSettings): PrunedRecordInfo[] {
  const days = settings.pruneAfterDays ?? 14;
  if (!days) return [];
  const now = Date.now();
  const last = sweepLastRunByDir.get(memoryDir) ?? 0;
  if (now - last < SWEEP_MIN_INTERVAL_MS) return [];
  sweepLastRunByDir.set(memoryDir, now);
  try {
    return sweepPrunableMemory(memoryDir, days);
  } catch {
    // GC is never allowed to break injection.
    return [];
  }
}

/**
 * Pre-commit lifecycle guards (checked before any file write).
 */

/** Matches dated IDs like 20260725, 2026-07-25, or the -20260725 / -2026-07-25 suffix forms. */
export function isDatedMemoryId(id: string): boolean {
  return /(?:^|[.-])(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?=$|[.-])/.test(
    normalizeMemoryId(id),
  );
}

/** Version-ish iteration suffixes: -v2, -v3, -final, -new, -latest, -done, or a date suffix. */
function isIdFamilySuffix(suffix: string): boolean {
  return (
    /^-(?:v\d+|final|new|latest|done)(?:$|[-.])/.test(suffix) ||
    /^-\d{4}-?(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:$|[-.])/.test(suffix)
  );
}

/**
 * Deterministic ID-family auto-route: newId = oldId + version-ish suffix, same kind, and the
 * old record is not superseded. The longest matching prefix wins so the most specific family
 * member is overwritten. Returns the record to route to, or null.
 */
export function findIdFamilyRoute(memoryDir: string, newId: string): { id: string; filePath: string } | null {
  const entries = filterSupersededEntries(memoryDir, getMemoryCatalog(memoryDir));
  let best: MemoryCatalogEntry | null = null;
  for (const entry of entries) {
    if (entry.kind !== "state") continue;
    if (!newId.startsWith(`${entry.id}-`)) continue;
    if (!isIdFamilySuffix(newId.slice(entry.id.length))) continue;
    if (!best || entry.id.length > best.id.length) best = entry;
  }
  if (!best) return null;
  return { id: best.id, filePath: path.join(memoryDir, best.path) };
}

/**
 * Concept-containment duplicate: same kind, both concept sets non-empty, and one set is a
 * subset of the other. Returns the single best candidate (largest shared overlap, then newest)
 * or null. Used to REJECT the write with a hint, never to auto-route.
 */
export function findConceptContainmentDuplicate(
  memoryDir: string,
  kind: MemoryKind,
  newConcepts: string[],
): { id: string; path: string; concepts: string[] } | null {
  const normalized = uniqueSorted(newConcepts.map((concept) => normalizeConceptLabel(concept)).filter(Boolean));
  if (normalized.length === 0) return null;
  const entries = filterSupersededEntries(memoryDir, getMemoryCatalog(memoryDir));
  let best: { entry: MemoryCatalogEntry; overlap: number } | null = null;
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    const old = uniqueSorted(entry.concepts.map((concept) => normalizeConceptLabel(concept)).filter(Boolean));
    if (old.length === 0) continue;
    const isSubset = normalized.every((concept) => old.includes(concept));
    const isSuperset = old.every((concept) => normalized.includes(concept));
    if (!isSubset && !isSuperset) continue;
    const overlap = normalized.filter((concept) => old.includes(concept)).length;
    if (!best || overlap > best.overlap || (overlap === best.overlap && entry.mtimeMs > best.entry.mtimeMs)) {
      best = { entry, overlap };
    }
  }
  if (!best) return null;
  return { id: best.entry.id, path: best.entry.path, concepts: best.entry.concepts };
}

/**
 * Cluster discovery: group records by (kind, canonical concept) and report clusters of at
 * least minSize records as merge candidates for memory_write + supersedes. Read-only;
 * superseded records are already being phased out so they are excluded.
 */
export interface CompactClusterReport {
  kind: MemoryKind;
  concept: string;
  ids: string[];
}

export function findCompactClusters(memoryDir: string, minSize = 4): CompactClusterReport[] {
  const entries = filterSupersededEntries(memoryDir, getMemoryCatalog(memoryDir));
  const byConcept = new Map<string, Map<MemoryKind, string[]>>();
  for (const entry of entries) {
    for (const concept of entry.concepts) {
      const normalized = normalizeConceptLabel(concept);
      if (!normalized) continue;
      let kinds = byConcept.get(normalized);
      if (!kinds) {
        kinds = new Map();
        byConcept.set(normalized, kinds);
      }
      const ids = kinds.get(entry.kind) ?? [];
      ids.push(entry.id);
      kinds.set(entry.kind, ids);
    }
  }
  const clusters: CompactClusterReport[] = [];
  for (const [concept, kinds] of byConcept) {
    for (const [kind, ids] of kinds) {
      if (ids.length < minSize) continue;
      clusters.push({ kind, concept, ids: uniqueSorted(ids) });
    }
  }
  return clusters.sort(
    (a, b) => b.ids.length - a.ids.length || a.concept.localeCompare(b.concept) || a.kind.localeCompare(b.kind),
  );
}

function memoryFromCatalogEntry(memoryDir: string, entry: MemoryCatalogEntry) {
  const filePath = path.join(memoryDir, entry.path);
  const memory = readMemoryFile(filePath);
  if (!memory) throw new Error(`Memory catalog entry points to an unreadable file: ${entry.path}`);
  return memory;
}

function readMemoryCatalog(memoryDir: string): MemoryCatalog | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath(memoryDir), "utf-8")) as MemoryCatalog;
    if (parsed.version !== MEMORY_CATALOG_VERSION || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeMemoryCatalog(memoryDir: string, entries: MemoryCatalogEntry[]): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    catalogPath(memoryDir),
    `${JSON.stringify({ version: MEMORY_CATALOG_VERSION, entries }, null, 2)}\n`,
  );
}

function catalogIsFresh(memoryDir: string, entries: MemoryCatalogEntry[]): boolean {
  const files = listMemoryFiles(memoryDir);
  if (files.length !== entries.length) return false;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const filePath of files) {
    const relPath = path.relative(memoryDir, filePath);
    const entry = byPath.get(relPath);
    if (!entry) return false;
    const stats = fs.statSync(filePath);
    if (entry.size !== stats.size || entry.mtimeMs !== stats.mtimeMs) return false;
  }
  return true;
}

export function rebuildMemoryCatalog(memoryDir: string): MemoryCatalogEntry[] {
  const entries = listMemoryFiles(memoryDir)
    .map((filePath) => catalogEntryFromMemory(memoryDir, filePath))
    .filter((entry): entry is MemoryCatalogEntry => Boolean(entry))
    .sort((a, b) => a.path.localeCompare(b.path));
  writeMemoryCatalog(memoryDir, entries);
  return entries;
}

export function getMemoryCatalog(memoryDir: string): MemoryCatalogEntry[] {
  const catalog = readMemoryCatalog(memoryDir);
  if (catalog && catalogIsFresh(memoryDir, catalog.entries)) return catalog.entries;
  return rebuildMemoryCatalog(memoryDir);
}
/**
 * Cross-session update detection.
 *
 * Sessions poll the catalog signature at turn boundaries. Entries changed outside
 * this session (another session, git pull, manual edit) produce a compact append-only
 * notice. The comparison is content-based, so catalog rewrites with identical
 * content never trigger a notice.
 */

export type CatalogSignature = Map<string, MemoryCatalogEntry>;

export function readCatalogSignature(memoryDir: string): CatalogSignature {
  return new Map(getMemoryCatalog(memoryDir).map((entry) => [entry.id, entry]));
}

export interface CatalogDelta {
  added: MemoryCatalogEntry[];
  updated: MemoryCatalogEntry[]; // entries from the NEW signature
  removed: MemoryCatalogEntry[]; // entries from the OLD signature
}

const CATALOG_CHANGE_KEYS = ["mtimeMs", "updated", "supersededBy"] as const;

export function diffCatalogSignatures(oldSig: CatalogSignature, newSig: CatalogSignature): CatalogDelta | null {
  const added: MemoryCatalogEntry[] = [];
  const updated: MemoryCatalogEntry[] = [];
  const removed: MemoryCatalogEntry[] = [];
  for (const [id, entry] of newSig) {
    const prev = oldSig.get(id);
    if (!prev) added.push(entry);
    else if (CATALOG_CHANGE_KEYS.some((key) => prev[key] !== entry[key])) updated.push(entry);
  }
  for (const [id, entry] of oldSig) {
    if (!newSig.has(id)) removed.push(entry);
  }
  if (!added.length && !updated.length && !removed.length) return null;
  return { added, updated, removed };
}

/**
 * Render a compact notice. Sensitive entries keep their id only; deletions found
 * in .pruned.log are labeled "(pruned)" so passive GC reads differently from
 * explicit deletes.
 */
export function renderUpdateNotice(delta: CatalogDelta, prunedIds: Set<string>): string {
  const line = (entry: MemoryCatalogEntry, mark: string, suffix = "") =>
    `  ${mark} @${entry.id}${suffix}${entry.sensitive ? " (sensitive)" : ` — ${entry.description}`}`;
  const lines = [
    ...delta.added.map((entry) => line(entry, "+")),
    ...delta.updated.map((entry) => line(entry, "~")),
    ...delta.removed.map((entry) => line(entry, "-", prunedIds.has(entry.id) ? " (pruned)" : "")),
  ];
  const cap = 10;
  if (lines.length > cap) {
    return `Project memory changed since last turn (external write):\n${lines.slice(0, cap).join("\n")}\n  (+${lines.length - cap} more)`;
  }
  return `Project memory changed since last turn (external write):\n${lines.join("\n")}`;
}

/** Ids present in the tail of .pruned.log, used to explain disappearances. */
export function readPrunedIds(memoryDir: string, maxBytes = 8192): Set<string> {
  try {
    const logPath = path.join(memoryDir, ".pruned.log");
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    const ids = new Set<string>();
    for (const row of buffer.toString("utf8").split("\n")) {
      const cols = row.split("\t");
      if (cols.length >= 2 && cols[1]) ids.add(cols[1]);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

export function upsertMemoryCatalog(memoryDir: string, filePath: string): void {
  const entry = catalogEntryFromMemory(memoryDir, filePath);
  if (!entry) return;
  const entries = getMemoryCatalog(memoryDir).filter(
    (candidate) => candidate.path !== entry.path && candidate.id !== entry.id,
  );
  entries.push(entry);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  writeMemoryCatalog(memoryDir, entries);
}

export function memoryFileFromCatalogEntry(memoryDir: string, entry: MemoryCatalogEntry) {
  return memoryFromCatalogEntry(memoryDir, entry);
}

export function removeMemoryCatalogEntry(memoryDir: string, filePath: string): void {
  const relPath = path.relative(memoryDir, filePath);
  const entries = getMemoryCatalog(memoryDir).filter((entry) => entry.path !== relPath);
  writeMemoryCatalog(memoryDir, entries);
}

export function reconcileConceptDictionary(memoryDir: string, removableConcepts: string[] = []): ConceptDictionary {
  const existing = getConceptDictionary(memoryDir);
  const activeConcepts = new Set<string>();
  for (const filePath of listMemoryFiles(memoryDir)) {
    const memory = readMemoryFile(filePath);
    for (const concept of memory?.frontmatter.concepts ?? []) {
      const normalized = normalizeConceptLabel(concept);
      if (normalized) activeConcepts.add(normalized);
    }
  }

  const aliasTargets = new Set(
    Object.values(existing.aliases)
      .map((target) => normalizeConceptLabel(target))
      .filter(Boolean),
  );
  const removable = new Set(removableConcepts.map((concept) => normalizeConceptLabel(concept)).filter(Boolean));
  const concepts = new Set<string>(existing.concepts.map((concept) => normalizeConceptLabel(concept)).filter(Boolean));
  for (const concept of activeConcepts) concepts.add(concept);
  for (const concept of aliasTargets) concepts.add(concept);
  for (const concept of removable) {
    if (!activeConcepts.has(concept) && !aliasTargets.has(concept)) concepts.delete(concept);
  }

  const dictionary: ConceptDictionary = {
    version: 1,
    concepts: uniqueSorted(concepts),
    aliases: existing.aliases,
  };
  writeConceptDictionary(memoryDir, dictionary);
  return dictionary;
}

export function deleteMemoryFile(
  memoryDir: string,
  pathOrId: string,
): { id: string; path: string; dictionary: ConceptDictionary; unhidden: string[] } {
  const filePath = resolveMemoryFile(memoryDir, pathOrId);
  const memory = readMemoryFile(filePath);
  if (!memory?.frontmatter.id || !memory.frontmatter.kind) throw new Error(`Memory file not found: ${pathOrId}`);
  fs.rmSync(filePath, { force: true });
  removeMemoryCatalogEntry(memoryDir, filePath);
  // Reconcile: any record pointing at the deleted id is resurrected (natural undo of
  // supersedes) by clearing its marker.
  const unhidden = clearSupersededMarkers(memoryDir, memory.frontmatter.id);
  const dictionary = reconcileConceptDictionary(memoryDir, memory.frontmatter.concepts ?? []);
  return {
    id: memory.frontmatter.id,
    path: path.relative(memoryDir, filePath),
    dictionary,
    unhidden,
  };
}
/**
 * Memory context
 */

function ensureDirectoryStructure(memoryDir: string): void {
  fs.mkdirSync(path.join(memoryDir, MEMORY_RECORDS_DIR), { recursive: true });
}

function createDefaultFiles(memoryDir: string): void {
  const today = getCurrentDate();
  const defaults: Array<{ id: string; description: string; tags: string[]; content: string }> = [
    {
      id: "state.identity",
      description: "Project-specific user identity and background",
      tags: ["user", "identity"],
      content: `# User Identity\n\n${MEMORY_FACTS_START}\nuser.identity = "Customize this fact"\n${MEMORY_FACTS_END}`,
    },
    {
      id: "state.preferences",
      description: "Project-specific user and collaboration preferences",
      tags: ["user", "preferences"],
      content: `# User Preferences\n\n${MEMORY_FACTS_START}\ncommunication.style = "concise"\n${MEMORY_FACTS_END}`,
    },
  ];

  for (const entry of defaults) {
    const filePath = recordPathForId(memoryDir, entry.id);
    if (fs.existsSync(filePath)) continue;
    writeMemoryFile(filePath, entry.content, {
      description: entry.description,
      tags: entry.tags,
      created: today,
      updated: today,
    });
    upsertMemoryCatalog(memoryDir, filePath);
  }
}

/**
 * Auto-init: the first memory_write in a project creates the local records/ layout and the
 * default records. Local only - there is no remote clone step.
 */
export function ensureProjectMemoryInitialized(memoryDir: string): boolean {
  if (fs.existsSync(path.join(memoryDir, MEMORY_RECORDS_DIR))) return false;
  ensureDirectoryStructure(memoryDir);
  createDefaultFiles(memoryDir);
  return true;
}

const MAX_INJECTED_MEMORY_FILES = 10;
const STATE_INJECTION_QUOTA = 5;

function memoryTimestamp(filePath: string, frontmatter: MemoryFrontmatter): number {
  for (const value of [frontmatter.updated, frontmatter.created]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return fs.statSync(filePath).mtimeMs;
}

export function buildMemoryContext(settings: MemoryMdSettings, cwd: string): string {
  const memoryDir = getMemoryDir(settings, cwd);
  if (!fs.existsSync(memoryDir)) return "";

  // Passive prune rides along (throttled to once per hour per project) — GC on
  // the injection path, never on the memory_write hot path.
  maybeSweepPrunableMemory(memoryDir, settings);

  const candidates = filterSupersededEntries(memoryDir, getMemoryCatalog(memoryDir))
    .filter((entry) => !entry.sensitive)
    .sort(
      (a, b) =>
        memoryTimestamp(path.join(memoryDir, b.path), b) - memoryTimestamp(path.join(memoryDir, a.path), a) ||
        a.path.localeCompare(b.path),
    );

  // Reserve up to STATE_INJECTION_QUOTA slots for the newest state records and the rest for the newest
  // events, with two-way backfill: a shortfall on either kind is filled by the newest records of the
  // other kind, capped at MAX_INJECTED_MEMORY_FILES total.
  const eventQuota = MAX_INJECTED_MEMORY_FILES - STATE_INJECTION_QUOTA;
  const states = candidates.filter((entry) => entry.kind === "state");
  const events = candidates.filter((entry) => entry.kind !== "state");
  const topStates = states.slice(0, STATE_INJECTION_QUOTA);
  const topEvents = events.slice(0, eventQuota);
  const selectedPaths = new Set<string>([...topStates, ...topEvents].map((entry) => entry.path));
  for (const [shortfall, fillWith] of [
    [STATE_INJECTION_QUOTA - topStates.length, events],
    [eventQuota - topEvents.length, states],
  ] as Array<[number, MemoryCatalogEntry[]]>) {
    let filled = 0;
    for (const entry of fillWith) {
      if (selectedPaths.size >= MAX_INJECTED_MEMORY_FILES) break;
      if (selectedPaths.has(entry.path)) continue;
      selectedPaths.add(entry.path);
      filled += 1;
      if (filled >= shortfall) break;
    }
  }
  const memories = candidates.filter((entry) => selectedPaths.has(entry.path));
  if (memories.length === 0) return "";

  // Enforce the systemPrompt.maxTokens budget (≈4 chars/token heuristic) on top of
  // the file-count cap: oversized descriptions trim the oldest entries first, but
  // at least the newest record always survives (the field used to be defaulted
  // but never read).
  const maxTokens = settings.systemPrompt?.maxTokens ?? 10000;
  const budgetChars = maxTokens * 4;
  let usedChars = 0;
  const budgeted: MemoryCatalogEntry[] = [];
  for (const entry of memories) {
    const entryChars =
      entry.path.length +
      entry.id.length +
      entry.kind.length +
      (entry.description?.length ?? 0) +
      entry.tags.join(",").length +
      64;
    if (budgeted.length > 0 && usedChars + entryChars > budgetChars) break;
    budgeted.push(entry);
    usedChars += entryChars;
  }

  const lines: string[] = [
    "# Project Memory",
    "",
    "Recent memory files (use memory_read with a path or @id for full content):",
    "",
  ];

  for (const entry of budgeted) {
    lines.push(`- ${entry.path} (@${entry.id})`);
    lines.push(`  Kind: ${entry.kind}`);
    lines.push(`  Description: ${entry.description}`);
    lines.push(`  Tags: ${entry.tags.join(", ") || "none"}`);
    lines.push("");
  }

  return lines.join("\n");
}
