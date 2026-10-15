import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import type ClaudeStudio from "../main";
import type { RunHandle } from "../runner";
import { BASE_SYSTEM, systemFor, type Gathered } from "../context";

interface Ghost {
  pos: number;
  text: string;
  loading: boolean;
}

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly loading: boolean,
  ) {
    super();
  }
  eq(o: GhostWidget) {
    return o.text === this.text && o.loading === this.loading;
  }
  toDOM() {
    const span = createSpan({ cls: "cs-ghost" + (this.loading ? " is-loading" : ""), text: this.text });
    if (!this.loading && this.text) {
      const k = span.createSpan({ cls: "cs-ghost-hint", text: "Tab" });
      k.setAttr("aria-hidden", "true");
    }
    return span;
  }
}

const ghostField = StateField.define<{ g: Ghost | null; deco: DecorationSet }>({
  create: () => ({ g: null, deco: Decoration.none }),
  update(v, tr) {
    let g = v.g;
    // Any edit by the user dismisses the suggestion.
    if (g && tr.docChanged) g = null;
    for (const e of tr.effects) if (e.is(setGhost)) g = e.value;
    if (g === v.g) return v;
    if (!g) {
      cancelRun();
      return { g: null, deco: Decoration.none };
    }
    return { g, deco: Decoration.set([Decoration.widget({ widget: new GhostWidget(g.loading && !g.text ? " …" : g.text, g.loading), side: 1 }).range(g.pos)]) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

let current: RunHandle | null = null;
function cancelRun() {
  current?.cancel();
  current = null;
}

export function ghostExtension(): Extension {
  return [
    ghostField,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            const g = view.state.field(ghostField, false)?.g;
            if (!g || g.loading || !g.text) return false;
            view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, effects: setGhost.of(null) });
            return true;
          },
        },
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(ghostField, false)?.g) return false;
            view.dispatch({ effects: setGhost.of(null) });
            return true;
          },
        },
      ]),
    ),
  ];
}

/** Stream a short continuation as ghost text at the cursor. */
export async function suggestContinuation(plugin: ClaudeStudio) {
  const note = plugin.actions.active();
  if (!note) return;
  const { cm, editor, file } = note;
  cancelRun();
  const pos = cm.state.selection.main.head;
  let g: Gathered;
  try {
    g = await plugin.ctx.gather(file, editor, "cursor");
  } catch {
    return;
  }
  const doc = cm.state.doc.toString();
  const before = doc.slice(Math.max(0, pos - plugin.settings.contextChars * 2), pos);
  const after = doc.slice(pos, pos + 400);
  cm.dispatch({ effects: setGhost.of({ pos, text: "", loading: true }) });

  let text = "";
  const system = systemFor(
    g.chips,
    "This is autocomplete. Continue the user's text at ⟦CURSOR⟧ with the words they would most plausibly write next: one to three sentences, in the SAME language as the text before the cursor, same voice and format. Output only those words, nothing else. If the text before the cursor ends mid-word or without a trailing space, start accordingly.",
  );
  const handle = plugin.core.run(
    {
      prompt: `${before}⟦CURSOR⟧${after}`,
      system: system || BASE_SYSTEM,
      model: "fast",
      tools: [],
      persist: false,
      label: "Continue writing",
    },
    {
      onDelta: (t) => {
        if (current !== handle) return;
        text += t;
        const live = cm.state.field(ghostField, false)?.g;
        if (live) cm.dispatch({ effects: setGhost.of({ pos: live.pos, text, loading: true }) });
      },
      onResult: (r) => {
        if (r.text) text = r.text;
      },
      onClose: () => {
        if (current !== handle) return;
        current = null;
        const live = cm.state.field(ghostField, false)?.g;
        if (!live) return;
        const clean = text.replace(/⟦CURSOR⟧/g, "").replace(/\s+$/, "");
        cm.dispatch({ effects: setGhost.of(clean ? { pos: live.pos, text: clean, loading: false } : null) });
      },
    },
  );
  current = handle;
}
