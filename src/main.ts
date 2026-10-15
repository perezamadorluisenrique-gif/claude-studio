import { ICON, registerIcon } from "./icon";
import { MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { Core } from "./core";
import { ContextBuilder, type Gathered } from "./context";
import { Library } from "./library";
import { HistoryStore } from "./history";
import { ActionRunner } from "./actions";
import { detectClaude, claudeVersion } from "./runner";
import { DEFAULT_SETTINGS, StudioSettingTab, type StudioSettings } from "./settings";
import { closeAllCards, inlineExtension } from "./editor/inline";
import { ghostExtension, suggestContinuation } from "./editor/ghost";
import { bubbleExtension } from "./editor/bubble";
import { Palette } from "./ui/palette";
import { CHAT_VIEW, ChatStore, ChatView } from "./ui/chat";
import { HISTORY_VIEW, HistoryView } from "./ui/history";
import { USAGE_VIEW, UsageView } from "./ui/usage";
import { UsageStore } from "./usage";
import { usageLevel } from "./util";
import { carryOverTasks, checklistToHub, createBase, extractToNote, projectStatus, suggestTags, weeklyRecap } from "./features";
import { StudioApi, registerUri, watchClippings } from "./integrations";
import { installStarter } from "./starter";

export default class ClaudeStudio extends Plugin {
  settings!: StudioSettings;
  core!: Core;
  library!: Library;
  ctx!: ContextBuilder;
  history!: HistoryStore;
  usage!: UsageStore;
  chats!: ChatStore;
  actions!: ActionRunner;
  api!: StudioApi;
  private lastLeaf: WorkspaceLeaf | null = null;
  private actionCommandIds: string[] = [];

  async onload() {
    registerIcon();
    await this.loadSettings();
    this.core = new Core(this.app, () => this.settings);
    this.library = new Library(this.app, () => this.settings.libraryFolder);
    this.ctx = new ContextBuilder(this.app, this.core, this.library);
    this.history = new HistoryStore(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
    this.usage = new UsageStore(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`, this.core);
    void this.usage.load();
    this.chats = new ChatStore(this);
    this.actions = new ActionRunner(this);
    this.api = new StudioApi(this);

    this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
    this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this));
    this.registerView(USAGE_VIEW, (leaf) => new UsageView(leaf, this));
    this.registerEditorExtension([inlineExtension(), ghostExtension(), bubbleExtension(this)]);
    this.addSettingTab(new StudioSettingTab(this.app, this));
    this.addRibbonIcon(ICON, "Claude Studio chat", () => this.openChat());
    this.setupStatusBar();
    this.registerCommands();
    this.registerEditorMenu();
    registerUri(this);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) this.lastLeaf = leaf;
      }),
    );
    const touchLibrary = (f: TAbstractFile | string) => this.library.inLibrary(f) && this.library.reload();
    this.registerEvent(this.app.metadataCache.on("changed", (f) => touchLibrary(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => touchLibrary(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => (touchLibrary(f), touchLibrary(old))));
    this.registerEvent(this.library.on("changed", () => this.registerActionCommands()));

    if (!this.settings.claudePath) void detectClaude().then((p) => p && (this.core.detectedPath = p));

    this.app.workspace.onLayoutReady(async () => {
      const lib = normalizePath(this.settings.libraryFolder);
      if (!this.settings.starterInstalled && !this.app.vault.getAbstractFileByPath(lib)) {
        const r = await installStarter(this.app, lib);
        new Notice(`Claude Studio: added ${r.created.length} editable actions and profiles in ${lib}/`);
      }
      if (!this.settings.starterInstalled) {
        this.settings.starterInstalled = true;
        await this.saveSettings();
      }
      await this.library.load();
      watchClippings(this);
    });
  }

  onunload() {
    closeAllCards();
    this.core?.stopAll();
  }

  /* ---------------------------------------------------------------- */

  claudePath() {
    return this.core.claudePath();
  }

  vaultPath() {
    return this.core.vaultPath();
  }

  lastMarkdownLeaf(): WorkspaceLeaf | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active.leaf;
    if (this.lastLeaf && (this.lastLeaf.view as MarkdownView)?.file) return this.lastLeaf;
    return this.app.workspace.getLeavesOfType("markdown")[0] ?? null;
  }

  lastMarkdownFile(): TFile | null {
    const v = this.lastMarkdownLeaf()?.view;
    return v instanceof MarkdownView ? v.file : null;
  }

  async openChat(prompt?: string, g?: Gathered) {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: CHAT_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as ChatView;
    if (prompt) window.setTimeout(() => view.send(prompt, g), 50);
  }

  async openHistory() {
    await this.openSide(HISTORY_VIEW);
  }

  async openUsage() {
    await this.openSide(USAGE_VIEW);
  }

  private async openSide(type: string) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  /* ---------------------------------------------------------------- */

  private setupStatusBar() {
    const el = this.addStatusBarItem();
    el.addClass("cs-status");
    const render = (running: string[]) => {
      el.empty();
      el.toggleClass("is-running", running.length > 0);
      setIcon(el.createSpan({ cls: "cs-status-icon" }), ICON);
      if (running.length) {
        el.createSpan({ text: running.length > 1 ? `${running.length} running` : running[0] });
        el.setAttr("aria-label", "Click to stop");
      } else el.setAttr("aria-label", "Claude Studio");
    };
    el.onclick = () => (this.core.running().length ? this.core.stopAll() : new Palette(this.app, this).open());
    this.register(this.core.onChange(render));
    render([]);

    // Session usage at a glance; the full view is one click away.
    const u = this.addStatusBarItem();
    u.addClass("cs-status", "cs-status-usage");
    u.onclick = () => void this.openUsage();
    const renderUsage = () => {
      const w = this.usage.last?.windows.five_hour;
      const stale = w && w.resetsAt * 1000 < Date.now();
      u.empty();
      setIcon(u.createSpan({ cls: "cs-status-icon" }), "gauge");
      u.removeClass("is-high", "is-full");
      if (w && !stale) {
        u.createSpan({ text: `${Math.round(w.utilization * 100)}%` });
        const lvl = usageLevel(w.utilization);
        if (lvl !== "ok") u.addClass(`is-${lvl}`);
        u.setAttr("aria-label", "Claude session usage (5-hour window) · click for details");
      } else u.setAttr("aria-label", "Claude usage limits");
    };
    this.registerEvent(this.usage.on("changed", renderUsage));
    this.registerInterval(window.setInterval(renderUsage, 60_000));
    renderUsage();
  }

  private registerCommands() {
    this.addCommand({ id: "open-palette", name: "Open AI palette", icon: ICON, callback: () => new Palette(this.app, this).open() });
    this.addCommand({ id: "open-chat", name: "Open chat", icon: "message-circle", callback: () => this.openChat() });
    this.addCommand({ id: "open-history", name: "Open run history", icon: "history", callback: () => this.openHistory() });
    this.addCommand({ id: "open-usage", name: "Show usage limits", icon: "gauge", callback: () => this.openUsage() });
    this.addCommand({ id: "continue-writing", name: "Continue writing (ghost text, Tab to accept)", icon: "pen-line", editorCallback: () => void suggestContinuation(this) });
    this.addCommand({
      id: "ask-selection",
      name: "Ask in chat about the selection",
      icon: "message-circle-question",
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (!sel.trim()) return new Notice("Select some text first.");
        void this.openChat(`Explícame este fragmento en el contexto de mis notas:\n\n> ${sel.split("\n").join("\n> ")}`);
      },
    });
    this.addCommand({
      id: "suggest-tags",
      name: "Suggest tags and categories",
      icon: "tags",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) void suggestTags(this, f);
        return true;
      },
    });
    this.addCommand({ id: "extract-to-note", name: "Extract selection to a new note", icon: "file-output", editorCallback: () => void extractToNote(this) });
    this.addCommand({ id: "daily-recap", name: "Recap today", icon: "calendar", callback: () => void weeklyRecap(this, 1) });
    this.addCommand({ id: "weekly-recap", name: "Recap the last 7 days", icon: "calendar-range", callback: () => void weeklyRecap(this, 7) });
    this.addCommand({ id: "carry-over-tasks", name: "Carry open tasks into today's note", icon: "list-checks", callback: () => void carryOverTasks(this) });
    this.addCommand({ id: "create-base", name: "Create a Base from a description", icon: "table", callback: () => createBase(this) });
    this.addCommand({ id: "checklist-to-hub", name: "Send tasks to the project hub", icon: "folder-kanban", editorCallback: () => void checklistToHub(this) });
    this.addCommand({ id: "project-status", name: "Project status from hub and related notes", icon: "activity", callback: () => void projectStatus(this) });
    this.addCommand({ id: "stop", name: "Stop running requests", icon: "square", callback: () => this.core.stopAll() });
    this.addCommand({
      id: "install-starter",
      name: "Install starter actions and profiles (missing files only)",
      icon: "download",
      callback: async () => {
        const r = await installStarter(this.app, normalizePath(this.settings.libraryFolder));
        new Notice(`Claude Studio: ${r.created.length} created, ${r.skipped.length} already there`);
        await this.library.load();
      },
    });
    this.addCommand({
      id: "test-connection",
      name: "Test the Claude Code connection",
      icon: "plug",
      callback: async () => {
        try {
          new Notice(`Claude Studio: ${await claudeVersion(this.claudePath())} at ${this.claudePath()}`);
        } catch (e) {
          new Notice(`Claude Studio: CLI not reachable (${(e as Error).message})`);
        }
      },
    });
  }

  /** One command per library action, so each can get its own hotkey. */
  private registerActionCommands() {
    const commands = (this.app as unknown as { commands?: { removeCommand?: (id: string) => void } }).commands;
    for (const id of this.actionCommandIds) commands?.removeCommand?.(`${this.manifest.id}:${id}`);
    this.actionCommandIds = [];
    for (const a of this.library.actions) {
      const id = `action-${a.id}`;
      this.addCommand({ id, name: `${a.group}: ${a.name}`, icon: a.icon, callback: () => void this.actions.run(a) });
      this.actionCommandIds.push(id);
    }
  }

  private registerEditorMenu() {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor) => {
        const hasSel = !!editor.getSelection().trim();
        menu.addItem((item) => {
          item.setTitle("Claude Studio").setIcon(ICON).setSection("action");
          const sub = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
          sub.addItem((i) => i.setTitle("Ask Claude…").setIcon(ICON).onClick(() => new Palette(this.app, this).open()));
          if (hasSel) {
            for (const a of this.library.actions.filter((x) => x.scope === "selection"))
              sub.addItem((i) => i.setTitle(a.name).setIcon(a.icon).onClick(() => void this.actions.run(a)));
            sub.addSeparator();
            sub.addItem((i) => i.setTitle("Extract to new note").setIcon("file-output").onClick(() => void extractToNote(this)));
          } else {
            sub.addItem((i) => i.setTitle("Continue writing").setIcon("pen-line").onClick(() => void suggestContinuation(this)));
          }
          sub.addItem((i) => i.setTitle("Suggest tags").setIcon("tags").onClick(() => {
            const f = this.app.workspace.getActiveFile();
            if (f) void suggestTags(this, f);
          }));
        });
      }),
    );
  }

  /* ---------------------------------------------------------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<StudioSettings> | null);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
