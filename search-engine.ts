/**
 * Search engine for memory files.
 * Regex support, stopword filtering, line-based snippets.
 * Regex support, stopword filtering, multi-term OR matching, line-based snippets.
 */

import type { MemoryFile } from "./types.js";

// ── Types ──

export type MatchedField = "content" | "tags" | "description" | "summary" | "concepts" | "claims" | "id" | "kind";

export interface SearchHit {
  path: string;
  snippet: string;
  matchCount: number;
  matchedIn: MatchedField[];
}

export type SearchField = "content" | "tags" | "description" | "summary" | "concepts" | "claims" | "id" | "all";

const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPET_CHARS = 500;
const SEARCH_CONTEXT_LINES = 1;

// ── Regex utilities ──

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeRegex = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

const looksLikeRegex = (query: string): boolean =>
  /[|^$[\]\\]/.test(query) || /\.\*|\.\+|\([^)]*\)|\{\d+(?:,\d*)?\}/.test(query);

const literalTermRegexes = (terms: string[]): RegExp[] => terms.map((term) => new RegExp(escapeRegex(term), "i"));

const snippetRegex = (terms: string[]): RegExp => new RegExp(terms.map(escapeRegex).join("|"), "i");

// ── Stopwords ──

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
]);

const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  return meaningful.length > 0 ? meaningful : terms;
};

// ── Helpers ──

const countMatches = (hay: string, termRegexes: RegExp[]): number => {
  let count = 0;
  for (const regex of termRegexes) {
    if (regex.test(hay)) count++;
  }
  return count;
};

const truncateSnippet = (snippet: string): string => {
  if (snippet.length <= MAX_SNIPPET_CHARS) return snippet;
  return `${snippet.slice(0, MAX_SNIPPET_CHARS).trimEnd()}\n...(truncated)`;
};

const lineSnippet = (text: string, regex: RegExp, contextLines = SEARCH_CONTEXT_LINES): string => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return truncateSnippet(lines.find((line) => line.trim()) ?? "");

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return truncateSnippet(parts.join("\n"));
};

function buildSearchText(memory: MemoryFile, field: SearchField): string {
  switch (field) {
    case "content":
      return memory.content;
    case "tags":
      return memory.frontmatter.tags?.join(" ") ?? "";
    case "description":
      return memory.frontmatter.description;
    case "summary":
      return memory.frontmatter.summary ?? "";
    case "concepts":
      return memory.frontmatter.concepts?.join("\n") ?? "";
    case "claims":
      return memory.frontmatter.claims?.join("\n") ?? "";
    case "id":
      return memory.frontmatter.id ?? "";
    case "all":
      return [
        memory.frontmatter.id ?? "",
        memory.frontmatter.kind ?? "",
        memory.frontmatter.description,
        memory.frontmatter.summary ?? "",
        memory.frontmatter.concepts?.join("\n") ?? "",
        memory.frontmatter.claims?.join("\n") ?? "",
        memory.frontmatter.tags?.join(" ") ?? "",
        memory.content,
      ].join("\n");
  }
}

function detectMatchedFields(memory: MemoryFile, regex: RegExp, searchIn: SearchField): MatchedField[] {
  if (searchIn !== "all") return regex.test(buildSearchText(memory, searchIn)) ? [searchIn] : [];

  const fields: MatchedField[] = [];
  if (regex.test(memory.content)) fields.push("content");
  if (memory.frontmatter.tags?.some((t) => regex.test(t))) fields.push("tags");
  if (regex.test(memory.frontmatter.description)) fields.push("description");
  if (memory.frontmatter.summary && regex.test(memory.frontmatter.summary)) fields.push("summary");
  if (memory.frontmatter.concepts?.some((concept) => regex.test(concept))) fields.push("concepts");
  if (memory.frontmatter.claims?.some((claim) => regex.test(claim))) fields.push("claims");
  if (memory.frontmatter.id && regex.test(memory.frontmatter.id)) fields.push("id");
  if (memory.frontmatter.kind && regex.test(memory.frontmatter.kind)) fields.push("kind");
  return fields;
}

function buildSnippet(memory: MemoryFile, searchIn: SearchField, regex: RegExp): string {
  const tags = memory.frontmatter.tags?.join(", ") ?? "";
  const tagSnippet = () => truncateSnippet(`Tags: ${tags}`);
  const descriptionSnippet = () => truncateSnippet(memory.frontmatter.description);
  const summarySnippet = () => truncateSnippet(memory.frontmatter.summary ?? "");
  const conceptsSnippet = () => truncateSnippet(`Concepts: ${memory.frontmatter.concepts?.join(", ") ?? ""}`);
  const claimsSnippet = () => truncateSnippet((memory.frontmatter.claims ?? []).join("\n"));

  if (searchIn === "tags") return tagSnippet();
  if (searchIn === "description") return descriptionSnippet();
  if (searchIn === "summary") return summarySnippet();
  if (searchIn === "concepts") return conceptsSnippet();
  if (searchIn === "claims") return claimsSnippet();
  if (searchIn === "id") return truncateSnippet(`ID: ${memory.frontmatter.id ?? "none"}`);
  if (searchIn === "all") {
    if (memory.frontmatter.summary && regex.test(memory.frontmatter.summary)) return summarySnippet();
    if (memory.frontmatter.concepts?.some((concept) => regex.test(concept))) return conceptsSnippet();
    if (memory.frontmatter.claims?.some((claim) => regex.test(claim))) return claimsSnippet();
    if (memory.frontmatter.tags?.some((tag) => regex.test(tag))) return tagSnippet();
    if (regex.test(memory.frontmatter.description)) return descriptionSnippet();
    if (regex.test(memory.content)) return lineSnippet(memory.content, regex);
    if (memory.frontmatter.id && regex.test(memory.frontmatter.id)) {
      return truncateSnippet(`ID: ${memory.frontmatter.id}`);
    }
    if (memory.frontmatter.kind && regex.test(memory.frontmatter.kind)) {
      return truncateSnippet(`Kind: ${memory.frontmatter.kind}`);
    }
  }
  return lineSnippet(memory.content, regex);
}

// ── Main search function ──

export interface SearchInput {
  files: Map<string, MemoryFile>;
  query: string;
  searchIn: SearchField;
  kind?: "state" | "event";
  /** Optional OR-groups for exact concept matching: a record matches when it stores any term of each family. */
  conceptAliasFamilies?: string[][];
}

/** Recency key for ranking: frontmatter.updated parsed to ms, 0 when absent/unparseable. */
function recordRecency(memory: MemoryFile): number {
  const raw = memory.frontmatter.updated;
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

export function searchMemoryFiles(input: SearchInput): SearchHit[] {
  const { files, query, searchIn, kind } = input;
  const rawQuery = query.trim();
  if (!rawQuery) return [];

  const entries = Array.from(files.entries()).filter(([, memory]) => !kind || memory.frontmatter.kind === kind);

  // Regex mode: query contains metacharacters
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: Array<{ hit: SearchHit; ts: number }> = [];

    for (const [relPath, memory] of entries) {
      const text = buildSearchText(memory, searchIn);
      if (!regex.test(text)) continue;

      hits.push({
        hit: {
          path: relPath,
          snippet: buildSnippet(memory, searchIn, regex),
          matchCount: 1,
          matchedIn: detectMatchedFields(memory, regex, searchIn),
        },
        ts: recordRecency(memory),
      });
    }

    // Every regex hit ties at matchCount 1, so recency decides (specialist
    // review #4 quick win — alphabetical path order was the old tie-break).
    hits.sort((a, b) => b.ts - a.ts);
    return hits.slice(0, MAX_SEARCH_RESULTS).map((h) => h.hit);
  }

  const exactConceptTerms = rawQuery.split(/\s+/).filter((term) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(term));
  if (
    searchIn === "concepts" &&
    exactConceptTerms.length > 0 &&
    exactConceptTerms.length === rawQuery.split(/\s+/).length
  ) {
    const hits: Array<SearchHit & { recency?: number }> = [];
    const families = input.conceptAliasFamilies;
    const matchesExact = families
      ? (concepts: string[]) => families.every((family) => family.some((term) => concepts.includes(term)))
      : (concepts: string[]) => exactConceptTerms.every((term) => concepts.includes(term));
    for (const [relPath, memory] of entries) {
      const concepts = memory.frontmatter.concepts ?? [];
      if (!matchesExact(concepts)) continue;
      hits.push({
        path: relPath,
        snippet: buildSnippet(memory, searchIn, snippetRegex(exactConceptTerms)),
        matchCount: exactConceptTerms.length,
        matchedIn: ["concepts"],
        recency: recordRecency(memory),
      });
    }
    // All exact-concept hits tie at matchCount = term count; recency decides.
    hits.sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0));
    return hits.slice(0, MAX_SEARCH_RESULTS);
  }

  // Natural language mode: OR match, sorted by matchCount desc
  const terms = filterStopwords(rawQuery.split(/\s+/));
  const termRegexes = literalTermRegexes(terms);
  const snipRe = snippetRegex(terms);

  const hits: Array<{ hit: SearchHit; mc: number; ts: number }> = [];
  for (const [relPath, memory] of entries) {
    const text = buildSearchText(memory, searchIn);
    const mc = countMatches(text, termRegexes);
    if (mc === 0) continue;

    hits.push({
      hit: {
        path: relPath,
        snippet: buildSnippet(memory, searchIn, snipRe),
        matchCount: mc,
        matchedIn: detectMatchedFields(memory, snipRe, searchIn),
      },
      mc,
      ts: recordRecency(memory),
    });
  }

  // Relevance first (match count), recency as the tie-break — a six-month-old
  // event no longer outranks yesterday's record on alphabetical luck.
  hits.sort((a, b) => b.mc - a.mc || b.ts - a.ts);
  return hits.slice(0, MAX_SEARCH_RESULTS).map((h) => h.hit);
}
