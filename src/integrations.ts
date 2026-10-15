import { Notice, TFile, normalizePath } from "obsidian";
import type ClaudeStudio from "./main";
import { stripFrontmatter, truncate } from "./util";
import { Palette } from "./ui/palette";
import { weeklyRecap } from "./features";

/* ------------------------------------------------------------------ */
/* Clippings: summary property on new notes (opt-in)                     */
/* ------------------------------------------------------------------ */

export function watchClippings(plugin: ClaudeStudio) {
  const { app } = plugin;
  const pending = new Set<string>();
  const inFolder = (f: TFile) => f.extension === "md" && f.path.startsWith(normalizePath(plugin.settings.clippingsFolder) + "/");

  // Registered after layout-ready so the startup scan doesn't count as "new".
  plugin.registerEvent(
    app.vault.on("create", (f) => {
      if (plugin.settings.clippingsEnabled && f instanceof TFile && inFolder(f)) pending.add(f.path);
    }),
  );
  // Web Clipper creates the file and then writes it; wait for the parsed content.
  plugin.registerEvent(
    app.metadataCache.on("changed", (f) => {
      if (!pending.has(f.path)) return;
      pending.delete(f.path);
      void summarize(plugin, f);
    }),
  );
}

async function summarize(plugin: ClaudeStudio, file: TFile) {
  const { app } = plugin;
  const prop = plugin.settings.clippingsProperty;
  if (plugin.core.isExcluded(file) || app.metadataCache.getFileCache(file)?.frontmatter?.[prop]) return;
  const body = stripFrontmatter(await app.vault.read(file));
  if (body.trim().length < 200) return;
  try {
    const out = await plugin.core.complete({
      model: "fast",
      tools: [],
      persist: false,
      label: "Summarize clipping",
      system: "Reply with the summary only: plain text, one paragraph, no Markdown.",
      prompt: `Summarize this clipped article in 2-3 sentences, in the article's language.\n\n${truncate(body, 14000)}`,
    });
    const before = await app.vault.read(file);
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => (fm[prop] = out.trim().replace(/\s+/g, " ")));
    const after = await app.vault.read(file);
    await plugin.history.add({ action: "Summarize clipping", file: file.path, model: plugin.core.model("fast"), costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: out, before, after });
  } catch (e) {
    console.warn("Claude Studio: clipping summary failed", e);
  }
}

/* ------------------------------------------------------------------ */
/* Public API (Templater, QuickAdd, DataviewJS, other plugins)           */
/* ------------------------------------------------------------------ */

/**
 * app.plugins.plugins["claude-studio"].api
 *
 *   <% await app.plugins.plugins["claude-studio"].api.run("Three title ideas for: " + tp.file.title) %>
 */
export class StudioApi {
  constructor(private plugin: ClaudeStudio) {}

  /** One-shot completion. model: "fast" | "write" | "chat" | a model id. No tools unless given. */
  run(prompt: string, opts: { model?: string; system?: string; tools?: string[] } = {}): Promise<string> {
    return this.plugin.core.complete({ prompt, model: opts.model ?? "fast", system: opts.system, tools: opts.tools ?? [], persist: false, label: "API" });
  }

  /** Run a library action by id or name on the active note. */
  async runAction(nameOrId: string, input?: string): Promise<void> {
    const a = this.plugin.library.byId(nameOrId);
    if (!a) throw new Error(`No Claude Studio action "${nameOrId}"`);
    await this.plugin.actions.run(a, { input });
  }

  ask(question: string): void {
    void this.plugin.openChat(question);
  }

  actions(): { id: string; name: string; group: string }[] {
    return this.plugin.library.actions.map((a) => ({ id: a.id, name: a.name, group: a.group }));
  }
}

/* ------------------------------------------------------------------ */
/* obsidian://claude-studio?do=…                                         */
/* ------------------------------------------------------------------ */

/**
 *   obsidian://claude-studio?do=chat&prompt=…
 *   obsidian://claude-studio?do=run&action=Resumir%20nota&file=Notes/X.md
 *   obsidian://claude-studio?do=palette
 *   obsidian://claude-studio?do=recap
 */
export function registerUri(plugin: ClaudeStudio) {
  plugin.registerObsidianProtocolHandler("claude-studio", async (p) => {
    const { app } = plugin;
    if (p.file) {
      const f = app.vault.getAbstractFileByPath(normalizePath(p.file.endsWith(".md") ? p.file : `${p.file}.md`));
      if (!(f instanceof TFile)) return new Notice(`Claude Studio: no note "${p.file}"`);
      await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source" } });
    }
    switch (p.do) {
      case "chat":
        return plugin.openChat(p.prompt ?? "");
      case "palette":
        return new Palette(app, plugin, p.prompt ?? "").open();
      case "usage":
        return plugin.openUsage();
      case "recap":
        return weeklyRecap(plugin, Number(p.days) || 7);
      case "run": {
        const a = plugin.library.byId(p.action ?? "");
        if (!a) return new Notice(`Claude Studio: no action "${p.action}"`);
        // Give the editor a moment to mount after openFile.
        window.setTimeout(() => void plugin.actions.run(a, { input: p.prompt }), 150);
        return;
      }
      default:
        new Notice(`Claude Studio: unknown do="${p.do}"`);
    }
  });
}
