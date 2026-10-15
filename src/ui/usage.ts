import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeStudio from "../main";
import { formatDuration, usageLevel } from "../util";
import { clock } from "../time";

export const USAGE_VIEW = "claude-studio-usage";

/** Known windows in display order; unknown ones the CLI adds later are shown after these. */
const WINDOWS: Record<string, { title: string; hint: string }> = {
  five_hour: { title: "Current session", hint: "5-hour window" },
  seven_day: { title: "This week", hint: "All models" },
  seven_day_opus: { title: "This week · Opus", hint: "Opus only" },
  seven_day_sonnet: { title: "This week · Sonnet", hint: "Sonnet only" },
};

const STATUS: Record<string, { icon: string; text: string; cls: string }> = {
  allowed: { icon: "circle-check", text: "You're within your limits", cls: "ok" },
  allowed_warning: { icon: "triangle-alert", text: "Getting close to a limit", cls: "high" },
  rejected: { icon: "octagon-x", text: "Limit reached", cls: "full" },
};

export class UsageView extends ItemView {
  private bodyEl!: HTMLElement;
  private timer = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ClaudeStudio,
  ) {
    super(leaf);
  }

  getViewType() {
    return USAGE_VIEW;
  }
  getDisplayText() {
    return "Claude usage";
  }
  getIcon() {
    return "gauge";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cs-usage");
    const head = root.createDiv({ cls: "cs-chat-head" });
    head.createDiv({ cls: "cs-chat-title", text: "Usage limits" });
    const refresh = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Check now" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => this.check();
    this.bodyEl = root.createDiv({ cls: "cs-usage-body" });
    this.registerEvent(this.plugin.usage.on("changed", () => this.render()));
    // Countdowns and "updated … ago" go stale on their own.
    this.timer = window.setInterval(() => this.render(), 30_000);
    this.registerInterval(this.timer);
    this.render();
    return Promise.resolve();
  }

  private async check() {
    try {
      await this.plugin.usage.check();
    } catch (e) {
      new Notice(`Claude Studio: ${(e as Error).message}`);
    }
  }

  private render() {
    const el = this.bodyEl;
    if (!el) return;
    el.empty();
    const u = this.plugin.usage.last;
    const checking = this.plugin.usage.checking;

    if (!u || !Object.keys(u.windows).length) {
      const empty = el.createDiv({ cls: "cs-usage-empty" });
      setIcon(empty.createDiv({ cls: "cs-usage-empty-icon" }), "gauge");
      empty.createDiv({ cls: "cs-usage-empty-title", text: "No usage data yet" });
      empty.createDiv({ text: "It appears after your next Claude Studio run, or check it now." });
      const b = empty.createEl("button", { cls: "mod-cta", text: checking ? "Checking…" : "Check now" });
      b.disabled = checking;
      b.onclick = () => this.check();
      return;
    }

    const st = STATUS[u.status] ?? STATUS.allowed;
    const banner = el.createDiv({ cls: `cs-usage-status is-${st.cls}` });
    setIcon(banner.createSpan({ cls: "cs-usage-status-icon" }), st.icon);
    banner.createSpan({ text: st.text });
    if (u.status === "rejected" && u.resetsAt) banner.createSpan({ cls: "cs-usage-status-sub", text: ` · back at ${clock(u.resetsAt * 1000).format("ddd HH:mm")}` });

    const keys = [...Object.keys(WINDOWS).filter((k) => u.windows[k]), ...Object.keys(u.windows).filter((k) => !WINDOWS[k])];
    for (const k of keys) {
      const w = u.windows[k];
      const meta = WINDOWS[k] ?? { title: k.replace(/_/g, " "), hint: "" };
      const pct = Math.round(w.utilization * 100);
      const card = el.createDiv({ cls: `cs-usage-card is-${usageLevel(w.utilization)}` });
      const top = card.createDiv({ cls: "cs-usage-top" });
      const name = top.createDiv({ cls: "cs-usage-name" });
      name.createDiv({ cls: "cs-usage-title", text: meta.title });
      if (meta.hint) name.createDiv({ cls: "cs-usage-hint", text: meta.hint });
      top.createDiv({ cls: "cs-usage-pct", text: `${pct}%` });
      const bar = card.createDiv({ cls: "cs-usage-bar", attr: { role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": meta.title } });
      bar.createDiv({ cls: "cs-usage-fill" }).style.width = `${Math.min(100, Math.max(pct, pct > 0 ? 2 : 0))}%`;
      if (w.resetsAt) {
        const at = w.resetsAt * 1000;
        const when = clock(at).isSame(clock(), "day") ? clock(at).format("HH:mm") : clock(at).format("ddd D MMM, HH:mm");
        card.createDiv({ cls: "cs-usage-reset", text: at > Date.now() ? `Resets in ${formatDuration(at - Date.now())} · ${when}` : "Reset since the last check" });
      }
    }

    const foot = el.createDiv({ cls: "cs-usage-foot" });
    foot.createSpan({ text: checking ? "Checking…" : `Updated ${clock(u.at).fromNow()}` });
    const b = foot.createEl("button", { text: "Check now" });
    b.disabled = checking;
    b.onclick = () => this.check();
    el.createDiv({
      cls: "cs-usage-note",
      text: "Shared with Claude Code and claude.ai on the same account. Updated after every Claude Studio run; “Check now” sends one tiny request.",
    });
  }
}
