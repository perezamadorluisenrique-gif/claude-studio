import { App, Modal, setIcon } from "obsidian";
import { t } from "../i18n";
import { diffLines, type DiffOp } from "../util";

const CONTEXT = 3;

/** Unified line diff with collapsed unchanged runs. Resolves true when the user applies. */
export class DiffModal extends Modal {
  private resolve!: (ok: boolean) => void;
  readonly result = new Promise<boolean>((r) => (this.resolve = r));
  private decided = false;

  constructor(
    app: App,
    private opts: { title: string; before: string; after: string; applyLabel?: string; note?: string; warning?: string },
  ) {
    super(app);
  }

  /** open() and wait for the decision. */
  open_(): Promise<boolean> {
    this.open();
    return this.result;
  }

  onOpen() {
    this.modalEl.addClass("cs-modal", "cs-diff-modal");
    const head = this.titleEl.createDiv({ cls: "cs-modal-title" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), "git-compare");
    head.createSpan({ text: this.opts.title });

    const ops = diffLines(this.opts.before, this.opts.after);
    const added = ops.filter((o) => o.type === "add").length;
    const removed = ops.filter((o) => o.type === "del").length;
    const meta = this.contentEl.createDiv({ cls: "cs-diff-meta" });
    meta.createSpan({ cls: "cs-diff-add", text: `+${added}` });
    meta.createSpan({ cls: "cs-diff-del", text: `−${removed}` });
    if (this.opts.note) meta.createSpan({ cls: "cs-diff-note", text: this.opts.note });
    if (this.opts.warning) {
      const w = this.contentEl.createDiv({ cls: "cs-card-warn" });
      setIcon(w.createSpan({ cls: "cs-warn-icon" }), "triangle-alert");
      w.createSpan({ text: this.opts.warning });
    }

    const box = this.contentEl.createDiv({ cls: "cs-diff" });
    if (!added && !removed) box.createDiv({ cls: "cs-diff-empty", text: t("diff.noChanges") });
    else this.renderOps(box, ops);

    const btns = this.contentEl.createDiv({ cls: "cs-result-btns" });
    btns.createEl("button", { text: t("common.cancel") }).onclick = () => this.finish(false);
    const apply = btns.createEl("button", { cls: "mod-cta", text: this.opts.applyLabel ?? t("common.apply") });
    apply.disabled = !added && !removed;
    apply.onclick = () => this.finish(true);
  }

  private renderOps(box: HTMLElement, ops: DiffOp[]) {
    const changed = ops.map((o) => o.type !== "same");
    const near = (i: number) => {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) if (changed[k]) return true;
      return false;
    };
    let hidden = 0;
    const flush = () => {
      if (hidden) box.createDiv({ cls: "cs-diff-gap", text: hidden === 1 ? t("diff.unchanged.one") : t("diff.unchanged.other", { count: hidden }) });
      hidden = 0;
    };
    ops.forEach((o, i) => {
      if (o.type === "same" && !near(i)) {
        hidden++;
        return;
      }
      flush();
      const row = box.createDiv({ cls: `cs-diff-line cs-diff-${o.type}` });
      row.createSpan({ cls: "cs-diff-sign", text: o.type === "add" ? "+" : o.type === "del" ? "−" : " " });
      row.createSpan({ cls: "cs-diff-text", text: o.text || " " });
    });
    flush();
  }

  private finish(ok: boolean) {
    this.decided = true;
    this.resolve(ok);
    this.close();
  }

  onClose() {
    if (!this.decided) this.resolve(false);
    this.contentEl.empty();
  }
}
