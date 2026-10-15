import { App, Component, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import { t } from "../i18n";
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import type ClaudeStudio from "../main";
import type { RunHandle, RunResult } from "../runner";
import { findWikiLinks, unlink, unwrapFence } from "../util";

/* ------------------------------------------------------------------ */
/* Link checking                                                       */
/* ------------------------------------------------------------------ */

export function brokenLinks(app: App, md: string, sourcePath: string): string[] {
  const out = new Set<string>();
  for (const l of findWikiLinks(md)) {
    if (!l.target) continue;
    if (!app.metadataCache.getFirstLinkpathDest(l.target, sourcePath)) out.add(l.target);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* CodeMirror state                                                     */
/* ------------------------------------------------------------------ */

interface CardPos {
  id: number;
  from: number;
  to: number;
}

const openCard = StateEffect.define<CardPos>();
const closeCard = StateEffect.define<number>();

const sessions = new Map<number, InlineSession>();
let nextId = 1;

class CardWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: CardWidget) {
    return other.id === this.id;
  }
  toDOM() {
    return sessions.get(this.id)?.el ?? createDiv();
  }
  ignoreEvent() {
    return true;
  }
}

const cardField = StateField.define<{ pos: CardPos | null; deco: DecorationSet }>({
  create: () => ({ pos: null, deco: Decoration.none }),
  update(value, tr) {
    let pos = value.pos;
    if (pos && tr.docChanged) pos = { ...pos, from: tr.changes.mapPos(pos.from, 1), to: tr.changes.mapPos(pos.to, -1) };
    if (pos && pos.to < pos.from) pos = { ...pos, to: pos.from };
    for (const e of tr.effects) {
      if (e.is(openCard)) pos = e.value;
      if (e.is(closeCard) && pos?.id === e.value) pos = null;
    }
    if (pos === value.pos && !tr.docChanged) return value;
    return { pos, deco: pos ? build(tr.state, pos) : Decoration.none };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

function build(state: EditorState, pos: CardPos): DecorationSet {
  const line = state.doc.lineAt(Math.min(pos.to, state.doc.length));
  const ranges = [Decoration.widget({ widget: new CardWidget(pos.id), block: true, side: 1 }).range(line.to)];
  if (pos.to > pos.from) ranges.unshift(Decoration.mark({ class: "cs-target" }).range(pos.from, pos.to));
  return Decoration.set(ranges, true);
}

function currentPos(view: EditorView, id: number): CardPos | null {
  const p = view.state.field(cardField, false)?.pos;
  return p && p.id === id ? p : null;
}

export function inlineExtension(): Extension {
  return [
    cardField,
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            const p = view.state.field(cardField, false)?.pos;
            const s = p && sessions.get(p.id);
            if (!s) return false;
            s.discard();
            return true;
          },
        },
      ]),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* Session: one card, one or more runs                                  */
/* ------------------------------------------------------------------ */

export interface InlineRequest {
  title: string;
  icon: string;
  prompt: string;
  system: string;
  model: string;
  tools: string[];
  /** What Enter does once the answer is ready. */
  mode: "replace" | "below";
  file: TFile | null;
  chipsLabel: string;
}

export class InlineSession {
  readonly id = nextId++;
  readonly el: HTMLElement;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private warn!: HTMLElement;
  private input!: HTMLInputElement;
  private primary!: HTMLButtonElement;
  private secondary!: HTMLButtonElement;
  private text = "";
  private handle: RunHandle | null = null;
  private result: RunResult | null = null;
  private renderer: Component | null = null;
  private renderTimer: number | null = null;
  private turns: { prompt: string; answer: string }[] = [];
  private closed = false;
  private hasRange: boolean;

  constructor(
    private plugin: ClaudeStudio,
    private view: EditorView,
    private req: InlineRequest,
    range: { from: number; to: number },
  ) {
    this.hasRange = range.to > range.from;
    this.el = this.buildDom();
    // One card per editor: replace any card already open there.
    const prev = view.state.field(cardField, false)?.pos;
    if (prev) sessions.get(prev.id)?.discard();
    sessions.set(this.id, this);
    view.dispatch({ effects: openCard.of({ id: this.id, from: range.from, to: range.to }) });
    window.setTimeout(() => this.input.focus(), 30);
    this.start(req.prompt);
  }

  private buildDom(): HTMLElement {
    const el = createDiv({ cls: "cs-card" });
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    const head = el.createDiv({ cls: "cs-card-head" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), this.req.icon);
    head.createSpan({ cls: "cs-card-title", text: this.req.title });
    if (this.req.chipsLabel) head.createSpan({ cls: "cs-card-ctx", text: this.req.chipsLabel });
    this.status = head.createSpan({ cls: "cs-card-status" });

    this.body = el.createDiv({ cls: "cs-card-body markdown-rendered" });
    this.warn = el.createDiv({ cls: "cs-card-warn" });
    this.warn.hide();

    const foot = el.createDiv({ cls: "cs-card-foot" });
    const ask = foot.createDiv({ cls: "cs-card-ask" });
    setIcon(ask.createSpan({ cls: "cs-card-ask-icon" }), "corner-down-right");
    this.input = ask.createEl("input", { type: "text", placeholder: t("inline.placeholder") });
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    const btns = foot.createDiv({ cls: "cs-card-btns" });
    const primaryLabel = this.req.mode === "replace" && this.hasRange ? t("inline.replace") : t("inline.insert");
    this.primary = btns.createEl("button", { cls: "mod-cta", text: primaryLabel });
    this.primary.createSpan({ cls: "cs-kbd", text: "↵" });
    this.primary.onclick = () => this.accept(this.req.mode);
    if (this.hasRange) {
      const other = this.req.mode === "replace" ? "below" : "replace";
      this.secondary = btns.createEl("button", { text: other === "below" ? t("inline.insertBelow") : t("inline.replace") });
      this.secondary.createSpan({ cls: "cs-kbd", text: "⇧↵" });
      this.secondary.onclick = () => this.accept(other);
    }
    const iconBtn = (icon: string, label: string, fn: () => void) => {
      const b = btns.createEl("button", { cls: "clickable-icon cs-icon-btn", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.onclick = fn;
      return b;
    };
    iconBtn("copy", t("common.copy"), () => {
      void navigator.clipboard.writeText(this.finalText());
      new Notice(t("common.copied"));
    });
    iconBtn("rotate-ccw", t("inline.retry"), () => this.retry());
    iconBtn("x", t("inline.discard"), () => this.discard());
    return el;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.discard();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (this.handle) return;
      const v = this.input.value.trim();
      if (v) {
        this.input.value = "";
        this.refine(v);
      } else if (e.shiftKey && this.hasRange) void this.accept(this.req.mode === "replace" ? "below" : "replace");
      else void this.accept(this.req.mode);
    } else if (e.key.toLowerCase() === "r" && e.altKey) {
      e.preventDefault();
      this.retry();
    }
  }

  private setBusy(busy: boolean) {
    this.el.toggleClass("is-busy", busy);
    this.primary.disabled = busy;
    if (this.secondary) this.secondary.disabled = busy;
    this.status.empty();
    if (busy) {
      this.status.createSpan({ cls: "cs-dots" });
      const stop = this.status.createEl("button", { cls: "cs-link-btn", text: t("inline.stop") });
      stop.onclick = () => this.handle?.cancel();
    } else if (this.result) {
      const r = this.result;
      this.status.setText(`${(r.durationMs / 1000).toFixed(1)}s${r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}`);
    }
  }

  private lastPrompt = "";

  private start(prompt: string) {
    this.lastPrompt = prompt;
    this.text = "";
    this.result = null;
    this.body.empty();
    this.body.createDiv({ cls: "cs-shimmer" });
    this.warn.hide();
    this.setBusy(true);
    const t0 = Date.now();
    this.handle = this.plugin.core.run(
      {
        prompt,
        system: this.req.system,
        model: this.req.model,
        tools: this.req.tools,
        persist: false,
        label: this.req.title,
      },
      {
        onDelta: (t) => {
          this.text += t;
          this.scheduleRender();
        },
        onResult: (r) => (this.result = r),
        onError: (m) => {
          if (this.closed) return;
          this.body.empty();
          this.body.createDiv({ cls: "cs-card-error", text: m });
        },
        onClose: () => {
          this.handle = null;
          if (this.closed) return;
          if (this.result && !this.result.isError) {
            this.text = unwrapFence(this.result.text || this.text).trim();
            this.turns.push({ prompt, answer: this.text });
            this.render();
            this.checkLinks();
          } else if (this.result?.isError) {
            this.body.empty();
            this.body.createDiv({ cls: "cs-card-error", text: this.result.text || t("error.claudeError") });
          }
          this.setBusy(false);
          if (!this.result) this.status.setText(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
          this.input.focus();
        },
      },
    );
  }

  private scheduleRender() {
    if (this.renderTimer != null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 90);
  }

  private render() {
    if (this.closed) return;
    this.renderer?.unload();
    this.renderer = new Component();
    this.renderer.load();
    const target = createDiv();
    void MarkdownRenderer.render(this.plugin.app, this.text, target, this.req.file?.path ?? "", this.renderer).then(() => {
      if (this.closed) return;
      this.body.empty();
      this.body.append(...Array.from(target.childNodes));
      if (this.handle) this.body.createSpan({ cls: "cs-caret" });
      this.markBroken();
    });
  }

  private broken: string[] = [];

  private checkLinks() {
    this.broken = brokenLinks(this.plugin.app, this.text, this.req.file?.path ?? "");
    this.warn.empty();
    if (!this.broken.length) return this.warn.hide();
    this.warn.show();
    setIcon(this.warn.createSpan({ cls: "cs-warn-icon" }), "unlink");
    this.warn.createSpan({
      text: this.broken.length === 1 ? t("inline.brokenLinks.one", { links: this.broken.join(", ") }) : t("inline.brokenLinks.other", { count: this.broken.length, links: this.broken.join(", ") }),
    });
    const fix = this.warn.createEl("button", { cls: "cs-link-btn", text: t("inline.unlink") });
    fix.onclick = () => {
      const set = new Set(this.broken);
      this.text = unlink(this.text, (t) => set.has(t));
      this.render();
      this.checkLinks();
    };
  }

  private markBroken() {
    this.body.querySelectorAll("a.internal-link.is-unresolved").forEach((a) => a.addClass("cs-broken"));
  }

  private finalText() {
    return this.text;
  }

  private refine(instruction: string) {
    const history = this.turns.map((t, i) => `<answer_${i + 1}>\n${t.answer}\n</answer_${i + 1}>`).join("\n");
    this.start(
      `${this.req.prompt}\n\n${history}\n\nRevise your last answer following this instruction: ${instruction}\nReply with the full revised text only.`,
    );
  }

  retry() {
    if (this.handle) this.handle.cancel();
    // Drop the answer being retried; the prompt that produced it runs again.
    if (this.result) this.turns.pop();
    this.start(this.lastPrompt);
  }

  private async accept(mode: "replace" | "below") {
    if (this.handle || !this.text) return;
    const pos = currentPos(this.view, this.id);
    if (!pos) return this.close();
    const before = this.view.state.doc.toString();
    if (mode === "replace" && pos.to > pos.from) {
      this.view.dispatch({ changes: { from: pos.from, to: pos.to, insert: this.text }, selection: { anchor: pos.from + this.text.length } });
    } else {
      const line = this.view.state.doc.lineAt(pos.to);
      const atEmpty = line.text.trim() === "";
      const insert = atEmpty ? this.text : `\n\n${this.text}`;
      const at = atEmpty ? line.from : line.to;
      this.view.dispatch({ changes: { from: at, to: atEmpty ? line.to : at, insert }, selection: { anchor: at + insert.length } });
    }
    const after = this.view.state.doc.toString();
    await this.log("accepted", before, after);
    this.close();
    this.view.focus();
  }

  discard() {
    this.handle?.cancel();
    if (this.text && !this.closed) void this.log("discarded");
    this.close();
    this.view.focus();
  }

  private async log(status: "accepted" | "discarded", before?: string, after?: string) {
    await this.plugin.history.add({
      action: this.req.title,
      file: this.req.file?.path,
      model: this.req.model,
      costUsd: this.result?.costUsd ?? 0,
      durationMs: this.result?.durationMs ?? 0,
      status,
      prompt: this.req.prompt,
      result: this.text,
      before,
      after,
    });
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.handle?.cancel();
    this.renderer?.unload();
    if (this.renderTimer != null) window.clearTimeout(this.renderTimer);
    sessions.delete(this.id);
    this.view.dispatch({ effects: closeCard.of(this.id) });
  }
}

/** Ends every open card, used on plugin unload. */
export function closeAllCards() {
  for (const s of [...sessions.values()]) s.discard();
}
