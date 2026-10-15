import { ICON } from "../icon";
import { Component, ItemView, Keymap, MarkdownRenderer, MarkdownView, Menu, Notice, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import * as path from "path";
import type ClaudeStudio from "../main";
import type { Gathered } from "../context";
import type { RunHandle } from "../runner";
import { sanitizeFileName } from "../util";
import { clock } from "../time";

export const CHAT_VIEW = "claude-studio-chat";

interface Msg {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  meta?: string;
  error?: boolean;
}

interface Chat {
  id: string;
  sessionId: string;
  title: string;
  updated: number;
  crossVault: boolean;
  messages: Msg[];
}

const MAX_CHATS = 60;

/** Chat transcripts live in chats.json next to the plugin; the CLI keeps its own session for --resume. */
export class ChatStore {
  chats: Chat[] = [];
  private loaded = false;
  constructor(private plugin: ClaudeStudio) {}
  private get file() {
    return normalizePath(`${this.plugin.manifest.dir}/chats.json`);
  }
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const a = this.plugin.app.vault.adapter;
      if (await a.exists(this.file)) this.chats = JSON.parse(await a.read(this.file)) as typeof this.chats;
    } catch {
      this.chats = [];
    }
  }
  async save() {
    this.chats.sort((a, b) => b.updated - a.updated);
    this.chats = this.chats.slice(0, MAX_CHATS);
    await this.plugin.app.vault.adapter.write(this.file, JSON.stringify(this.chats));
  }
}

const SUGGESTIONS = ["¿Qué tengo pendiente en mis proyectos?", "Resume lo que escribí esta semana", "¿Qué notas hablan de "];

export class ChatView extends ItemView {
  private chat!: Chat;
  private list!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private titleEl!: HTMLElement;
  private scopeBtn!: HTMLButtonElement;
  private noteChip!: HTMLElement;
  private includeNote = true;
  private handle: RunHandle | null = null;
  private comp = new Component();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ClaudeStudio,
  ) {
    super(leaf);
  }

  getViewType() {
    return CHAT_VIEW;
  }
  getDisplayText() {
    return "Claude";
  }
  getIcon() {
    return ICON;
  }

  async onOpen() {
    await this.plugin.chats.load();
    this.comp.load();
    const root = this.contentEl;
    root.empty();
    root.addClass("cs-chat");

    const head = root.createDiv({ cls: "cs-chat-head" });
    this.titleEl = head.createDiv({ cls: "cs-chat-title" });
    this.titleEl.onclick = (e) => this.sessionMenu(e);
    const tools = head.createDiv({ cls: "cs-chat-tools" });
    this.scopeBtn = tools.createEl("button", { cls: "cs-scope" });
    this.scopeBtn.onclick = () => {
      this.chat.crossVault = !this.chat.crossVault;
      this.renderHead();
    };
    const iconBtn = (icon: string, label: string, fn: () => void) => {
      const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    iconBtn("history", "Run history", () => void this.plugin.openHistory());
    iconBtn("square-pen", "New chat", () => this.newChat());

    this.list = root.createDiv({ cls: "cs-chat-list" });
    this.list.addEventListener("click", (e) => this.onLinkClick(e));

    const composer = root.createDiv({ cls: "cs-composer" });
    const chips = composer.createDiv({ cls: "cs-chips" });
    this.noteChip = chips.createEl("button", { cls: "cs-chip is-on" });
    this.noteChip.onclick = () => {
      this.includeNote = !this.includeNote;
      this.renderNoteChip();
    };
    const row = composer.createDiv({ cls: "cs-composer-row" });
    this.input = row.createEl("textarea", { attr: { rows: "1", placeholder: "Ask about your notes…" } });
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.sendBtn = row.createEl("button", { cls: "cs-send", attr: { "aria-label": "Send" } });
    this.sendBtn.onclick = () => (this.handle ? this.handle.cancel() : this.submit());

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.renderNoteChip()));
    const last = this.plugin.chats.chats[0];
    if (last && last.messages.length && Date.now() - last.updated < 6 * 3600_000) this.loadChat(last);
    else this.newChat();
  }

  onClose(): Promise<void> {
    this.handle?.cancel();
    this.comp.unload();
    return Promise.resolve();
  }

  private autosize() {
    this.input.setCssProps({ height: "auto" });
    this.input.setCssProps({ height: Math.min(this.input.scrollHeight, 220) + "px" });
  }

  private siblings() {
    return this.plugin.settings.siblingVaults;
  }

  private renderHead() {
    this.titleEl.empty();
    this.titleEl.createSpan({ text: this.chat.title || "New chat" });
    setIcon(this.titleEl.createSpan({ cls: "cs-chev" }), "chevron-down");
    const n = this.siblings().length;
    this.scopeBtn.empty();
    setIcon(this.scopeBtn.createSpan(), n && this.chat.crossVault ? "library" : "book");
    this.scopeBtn.createSpan({ text: n && this.chat.crossVault ? `${this.plugin.core.vaultName()} + ${n}` : this.plugin.core.vaultName() });
    this.scopeBtn.setAttr("aria-label", n ? "Toggle searching sibling vaults" : "Add sibling vaults in settings");
    this.scopeBtn.toggleClass("is-on", !!n && this.chat.crossVault);
  }

  private currentNote() {
    const f = this.plugin.lastMarkdownFile();
    return f && !this.plugin.core.isExcluded(f) ? f : null;
  }

  private renderNoteChip() {
    const f = this.currentNote();
    this.noteChip.empty();
    this.noteChip.toggle(!!f);
    if (!f) return;
    setIcon(this.noteChip.createSpan({ cls: "cs-chip-icon" }), "file-text");
    this.noteChip.createSpan({ text: f.basename });
    this.noteChip.toggleClass("is-on", this.includeNote);
  }

  private renderSend() {
    this.sendBtn.empty();
    setIcon(this.sendBtn, this.handle ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-running", !!this.handle);
    this.sendBtn.setAttr("aria-label", this.handle ? "Stop" : "Send");
  }

  newChat() {
    this.handle?.cancel();
    this.chat = { id: Date.now().toString(36), sessionId: "", title: "", updated: Date.now(), crossVault: true, messages: [] };
    this.renderAll();
  }

  private loadChat(c: Chat) {
    this.handle?.cancel();
    this.chat = c;
    this.renderAll();
  }

  private renderAll() {
    this.renderHead();
    this.renderNoteChip();
    this.renderSend();
    this.list.empty();
    if (!this.chat.messages.length) return this.renderEmpty();
    for (const m of this.chat.messages) this.renderMsg(m);
    this.list.scrollTop = this.list.scrollHeight;
  }

  private renderEmpty() {
    const e = this.list.createDiv({ cls: "cs-chat-empty" });
    setIcon(e.createDiv({ cls: "cs-chat-logo" }), ICON);
    e.createDiv({ cls: "cs-chat-hello", text: "Ask about your vault" });
    e.createDiv({ cls: "cs-chat-sub", text: "Claude reads your notes (never edits them) and cites what it used." });
    const sug = e.createDiv({ cls: "cs-suggestions" });
    for (const s of SUGGESTIONS) {
      const b = sug.createEl("button", { cls: "cs-suggestion", text: s.endsWith(" ") ? s + "…" : s });
      b.onclick = () => {
        this.input.value = s;
        this.input.focus();
        if (!s.endsWith(" ")) this.submit();
      };
    }
  }

  private sessionMenu(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("New chat").setIcon("square-pen").onClick(() => this.newChat()));
    menu.addSeparator();
    for (const c of this.plugin.chats.chats.slice(0, 20))
      menu.addItem((i) =>
        i
          .setTitle(`${c.title || "Untitled"} · ${clock(c.updated).fromNow()}`)
          .setChecked(c.id === this.chat.id)
          .onClick(() => this.loadChat(c)),
      );
    menu.showAtMouseEvent(e);
  }

  private renderMsg(m: Msg): { body: HTMLElement; toolsEl: HTMLElement; footer: HTMLElement } {
    const wrap = this.list.createDiv({ cls: `cs-msg cs-msg-${m.role}${m.error ? " is-error" : ""}` });
    const body = wrap.createDiv({ cls: "cs-msg-body markdown-rendered" });
    const toolsEl = wrap.createDiv({ cls: "cs-msg-tools" });
    for (const t of m.tools ?? []) toolsEl.createSpan({ cls: "cs-tool", text: t });
    const footer = wrap.createDiv({ cls: "cs-msg-foot" });
    if (m.role === "user") body.setText(m.text);
    else {
      this.renderMarkdown(body, m.text);
      if (m.text && !m.error) this.renderFooter(footer, m);
    }
    return { body, toolsEl, footer };
  }

  private renderMarkdown(el: HTMLElement, text: string) {
    const tmp = createDiv();
    void MarkdownRenderer.render(this.app, text, tmp, this.currentNote()?.path ?? "", this.comp).then(() => {
      el.empty();
      el.append(...Array.from(tmp.childNodes));
    });
  }

  private renderFooter(footer: HTMLElement, m: Msg) {
    footer.empty();
    if (m.meta) footer.createSpan({ cls: "cs-msg-meta", text: m.meta });
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    btn("copy", "Copy", () => {
      void navigator.clipboard.writeText(m.text);
      new Notice("Copied");
    });
    btn("text-cursor-input", "Insert at cursor", () => this.insertAtCursor(m.text));
    btn("file-plus", "Save as note", () => void this.saveAsNote(m.text));
  }

  private insertAtCursor(text: string) {
    const leaf = this.plugin.lastMarkdownLeaf();
    const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
    if (!view) return new Notice("No open note to insert into.");
    view.editor.replaceSelection(text);
    this.app.workspace.setActiveLeaf(leaf!, { focus: true });
  }

  private async saveAsNote(text: string) {
    const name = sanitizeFileName(this.chat.title || `Claude ${clock().format("YYYY-MM-DD HH.mm")}`);
    const file = await this.plugin.actions.createNote(name, text, this.currentNote());
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private onLinkClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
    void this.app.workspace.openLinkText(href, this.currentNote()?.path ?? "", Keymap.isModEvent(e));
  }

  private systemPrompt(): string {
    const sib = this.chat.crossVault ? this.siblings() : [];
    const lines = [
      "You are Claude Studio's vault assistant inside Obsidian. The working directory is the root of the user's vault " +
        `"${this.plugin.core.vaultName()}". Use Read, Grep and Glob to find what the notes actually say before answering. You cannot edit files.`,
      "Cite the notes you used: for this vault as [[Exact note name]] (file name without .md).",
      "Answer in the user's language, concisely, in Markdown. If the notes don't contain the answer, say so instead of guessing.",
    ];
    if (sib.length) {
      lines.push("You may also search these other vaults of the same user (read-only). Cite their notes as [Name ↗](obsidian://open?vault=<vault name URL-encoded>&file=<path inside that vault without .md, URL-encoded>):");
      for (const p of sib) lines.push(`- vault "${path.basename(p)}" at ${p}`);
    }
    return lines.join("\n");
  }

  /** Called by the palette and the API: fill and send. */
  send(text: string, g?: Gathered) {
    if (this.handle) return new Notice("Claude is still answering.");
    this.input.value = text;
    if (g?.chips.some((c) => c.kind === "selection" && c.on)) {
      const sel = g.chips.find((c) => c.kind === "selection")!.text;
      this.input.value = `${text}\n\n> ${sel.split("\n").join("\n> ")}`;
    }
    this.submit();
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text || this.handle) return;
    this.input.value = "";
    this.autosize();
    if (!this.chat.messages.length) this.list.empty();
    const user: Msg = { role: "user", text };
    this.chat.messages.push(user);
    if (!this.chat.title) this.chat.title = text.split("\n")[0].slice(0, 60);
    this.renderMsg(user);
    this.renderHead();

    const note = this.includeNote ? this.currentNote() : null;
    const prompt = note ? `${text}\n\n(The user is looking at the note "${note.path}".)` : text;
    const reply: Msg = { role: "assistant", text: "", tools: [] };
    const ui = this.renderMsg(reply);
    ui.body.createDiv({ cls: "cs-shimmer" });
    this.list.scrollTop = this.list.scrollHeight;

    let timer: number | null = null;
    const t0 = Date.now();
    this.handle = this.plugin.core.run(
      {
        prompt,
        system: this.systemPrompt(),
        model: "chat",
        tools: ["Read", "Grep", "Glob"],
        sessionId: this.chat.sessionId || undefined,
        addDirs: this.chat.crossVault ? this.siblings() : [],
        maxTurns: 30,
        label: "Chat",
      },
      {
        onInit: (id) => (this.chat.sessionId = id),
        onTool: (name, summary) => {
          const label = `${name === "Read" ? "Reading" : name === "Grep" ? "Searching" : name === "Glob" ? "Listing" : name} ${summary}`.trim();
          reply.tools!.push(label);
          ui.toolsEl.createSpan({ cls: "cs-tool", text: label });
        },
        onDelta: (t) => {
          reply.text += t;
          if (timer == null)
            timer = window.setTimeout(() => {
              timer = null;
              this.renderMarkdown(ui.body, reply.text);
              this.stickToBottom();
            }, 120);
        },
        onResult: (r) => {
          if (r.text) reply.text = r.text;
          reply.error = r.isError;
          reply.meta = `${this.plugin.core.model("chat")} · ${((r.durationMs || Date.now() - t0) / 1000).toFixed(1)}s${r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ""}`;
          if (r.sessionId) this.chat.sessionId = r.sessionId;
        },
        onError: (m) => {
          reply.text = reply.text ? `${reply.text}\n\n_${m}_` : m;
          reply.error = !reply.text || m !== "Stopped.";
        },
        onClose: () => {
          if (timer != null) window.clearTimeout(timer);
          this.handle = null;
          this.chat.messages.push(reply);
          this.chat.updated = Date.now();
          ui.body.parentElement?.toggleClass("is-error", !!reply.error);
          this.renderMarkdown(ui.body, reply.text || "_No answer._");
          if (!reply.error) this.renderFooter(ui.footer, reply);
          this.renderSend();
          this.stickToBottom();
          const store = this.plugin.chats;
          if (!store.chats.includes(this.chat)) store.chats.unshift(this.chat);
          void store.save();
        },
      },
    );
    this.renderSend();
  }

  private stickToBottom() {
    const l = this.list;
    if (l.scrollHeight - l.scrollTop - l.clientHeight < 160) l.scrollTop = l.scrollHeight;
  }
}
