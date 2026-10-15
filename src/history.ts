import { App, Events, normalizePath } from "obsidian";

export type HistoryStatus = "accepted" | "discarded" | "applied" | "shown" | "error" | "reverted";

export interface HistoryEntry {
  id: string;
  time: number;
  action: string;
  file?: string;
  model: string;
  costUsd: number;
  durationMs: number;
  status: HistoryStatus;
  prompt: string;
  result: string;
  /** Whole-file snapshots around an applied change; dropped when too large. */
  before?: string;
  after?: string;
}

const MAX_ENTRIES = 200;
const MAX_SNAPSHOT = 300_000;
const MAX_TEXT = 20_000;

/** Run log kept in the plugin folder (history.json), separate from settings so data.json stays small. */
export class HistoryStore extends Events {
  entries: HistoryEntry[] = [];
  private loaded = false;

  constructor(
    private app: App,
    private dir: string,
  ) {
    super();
  }

  private get file() {
    return normalizePath(`${this.dir}/history.json`);
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (await this.app.vault.adapter.exists(this.file)) this.entries = JSON.parse(await this.app.vault.adapter.read(this.file)) as typeof this.entries;
    } catch {
      this.entries = [];
    }
  }

  async add(e: Omit<HistoryEntry, "id" | "time">): Promise<HistoryEntry> {
    await this.load();
    const entry: HistoryEntry = {
      ...e,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: Date.now(),
      prompt: e.prompt.slice(0, MAX_TEXT),
      result: e.result.slice(0, MAX_TEXT),
    };
    if ((entry.before?.length ?? 0) > MAX_SNAPSHOT || (entry.after?.length ?? 0) > MAX_SNAPSHOT) {
      delete entry.before;
      delete entry.after;
    }
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, MAX_ENTRIES);
    await this.save();
    return entry;
  }

  async update(id: string, patch: Partial<HistoryEntry>) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    await this.save();
  }

  async clear() {
    this.entries = [];
    await this.save();
  }

  private async save() {
    await this.app.vault.adapter.write(this.file, JSON.stringify(this.entries));
    this.trigger("changed");
  }
}
