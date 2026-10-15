import { ICON } from "../icon";
import { App, Modal, prepareFuzzySearch, setIcon } from "obsidian";
import type ClaudeStudio from "../main";
import type { Action } from "../library";
import type { Gathered } from "../context";
import { freeAction } from "../actions";

type Row =
  | { kind: "free"; label: string; icon: string; hint: string }
  | { kind: "vault"; label: string; icon: string; hint: string }
  | { kind: "recent"; label: string; icon: string; hint: string }
  | { kind: "action"; action: Action; label: string; icon: string; hint: string };

/** Spotlight-style entry point: type a prompt or pick an action, with the context shown as chips. */
export class Palette extends Modal {
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private chipsEl!: HTMLElement;
  private rows: Row[] = [];
  private sel = 0;
  private g: Gathered | null = null;
  private hasSelection = false;

  constructor(
    app: App,
    private plugin: ClaudeStudio,
    private initial = "",
  ) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass("cs-modal", "cs-palette");
    this.containerEl.addClass("cs-palette-container");
    const top = this.contentEl.createDiv({ cls: "cs-palette-top" });
    setIcon(top.createSpan({ cls: "cs-palette-logo" }), ICON);
    this.input = top.createEl("input", { type: "text", placeholder: "Ask Claude, or pick an action…", value: this.initial });
    this.input.addEventListener("input", () => {
      this.sel = 0;
      this.renderRows();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.chipsEl = this.contentEl.createDiv({ cls: "cs-chips" });
    this.list = this.contentEl.createDiv({ cls: "cs-palette-list" });
    const foot = this.contentEl.createDiv({ cls: "cs-palette-foot" });
    for (const [k, t] of [["↵", "run"], ["↑↓", "move"], ["Tab", "ask the vault"], ["esc", "close"]]) {
      const h = foot.createSpan({ cls: "cs-hint" });
      h.createSpan({ cls: "cs-kbd", text: k });
      h.appendText(t);
    }
    foot.createSpan({ cls: "cs-palette-model", text: `${this.plugin.settings.fastModel} · ${this.plugin.settings.writeModel}` });
    this.input.focus();

    const note = this.plugin.actions.active();
    this.hasSelection = !!note?.editor.getSelection().trim();
    try {
      this.g = await this.plugin.ctx.gather(note?.file ?? this.app.workspace.getActiveFile(), note?.editor ?? null, this.hasSelection ? "selection" : "cursor");
    } catch (e) {
      this.chipsEl.createSpan({ cls: "cs-chip is-error", text: (e as Error).message });
    }
    this.renderChips();
    this.renderRows();
  }

  private renderChips() {
    this.chipsEl.empty();
    if (!this.g) return;
    this.chipsEl.createSpan({ cls: "cs-chips-label", text: "Context" });
    for (const c of this.g.chips) {
      const chip = this.chipsEl.createEl("button", { cls: `cs-chip cs-chip-${c.kind}${c.on ? " is-on" : ""}`, attr: { "aria-label": c.path ?? c.label } });
      setIcon(chip.createSpan({ cls: "cs-chip-icon" }), c.icon);
      chip.createSpan({ text: c.label });
      chip.onclick = () => {
        c.on = !c.on;
        this.renderChips();
        this.input.focus();
      };
    }
  }

  private applicable(a: Action): boolean {
    if (a.scope === "selection") return this.hasSelection;
    if (a.output === "replace" || a.output === "below") return !!this.plugin.actions.active();
    return true;
  }

  private buildRows(): Row[] {
    const q = this.input.value.trim();
    const actions = this.plugin.library.actions.filter((a) => this.applicable(a));
    const rows: Row[] = [];
    if (!q) {
      for (const r of this.plugin.settings.recentPrompts.slice(0, 4)) rows.push({ kind: "recent", label: r, icon: "history", hint: "Recent" });
      for (const a of actions) rows.push({ kind: "action", action: a, label: a.name, icon: a.icon, hint: a.group });
      return rows;
    }
    rows.push({ kind: "free", label: q, icon: ICON, hint: this.hasSelection ? "Edit selection" : "Write at cursor" });
    rows.push({ kind: "vault", label: q, icon: "message-circle-question", hint: "Ask the vault" });
    const fuzzy = prepareFuzzySearch(q);
    const matched = actions
      .map((a) => ({ a, m: fuzzy(a.name) }))
      .filter((x) => x.m)
      .sort((x, y) => y.m!.score - x.m!.score)
      .map((x) => x.a);
    for (const a of matched) rows.push({ kind: "action", action: a, label: a.name, icon: a.icon, hint: a.group });
    for (const a of actions)
      if (!matched.includes(a) && a.prompt.includes("{{input}}")) rows.push({ kind: "action", action: a, label: a.name, icon: a.icon, hint: "With your text" });
    return rows;
  }

  private renderRows() {
    this.rows = this.buildRows();
    this.list.empty();
    let lastHint = "";
    this.rows.forEach((r, i) => {
      if (r.kind === "action" && r.hint !== lastHint) {
        this.list.createDiv({ cls: "cs-group", text: r.hint });
        lastHint = r.hint;
      }
      const el = this.list.createDiv({ cls: `cs-row cs-row-${r.kind}${i === this.sel ? " is-selected" : ""}` });
      setIcon(el.createSpan({ cls: "cs-row-icon" }), r.icon);
      const label = el.createSpan({ cls: "cs-row-label" });
      if (r.kind === "free") label.appendText("Ask Claude: ");
      if (r.kind === "vault") label.appendText("Ask the vault: ");
      label.createSpan({ cls: r.kind === "action" ? "" : "cs-row-query", text: r.label });
      if (r.kind !== "action") el.createSpan({ cls: "cs-row-hint", text: r.hint });
      el.onmouseenter = () => this.select(i);
      el.onclick = () => this.exec(r);
    });
    if (!this.rows.length) this.list.createDiv({ cls: "cs-empty", text: "Type to ask Claude anything." });
  }

  private select(i: number) {
    this.sel = i;
    this.list.querySelectorAll(".cs-row").forEach((el, k) => el.toggleClass("is-selected", k === i));
    (this.list.querySelectorAll(".cs-row")[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.rows.length;
      if (n) this.select((this.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const r = this.rows[this.sel];
      if (r) this.exec(r);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const q = this.input.value.trim();
      if (q) this.exec({ kind: "vault", label: q, icon: "", hint: "" });
    }
  }

  private async remember(q: string) {
    const s = this.plugin.settings;
    s.recentPrompts = [q, ...s.recentPrompts.filter((x) => x !== q)].slice(0, 8);
    await this.plugin.saveSettings();
  }

  private exec(r: Row) {
    const q = this.input.value.trim();
    const g = this.g ?? undefined;
    this.close();
    if (r.kind === "free" || r.kind === "recent") {
      const text = r.kind === "recent" ? r.label : q;
      void this.remember(text);
      void this.plugin.actions.run(freeAction(text, this.hasSelection), { input: text, gathered: g });
    } else if (r.kind === "vault") {
      void this.remember(q);
      void this.plugin.openChat(q, g);
    } else {
      void this.plugin.actions.run(r.action, { input: q, gathered: g });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
