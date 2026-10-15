import { ICON } from "./icon";
import { t } from "./i18n";
import { Editor, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type ClaudeStudio from "./main";
import type { Action } from "./library";
import { buildPrompt, systemFor, type Gathered } from "./context";
import { InlineSession, brokenLinks } from "./editor/inline";
import { DiffModal } from "./ui/diff";
import { ResultModal } from "./ui/result";
import { findWikiLinks, keepFrontmatter, sanitizeFileName, unwrapFence } from "./util";
import { clock } from "./time";

export interface ActiveNote {
  view: MarkdownView;
  editor: Editor;
  cm: EditorView;
  file: TFile;
}

export function freeAction(input: string, hasSelection: boolean): Action {
  return {
    id: "free",
    name: t("action.askClaude"),
    icon: ICON,
    group: "",
    model: "write",
    scope: hasSelection ? "selection" : "cursor",
    output: hasSelection ? "replace" : "below",
    tools: [],
    index: false,
    bubble: false,
    order: 0,
    prompt: input,
    path: "",
  };
}

const chipsLabel = (g: Gathered) =>
  g.chips
    .filter((c) => c.on && c.kind !== "profile")
    .map((c) => (c.kind === "selection" ? t("chip.selectionShort") : c.kind === "cursor" ? t("chip.cursorShort") : c.label))
    .join(" · ");

export class ActionRunner {
  constructor(private plugin: ClaudeStudio) {}

  private get app() {
    return this.plugin.app;
  }

  active(): ActiveNote | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.getMode() !== "source") return null;
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    return cm ? { view, editor: view.editor, cm, file: view.file } : null;
  }

  async run(action: Action, opts: { input?: string; gathered?: Gathered } = {}) {
    const note = this.active();
    const needsEditor = action.output === "replace" || action.output === "below";
    if (needsEditor && !note) return new Notice(t("notice.openNoteEditing"));
    if (action.scope === "selection" && note && !note.editor.getSelection().trim() && !opts.gathered?.chips.some((c) => c.kind === "selection"))
      return new Notice(t("notice.needsSelection", { name: action.name }));

    let g: Gathered;
    try {
      g = opts.gathered ?? (await this.plugin.ctx.gather(note?.file ?? this.app.workspace.getActiveFile(), note?.editor ?? null, action.scope));
    } catch (e) {
      return new Notice((e as Error).message);
    }

    if (action.output === "chat") {
      const text = opts.input ?? "";
      return this.plugin.openChat(action.prompt.includes("{{input}}") ? action.prompt.replace(/\{\{\s*input\s*\}\}/g, text) : `${action.prompt}\n\n${text}`.trim(), g);
    }

    const prompt = buildPrompt(this.app, {
      instruction: action.prompt,
      chips: g.chips,
      file: g.file,
      input: opts.input,
      index: action.index ? this.plugin.ctx.noteIndex() : undefined,
    });
    const system = systemFor(g.chips);
    const spec = { prompt, system, model: action.model, tools: action.tools, persist: false, label: action.name };

    switch (action.output) {
      case "replace":
      case "below": {
        const range = g.range ?? { from: 0, to: 0 };
        const r = action.scope === "selection" ? range : { from: range.to, to: range.to };
        new InlineSession(this.plugin, note!.cm, { title: action.name, icon: action.icon, prompt, system, model: action.model, tools: action.tools, mode: action.output, file: g.file, chipsLabel: chipsLabel(g) }, r);
        return;
      }
      case "modal": {
        new ResultModal(this.app, this.plugin, {
          title: action.name,
          icon: action.icon,
          spec,
          sourcePath: g.file?.path ?? "",
          actions: note ? [{ label: t("inline.insertBelow"), cta: true, run: (t) => this.insertBelow(note, t) }] : [],
          onDone: (text, r) =>
            void this.plugin.history.add({ action: action.name, file: g.file?.path, model: action.model, costUsd: r?.costUsd ?? 0, durationMs: r?.durationMs ?? 0, status: "shown", prompt, result: text }),
        }).open();
        return;
      }
      case "note": {
        if (!g.file) return new Notice(t("notice.openNote"));
        return this.rewriteNote(g.file, action.name, spec);
      }
      case "new-note":
        return this.toNewNote(action.name, spec, g.file);
      default:
        if (action.output.startsWith("property:")) {
          if (!g.file) return new Notice(t("notice.openNote"));
          return this.toProperty(g.file, action.output.slice("property:".length), action.name, spec);
        }
        new Notice(t("notice.unknownOutput", { output: action.output, path: action.path }));
    }
  }

  insertBelow(note: ActiveNote, text: string) {
    const cur = note.editor.getCursor("to");
    const line = note.editor.getLine(cur.line);
    const insert = line.trim() ? `\n\n${text}` : text;
    note.editor.replaceRange(insert, { line: cur.line, ch: line.length });
  }

  /** Whole-note rewrite → diff → apply as a minimal edit so undo, folds and scroll survive. */
  async rewriteNote(file: TFile, title: string, spec: Parameters<ClaudeStudio["core"]["run"]>[0]) {
    const notice = new Notice(`${title}…`, 0);
    let out: string;
    const before = await this.readCurrent(file);
    try {
      out = unwrapFence(await this.plugin.core.complete(spec)).trim() + "\n";
    } catch (e) {
      notice.hide();
      return new Notice((e as Error).message);
    }
    notice.hide();
    out = keepFrontmatter(before, out);
    const oldLinks = new Set(findWikiLinks(before).map((l) => l.target));
    const newBroken = brokenLinks(this.app, out, file.path).filter((t) => !oldLinks.has(t));
    const ok = await new DiffModal(this.app, {
      title: `${title} · ${file.basename}`,
      before,
      after: out,
      warning: newBroken.length ? t("diff.newBrokenLinks", { links: newBroken.join(", ") }) : undefined,
    }).open_();
    if (!ok) return;
    if ((await this.readCurrent(file)) !== before) return new Notice(t("notice.noteChanged"));
    await this.applyWholeNote(file, out);
    await this.plugin.history.add({ action: title, file: file.path, model: spec.model ?? "", costUsd: 0, durationMs: 0, status: "applied", prompt: spec.prompt, result: out, before, after: out });
  }

  async readCurrent(file: TFile): Promise<string> {
    const open = this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === file.path);
    return open ? (open.view as MarkdownView).editor.getValue() : this.app.vault.read(file);
  }

  async applyWholeNote(file: TFile, next: string) {
    const leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === file.path);
    const cm = leaf ? ((leaf.view as MarkdownView).editor as unknown as { cm?: EditorView }).cm : undefined;
    if (cm) {
      const cur = cm.state.doc.toString();
      let a = 0;
      while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
      let b = 0;
      while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
      cm.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
    } else {
      await this.app.vault.process(file, () => next);
    }
  }

  private async toNewNote(title: string, spec: Parameters<ClaudeStudio["core"]["run"]>[0], source: TFile | null) {
    const notice = new Notice(`${title}…`, 0);
    try {
      const out = unwrapFence(await this.plugin.core.complete(spec)).trim();
      const heading = out.match(/^#\s+(.+)$/m)?.[1];
      const name = sanitizeFileName(heading ?? `${title} ${clock().format("YYYY-MM-DD HH.mm")}`);
      const file = await this.createNote(name, out, source);
      await this.app.workspace.getLeaf("tab").openFile(file);
      await this.plugin.history.add({ action: title, file: file.path, model: spec.model ?? "", costUsd: 0, durationMs: 0, status: "applied", prompt: spec.prompt, result: out, before: "", after: out });
    } catch (e) {
      new Notice((e as Error).message);
    } finally {
      notice.hide();
    }
  }

  async createNote(name: string, body: string, source: TFile | null, tags: string[] = []): Promise<TFile> {
    const folder = normalizePath(this.plugin.settings.notesFolder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    let path = normalizePath(`${folder}/${name}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${name} ${i}.md`);
    const fm = ["---", `tags:${tags.length ? "\n" + tags.map((t) => `  - ${t}`).join("\n") : " []"}`, `created: ${clock().format("YYYY-MM-DD")}`, "---", ""].join("\n");
    const backlink = source ? `\n\nOrigen: [[${this.app.metadataCache.fileToLinktext(source, path)}]]\n` : "\n";
    return this.app.vault.create(path, fm + body.trim() + backlink);
  }

  private async toProperty(file: TFile, prop: string, title: string, spec: Parameters<ClaudeStudio["core"]["run"]>[0]) {
    const notice = new Notice(`${title}…`, 0);
    try {
      const out = unwrapFence(await this.plugin.core.complete(spec)).trim();
      const before = await this.app.vault.read(file);
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => (fm[prop] = out));
      const after = await this.app.vault.read(file);
      await this.plugin.history.add({ action: title, file: file.path, model: spec.model ?? "", costUsd: 0, durationMs: 0, status: "applied", prompt: spec.prompt, result: out, before, after });
      new Notice(t("notice.savedToProperty", { title, property: prop }));
    } catch (e) {
      new Notice((e as Error).message);
    } finally {
      notice.hide();
    }
  }
}
