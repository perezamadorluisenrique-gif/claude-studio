import { App, Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import type ClaudeStudio from "../main";
import type { RunSpec } from "../core";
import type { RunHandle, RunResult } from "../runner";
import { unwrapFence } from "../util";

export interface ResultButton {
  label: string;
  icon?: string;
  cta?: boolean;
  run: (text: string) => void | Promise<void>;
}

/** Streams one run into rendered Markdown, with caller-defined buttons once it finishes. */
export class ResultModal extends Modal {
  private body!: HTMLElement;
  private status!: HTMLElement;
  private buttons!: HTMLElement;
  private text = "";
  private handle: RunHandle | null = null;
  private result: RunResult | null = null;
  private comp = new Component();
  private timer: number | null = null;

  constructor(
    app: App,
    private plugin: ClaudeStudio,
    private opts: { title: string; icon: string; spec: RunSpec; sourcePath: string; actions: ResultButton[]; onDone?: (text: string, r: RunResult | null) => void },
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("cs-modal", "cs-result-modal");
    const head = this.titleEl.createDiv({ cls: "cs-modal-title" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), this.opts.icon);
    head.createSpan({ text: this.opts.title });
    this.status = head.createSpan({ cls: "cs-card-status" });
    this.status.createSpan({ cls: "cs-dots" });
    this.body = this.contentEl.createDiv({ cls: "cs-result-body markdown-rendered" });
    this.body.createDiv({ cls: "cs-shimmer" });
    this.buttons = this.contentEl.createDiv({ cls: "cs-result-btns" });
    this.comp.load();

    this.handle = this.plugin.core.run(this.opts.spec, {
      onDelta: (t) => {
        this.text += t;
        if (this.timer == null) this.timer = window.setTimeout(() => ((this.timer = null), this.render()), 100);
      },
      onResult: (r) => (this.result = r),
      onError: (m) => {
        this.body.empty();
        this.body.createDiv({ cls: "cs-card-error", text: m });
      },
      onClose: () => {
        this.handle = null;
        this.status.empty();
        if (this.result && !this.result.isError) {
          this.text = unwrapFence(this.result.text || this.text).trim();
          this.render();
          this.status.setText(`${(this.result.durationMs / 1000).toFixed(1)}s${this.result.costUsd ? ` · $${this.result.costUsd.toFixed(4)}` : ""}`);
          this.renderButtons();
        } else if (this.result?.isError) {
          this.body.empty();
          this.body.createDiv({ cls: "cs-card-error", text: this.result.text });
        }
        this.opts.onDone?.(this.text, this.result);
      },
    });
  }

  private render() {
    const target = createDiv();
    void MarkdownRenderer.render(this.app, this.text, target, this.opts.sourcePath, this.comp).then(() => {
      this.body.empty();
      this.body.append(...Array.from(target.childNodes));
    });
  }

  private renderButtons() {
    this.buttons.empty();
    const copy = this.buttons.createEl("button", { text: "Copy" });
    copy.onclick = () => {
      void navigator.clipboard.writeText(this.text);
      new Notice("Copied");
    };
    for (const a of this.opts.actions) {
      const b = this.buttons.createEl("button", { text: a.label, cls: a.cta ? "mod-cta" : "" });
      b.onclick = async () => {
        await a.run(this.text);
        this.close();
      };
    }
  }

  onClose() {
    this.handle?.cancel();
    this.comp.unload();
    this.contentEl.empty();
  }
}
