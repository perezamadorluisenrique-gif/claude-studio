import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeStudio from "../main";
import type { HistoryEntry } from "../history";
import { DiffModal } from "./diff";
import { clock } from "../time";

export const HISTORY_VIEW = "claude-studio-history";

const STATUS_ICON: Record<string, string> = {
  accepted: "check",
  applied: "check-check",
  discarded: "x",
  shown: "eye",
  error: "triangle-alert",
  reverted: "undo-2",
};

export class HistoryView extends ItemView {
  private listEl!: HTMLElement;
  private totalEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ClaudeStudio,
  ) {
    super(leaf);
  }

  getViewType() {
    return HISTORY_VIEW;
  }
  getDisplayText() {
    return "Claude history";
  }
  getIcon() {
    return "history";
  }

  async onOpen() {
    await this.plugin.history.load();
    const root = this.contentEl;
    root.empty();
    root.addClass("cs-history");
    const head = root.createDiv({ cls: "cs-chat-head" });
    head.createDiv({ cls: "cs-chat-title", text: "Run history" });
    this.totalEl = head.createDiv({ cls: "cs-history-total" });
    const clear = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Clear history" } });
    setIcon(clear, "trash-2");
    clear.onclick = async () => {
      if (!confirm("Clear the whole Claude Studio run history? Snapshots used for revert are deleted too.")) return;
      await this.plugin.history.clear();
    };
    this.listEl = root.createDiv({ cls: "cs-history-list" });
    this.registerEvent(this.plugin.history.on("changed", () => this.render()));
    this.render();
  }

  private render() {
    const entries = this.plugin.history.entries;
    this.listEl.empty();
    const month = entries.filter((e) => clock(e.time).isSame(clock(), "month")).reduce((s, e) => s + (e.costUsd || 0), 0);
    this.totalEl.setText(month ? `$${month.toFixed(3)} this month` : "");
    if (!entries.length) {
      this.listEl.createDiv({ cls: "cs-empty", text: "Every Claude Studio run will be listed here." });
      return;
    }
    let day = "";
    for (const e of entries) {
      const d = clock(e.time).calendar(null, { sameDay: "[Today]", lastDay: "[Yesterday]", lastWeek: "dddd", sameElse: "LL" });
      if (d !== day) {
        this.listEl.createDiv({ cls: "cs-group", text: d });
        day = d;
      }
      this.renderEntry(e);
    }
  }

  private renderEntry(e: HistoryEntry) {
    const row = this.listEl.createDiv({ cls: `cs-hrow is-${e.status}` });
    const top = row.createDiv({ cls: "cs-hrow-top" });
    setIcon(top.createSpan({ cls: "cs-hrow-status", attr: { "aria-label": e.status } }), STATUS_ICON[e.status] ?? "dot");
    top.createSpan({ cls: "cs-hrow-action", text: e.action });
    if (e.file) {
      const f = top.createEl("a", { cls: "cs-hrow-file", text: e.file.split("/").pop()!.replace(/\.md$/, "") });
      f.onclick = (ev) => {
        ev.stopPropagation();
        void this.app.workspace.openLinkText(e.file!, "", false);
      };
    }
    top.createSpan({ cls: "cs-hrow-time", text: clock(e.time).format("HH:mm") });

    const detail = row.createDiv({ cls: "cs-hrow-detail" });
    detail.hide();
    row.onclick = () => {
      if (detail.isShown()) return detail.hide();
      detail.empty();
      detail.show();
      detail.createDiv({ cls: "cs-hrow-meta", text: [e.model, e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : "", e.costUsd ? `$${e.costUsd.toFixed(4)}` : ""].filter(Boolean).join(" · ") });
      detail.createEl("pre", { cls: "cs-hrow-result", text: e.result.slice(0, 1500) || "(empty)" });
      const btns = detail.createDiv({ cls: "cs-result-btns" });
      btns.createEl("button", { text: "Copy result" }).onclick = (ev) => {
        ev.stopPropagation();
        void navigator.clipboard.writeText(e.result);
        new Notice("Copied");
      };
      if (e.before !== undefined && e.after !== undefined && e.file && e.status !== "reverted") {
        const rv = btns.createEl("button", { cls: "mod-warning", text: "Revert" });
        rv.onclick = (ev) => {
          ev.stopPropagation();
          void this.revert(e);
        };
      }
    };
  }

  private async revert(e: HistoryEntry) {
    const file = this.app.vault.getAbstractFileByPath(e.file!);
    if (!(file instanceof TFile)) return new Notice("That note no longer exists.");
    const current = await this.plugin.actions.readCurrent(file);
    const changedSince = current !== e.after;
    // A new note revert means deleting it; ask explicitly.
    if (e.before === "") {
      if (!confirm(`Delete "${file.basename}", the note this run created?`)) return;
      await this.app.fileManager.trashFile(file);
      await this.plugin.history.update(e.id, { status: "reverted" });
      return;
    }
    const ok = await new DiffModal(this.app, {
      title: `Revert · ${file.basename}`,
      before: current,
      after: e.before!,
      applyLabel: "Revert",
      warning: changedSince ? "The note changed after this run. Reverting restores the whole note as it was before the run, discarding those later edits too." : undefined,
    }).open_();
    if (!ok) return;
    await this.plugin.actions.applyWholeNote(file, e.before!);
    await this.plugin.history.update(e.id, { status: "reverted" });
    new Notice(`Reverted ${file.basename}`);
  }
}
