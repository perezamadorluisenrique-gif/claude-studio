import { ICON } from "../icon";
import { setIcon } from "obsidian";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type ClaudeStudio from "../main";
import { Palette } from "../ui/palette";

const DELAY = 280;

/** Floating action bar above a text selection. */
export function bubbleExtension(plugin: ClaudeStudio) {
  return ViewPlugin.fromClass(
    class {
      el: HTMLElement | null = null;
      timer: number | null = null;
      pointerDown = false;
      onScroll = () => this.hide();

      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      }

      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) this.schedule();
      }

      schedule() {
        this.hide();
        if (this.timer != null) window.clearTimeout(this.timer);
        if (!plugin.settings.selectionBubble || this.pointerDown) return;
        this.timer = window.setTimeout(() => this.show(), DELAY);
      }

      show() {
        this.timer = null;
        const { view } = this;
        const sel = view.state.selection.main;
        if (sel.empty || !view.hasFocus || view.state.sliceDoc(sel.from, sel.to).trim().length < 2) return;
        if (view.dom.closest(".cs-card")) return;
        const start = view.coordsAtPos(sel.from);
        const end = view.coordsAtPos(sel.to);
        if (!start || !end) return;

        const el = activeDocument.body.createDiv({ cls: "cs-bubble" });
        const add = (icon: string, label: string, fn: () => void, cls = "") => {
          const b = el.createEl("button", { cls: `cs-bubble-btn ${cls}`, attr: { "aria-label": label } });
          setIcon(b.createSpan(), icon);
          if (cls.includes("with-text")) b.createSpan({ text: label });
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => {
            this.hide();
            fn();
          });
        };
        add(ICON, "Ask Claude", () => new Palette(plugin.app, plugin).open(), "with-text cs-bubble-ask");
        el.createSpan({ cls: "cs-bubble-sep" });
        for (const a of plugin.library.actions.filter((x) => x.bubble && x.scope === "selection"))
          add(a.icon, a.name, () => void plugin.actions.run(a));

        const r = el.getBoundingClientRect();
        let top = start.top - r.height - 8;
        if (top < 8) top = end.bottom + 8;
        const left = Math.min(Math.max(8, start.left), window.innerWidth - r.width - 8);
        el.style.setProperty("--cs-top", `${top}px`);
        el.style.setProperty("--cs-left", `${left}px`);
        el.addClass("is-shown");
        this.el = el;
      }

      hide() {
        this.el?.remove();
        this.el = null;
      }

      destroy() {
        if (this.timer != null) window.clearTimeout(this.timer);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.hide();
      }
    },
    {
      eventHandlers: {
        mousedown() {
          this.pointerDown = true;
          this.hide();
        },
        mouseup() {
          this.pointerDown = false;
          this.schedule();
        },
        blur() {
          window.setTimeout(() => this.hide(), 120);
        },
      },
    },
  );
}
