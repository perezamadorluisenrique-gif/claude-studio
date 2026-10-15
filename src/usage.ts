import { App, Events, normalizePath } from "obsidian";
import type { Core } from "./core";
import type { RateLimitInfo } from "./runner";

export interface UsageSnapshot extends RateLimitInfo {
  /** When the CLI reported it (epoch ms). */
  at: number;
}

/**
 * Last usage-limit snapshot reported by the CLI. Every run already carries it, so keeping
 * the view current costs nothing; "Check now" is the only call made just for this.
 */
export class UsageStore extends Events {
  last: UsageSnapshot | null = null;
  checking = false;

  constructor(
    private app: App,
    private dir: string,
    private core: Core,
  ) {
    super();
    core.usageSink = (i) => void this.update(i);
  }

  private get file() {
    return normalizePath(`${this.dir}/usage.json`);
  }

  async load() {
    try {
      if (await this.app.vault.adapter.exists(this.file)) this.last = JSON.parse(await this.app.vault.adapter.read(this.file)) as typeof this.last;
    } catch {
      this.last = null;
    }
    this.trigger("changed");
  }

  async update(i: RateLimitInfo) {
    // A run may report only the window that is binding; keep the others from the previous snapshot.
    const windows = { ...(this.last?.windows ?? {}), ...i.windows };
    this.last = { ...i, windows, at: Date.now() };
    this.trigger("changed");
    try {
      await this.app.vault.adapter.write(this.file, JSON.stringify(this.last));
    } catch {
      /* the view still has it in memory */
    }
  }

  /** Smallest possible run (haiku, no tools, no session) just to get a fresh snapshot. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.trigger("changed");
    try {
      await this.core.complete({ prompt: "ok", model: "fast", tools: [], persist: false, label: "Checking usage" });
    } finally {
      this.checking = false;
      this.trigger("changed");
    }
  }
}
