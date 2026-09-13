import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildMemoryContext, getMemoryDir, loadSettings, type MemoryMdSettings } from "./memoryMdCore.js";
import { registerAllMemoryTools } from "./tools.js";

/**
 * Main extension initialization.
 */

export default function memoryMdExtension(pi: ExtensionAPI) {
  let settings: MemoryMdSettings = loadSettings();
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;

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
          customType: "pi-memory-md",
          content: cachedMemoryContext,
          display: false,
        },
      };
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

  registerAllMemoryTools(pi, settings);

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

      const mode = settings.injection || "message-append";
      const fileCount = memoryContext.split("\n").filter((l) => l.startsWith("-")).length;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
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
