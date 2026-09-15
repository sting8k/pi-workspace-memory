import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildMemoryContext,
  type CatalogSignature,
  diffCatalogSignatures,
  getMemoryDir,
  loadSettings,
  type MemoryMdSettings,
  readCatalogSignature,
  readPrunedIds,
  renderUpdateNotice,
} from "./memoryMdCore.js";
import { registerAllMemoryTools } from "./tools.js";

/**
 * Main extension initialization.
 */

export default function memoryMdExtension(pi: ExtensionAPI) {
  let settings: MemoryMdSettings = loadSettings();
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;
  // Cross-session update detection: catalog signature at the last turn boundary,
  // plus a flag absorbing this session's own writes so notices stay foreign-only.
  let catalogSig: CatalogSignature | null = null;
  let ownWriteThisTurn = false;

  function initMemoryContext(ctx: ExtensionContext, options: { showNotification: boolean }): boolean {
    settings = loadSettings();

    if (!settings.enabled) return false;

    const memoryDir = getMemoryDir(settings, ctx.cwd);

    if (!fs.existsSync(memoryDir)) {
      if (options.showNotification) {
        ctx.ui.notify("Memory-md has no records yet. The first memory_write creates project memory.", "info");
      }
      return false;
    }

    cachedMemoryContext = buildMemoryContext(settings, ctx.cwd);
    catalogSig = readCatalogSignature(memoryDir);
    memoryInjected = false;
    return true;
  }

  pi.on("session_start", async (_event, ctx) => {
    initMemoryContext(ctx, { showNotification: true });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const mode = settings.injection || "message-append";

    // "off" registers tools (and commands) without any automatic injection.
    if (mode === "off") return undefined;

    if (!cachedMemoryContext) return undefined;

    const isFirstInjection = !memoryInjected;

    if (isFirstInjection) {
      memoryInjected = true;
      const fileCount = cachedMemoryContext.split("\n").filter((l) => l.startsWith("-")).length;
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");
    }

    if (mode === "message-append" && isFirstInjection) {
      return {
        message: {
          customType: "pi-workspace-memory",
          content: cachedMemoryContext,
          display: false,
        },
      };
    }

    // Cross-session updates: diff the catalog signature at each turn boundary and
    // append a compact notice when another session (or an external write) changed
    // project memory. Append-only — the cached prefix and system prompt stay
    // byte-identical, so provider prompt caching is unaffected.
    if (mode === "message-append" && !isFirstInjection && catalogSig) {
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (fs.existsSync(memoryDir)) {
        const sigNow = readCatalogSignature(memoryDir);
        const delta = diffCatalogSignatures(catalogSig, sigNow);
        catalogSig = sigNow;
        if (delta) {
          const notice = renderUpdateNotice(delta, readPrunedIds(memoryDir));
          ctx.ui.notify(
            `Memory updated elsewhere: +${delta.added.length} ~${delta.updated.length} −${delta.removed.length}`,
            "info",
          );
          return {
            message: {
              customType: "pi-workspace-memory-update",
              content: notice,
              display: false,
            },
          };
        }
      }
      return undefined;
    }

    if (mode === "system-prompt") {
      // Rebuild from disk each turn instead of appending the session-start
      // snapshot — records written mid-session reach the very next request.
      // (Rides the throttled passive-prune sweep, same as message-append.)
      const freshContext = buildMemoryContext(settings, ctx.cwd);
      if (!freshContext) return undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${freshContext}`,
      };
    }

    return undefined;
  });

  // Absorb this session's own writes right after the turn ends, so the next turn's
  // diff only reports foreign changes. Without own writes the signature is left
  // untouched: mid-turn foreign writes surface at the next turn boundary.
  pi.on("turn_end", async (_event, ctx) => {
    if (!ownWriteThisTurn || !settings.enabled) return;
    ownWriteThisTurn = false;
    const memoryDir = getMemoryDir(settings, ctx.cwd);
    if (fs.existsSync(memoryDir)) catalogSig = readCatalogSignature(memoryDir);
  });

  registerAllMemoryTools(pi, settings, () => {
    ownWriteThisTurn = true;
  });

  pi.registerCommand("memory-refresh", {
    description: "Refresh memory context from files",
    handler: async (_args, ctx) => {
      const memoryContext = buildMemoryContext(settings, ctx.cwd);

      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      cachedMemoryContext = memoryContext;
      memoryInjected = false;
      const refreshDir = getMemoryDir(settings, ctx.cwd);
      if (fs.existsSync(refreshDir)) catalogSig = readCatalogSignature(refreshDir);

      const mode = settings.injection || "message-append";
      const fileCount = memoryContext.split("\n").filter((l) => l.startsWith("-")).length;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-workspace-memory-refresh",
          content: memoryContext.replace(/^# Project Memory/, "# Project Memory (Refreshed)"),
          display: false,
        });
        ctx.ui.notify(`Memory refreshed: ${fileCount} files injected (${mode})`, "info");
      } else {
        ctx.ui.notify(`Memory cache refreshed: ${fileCount} files (will be injected on next prompt)`, "info");
      }
    },
  });

  pi.registerCommand("memory-check", {
    description: "Check memory folder structure",
    handler: async (_args, ctx) => {
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      if (!fs.existsSync(memoryDir)) {
        ctx.ui.notify(`Memory directory not found: ${memoryDir}`, "error");
        return;
      }

      const { execSync } = await import("node:child_process");
      let treeOutput = "";

      try {
        treeOutput = execSync(`tree -L 3 -I "node_modules" "${memoryDir}"`, { encoding: "utf-8" });
      } catch {
        try {
          treeOutput = execSync(`find "${memoryDir}" -type d -not -path "*/node_modules/*"`, { encoding: "utf-8" });
        } catch {
          treeOutput = "Unable to generate directory tree.";
        }
      }

      ctx.ui.notify(treeOutput.trim(), "info");
    },
  });
}
