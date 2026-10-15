import { App, Modal, Setting } from "obsidian";

/** A yes/no question in Obsidian's own modal (the native confirm() is blocked on some platforms and unstyled). Resolves false on dismiss. */
export class ConfirmModal extends Modal {
  private resolve!: (ok: boolean) => void;
  private readonly result = new Promise<boolean>((r) => (this.resolve = r));
  private decided = false;

  constructor(
    app: App,
    private opts: { title: string; message: string; confirmLabel: string; danger?: boolean },
  ) {
    super(app);
  }

  /** Opens the modal and waits for the answer. */
  ask(): Promise<boolean> {
    this.open();
    return this.result;
  }

  onOpen() {
    this.modalEl.addClass("cs-modal");
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.opts.confirmLabel).onClick(() => {
          this.decided = true;
          this.resolve(true);
          this.close();
        });
        if (this.opts.danger) b.buttonEl.addClass("mod-warning");
        else b.setCta();
      });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false);
  }
}
