import type { FrontmatterData } from "./frontmatter.js";

/**
 * Type definitions for memory files and settings.
 */

export type MemoryKind = "state" | "event";
export type MemoryReadView = "full" | "summary" | "knowledge";

export type MemoryFactValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type MemoryFactInputValue = MemoryFactValue | { [key: string]: MemoryFactInputValue };

export interface StructuredMemoryFields {
  summary?: string;
  concepts?: string[];
  claims?: string[];
  facts?: Record<string, MemoryFactInputValue>;
  relations?: Record<string, string>;
  notes?: string;
}

export interface ConceptDictionary {
  version: 1;
  concepts: string[];
  aliases: Record<string, string>;
}

export interface ConceptDuplicateHint {
  concept: string;
  candidate: string;
  score: number;
}

export interface ConceptNormalizationAudit {
  canonical: string[];
  resolvedAliases: Record<string, string>;
  registered: string[];
  possibleDuplicates: ConceptDuplicateHint[];
  warnings: string[];
}

export interface ConceptAliasResult {
  ok: boolean;
  error?: string;
  alias?: string;
  canonical?: string;
  converted?: boolean;
}

export interface MemoryFrontmatter {
  id?: string;
  kind?: MemoryKind;
  description: string;
  summary?: string;
  concepts?: string[];
  claims?: string[];
  sensitive?: boolean;
  limit?: number;
  tags?: string[];
  created?: string;
  updated?: string;
  supersededBy?: string;
  /** ISO timestamp set when the supersede marker was attached; drives passive prune age. */
  supersededAt?: string;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

export interface MemoryMdSettings {
  enabled?: boolean;
  localPath?: string;
  injection?: "system-prompt" | "message-append" | "off";
  /** Passive-prune age for superseded tombstones, in days from the marker timestamp. 0 disables. */
  pruneAfterDays?: number;
  systemPrompt?: {
    maxTokens?: number;
    includeProjects?: string[];
  };
}

export type ParsedFrontmatter = FrontmatterData;
