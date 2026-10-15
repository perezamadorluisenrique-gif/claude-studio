import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { t } from "../i18n";
import type ClaudeStudio from "../main";
import { formatDuration, usageLevel } from "../util";
import { clock } from "../time";

export const USAGE_VIEW = "claude-studio-usage";

/** Known windows in display order; unknown ones the CLI adds later are shown after these. */
type WindowKey = "usage.fiveHour" | "usage.fiveHourHint" | "usage.sevenDay" | "usage.sevenDayHint" | "usage.sevenDayOpus" | "usage.sevenDayOpusHint" | "usage.sevenDaySonnet" | "usage.sevenDaySonnetHint";
const WINDOWS: Record<string, { title: WindowKey; hint: WindowKey }> = {
  five_hour: { title: "usage.fiveHour", hint: "usage.fiveHourHint" },
  seven_day: { title: "usage.sevenDay", hint: "usage.sevenDayHint" },
  seven_day_opus: { title: "usage.sevenDayOpus", hint: "usage.sevenDayOpusHint" },
  seven_day_sonnet: { title: "usage.sevenDaySonnet", hint: "usage.sevenDaySonnetHint" },
};

const STATUS: Record<string, { icon: string; text: "usage.within" | "usage.warning" | "usage.rejected"; cls: string }> = {
  allowed: { icon: "circle-check", text: "usage.within", cls: "ok" },
  allowed_warning: { icon: "triangle-alert", text: "usage.warning", cls: "high" },
  rejected: { icon: "octagon-x", text: "usage.rejected", cls: "full" },
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
    return t("usage.viewName");
  }
  getIcon() {
    return "gauge";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cs-usage");
    const head = root.createDiv({ cls: "cs-chat-head" });
    head.createDiv({ cls: "cs-chat-title", text: t("usage.title") });
    const refresh = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("common.checkNow") } });
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
      empty.createDiv({ cls: "cs-usage-empty-title", text: t("usage.emptyTitle") });
      empty.createDiv({ text: t("usage.emptyText") });
      const b = empty.createEl("button", { cls: "mod-cta", text: checking ? t("common.checking") : t("common.checkNow") });
      b.disabled = checking;
      b.onclick = () => this.check();
      return;
    }

    const st = STATUS[u.status] ?? STATUS.allowed;
    const banner = el.createDiv({ cls: `cs-usage-status is-${st.cls}` });
    setIcon(banner.createSpan({ cls: "cs-usage-status-icon" }), st.icon);
    banner.createSpan({ text: t(st.text) });
    if (u.status === "rejected" && u.resetsAt) banner.createSpan({ cls: "cs-usage-status-sub", text: t("usage.backAt", { time: clock(u.resetsAt * 1000).format("ddd HH:mm") }) });

    const keys = [...Object.keys(WINDOWS).filter((k) => u.windows[k]), ...Object.keys(u.windows).filter((k) => !WINDOWS[k])];
    for (const k of keys) {
      const w = u.windows[k];
      const known = WINDOWS[k];
      const meta = { title: known ? t(known.title) : k.replace(/_/g, " "), hint: known ? t(known.hint) : "" };
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
        card.createDiv({ cls: "cs-usage-reset", text: at > Date.now() ? t("usage.resetsIn", { duration: formatDuration(at - Date.now()), when }) : t("usage.resetSince") });
      }
    }

    const foot = el.createDiv({ cls: "cs-usage-foot" });
    foot.createSpan({ text: checking ? t("common.checking") : t("usage.updated", { when: clock(u.at).fromNow() }) });
    const b = foot.createEl("button", { text: t("common.checkNow") });
    b.disabled = checking;
    b.onclick = () => this.check();
    el.createDiv({
      cls: "cs-usage-note",
      text: t("usage.note"),
    });
  }
}
