import { App, Editor, TFile, getAllTags } from "obsidian";
import type { Core } from "./core";
import type { Library, Profile, Scope } from "./library";
import { fillTemplate, stripFrontmatter, truncate } from "./util";
import { clock } from "./time";

export type ChipKind = "selection" | "cursor" | "note" | "snap" | "hub" | "linked" | "profile";

export interface Chip {
  id: string;
  kind: ChipKind;
  label: string;
  icon: string;
  text: string;
  path?: string;
  on: boolean;
}

export interface Gathered {
  file: TFile | null;
  chips: Chip[];
  profiles: Profile[];
  /** Selection range in the editor at gather time (from === to when nothing is selected). */
  range: { from: number; to: number } | null;
}

const NOTE_LIMIT = 30000;
const SNAP_A = "<!-- snap-a -->";
const SNAP_B = "<!-- snap-b -->";

export function findHub(app: App, file: TFile, hubFolder: string): TFile | null {
  const root = hubFolder.replace(/\/?$/, "/");
  if (file.path.startsWith(root)) return null;
  const links = app.metadataCache.resolvedLinks;
  const asFile = (path: string) => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };
  for (const target of Object.keys(links[file.path] ?? {})) if (target.startsWith(root)) return asFile(target);
  for (const [src, targets] of Object.entries(links)) if (src.startsWith(root) && targets[file.path]) return asFile(src);
  return null;
}

export class ContextBuilder {
  constructor(
    private app: App,
    private core: Core,
    private library: Library,
  ) {}

  async gather(file: TFile | null, editor: Editor | null, scope: Scope | "chat"): Promise<Gathered> {
    const s = this.core.settings;
    const chips: Chip[] = [];
    let range: Gathered["range"] = null;

    if (file && this.core.isExcluded(file)) {
      throw new Error(`"${file.basename}" is on the never-send list.`);
    }

    if (editor) {
      const from = editor.posToOffset(editor.getCursor("from"));
      const to = editor.posToOffset(editor.getCursor("to"));
      range = { from, to };
      const sel = editor.getSelection();
      if (sel.trim()) {
        chips.push({ id: "selection", kind: "selection", label: `Selection · ${sel.length} chars`, icon: "text-cursor-input", text: sel, on: true });
      } else {
        const doc = editor.getValue();
        const half = Math.floor(s.contextChars / 2);
        const before = doc.slice(Math.max(0, from - half), from);
        const after = doc.slice(to, to + half);
        chips.push({
          id: "cursor",
          kind: "cursor",
          label: "Around cursor",
          icon: "text-cursor",
          text: `${before}⟦CURSOR⟧${after}`,
          on: scope !== "note",
        });
      }
    }

    if (file) {
      const raw = editor ? editor.getValue() : await this.app.vault.cachedRead(file);
      chips.push({
        id: "note",
        kind: "note",
        label: file.basename,
        icon: "file-text",
        text: truncate(raw, NOTE_LIMIT),
        path: file.path,
        on: scope === "note" || scope === "chat" || scope === "none",
      });

      const a = raw.indexOf(SNAP_A);
      const b = raw.indexOf(SNAP_B);
      if (a >= 0 && b > a) {
        chips.push({ id: "snap", kind: "snap", label: "Snap range", icon: "bookmark", text: raw.slice(a + SNAP_A.length, b).trim(), on: false });
      }

      const hub = findHub(this.app, file, s.hubFolder);
      if (hub && !this.core.isExcluded(hub)) {
        const text = stripFrontmatter(await this.app.vault.cachedRead(hub));
        // Off for selection edits: background about the whole project pulls short rewrites off target.
        chips.push({ id: "hub", kind: "hub", label: `Hub · ${hub.basename}`, icon: "folder-kanban", text: truncate(text, s.linkedNoteChars * 2), path: hub.path, on: scope !== "selection" });
      }

      const outgoing = Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {})
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile && f.extension === "md" && f.path !== hub?.path && !this.core.isExcluded(f))
        .slice(0, s.linkedNotes);
      for (const f of outgoing) {
        const text = stripFrontmatter(await this.app.vault.cachedRead(f));
        chips.push({ id: `linked:${f.path}`, kind: "linked", label: f.basename, icon: "link", text: truncate(text, s.linkedNoteChars), path: f.path, on: false });
      }
    }

    const profiles = this.library.profilesFor(file);
    for (const p of profiles) chips.push({ id: `profile:${p.path}`, kind: "profile", label: p.name, icon: "user-round-cog", text: p.prompt, path: p.path, on: true });

    return { file, chips, profiles, range };
  }

  /** Note titles the model may link to (excluded and library notes left out). */
  noteIndex(limit = 600): string {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !this.core.isExcluded(f) && !this.library.inLibrary(f))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit)
      .map((f) => f.basename)
      .join("\n");
  }

  tagVocabulary(): string[] {
    const tags = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const c = this.app.metadataCache.getFileCache(f);
      for (const t of (c ? getAllTags(c) : null) ?? []) tags.add(t.replace(/^#/, ""));
    }
    return [...tags].sort();
  }
}

export const BASE_SYSTEM = `You are Claude Studio, a writing assistant embedded in the user's Obsidian editor.
- The user explicitly asked for this output, so producing it follows their decision rather than inventing content on their behalf.
- Reply with ONLY the text that belongs in the note: no preamble, no explanation, no closing remark, no code fence around the whole answer. Never talk about the task, ask questions or announce steps; if you truly cannot do it, return the original text unchanged.
- Write Markdown that Obsidian renders. Keep existing [[wikilinks]], embeds, callouts, tags and frontmatter syntax intact.
- Never invent [[wikilinks]]. Link only to notes listed in <vault_notes> when it is provided; otherwise keep the links that already exist.
- Use the language of the text you are given unless the instruction asks for another one.
- When the request contains <selection>, your reply replaces exactly that text: return only its new version, at a similar scope and length unless asked otherwise. Never answer with other notes' content.
- Anything inside <context> is background for reference only. Do not rewrite, summarize or repeat it unless the instruction asks for it.
- ⟦CURSOR⟧ marks where the user's cursor is. Never output that marker.
- Follow the vault conventions from CLAUDE.md for structure, tags and language.`;

export function systemFor(chips: Chip[], extra?: string): string {
  const profiles = chips.filter((c) => c.kind === "profile" && c.on);
  const parts = [BASE_SYSTEM];
  for (const p of profiles) parts.push(`## Profile for this note: ${p.label}\n${p.text}`);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

export interface PromptInput {
  instruction: string;
  chips: Chip[];
  file: TFile | null;
  input?: string;
  index?: string;
}

/** Fill {{vars}} from the chips; chips the template didn't consume are appended as <context>. */
export function buildPrompt(app: App, p: PromptInput): string {
  const byKind = (k: ChipKind) => p.chips.find((c) => c.kind === k && c.on)?.text;
  const fm = p.file ? app.metadataCache.getFileCache(p.file) : null;
  const sel = byKind("selection");
  const vars: Record<string, string | undefined> = {
    selection: sel === undefined ? undefined : `<selection>\n${sel}\n</selection>`,
    cursor: byKind("cursor"),
    note: byKind("note"),
    snap: byKind("snap"),
    hub: byKind("hub"),
    title: p.file?.basename,
    path: p.file?.path,
    tags: fm ? (getAllTags(fm) ?? []).join(", ") : "",
    today: clock().format("YYYY-MM-DD"),
    input: p.input ?? "",
  };
  const { text, used } = fillTemplate(p.instruction, vars);
  const rest = p.chips.filter((c) => c.on && c.kind !== "profile" && !used.has(c.kind));
  const blocks: string[] = [];
  for (const c of rest) {
    if (c.kind === "note" || c.kind === "hub" || c.kind === "linked")
      blocks.push(`<note role="${c.kind === "note" ? "current" : c.kind}" path="${c.path}">\n${c.text}\n</note>`);
    else blocks.push(`<${c.kind}>\n${c.text}\n</${c.kind}>`);
  }
  if (p.index) blocks.push(`<vault_notes>\n${p.index}\n</vault_notes>`);
  return blocks.length ? `${text}\n\n<context note="background only">\n${blocks.join("\n")}\n</context>` : text;
}
